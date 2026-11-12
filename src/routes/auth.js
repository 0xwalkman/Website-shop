const express = require('express');
const bcrypt = require('bcryptjs');
const { db, createUser } = require('../db');
const { flash, currentAffiliate } = require('../middleware');

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
    return fail('Incorrect email or password.');
  }
  attempts.delete(key);
  login(req, user.id, (err) => {
    if (err) return next(err);
    flash(req, 'success', `Welcome back, ${user.name}!`);
    res.redirect(nextUrl || (user.is_admin ? '/admin' : '/account'));
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
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return fail('An account with this email already exists.');

  const aff = currentAffiliate(req, email);
  const id = createUser({ name, email, password, referredBy: aff ? aff.id : null });
  login(req, id, (err) => {
    if (err) return next(err);
    flash(req, 'success', 'Account created! Share your link from the Earn page to start earning.');
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
