const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const multer = require('multer');

const { db } = require('./src/db');
const SqliteStore = require('./src/session-store')(session);
const mw = require('./src/middleware');
const paypal = require('./src/paypal');
const { releaseUnpaid } = require('./src/orders');
const binance = require('./src/binance');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Refuse to start a production server with unsafe settings.
if (process.env.NODE_ENV === 'production') {
  const missing = ['BASE_URL', 'SESSION_SECRET'].filter((k) => !process.env[k]);
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length < 32) missing.push('SESSION_SECRET (at least 32 characters)');
  if (missing.length) {
    console.error(`[fatal] Missing required settings for production: ${missing.join(', ')}. See .env.example.`);
    process.exit(1);
  }
} else if (!process.env.SESSION_SECRET) {
  console.warn('[warn] SESSION_SECRET is not set; using a random secret (sessions reset on restart).');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.COOKIE_SECURE === 'true') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.get('/healthz', (req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true }); });

app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
// PayPal webhook: only a signal to re-check the order with PayPal's API (see src/paypal.js),
// so it cannot mark anything paid by itself. Registered before the body parsers and CSRF checks.
app.post('/paypal/webhook', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  try {
    if (paypal.enabled()) await paypal.handleWebhook(req.body || Buffer.alloc(0));
  } catch (err) {
    console.error('[paypal] Webhook handling failed:', err.message);
    return res.status(500).send('retry later'); // PayPal retries failed deliveries
  }
  res.sendStatus(200);
});

// Binance Pay webhook: treated only as a signal to re-check the order with Binance's API
// (see src/binance.js), so it cannot mark anything paid by itself.
app.post('/binance/webhook', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  try {
    if (binance.enabled()) await binance.handleWebhook(req.body || Buffer.alloc(0));
  } catch (err) {
    console.error('[binance] Webhook handling failed:', err.message);
    return res.json({ returnCode: 'FAIL', returnMessage: 'retry later' });
  }
  res.json({ returnCode: 'SUCCESS', returnMessage: null });
});

app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
app.use(session({
  name: 'sid',
  store: new SqliteStore(db),
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));

app.use(mw.loadUser);
app.use(mw.referral);
app.use(mw.locals);

// Image uploads (admin only). Multer must run before CSRF so the token in multipart forms is readable.
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[file.mimetype];
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 }, // phone photos are large; they are shrunk right after upload
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPG, PNG, WEBP or GIF images are allowed.'), ok);
  },
});
app.use('/admin', mw.requireAdmin, upload.fields([{ name: 'image', maxCount: 1 }, { name: 'images', maxCount: 12 }]),
  require('./src/images').processUploads);

app.use(mw.csrf);

app.use(require('./src/analytics').track);
app.use(require('./src/routes/seo'));
app.use(require('./src/routes/auth'));
app.use(require('./src/routes/shop'));
app.use(require('./src/routes/pages'));
app.use('/account', require('./src/routes/account'));
app.use('/admin', require('./src/routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'The page you are looking for does not exist.' });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || /images are allowed/.test(err.message) || err.userMessage) {
    mw.flash(req, 'error', err.code === 'LIMIT_FILE_SIZE' ? 'Image is too large (max 15 MB).' : (err.userMessage || err.message));
    return res.redirect(req.get('referer') || '/admin');
  }
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred. Please try again.' });
});

if (process.env.BACKUPS !== 'off') require('./src/backup').schedule();

// Checkouts started with Stripe before the switch to PayPal can no longer be paid: release their stock.
for (const o of db.prepare("SELECT id FROM orders WHERE status = 'unpaid' AND payment_method = 'stripe'").all()) releaseUnpaid(o.id);

setInterval(() => {
  paypal.sweepStale().catch((e) => console.error(e));
  binance.sweepStale().catch((e) => console.error(e));
}, 10 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`Store running on http://localhost:${PORT}`);
  if (!paypal.enabled() && !binance.enabled()) console.warn('[warn] No payment method configured: set PayPal and/or Binance Pay keys to enable checkout.');
  if (!paypal.enabled()) console.warn('[warn] PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set: PayPal is off.');
  else console.log(`[paypal] Using the PayPal ${paypal.live() ? 'LIVE' : 'SANDBOX (test)'} environment.`);
  if (!binance.enabled()) console.warn('[warn] BINANCE_PAY_API_KEY / BINANCE_PAY_SECRET_KEY are not set: Binance Pay is off.');
});
