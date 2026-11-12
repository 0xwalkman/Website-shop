const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { db, createUser } = require('../db');
const { flash, currentAffiliate } = require('../middleware');
const notify = require('../notify');
const totp = require('../totp');

const router = express.Router();

// Simple in-memory login throttling per IP+email.
const attempts = new Map();
function throttled(key) {
  const a = attempts.get(key);
  return a && a.count >= 5 && Date.now() - a.first < 15 * 60 * 1000;
}
function recordFailure(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > 15 * 60 * 1000) attempts.set(key, { count: 1, first: Date.now() });
  else a.count++;
}

// Signs a user out of every browser (after a password reset, or when they change their password).
function signOutEverywhere(userId, keepSid = null) {
  db.prepare("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ? AND sid IS NOT ?").run(userId, keepSid);
}

function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : null;
}

function login(req, userId, done) {
  const cart = req.session.cart;
  const orders = req.session.orders;
  req.session.regenerate((err) => {
    if (err) return done(err);
    req.session.userId = userId;
    if (cart) req.session.cart = cart;
    if (orders) req.session.orders = orders;
    done();
  });
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/account');
  res.render('login', { title: 'Log in', next: safeNext(req.query.next) || '', values: {} });
});

router.post('/login', (req, res, next) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const key = `${req.ip}|${email}`;
  const nextUrl = safeNext(req.body.next);
  const fail = (msg) => res.status(400).render('login', { title: 'Log in', next: nextUrl || '', values: { email }, error: msg });

  if (throttled(key)) return fail('Too many attempts. Please wait 15 minutes and try again.');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    recordFailure(key);
    return fail("That email and password don't match. Please try again.");
  }
  attempts.delete(key);
  if (user.totp_enabled) {
    // Password is right; ask for the authenticator code before logging in.
    req.session.pending2fa = { userId: user.id, next: nextUrl, at: Date.now() };
    return res.redirect('/login/2fa');
  }
  login(req, user.id, (err) => {
    if (err) return next(err);
    flash(req, 'success', `Welcome back, ${user.name}!`);
    res.redirect(nextUrl || (user.is_admin || user.staff_role ? '/admin' : '/account'));
  });
});

/* ---------- two-factor login step ---------- */

function pending(req) {
  const p = req.session.pending2fa;
  return p && Date.now() - p.at < 10 * 60 * 1000 ? p : null;
}

router.get('/login/2fa', (req, res) => {
  if (!pending(req)) return res.redirect('/login');
  res.render('login-2fa', { title: 'Two-step verification' });
});

router.post('/login/2fa', (req, res, next) => {
  const p = pending(req);
  if (!p) return res.redirect('/login');
  const key = `2fa|${p.userId}`;
  const fail = (msg) => res.status(400).render('login-2fa', { title: 'Two-step verification', error: msg });
  if (throttled(key)) return fail('Too many attempts. Please wait 15 minutes and try again.');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(p.userId);
  const step = user && totp.verify(user.totp_secret, req.body.code, user.totp_last_step);
  if (!step) { recordFailure(key); return fail("That code didn't work. Check your authenticator app and try the newest code."); }
  attempts.delete(key);
  db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
  delete req.session.pending2fa;
  login(req, user.id, (err) => {
    if (err) return next(err);
    flash(req, 'success', `Welcome back, ${user.name}!`);
    res.redirect(p.next || (user.is_admin || user.staff_role ? '/admin' : '/account'));
  });
});

/* ---------- forgot / reset password ---------- */

const resetRequests = new Map(); // ip -> [timestamps]
function tooManyResets(ip) {
  const list = (resetRequests.get(ip) || []).filter((t) => Date.now() - t < 60 * 60 * 1000);
  list.push(Date.now());
  resetRequests.set(ip, list);
  return list.length > 5;
}
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

router.get('/forgot', (req, res) => {
  res.render('forgot', { title: 'Forgot password', sent: false, values: {} });
});

router.post('/forgot', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!tooManyResets(req.ip)) {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user) {
      const token = crypto.randomBytes(32).toString('base64url');
      db.prepare('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?').run(user.id, Date.now());
      db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .run(hashToken(token), user.id, Date.now() + 60 * 60 * 1000);
      notify.passwordReset(user, token);
    }
  }
  // Same answer whether or not the account exists, so emails can't be probed.
  res.render('forgot', { title: 'Forgot password', sent: true, values: { email } });
});

function validReset(token) {
  const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(hashToken(token));
  return row && !row.used && row.expires_at > Date.now() ? row : null;
}

router.get('/reset/:token', (req, res) => {
  if (!validReset(req.params.token)) {
    return res.status(400).render('error', { title: 'This link has expired', message: 'Password reset links work once and only for 1 hour. Request a new one from the login page.' });
  }
  res.render('reset', { title: 'Choose a new password', token: req.params.token });
});

router.post('/reset/:token', (req, res, next) => {
  const row = validReset(req.params.token);
  if (!row) return res.redirect('/forgot');
  const password = String(req.body.password || '');
  if (password.length < 8) {
    return res.status(400).render('reset', { title: 'Choose a new password', token: req.params.token, error: 'Password must be at least 8 characters.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), row.user_id);
  db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ?').run(row.user_id);
  signOutEverywhere(row.user_id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (user.totp_enabled) {
    flash(req, 'success', 'Password updated. Log in with your new password and your authenticator code.');
    return res.redirect('/login');
  }
  login(req, user.id, (err) => {
    if (err) return next(err);
    flash(req, 'success', 'Password updated. You are now logged in.');
    res.redirect(user.is_admin || user.staff_role ? '/admin' : '/account');
  });
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/account');
  res.render('register', { title: 'Create account', next: safeNext(req.query.next) || '', values: {} });
});

router.post('/register', (req, res, next) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const nextUrl = safeNext(req.body.next);
  const fail = (msg) => res.status(400).render('register', { title: 'Create account', next: nextUrl || '', values: { name, email }, error: msg });

  if (name.length < 2 || name.length > 80) return fail('Please enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) return fail('Please enter a valid email address.');
  if (password.length < 8) return fail('Password must be at least 8 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return fail('You already have an account with this email. Log in instead?');

  const aff = currentAffiliate(req, email);
  const id = createUser({ name, email, password, referredBy: aff ? aff.id : null });
  login(req, id, (err) => {
    if (err) return next(err);
    flash(req, 'success', `Welcome to the crew, ${name.split(' ')[0]}! Your personal share link is ready on the Earn page.`);
    res.redirect(nextUrl || '/account');
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('sid');
    res.redirect('/');
  });
});

module.exports = router;
module.exports.signOutEverywhere = signOutEverywhere;
