// Fake Stripe + Binance Pay APIs for end-to-end tests (no real money, no network).
// Minimal fake Stripe API for local end-to-end testing (no network access to Stripe here).
const http = require('node:http');
const qs = require('qs');
const Stripe = require('stripe');

const PORT = 4555;
const APP = process.env.APP_URL || 'http://localhost:3123';
const WEBHOOK_SECRET = 'whsec_test_mock';
const signer = Stripe('sk_test_mock');
const sessions = {};
const crypto = require('node:crypto');
const BP_KEY = 'bp_key_mock', BP_SECRET = 'bp_secret_mock';
const bpOrders = {};
let bpSigFailures = 0;
const bpOk = (res, data) => json(res, 200, { status: 'SUCCESS', code: '000000', data, errorMessage: '' });
const refunds = [];
const coupons = {};
let n = 0;

async function sendWebhook(type, object) {
  const payload = JSON.stringify({ id: `evt_${++n}`, object: 'event', type, data: { object } });
  const header = signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const r = await fetch(`${APP}/stripe/webhook`, { method: 'POST', body: payload, headers: { 'content-type': 'application/json', 'stripe-signature': header } });
  console.log('[mock] webhook', type, r.status);
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;
    let params = {};
    if (!p.startsWith('/binancepay/')) params = qs.parse(body);
    if (p.startsWith('/binancepay/')) {
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
    }
    if (req.method === 'POST' && p === '/v1/checkout/sessions') {
      const id = `cs_test_${++n}`;
      let amount = params.line_items.reduce((s, li) => s + Number(li.price_data.unit_amount) * Number(li.quantity), 0);
      for (const d of params.discounts || []) amount -= Number(coupons[d.coupon].amount_off);
      sessions[id] = {
        id, object: 'checkout.session', status: 'open', payment_status: 'unpaid', amount_total: amount,
        currency: params.line_items[0].price_data.currency, metadata: params.metadata, client_reference_id: params.client_reference_id,
        success_url: params.success_url.replace('{CHECKOUT_SESSION_ID}', id), cancel_url: params.cancel_url,
        url: `http://localhost:${PORT}/pay/${id}`, payment_intent: null, line_items: params.line_items,
      };
      console.log('[mock] session', id, amount, params.line_items.map((l) => l.price_data.product_data.name).join(', '));
      return json(res, 200, sessions[id]);
    }
    let m;
    if (req.method === 'GET' && (m = p.match(/^\/v1\/checkout\/sessions\/([^/]+)$/))) {
      return sessions[m[1]] ? json(res, 200, sessions[m[1]]) : json(res, 404, { error: { message: 'No such session' } });
    }
    if (req.method === 'POST' && (m = p.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/))) {
      const s = sessions[m[1]];
      if (!s || s.status !== 'open') return json(res, 400, { error: { type: 'invalid_request_error', message: 'Session is not open' } });
      s.status = 'expired';
      return json(res, 200, s);
    }
    if (req.method === 'POST' && p === '/v1/coupons') {
      const id = `co_${++n}`;
      coupons[id] = { id, object: 'coupon', ...params };
      return json(res, 200, coupons[id]);
    }
    if (req.method === 'POST' && p === '/v1/refunds') {
      refunds.push(params);
      return json(res, 200, { id: `re_${++n}`, object: 'refund', status: 'succeeded', payment_intent: params.payment_intent });
    }
    // Fake hosted payment page: ?silent=1 skips the webhook (to test the return-URL fallback)
    if ((m = p.match(/^\/pay\/([^/]+)$/))) {
      const s = sessions[m[1]];
      if (!url.searchParams.get('go')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<h1>Fake Stripe</h1><p id="amt">${s.amount_total} ${s.currency}</p><a id="pay" href="/pay/${s.id}?go=1">Pay</a> <a id="paysilent" href="/pay/${s.id}?go=1&silent=1">Pay (no webhook)</a> <a id="cancel" href="${s.cancel_url}">Back</a>`);
      }
      if (s.status !== 'open') { res.writeHead(400); return res.end('session not open'); }
      s.status = 'complete'; s.payment_status = 'paid'; s.payment_intent = `pi_test_${++n}`;
      if (!url.searchParams.get('silent')) await sendWebhook('checkout.session.completed', s);
      res.writeHead(303, { location: s.success_url });
      return res.end();
    }
    if (p === '/__expire_all') { // simulate Stripe expiring open sessions
      for (const s of Object.values(sessions)) if (s.status === 'open') { s.status = 'expired'; await sendWebhook('checkout.session.expired', s); }
      return json(res, 200, { ok: true });
    }
    if (p === '/__refunds') return json(res, 200, refunds);
    if ((m = p.match(/^\/bpay\/([^/]+)$/))) {
      const o = bpOrders[m[1]];
      if (!url.searchParams.get('go')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<h1>Fake Binance Pay</h1><p id="amt">${o.orderAmount} ${o.currency}</p><a id="pay" href="/bpay/${m[1]}?go=1">Pay</a> <a id="paysilent" href="/bpay/${m[1]}?go=1&silent=1">Pay (no webhook)</a> <a id="cancel" href="${o.cancelUrl}">Back</a>`);
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
  });
}).listen(PORT, () => console.log('[mock] stripe on', PORT));
