/**
 * Binance Pay (merchant API) integration.
 *
 * Trust model: Binance's webhook is only used as a "please re-check" signal. Whether an order is
 * paid is always decided by querying Binance Pay with our own signed API request, so a forged or
 * replayed webhook can never mark an order as paid.
 */
const crypto = require('node:crypto');
const { db, tx } = require('./db');
const { applyStatus, releaseUnpaid } = require('./orders');

const API_BASE = () => (process.env.BINANCE_PAY_API_BASE || 'https://bpay.binanceapi.com').replace(/\/$/, '');
const enabled = () => Boolean(process.env.BINANCE_PAY_API_KEY && process.env.BINANCE_PAY_SECRET_KEY);
// Crypto the customer pays in when the store currency is USD (charged 1:1).
const payCurrency = () => (process.env.BINANCE_PAY_CURRENCY || 'USDT').toUpperCase();

function nonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.randomBytes(32), (b) => chars[b % chars.length]).join('');
}

// Signed request: HMAC-SHA512 over "timestamp\nnonce\nbody\n", hex, upper case.
async function call(path, payload) {
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const n = nonce();
  const signature = crypto.createHmac('sha512', process.env.BINANCE_PAY_SECRET_KEY)
    .update(`${timestamp}\n${n}\n${body}\n`).digest('hex').toUpperCase();
  const res = await fetch(`${API_BASE()}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'BinancePay-Timestamp': timestamp,
      'BinancePay-Nonce': n,
      'BinancePay-Certificate-SN': process.env.BINANCE_PAY_API_KEY,
      'BinancePay-Signature': signature,
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  let json;
  try { json = await res.json(); } catch { throw new Error(`Binance Pay returned HTTP ${res.status}`); }
  if (json.status !== 'SUCCESS') {
    throw new Error(`Binance Pay error ${json.code || res.status}: ${json.errorMessage || 'request failed'}`);
  }
  return json.data;
}

const toCents = (v) => Math.round(parseFloat(v) * 100);
const amount = (cents) => (cents / 100).toFixed(2);

async function createOrder({ order, items, baseUrl }) {
  const tradeNo = `OTF${order.id}N${crypto.randomBytes(6).toString('hex').toUpperCase()}`; // letters/digits only, <= 32
  const summary = items.map((i) => `${i.qty}x ${i.product_name} (${[i.color, i.size].filter(Boolean).join(' ')})`).join(', ').slice(0, 256);
  const usd = order.currency === 'usd';
  const data = await call('/binancepay/openapi/v3/order', {
    env: { terminalType: 'WEB' },
    merchantTradeNo: tradeNo,
    // USD stores charge the exact amount in a stablecoin; other currencies let Binance convert at market rate.
    ...(usd
      ? { orderAmount: amount(order.total_cents), currency: payCurrency() }
      : { fiatAmount: amount(order.total_cents), fiatCurrency: order.currency.toUpperCase() }),
    description: `Outouf order #${order.id}`,
    goodsDetails: [{
      goodsType: '01', // tangible goods
      goodsCategory: 'Z000',
      referenceGoodsId: String(order.id),
      goodsName: `Outouf order #${order.id}`,
      goodsDetail: summary,
    }],
    returnUrl: `${baseUrl}/order/${order.id}?bp=1`, // Binance allows a single query parameter
    cancelUrl: `${baseUrl}/checkout/cancelled/${order.id}`,
    orderExpireTime: Date.now() + 60 * 60 * 1000,
    webhookUrl: `${baseUrl}/binance/webhook`,
  });
  if (!data || !data.checkoutUrl) throw new Error('Binance Pay did not return a checkout URL');
  db.prepare('UPDATE orders SET binance_trade_no = ?, binance_prepay_id = ? WHERE id = ?').run(tradeNo, data.prepayId || null, order.id);
  return data.checkoutUrl;
}

const queryOrder = (tradeNo) => call('/binancepay/openapi/v2/order/query', { merchantTradeNo: tradeNo });

async function closeOrder(tradeNo) {
  try { await call('/binancepay/openapi/order/close', { merchantTradeNo: tradeNo }); return true; } catch { return false; }
}

/**
 * Asks Binance Pay for the order's real status and applies it.
 * Returns the fresh order row.
 */
async function sync(order) {
  if (!enabled() || order.payment_method !== 'binance' || !order.binance_trade_no) return order;
  if (order.status !== 'unpaid' && order.status !== 'cancelled') return order;
  let info;
  try {
    info = await queryOrder(order.binance_trade_no);
  } catch (err) {
    console.error(`[binance] Could not query order #${order.id}:`, err.message);
    return order;
  }
  const status = String(info.status || '').toUpperCase();
  if (status === 'PAID') {
    // For USD stores the exact stablecoin amount is known, so check it.
    if (order.currency === 'usd' && (toCents(info.orderAmount) !== order.total_cents || String(info.currency).toUpperCase() !== payCurrency())) {
      console.error(`[binance] Amount mismatch for order #${order.id}: got ${info.orderAmount} ${info.currency}`);
      return order;
    }
    tx(() => {
      const fresh = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
      db.prepare("UPDATE orders SET binance_transaction_id = COALESCE(?, binance_transaction_id), paid_at = COALESCE(paid_at, datetime('now')) WHERE id = ?")
        .run(info.transactionId ? String(info.transactionId) : null, order.id);
      if (fresh.status === 'unpaid' || fresh.status === 'cancelled') applyStatus(fresh, 'paid');
    });
  } else if (['CANCELED', 'CANCELLED', 'EXPIRED', 'ERROR'].includes(status)) {
    releaseUnpaid(order.id);
  }
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
}

// Webhook: pull merchantTradeNo out of the notification, then re-check that order with Binance.
async function handleWebhook(rawBody) {
  let tradeNo = null;
  try {
    const event = JSON.parse(rawBody.toString('utf8'));
    const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    tradeNo = data && data.merchantTradeNo;
  } catch { /* ignore malformed bodies */ }
  if (typeof tradeNo !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(tradeNo)) return false;
  const order = db.prepare("SELECT * FROM orders WHERE binance_trade_no = ? AND payment_method = 'binance'").get(tradeNo);
  if (order) await sync(order);
  return true;
}

// Cancels the customer's open Binance order (when they come back or start a new checkout).
async function cancelOpen(order) {
  if (order.binance_trade_no) {
    const fresh = await sync(order);
    if (fresh.status !== 'unpaid') return; // paid in the meantime, or already released
    if (!(await closeOrder(order.binance_trade_no))) {
      // Binance refused to close it (e.g. money arrived but did not match the order).
      // Keep the order and its stock held so an admin can review it rather than silently cancelling.
      console.warn(`[binance] Order #${order.id} could not be closed on Binance; left awaiting payment for review.`);
      return;
    }
  }
  releaseUnpaid(order.id);
}

// Safety net: check unpaid Binance orders once their payment page has expired.
async function sweepStale() {
  if (!enabled()) return;
  const stale = db.prepare(`SELECT * FROM orders WHERE status = 'unpaid' AND payment_method = 'binance'
                            AND created_at < datetime('now', '-70 minutes') LIMIT 50`).all();
  for (const o of stale) {
    const fresh = await sync(o);
    if (fresh.status === 'unpaid' && !o.binance_trade_no) releaseUnpaid(o.id);
    else if (fresh.status === 'unpaid' && fresh.created_at < new Date(Date.now() - 3 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)) {
      // Binance still reports it open long after expiry: close it and free the stock.
      await cancelOpen(fresh);
    }
  }
}

module.exports = { enabled, payCurrency, createOrder, sync, handleWebhook, cancelOpen, sweepStale, call };
