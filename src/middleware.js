const crypto = require('node:crypto');
const { db, getSettings } = require('./db');

const REF_COOKIE = 'ref';
const REF_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days attribution window

function loadUser(req, res, next) {
  if (req.session.userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (user) req.user = user;
    else delete req.session.userId;
  }
  next();
}

// Captures ?ref=CODE on any page, stores it in a cookie and logs a click.
function referral(req, res, next) {
  const raw = req.query.ref;
  if (typeof raw === 'string' && raw.length <= 32) {
    const code = raw.trim().toUpperCase();
    const aff = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(code);
    if (aff && (!req.user || req.user.id !== aff.id)) {
      res.cookie(REF_COOKIE, code, { maxAge: REF_TTL, httpOnly: true, sameSite: 'lax' });
      req.cookies[REF_COOKIE] = code;
      req.session.refClicks = req.session.refClicks || [];
      if (!req.session.refClicks.includes(code)) {
        req.session.refClicks.push(code);
        const visitor = crypto.createHash('sha256').update(`${req.ip}|${req.get('user-agent') || ''}`).digest('hex').slice(0, 32);
        db.prepare('INSERT INTO referral_clicks (affiliate_id, visitor_hash, landing) VALUES (?, ?, ?)')
          .run(aff.id, visitor, req.path.slice(0, 200));
      }
    }
  }
  next();
}

// Returns the affiliate user to credit for the current request, or null.
function currentAffiliate(req, buyerEmail) {
  const code = req.cookies && req.cookies[REF_COOKIE];
  if (!code) return null;
  const aff = db.prepare('SELECT id, email FROM users WHERE referral_code = ?').get(String(code).toUpperCase());
  if (!aff) return null;
  if (req.user && req.user.id === aff.id) return null; // no self-referrals
  if (buyerEmail && aff.email.toLowerCase() === String(buyerEmail).toLowerCase()) return null;
  return aff;
}

function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrf;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const sent = String((req.body && req.body._csrf) || req.get('x-csrf-token') || '');
    const a = Buffer.from(sent);
    const b = Buffer.from(req.session.csrf);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).render('error', { title: 'Let’s try that again', message: 'Your page was open a little too long. Go back, refresh, and try once more.' });
    }
  }
  next();
}

function locals(req, res, next) {
  const settings = getSettings();
  res.locals.settings = settings;
  res.locals.freeShipping = settings.shipping_cents === 0; // drives the "free worldwide shipping" copy
  // Payment wording follows whichever payment methods are actually configured.
  const card = Boolean(process.env.STRIPE_SECRET_KEY);
  const bpay = Boolean(process.env.BINANCE_PAY_API_KEY && process.env.BINANCE_PAY_SECRET_KEY);
  res.locals.payLabel = card && bpay ? 'Pay by card or Binance Pay' : card ? 'Secure card payments by Stripe' : bpay ? 'Pay with Binance Pay' : 'Secure checkout';
  res.locals.user = req.user || null;
  res.locals.path = req.path;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.cartCount = (req.session.cart || []).reduce((n, i) => n + i.qty, 0);
  res.locals.money = (cents) => `${settings.currency_symbol}${(Number(cents || 0) / 100).toFixed(2)}`;
  res.locals.usdc = (cents) => `${(Number(cents || 0) / 100).toFixed(2)} USDC`;
  res.locals.navCategories = db.prepare('SELECT id, name, slug FROM categories ORDER BY sort_order, name').all();
  res.locals.baseUrl = (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  next();
}

function flash(req, type, message) {
  req.session.flash = { type, message };
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  flash(req, 'info', 'Log in or create a free account to continue.');
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

// Admin area: owners (is_admin) and staff. Owner-only sections are checked again in routes/admin.js.
function requireAdmin(req, res, next) {
  if (req.user && (req.user.is_admin || req.user.staff_role === 'staff')) return next();
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  res.status(403).render('error', { title: 'Forbidden', message: 'You do not have access to this page.' });
}

// "12.5" -> 1250 ; returns NaN for invalid input
function parseMoney(v) {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100);
}

function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

module.exports = {
  loadUser, referral, currentAffiliate, csrf, locals, flash,
  requireAuth, requireAdmin, parseMoney, toArray, REF_COOKIE,
};
