const { db } = require('./db');

// USDC networks supported for payouts.
const NETWORKS = {
  ethereum: { label: 'Ethereum (ERC-20)', type: 'evm' },
  base: { label: 'Base', type: 'evm' },
  polygon: { label: 'Polygon (PoS)', type: 'evm' },
  arbitrum: { label: 'Arbitrum One', type: 'evm' },
  optimism: { label: 'Optimism', type: 'evm' },
  solana: { label: 'Solana (SPL)', type: 'solana' },
};

function validateWallet(network, address) {
  const net = NETWORKS[network];
  if (!net) return 'Please choose a supported network.';
  const a = String(address || '').trim();
  if (net.type === 'evm' && !/^0x[a-fA-F0-9]{40}$/.test(a)) {
    return 'That does not look like a valid EVM address (0x followed by 40 hex characters).';
  }
  if (net.type === 'solana' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) {
    return 'That does not look like a valid Solana address.';
  }
  return null;
}

/**
 * Commission lifecycle (driven by the order status):
 *   order unpaid                 -> no commission yet (created once Stripe confirms payment)
 *   order paid / shipped         -> commission "pending"   (not withdrawable yet)
 *   order delivered              -> commission "approved"  (withdrawable)
 *   order cancelled / refunded   -> commission "cancelled"
 */
function commissionStatusFor(orderStatus) {
  if (orderStatus === 'delivered') return 'approved';
  if (orderStatus === 'cancelled' || orderStatus === 'refunded') return 'cancelled';
  return 'pending';
}

// Creates the commission for a paid order that came through an affiliate link (idempotent).
function ensureCommission(orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o || !o.affiliate_id || !(o.commission_rate > 0)) return;
  const amount = Math.floor(o.subtotal_cents * o.commission_rate / 100);
  db.prepare(`INSERT OR IGNORE INTO commissions (affiliate_id, order_id, order_amount_cents, rate, amount_cents, status)
              VALUES (?, ?, ?, ?, ?, 'pending')`).run(o.affiliate_id, o.id, o.subtotal_cents, o.commission_rate, amount);
}

function syncCommission(orderId, orderStatus) {
  db.prepare("UPDATE commissions SET status = ?, updated_at = datetime('now') WHERE order_id = ?")
    .run(commissionStatusFor(orderStatus), orderId);
}

function balances(userId) {
  const c = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'pending'  THEN amount_cents END), 0) AS pending,
      COALESCE(SUM(CASE WHEN status = 'approved' THEN amount_cents END), 0) AS approved
    FROM commissions WHERE affiliate_id = ?`).get(userId);
  const w = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'pending' THEN amount_cents END), 0) AS requested,
      COALESCE(SUM(CASE WHEN status = 'paid'    THEN amount_cents END), 0) AS paid
    FROM withdrawals WHERE user_id = ?`).get(userId);
  const available = c.approved - w.requested - w.paid;
  return {
    pending: c.pending,              // waiting for orders to be delivered
    earned: c.approved,              // lifetime approved earnings
    lifetime: c.pending + c.approved,
    requested: w.requested,          // withdrawal requests waiting for payout
    withdrawn: w.paid,               // already paid out in USDC
    available: Math.max(0, available),
  };
}

function stats(userId) {
  const clicks = db.prepare('SELECT COUNT(*) AS n FROM referral_clicks WHERE affiliate_id = ?').get(userId).n;
  const counted = "status IN ('paid', 'shipped', 'delivered')";
  const orders = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE affiliate_id = ? AND ${counted}`).get(userId).n;
  const sales = db.prepare(`SELECT COALESCE(SUM(subtotal_cents), 0) AS s FROM orders WHERE affiliate_id = ? AND ${counted}`).get(userId).s;
  return { clicks, orders, sales, conversion: clicks ? (orders / clicks) * 100 : 0 };
}

module.exports = { NETWORKS, validateWallet, syncCommission, ensureCommission, commissionStatusFor, balances, stats };
