const { chromium, devices } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const B = process.env.APP_URL || 'http://localhost:3123';
const MOCK = process.env.MOCK_URL || 'http://localhost:4555';
const SHOTS = process.env.SHOTS_DIR; // set to save screenshots
const db = new DatabaseSync(process.env.TEST_DB);
const q = (sql, ...a) => db.prepare(sql).get(...a);
let failures = 0;
const check = (label, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${label} ${extra}`); if (!cond) failures++; };

(async () => {
  const browser = await chromium.launch();
  const phone = devices['iPhone 13'];
  const shot = (p, n) => (SHOTS ? p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }) : null);
  const stockOf = (size) => q("SELECT v.stock FROM product_variants v JOIN products p ON p.id=v.product_id WHERE p.slug='classic-cotton-tee' AND v.size=?", size).stock;
  const lastOrder = () => q('SELECT * FROM orders ORDER BY id DESC');

  const a = await (await browser.newContext({ ...phone })).newPage();
  await a.goto(B + '/register');
  await a.fill('[name=name]', 'Sara Affiliate'); await a.fill('[name=email]', 'sara@test.com'); await a.fill('[name=password]', 'password123');
  await a.click('form button[type=submit]');
  await a.goto(B + '/account/affiliate');
  const link = await a.inputValue('#reflink');

  const v = await (await browser.newContext({ ...phone })).newPage();
  await v.goto(link);
  check('footer mentions both methods', (await v.textContent('.footer')).includes('Pay by card or Binance Pay'));
  const stockM0 = stockOf('M');
  await v.goto(B + '/p/classic-cotton-tee');
  await v.click('label.size:has-text("M")'); await v.fill('#qty', '2');
  await v.click('button:has-text("Add to cart")');

  const checkout = async (method) => {
    await v.goto(B + '/checkout');
    await v.fill('[name=email]', 'buyer@x.com'); await v.fill('[name=phone]', '+971 50 000 0000');
    await v.fill('[name=name]', 'Omar Buyer'); await v.selectOption('[name=country]', 'AE');
    await v.fill('[name=address]', '5 Marina Walk'); await v.fill('[name=city]', 'Dubai');
    await v.check(`input[name=payment_method][value=${method}]`);
  };
  await checkout('binance');
  check('both payment options shown', (await v.$$('.pay-option')).length === 2);
  await shot(v, '30-checkout-methods');
  await v.click('form.form button[type=submit]');
  check('redirected to Binance Pay page', v.url().startsWith(MOCK + '/bpay/'), v.url());
  check('charged 38.00 USDT', (await v.textContent('#amt')) === '38.00 USDT');
  check('stock reserved', stockOf('M') === stockM0 - 2);
  const o1 = lastOrder();
  check('order stored as binance with trade no', o1.payment_method === 'binance' && /^OTF\d+N[0-9A-F]{12}$/.test(o1.binance_trade_no), o1.binance_trade_no);

  // Cancel
  await v.click('#cancel');
  check('cancel returns to cart with items', v.url() === B + '/cart' && (await v.$$('.cart-item')).length === 1);
  check('stock restored', stockOf('M') === stockM0);
  const bp1 = (await (await fetch(MOCK + '/__bp')).json()).bpOrders[o1.binance_trade_no];
  check('Binance order closed', bp1.status === 'CANCELED');

  // Forged webhook must not mark anything paid
  await checkout('binance'); await v.click('form.form button[type=submit]');
  const o2 = lastOrder();
  const forged = await fetch(B + '/binance/webhook', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bizType: 'PAY', bizStatus: 'PAY_SUCCESS', data: JSON.stringify({ merchantTradeNo: o2.binance_trade_no }) }) });
  check('forged webhook answered politely', forged.status === 200);
  check('forged webhook did NOT mark order paid', q('SELECT status FROM orders WHERE id=?', o2.id).status === 'unpaid');

  // Pay without webhook -> confirmed on return (?bp=1)
  await v.click('#paysilent');
  await v.waitForURL(/\/order\/\d+/);
  check('return URL has a single query param', new URL(v.url()).search === '?bp=1');
  const p2 = q('SELECT * FROM orders WHERE id=?', o2.id);
  check('paid via return-URL check', p2.status === 'paid' && p2.binance_transaction_id && p2.paid_at, p2.status);
  check('success headline', (await v.textContent('h1')).includes("It's yours"));
  await shot(v, '31-binance-paid');
  check('stock taken once', stockOf('M') === stockM0 - 2);
  check('commission 10% created', q('SELECT amount_cents FROM commissions WHERE order_id=?', o2.id)?.amount_cents === 380);

  // Pay with webhook
  await v.goto(B + '/p/linen-midi-dress'); await v.click('button:has-text("Buy now")');
  await checkout('binance'); await v.click('form.form button[type=submit]');
  const o3 = lastOrder();
  await v.click('#pay');
  await v.waitForURL(/\/order\/\d+/);
  check('webhook-confirmed order paid', q('SELECT status FROM orders WHERE id=?', o3.id).status === 'paid');

  // Underpayment is refused
  await v.goto(B + '/p/linen-midi-dress'); await v.click('button:has-text("Buy now")');
  await checkout('binance'); await v.click('form.form button[type=submit]');
  const o4 = lastOrder();
  await v.goto(v.url() + '?go=1&underpay=1&silent=1');
  check('wrong amount NOT accepted as paid', q('SELECT status FROM orders WHERE id=?', o4.id).status === 'unpaid');

  // Card still works
  await v.goto(B + '/p/classic-cotton-tee'); await v.click('label.size:has-text("L")'); await v.click('button:has-text("Buy now")');
  await checkout('stripe'); await v.click('form.form button[type=submit]');
  check('card option still goes to Stripe', v.url().startsWith(MOCK + '/pay/'));
  const o5 = lastOrder();
  check('mismatched Binance payment kept for review, not cancelled', q('SELECT status FROM orders WHERE id=?', o4.id).status === 'unpaid');
  await v.click('#pay'); await v.waitForURL(/\/order\/\d+/);
  check('card order paid', q('SELECT status, payment_method FROM orders WHERE id=?', o5.id).status === 'paid');

  // Admin refunds a Binance order by hand
  const m = await (await browser.newContext({ ...phone })).newPage();
  await m.goto(B + '/login');
  await m.fill('[name=email]', 'admin@store.local'); await m.fill('[name=password]', 'admin12345');
  await m.click('form button[type=submit]');
  await m.goto(B + '/admin/orders/' + o3.id);
  check('admin shows Binance Pay', (await m.textContent('main')).includes('Binance Pay'));
  check('no Stripe refund button on Binance order', !(await m.$('button:has-text("via Stripe")')));
  await m.click('label.size:has-text("refunded")');
  await m.click('form.form button[type=submit]');
  check('Binance order marked refunded', q('SELECT status FROM orders WHERE id=?', o3.id).status === 'refunded');
  check('commission cancelled', q('SELECT status FROM commissions WHERE order_id=?', o3.id).status === 'cancelled');
  await m.goto(B + '/admin/orders/' + o2.id);
  await shot(m, '32-admin-binance-order');
  await m.goto(B + '/admin/settings');
  check('settings shows Binance connected', (await m.textContent('main')).includes('Binance Pay API key'));

  const bp = await (await fetch(MOCK + '/__bp')).json();
  check('every Binance request was correctly signed', bp.bpSigFailures === 0, `failures=${bp.bpSigFailures}`);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
