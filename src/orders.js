// Order status changes shared by every payment method: stock, affiliate commission, emails.
const { db, tx } = require('./db');
const { ensureCommission, syncCommission } = require('./affiliate');
const notify = require('./notify');

// Statuses in which the order's items are no longer reserved.
const RELEASED = ['cancelled', 'refunded'];

function restock(orderId, direction) {
  const sql = direction > 0
    ? 'UPDATE product_variants SET stock = stock + ? WHERE id = ?'
    : 'UPDATE product_variants SET stock = MAX(0, stock - ?) WHERE id = ?';
  const st = db.prepare(sql);
  for (const i of db.prepare('SELECT variant_id, qty FROM order_items WHERE order_id = ?').all(orderId)) {
    if (i.variant_id) st.run(i.qty, i.variant_id);
  }
}

/**
 * Moves an order to a new status and keeps stock and the affiliate commission in sync.
 * Must be called inside a transaction.
 */
function applyStatus(order, status) {
  if (status === order.status) return;
  const wasReleased = RELEASED.includes(order.status);
  const isReleased = RELEASED.includes(status);
  if (isReleased && !wasReleased) restock(order.id, +1);
  if (!isReleased && wasReleased) restock(order.id, -1);
  db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, order.id);
  if (['paid', 'shipped', 'delivered'].includes(status)) {
    ensureCommission(order.id);
    if (!order.paid_at) {
      // First time this order counts as paid: record it and use up the discount code.
      db.prepare("UPDATE orders SET paid_at = COALESCE(paid_at, datetime('now')) WHERE id = ?").run(order.id);
      if (order.discount_code) db.prepare('UPDATE discount_codes SET uses = uses + 1 WHERE code = ?').run(order.discount_code);
    }
  }
  syncCommission(order.id, status);
  notify.orderStatus(order.id, status); // queued inside the transaction, sent after it commits
}

// Cancels an unpaid order and returns its items to stock.
function releaseUnpaid(orderId) {
  return tx(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (order && order.status === 'unpaid') { applyStatus(order, 'cancelled'); return true; }
    return false;
  });
}

const getOrder = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);

module.exports = { RELEASED, applyStatus, releaseUnpaid, getOrder };
