// Fake PayPal + Binance Pay APIs for end-to-end tests (no real money, no network).
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = 4555;
const APP = process.env.APP_URL || 'http://localhost:3123';
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); };
let n = 0;

/* ---------------- PayPal ---------------- */
const PP_CLIENT = 'pp_client_mock', PP_SECRET = 'pp_secret_mock';
const ppTokens = new Set();
const ppOrders = {};          // id -> order
const ppIdempotent = {};      // PayPal-Request-Id -> response body
const ppRefunds = [];
const ppStats = { creates: 0, captures: 0, authFailures: 0 };
const cents = (v) => Math.round(parseFloat(v) * 100);
const ppError = (res, status, issue) => json(res, status, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue }], message: issue });

function ppView(o) {
  const unit = { ...o.unit, payments: o.capture ? { captures: [o.capture] } : undefined };
  return { id: o.id, intent: 'CAPTURE', status: o.status, purchase_units: [unit], links: o.links };
}
async function ppWebhook(event_type, resource) {
  const r = await fetch(`${APP}/paypal/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `WH-${++n}`, event_type, resource }) });
  console.log('[mock] paypal webhook', event_type, r.status);
}
const captureResource = (o) => ({ ...o.capture, custom_id: o.unit.custom_id, supplementary_data: { related_ids: { order_id: o.id } } });

async function paypal(req, res, p, body, url) {
  if (p === '/v1/oauth2/token') {
    const expected = `Basic ${Buffer.from(`${PP_CLIENT}:${PP_SECRET}`).toString('base64')}`;
    if (req.headers.authorization !== expected || body !== 'grant_type=client_credentials') return json(res, 401, { error: 'invalid_client' });
    const t = `A21AA${crypto.randomBytes(8).toString('hex')}`;
    ppTokens.add(t);
    return json(res, 200, { access_token: t, token_type: 'Bearer', expires_in: 32400 });
  }
  const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!ppTokens.has(auth)) { ppStats.authFailures++; return json(res, 401, { error: 'invalid_token' }); }
  const rid = req.headers['paypal-request-id'];
  if (rid && ppIdempotent[rid]) return json(res, 201, ppIdempotent[rid]); // same request twice: same answer
  const remember = (code, out) => { if (rid) ppIdempotent[rid] = out; return json(res, code, out); };
  let m;

  if (req.method === 'POST' && p === '/v2/checkout/orders') {
    const b = JSON.parse(body);
    const unit = b.purchase_units && b.purchase_units[0];
    const ctx = b.payment_source && b.payment_source.paypal && b.payment_source.paypal.experience_context;
    if (b.intent !== 'CAPTURE' || !unit || !ctx || !ctx.return_url || !ctx.cancel_url) return ppError(res, 400, 'MALFORMED_REQUEST_JSON');
    // Same consistency checks as PayPal: items add up to item_total, breakdown adds up to the amount.
    const bd = unit.amount.breakdown || {};
    const itemSum = (unit.items || []).reduce((s, i) => s + cents(i.unit_amount.value) * Number(i.quantity), 0);
    if (itemSum !== cents(bd.item_total.value)) return ppError(res, 422, 'ITEM_TOTAL_MISMATCH');
    const expected = cents(bd.item_total.value) + (bd.shipping ? cents(bd.shipping.value) : 0) - (bd.discount ? cents(bd.discount.value) : 0);
    if (expected !== cents(unit.amount.value)) return ppError(res, 422, 'AMOUNT_MISMATCH');
    if (Object.values(ppOrders).some((o) => o.unit.invoice_id === unit.invoice_id)) return ppError(res, 422, 'DUPLICATE_INVOICE_ID');
    const id = `5O${String(++n).padStart(6, '0')}X${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    ppStats.creates++;
    ppOrders[id] = { id, status: 'PAYER_ACTION_REQUIRED', unit, ctx,
      links: [{ href: `http://localhost:${PORT}/v2/checkout/orders/${id}`, rel: 'self', method: 'GET' },
        { href: `http://localhost:${PORT}/ppapprove/${id}`, rel: 'payer-action', method: 'GET' }] };
    console.log('[mock] paypal order', id, unit.amount.value, unit.amount.currency_code);
    return remember(200, ppView(ppOrders[id]));
  }
  if (req.method === 'GET' && (m = p.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)$/))) {
    return ppOrders[m[1]] ? json(res, 200, ppView(ppOrders[m[1]])) : ppError(res, 404, 'RESOURCE_NOT_FOUND');
  }
  if (req.method === 'POST' && (m = p.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/))) {
    const o = ppOrders[m[1]];
    if (!o) return ppError(res, 404, 'RESOURCE_NOT_FOUND');
    if (o.status === 'COMPLETED') return ppError(res, 422, 'ORDER_ALREADY_CAPTURED');
    if (o.status !== 'APPROVED') return ppError(res, 422, 'ORDER_NOT_APPROVED');
    if (o.decline) return ppError(res, 422, 'INSTRUMENT_DECLINED');
    ppStats.captures++;
    o.status = 'COMPLETED';
    o.capture = { id: `CAP${++n}`, status: o.pending ? 'PENDING' : 'COMPLETED',
      amount: o.underpay ? { currency_code: o.unit.amount.currency_code, value: '1.00' } : { currency_code: o.unit.amount.currency_code, value: o.unit.amount.value } };
    return remember(201, ppView(o));
  }
  if (req.method === 'POST' && (m = p.match(/^\/v2\/payments\/captures\/([A-Z0-9]+)\/refund$/))) {
    const o = Object.values(ppOrders).find((x) => x.capture && x.capture.id === m[1]);
    if (!o) return ppError(res, 404, 'RESOURCE_NOT_FOUND');
    if (o.capture.status === 'REFUNDED') return ppError(res, 422, 'CAPTURE_FULLY_REFUNDED');
    o.capture.status = 'REFUNDED';
    ppRefunds.push(m[1]);
    return remember(201, { id: `RF${++n}`, status: 'COMPLETED' });
  }
  return json(res, 404, { message: `mock: unhandled ${req.method} ${p}` });
}

/* ---------------- Binance Pay ---------------- */
const BP_KEY = 'bp_key_mock', BP_SECRET = 'bp_secret_mock';
const bpOrders = {};
let bpSigFailures = 0;
const bpOk = (res, data) => json(res, 200, { status: 'SUCCESS', code: '000000', data, errorMessage: '' });

function binance(req, res, p, body) {
  const h = req.headers;
  const expect = crypto.createHmac('sha512', BP_SECRET).update(`${h['binancepay-timestamp']}\n${h['binancepay-nonce']}\n${body}\n`).digest('hex').toUpperCase();
  const fresh = Math.abs(Date.now() - Number(h['binancepay-timestamp'])) < 5000;
  if (h['binancepay-certificate-sn'] !== BP_KEY || h['binancepay-signature'] !== expect || !fresh || (h['binancepay-nonce'] || '').length !== 32) {
    bpSigFailures++;
    return json(res, 200, { status: 'FAIL', code: '400002', errorMessage: 'Signature for this request is not valid.' });
  }
  const b = JSON.parse(body);
  if (p === '/binancepay/openapi/v3/order') {
    if (!/^[A-Za-z0-9]{1,32}$/.test(b.merchantTradeNo) || !b.env || !b.goodsDetails || !b.description) return json(res, 200, { status: 'FAIL', code: '400001', errorMessage: 'bad params' });
    if ((b.returnUrl.split('?')[1] || '').split('&').length > 1) return json(res, 200, { status: 'FAIL', code: '400001', errorMessage: 'returnUrl: one query param only' });
    bpOrders[b.merchantTradeNo] = { ...b, status: 'INITIAL' };
    console.log('[mock] binance order', b.merchantTradeNo, b.orderAmount, b.currency);
    return bpOk(res, { prepayId: `pp${++n}`, terminalType: 'WEB', expireTime: b.orderExpireTime, checkoutUrl: `http://localhost:${PORT}/bpay/${b.merchantTradeNo}` });
  }
  if (p === '/binancepay/openapi/v2/order/query') {
    const o = bpOrders[b.merchantTradeNo];
    if (!o) return json(res, 200, { status: 'FAIL', code: '400202', errorMessage: 'Order not found.' });
    return bpOk(res, { merchantTradeNo: b.merchantTradeNo, status: o.status, orderAmount: o.paidAmount || o.orderAmount, currency: o.currency, transactionId: o.txId || null });
  }
  if (p === '/binancepay/openapi/order/close') {
    const o = bpOrders[b.merchantTradeNo];
    if (!o || o.status !== 'INITIAL') return json(res, 200, { status: 'FAIL', code: '400203', errorMessage: 'Order status not support close.' });
    o.status = 'CANCELED';
    return bpOk(res, true);
  }
  return json(res, 404, {});
}

/* ---------------- server ---------------- */
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const p = url.pathname;
      let m;
      if (p.startsWith('/binancepay/')) return binance(req, res, p, body);
      if (p.startsWith('/v1/') || p.startsWith('/v2/')) return await paypal(req, res, p, body, url);

      // Fake PayPal approval page. Links simulate what the buyer can do there.
      if ((m = p.match(/^\/ppapprove\/([A-Z0-9]+)$/))) {
        const o = ppOrders[m[1]];
        const a = url.searchParams.get('a');
        if (!a) {
          return html(res, `<h1>Fake PayPal</h1><p id="amt">${o.unit.amount.value} ${o.unit.amount.currency_code}</p><p id="desc">${o.unit.description}</p>
            <a id="pay" href="?a=pay">Pay Now</a> <a id="decline" href="?a=decline">Pay (card declined)</a>
            <a id="pending" href="?a=pending">Pay (held for review)</a> <a id="underpay" href="?a=underpay">Pay (wrong amount)</a>
            <a id="closetab" href="?a=closetab">Approve then close tab</a> <a id="cancel" href="?a=cancel">Cancel and return</a>`);
        }
        const back = (target) => { res.writeHead(303, { location: `${target}${target.includes('?') ? '&' : '?'}token=${o.id}&PayerID=PAYER123` }); res.end(); };
        if (a === 'cancel') return back(o.ctx.cancel_url);
        o.status = 'APPROVED';
        if (a === 'decline') o.decline = true;
        if (a === 'pending') o.pending = true;
        if (a === 'underpay') o.underpay = true;
        if (a === 'closetab') { await ppWebhook('CHECKOUT.ORDER.APPROVED', { id: o.id, status: 'APPROVED' }); return html(res, '<p id="closed">Tab closed</p>'); }
        return back(o.ctx.return_url);
      }
      // Test helpers that simulate PayPal-side events
      if ((m = p.match(/^\/__pp\/approve\/([A-Z0-9]+)$/))) { ppOrders[m[1]].status = 'APPROVED'; return json(res, 200, { ok: true }); }
      if ((m = p.match(/^\/__pp\/complete\/([A-Z0-9]+)$/))) {
        const o = ppOrders[m[1]]; o.capture.status = 'COMPLETED';
        await ppWebhook('PAYMENT.CAPTURE.COMPLETED', captureResource(o)); return json(res, 200, { ok: true });
      }
      if ((m = p.match(/^\/__pp\/refund-in-dashboard\/([A-Z0-9]+)$/))) {
        const o = ppOrders[m[1]]; o.capture.status = 'REFUNDED';
        await ppWebhook('PAYMENT.CAPTURE.REFUNDED', { id: `RF${++n}`, status: 'COMPLETED', supplementary_data: { related_ids: { order_id: o.id, capture_id: o.capture.id } } });
        return json(res, 200, { ok: true });
      }
      if (p === '/__pp') return json(res, 200, { orders: Object.fromEntries(Object.entries(ppOrders).map(([k, o]) => [k, { status: o.status, capture: o.capture, unit: o.unit }])), refunds: ppRefunds, stats: ppStats });

      // Fake Binance Pay checkout page
      if ((m = p.match(/^\/bpay\/([^/]+)$/))) {
        const o = bpOrders[m[1]];
        if (!url.searchParams.get('go')) {
          return html(res, `<h1>Fake Binance Pay</h1><p id="amt">${o.orderAmount} ${o.currency}</p><a id="pay" href="/bpay/${m[1]}?go=1">Pay</a> <a id="paysilent" href="/bpay/${m[1]}?go=1&silent=1">Pay (no webhook)</a> <a id="cancel" href="${o.cancelUrl}">Back</a>`);
        }
        o.status = 'PAID'; o.txId = `tx${++n}`;
        if (url.searchParams.get('underpay')) o.paidAmount = '1.00';
        if (!url.searchParams.get('silent')) {
          const r = await fetch(o.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bizType: 'PAY', bizId: n, bizIdStr: String(n), bizStatus: 'PAY_SUCCESS', data: JSON.stringify({ merchantTradeNo: m[1], totalFee: o.orderAmount, currency: o.currency }) }) });
          console.log('[mock] binance webhook', r.status, await r.text());
        }
        res.writeHead(303, { location: o.returnUrl });
        return res.end();
      }
      if (p === '/__bp') return json(res, 200, { bpOrders, bpSigFailures });
      json(res, 404, { error: { message: `mock: unhandled ${req.method} ${p}` } });
    } catch (err) {
      console.error('[mock] error', err);
      json(res, 500, { message: String(err) });
    }
  });
}).listen(PORT, () => console.log('[mock] payments on', PORT));
