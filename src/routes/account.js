const express = require('express');
const bcrypt = require('bcryptjs');
const { db, tx, getSettings } = require('../db');
const { requireAuth, flash, parseMoney } = require('../middleware');
const { NETWORKS, validateWallet, balances, stats } = require('../affiliate');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? OR (user_id IS NULL AND email = ?) ORDER BY id DESC LIMIT 50')
    .all(req.user.id, req.user.email);
  res.render('account/index', { title: 'My account', orders, bal: balances(req.user.id) });
});

router.post('/password', (req, res) => {
  const { current, password } = req.body;
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash)) {
    flash(req, 'error', 'Current password is incorrect.');
  } else if (String(password || '').length < 8) {
    flash(req, 'error', 'New password must be at least 8 characters.');
  } else {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(password), 10), req.user.id);
    flash(req, 'success', 'Password updated.');
  }
  res.redirect('/account');
});

/* ---------------- affiliate dashboard ---------------- */

router.get('/affiliate', (req, res) => {
  const uid = req.user.id;
  const commissions = db.prepare(`
    SELECT c.*, o.status AS order_status, o.created_at AS order_date
    FROM commissions c JOIN orders o ON o.id = c.order_id
    WHERE c.affiliate_id = ? ORDER BY c.id DESC LIMIT 100`).all(uid);
  const withdrawals = db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(uid);
  const daily = db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS clicks FROM referral_clicks
    WHERE affiliate_id = ? AND created_at >= datetime('now', '-13 days') GROUP BY day`).all(uid);
  const dailyEarn = db.prepare(`
    SELECT date(created_at) AS day, SUM(amount_cents) AS cents FROM commissions
    WHERE affiliate_id = ? AND status != 'cancelled' AND created_at >= datetime('now', '-13 days') GROUP BY day`).all(uid);

  // Build a 14-day series for the mini chart
  const series = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    series.push({
      day: d,
      clicks: (daily.find((r) => r.day === d) || {}).clicks || 0,
      cents: (dailyEarn.find((r) => r.day === d) || {}).cents || 0,
    });
  }

  res.render('account/affiliate', {
    title: 'Earn with us',
    bal: balances(uid),
    st: stats(uid),
    commissions,
    withdrawals,
    series,
    networks: NETWORKS,
  });
});

router.post('/wallet', (req, res) => {
  const network = String(req.body.network || '');
  const address = String(req.body.address || '').trim();
  const err = validateWallet(network, address);
  if (err) {
    flash(req, 'error', err);
  } else if (!bcrypt.compareSync(String(req.body.password || ''), req.user.password_hash)) {
    flash(req, 'error', 'Password is incorrect. Your wallet was not changed.');
  } else {
    db.prepare("UPDATE users SET wallet_network = ?, wallet_address = ?, wallet_updated_at = datetime('now') WHERE id = ?")
      .run(network, address, req.user.id);
    flash(req, 'success', 'Wallet address saved.');
  }
  res.redirect('/account/affiliate#wallet');
});

router.post('/withdraw', (req, res) => {
  const settings = getSettings();
  const amount = parseMoney(req.body.amount);
  const user = req.user;
  const back = () => res.redirect('/account/affiliate#withdraw');

  if (!user.wallet_address || !user.wallet_network) {
    flash(req, 'error', 'Please save your USDC wallet address before requesting a withdrawal.');
    return back();
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    flash(req, 'error', 'Please enter a valid amount.');
    return back();
  }
  if (amount < settings.min_withdrawal_cents) {
    flash(req, 'error', `Minimum withdrawal is ${(settings.min_withdrawal_cents / 100).toFixed(2)} USDC.`);
    return back();
  }

  const ok = tx(() => {
    const bal = balances(user.id); // computed inside the transaction to avoid double spending
    if (amount > bal.available) return false;
    db.prepare('INSERT INTO withdrawals (user_id, amount_cents, wallet_address, wallet_network) VALUES (?, ?, ?, ?)')
      .run(user.id, amount, user.wallet_address, user.wallet_network);
    return true;
  });
  flash(req, ok ? 'success' : 'error', ok
    ? `Withdrawal of ${(amount / 100).toFixed(2)} USDC requested. You will be notified once it is sent.`
    : 'Amount is higher than your available balance.');
  back();
});

module.exports = router;
