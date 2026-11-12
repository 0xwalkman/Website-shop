const Stripe = require('stripe');
const { db, tx } = require('./db');
const { ensureCommission, syncCommission } = require('./affiliate');

let client = null;

// Returns a configured Stripe client, or null when STRIPE_SECRET_KEY is not set.
function stripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!client) {
    const opts = { maxNetworkRetries: 2, appInfo: { name: 'outouf-store' } };
    if (process.env.STRIPE_API_BASE) { // only used for local testing against a mock server
      const u = new URL(process.env.STRIPE_API_BASE);
      Object.assign(opts, { host: u.hostname, port: u.port, protocol: u.protocol.replace(':', '') });
    }
    client = new Stripe(key, opts);
  }
  return client;
}

const enabled = () => Boolean(process.env.STRIPE_SECRET_KEY);

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
  if (['paid', 'shipped', 'delivered'].includes(status)) ensureCommission(order.id);
  syncCommission(order.id, status);
}

async function createCheckoutSession({ order, items, baseUrl }) {
  const s = stripe();
  const currency = order.currency;
  const canShowImages = baseUrl.startsWith('https://');
  const line_items = items.map((i) => ({
    quantity: i.qty,
    price_data: {
      currency,
      unit_amount: i.price_cents,
      product_data: {
        name: `${i.product_name} (Size ${i.size})`,
        ...(canShowImages && i.image ? { images: [`${baseUrl}${i.image}`] } : {}),
      },
    },
  }));
  if (order.shipping_cents > 0) {
    line_items.push({ quantity: 1, price_data: { currency, unit_amount: order.shipping_cents, product_data: { name: 'Shipping' } } });
  }
  return s.checkout.sessions.create({
    mode: 'payment',
    line_items,
    customer_email: order.email,
    client_reference_id: String(order.id),
    metadata: { order_id: String(order.id) },
    payment_intent_data: { metadata: { order_id: String(order.id) } },
    success_url: `${baseUrl}/order/${order.id}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/checkout/cancelled/${order.id}`,
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60, // unpaid orders release their stock after 1 hour
  }, { idempotencyKey: `order-${order.id}-checkout` });
}

// Marks the order paid if the Checkout Session really is paid for the right amount. Safe to call repeatedly.
function recordPayment(session) {
  const orderId = parseInt((session.metadata && session.metadata.order_id) || session.client_reference_id, 10);
  if (!orderId || session.payment_status !== 'paid') return null;
  return tx(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return null;
    if (order.stripe_session_id && order.stripe_session_id !== session.id) return order;
    if (session.amount_total !== order.total_cents || String(session.currency).toLowerCase() !== order.currency) {
      console.error(`[stripe] Amount mismatch for order #${orderId}: got ${session.amount_total} ${session.currency}`);
      return order;
    }
    const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent && session.payment_intent.id;
    db.prepare("UPDATE orders SET stripe_payment_intent = COALESCE(?, stripe_payment_intent), paid_at = COALESCE(paid_at, datetime('now')) WHERE id = ?")
      .run(pi || null, orderId);
    // A session that expired in our database but was paid anyway is re-activated (stock taken again).
    if (order.status === 'unpaid' || order.status === 'cancelled') applyStatus(order, 'paid');
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  });
}

// Cancels an unpaid order and returns its items to stock.
function releaseUnpaid(orderId) {
  return tx(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (order && order.status === 'unpaid') { applyStatus(order, 'cancelled'); return true; }
    return false;
  });
}

async function syncFromSession(order, sessionId) {
  if (!enabled() || order.status !== 'unpaid' || sessionId !== order.stripe_session_id) return order;
  try {
    const session = await stripe().checkout.sessions.retrieve(sessionId);
    return recordPayment(session) || order;
  } catch (err) {
    console.error('[stripe] Could not verify session', err.message);
    return order;
  }
}

async function handleWebhook(rawBody, signature) {
  const event = stripe().webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  const obj = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      recordPayment(obj);
      break;
    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed': {
      const id = parseInt((obj.metadata && obj.metadata.order_id) || obj.client_reference_id, 10);
      if (id) releaseUnpaid(id);
      break;
    }
    case 'charge.refunded': {
      const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent && obj.payment_intent.id;
      if (pi && obj.refunded) {
        tx(() => {
          const order = db.prepare('SELECT * FROM orders WHERE stripe_payment_intent = ?').get(pi);
          if (order && order.status !== 'refunded') applyStatus(order, 'refunded');
        });
      }
      break;
    }
    default:
      break;
  }
  return event.type;
}

async function refundOrder(order) {
  await stripe().refunds.create({ payment_intent: order.stripe_payment_intent }, { idempotencyKey: `order-${order.id}-refund` });
  tx(() => applyStatus(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id), 'refunded'));
}

// Checkout pages expire after 1 hour. Orders still unpaid after that are checked with Stripe:
// paid ones are recorded (in case a webhook was missed), the rest give their stock back.
async function sweepStale() {
  if (!enabled()) return;
  const stale = db.prepare(`SELECT * FROM orders WHERE status = 'unpaid' AND created_at < datetime('now', '-70 minutes') LIMIT 50`).all();
  for (const o of stale) {
    try {
      if (o.stripe_session_id) {
        const session = await stripe().checkout.sessions.retrieve(o.stripe_session_id);
        if (session.payment_status === 'paid') { recordPayment(session); continue; }
        if (session.status === 'open') continue; // still payable; check again later
      }
      releaseUnpaid(o.id);
    } catch (err) {
      console.error(`[stripe] Could not check order #${o.id}:`, err.message);
    }
  }
}

async function expireSession(sessionId) {
  try { await stripe().checkout.sessions.expire(sessionId); return true; } catch { return false; }
}

module.exports = {
  stripe, enabled, applyStatus, createCheckoutSession, recordPayment,
  releaseUnpaid, syncFromSession, handleWebhook, refundOrder, expireSession, sweepStale, RELEASED,
};
