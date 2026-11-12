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
const payments = require('./src/payments');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!process.env.SESSION_SECRET) {
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
  next();
});

app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
// Stripe webhook: needs the raw request body to verify the signature, so it is registered
// before the body parsers, sessions and CSRF checks.
app.post('/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  if (!payments.enabled() || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Stripe is not configured');
  try {
    const type = await payments.handleWebhook(req.body, req.get('stripe-signature'));
    res.json({ received: true, type });
  } catch (err) {
    console.error('[stripe] Webhook rejected:', err.message);
    res.status(400).send(`Webhook error: ${err.message}`);
  }
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
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPG, PNG, WEBP or GIF images are allowed.'), ok);
  },
});
app.use('/admin', mw.requireAdmin, upload.single('image'));

app.use(mw.csrf);

app.use(require('./src/routes/auth'));
app.use(require('./src/routes/shop'));
app.use('/account', require('./src/routes/account'));
app.use('/admin', require('./src/routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'The page you are looking for does not exist.' });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || /images are allowed/.test(err.message)) {
    mw.flash(req, 'error', err.code === 'LIMIT_FILE_SIZE' ? 'Image is too large (max 5 MB).' : err.message);
    return res.redirect(req.get('referer') || '/admin');
  }
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred. Please try again.' });
});

setInterval(() => payments.sweepStale().catch((e) => console.error(e)), 10 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`Store running on http://localhost:${PORT}`);
  if (!payments.enabled()) console.warn('[warn] STRIPE_SECRET_KEY is not set: checkout is disabled until you add it.');
  else if (!process.env.STRIPE_WEBHOOK_SECRET) console.warn('[warn] STRIPE_WEBHOOK_SECRET is not set: payments are only confirmed when shoppers return from Stripe.');
});
