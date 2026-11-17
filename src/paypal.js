/**
 * PayPal Checkout (REST API, Orders v2).
 *
 * Flow: we create a PayPal order and send the customer to PayPal. They pay with their PayPal
 * account (or a card, where PayPal offers guest checkout). PayPal sends them back to
 * /order/:id?pp=1, where we capture the payment.
 *
 * Trust model: what PayPal's webhook or the return URL says is never trusted directly. The order is
 * always re-read from PayPal's API with our own credentials, and the captured amount and currency
 * must match before an order is marked paid.
 */
const crypto = require('node:crypto');
const { db, tx, getSettings } = require('./db');
const { applyStatus, releaseUnpaid, getOrder } = require('./orders');

const enabled = () => Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
const live = () => process.env.PAYPAL_ENV === 'live';
const API = () => (process.env.PAYPAL_API_BASE || (live() ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com')).replace(/\/$/, '');

// PayPal works in whole currency units with 2 decimals for the currencies this store offers.
const SUPPORTED_CURRENCIES = ['usd', 'eur', 'gbp', 'cad', 'aud', 'chf'];

/* ---------- API client ---------- */

let token = null; // { value, expires }
async function accessToken(force = false) {
  if (!force && token && token.expires > Date.now() + 60000) return token.value;
  const res = await fetch(`${API()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`PayPal login failed (${res.status}): ${json.error_description || json.error || 'check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET'}`);
  token = { value: json.access_token, expires: Date.now() + (Number(json.expires_in) || 300) * 1000 };
  return token.value;
}

async function call(method, path, body, requestId, retried = false) {
  const res = await fetch(`${API()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken(retried)}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'return=representation',
      ...(requestId ? { 'PayPal-Request-Id': requestId } : {}), // makes retries safe: PayPal won't do it twice
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401 && !retried) return call(method, path, body, requestId, true); // token expired
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const issue = json.details && json.details[0] && json.details[0].issue;
    const err = new Error(`PayPal ${res.status}: ${issue || json.name || 'error'}${json.message ? ` (${json.message})` : ''}`);
    err.issue = issue;
    err.status = res.status;
    throw err;
  }
  return json;
}

/* ---------- checkout ---------- */

const amount = (cents, currency) => ({ currency_code: currency, value: (cents / 100).toFixed(2) });

async function createOrder({ order, items, baseUrl }) {
  const cur = order.currency.toUpperCase();
  const store = getSettings().store_name;
  const ppItems = items.map((i) => ({
    name: `${i.product_name} (${[i.color, /size/i.test(i.size) ? i.size : `Size ${i.size}`].filter(Boolean).join(', ')})`.slice(0, 127),
    quantity: String(i.qty),
    unit_amount: amount(i.price_cents, cur),
    category: 'PHYSICAL_GOODS',
  }));
  const breakdown = { item_total: amount(order.subtotal_cents, cur) };
  if (order.shipping_cents > 0) breakdown.shipping = amount(order.shipping_cents, cur);
  if (order.discount_cents > 0) breakdown.discount = amount(order.discount_cents, cur);

  const pp = await call('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      custom_id: String(order.id),
      invoice_id: `OUTOUF-${order.id}-${crypto.randomBytes(3).toString('hex')}`, // must be unique per PayPal account
      description: `${store} order #${order.id}`.slice(0, 127),
      amount: { ...amount(order.total_cents, cur), breakdown },
      items: ppItems,
    }],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: store.slice(0, 127),
          user_action: 'PAY_NOW', // the PayPal button says "Pay Now" and the payment completes on return
          shipping_preference: 'NO_SHIPPING', // we already collected the delivery address
          return_url: `${baseUrl}/order/${order.id}?pp=1`,
          cancel_url: `${baseUrl}/checkout/cancelled/${order.id}`,
        },
      },
    },
  }, `outouf-${order.id}-create`);

  const link = (pp.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  if (!pp.id || !link) throw new Error('PayPal did not return an approval link');
  db.prepare('UPDATE orders SET paypal_order_id = ? WHERE id = ?').run(pp.id, order.id);
  return link.href;
}

const firstCapture = (pp) => {
  const unit = (pp.purchase_units || [])[0] || {};
  return ((unit.payments || {}).captures || [])[0] || null;
};

// Applies what PayPal reports to our order. Safe to call repeatedly.
function applyPaypalState(orderId, pp) {
  return tx(() => {
    const order = getOrder(orderId);
    if (!order || order.payment_method !== 'paypal' || order.paypal_order_id !== pp.id) return order;
    const unit = (pp.purchase_units || [])[0] || {};
    const capture = firstCapture(pp);
    if (!capture) {
      if (pp.status === 'VOIDED') releaseUnpaid(order.id);
      return getOrder(order.id);
    }
    if (unit.custom_id && unit.custom_id !== String(order.id)) {
      console.error(`[paypal] PayPal order ${pp.id} belongs to order ${unit.custom_id}, not #${order.id}`);
      return order;
    }
    if (capture.status === 'COMPLETED') {
      const paid = capture.amount || {};
      if (Math.round(parseFloat(paid.value) * 100) !== order.total_cents || String(paid.currency_code).toLowerCase() !== order.currency) {
        console.error(`[paypal] Amount mismatch for order #${order.id}: got ${paid.value} ${paid.currency_code}`);
        return order;
      }
      db.prepare('UPDATE orders SET paypal_capture_id = ? WHERE id = ?').run(capture.id, order.id);
      if (order.status === 'unpaid' || order.status === 'cancelled') applyStatus(order, 'paid');
    } else if (capture.status === 'REFUNDED') {
      if (order.paid_at && order.status !== 'refunded') applyStatus(order, 'refunded');
    } else if (capture.status === 'DECLINED' || capture.status === 'FAILED') {
      releaseUnpaid(order.id);
    } else if (capture.status === 'PENDING') {
      // PayPal is still reviewing the payment: remember the capture so the order keeps its stock
      // until a webhook or the periodic check sees it complete.
      db.prepare('UPDATE orders SET paypal_capture_id = ? WHERE id = ?').run(capture.id, order.id);
    }
    return getOrder(order.id);
  });
}

/**
 * Brings our order in line with PayPal. Captures the payment if the customer approved it and the
 * order is still waiting. An order we already cancelled is never captured, so a late approval
 * can't charge someone for items that went back on sale.
 */
async function sync(order) {
  if (!enabled() || !order || order.payment_method !== 'paypal' || !order.paypal_order_id) return order;
  try {
    let pp = await call('GET', `/v2/checkout/orders/${encodeURIComponent(order.paypal_order_id)}`);
    if (pp.status === 'APPROVED' && order.status === 'unpaid') {
      try {
        pp = await call('POST', `/v2/checkout/orders/${encodeURIComponent(order.paypal_order_id)}/capture`, {}, `outouf-${order.id}-capture`);
      } catch (err) {
        if (err.issue !== 'ORDER_ALREADY_CAPTURED') throw err;
        pp = await call('GET', `/v2/checkout/orders/${encodeURIComponent(order.paypal_order_id)}`);
      }
    }
    return applyPaypalState(order.id, pp) || order;
  } catch (err) {
    console.error(`[paypal] Could not check order #${order.id}:`, err.message);
    // PayPal refused the funding source at capture: nothing was charged, so release the order
    // (the customer's cart is kept and they can try again).
    if (err.issue === 'INSTRUMENT_DECLINED') releaseUnpaid(order.id);
    return getOrder(order.id) || order;
  }
}

// Webhook: only tells us which order to re-check. Nothing in the body is trusted.
async function handleWebhook(rawBody) {
  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch { return false; }
  const r = event && event.resource;
  if (!r) return false;
  const related = r.supplementary_data && r.supplementary_data.related_ids;
  const ppOrderId = /^CHECKOUT\.ORDER/.test(event.event_type || '') ? r.id : related && related.order_id;
  let order = null;
  if (typeof ppOrderId === 'string' && /^[A-Z0-9]{5,40}$/.test(ppOrderId)) {
    order = db.prepare("SELECT * FROM orders WHERE paypal_order_id = ? AND payment_method = 'paypal'").get(ppOrderId);
  }
  if (!order && typeof r.custom_id === 'string' && /^\d+$/.test(r.custom_id)) {
    order = db.prepare("SELECT * FROM orders WHERE id = ? AND payment_method = 'paypal'").get(Number(r.custom_id));
  }
  if (order) await sync(order);
  return true;
}

async function refundOrder(order) {
  if (!order.paypal_capture_id) throw new Error('No PayPal payment recorded for this order');
  await call('POST', `/v2/payments/captures/${encodeURIComponent(order.paypal_capture_id)}/refund`, {}, `outouf-${order.id}-refund`);
  tx(() => applyStatus(getOrder(order.id), 'refunded'));
}

// Customer went back from PayPal, or started a new checkout: release the old reservation.
async function cancelOpen(order) {
  const fresh = await sync(order); // in case they actually approved and paid
  if (fresh.status === 'unpaid') releaseUnpaid(order.id);
}

// Safety net: re-check unpaid PayPal orders; release those whose checkout was never completed.
async function sweepStale() {
  if (!enabled()) return;
  const stale = db.prepare(`SELECT * FROM orders WHERE status = 'unpaid' AND payment_method = 'paypal'
                            AND created_at < datetime('now', '-70 minutes') LIMIT 50`).all();
  for (const o of stale) {
    const fresh = await sync(o);
    // Pending captures (PayPal reviewing the payment) keep their stock; anything else still unpaid is released.
    if (fresh.status === 'unpaid' && !fresh.paypal_capture_id) releaseUnpaid(o.id);
  }
}

module.exports = { enabled, live, SUPPORTED_CURRENCIES, createOrder, sync, handleWebhook, refundOrder, cancelOpen, sweepStale, call };
