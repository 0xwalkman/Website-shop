// PayPal checkout: pay, cancel, abandon, declined card, payment held for review, wrong amount,
// approve-then-close-tab, forged webhooks, late approval of an expired checkout, refunds.
const { chromium, devices } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const B = process.env.APP_URL || 'http://localhost:3123';
const MOCK = process.env.MOCK_URL || 'http://localhost:4555';
const SHOTS = process.env.SHOTS_DIR;
const db = new DatabaseSync(process.env.TEST_DB);
const q = (sql, ...a) => db.prepare(sql).get(...a);
let failures = 0;
const check = (label, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${label} ${extra}`); if (!cond) failures++; };
const mock = async () => (await fetch(`${MOCK}/__pp`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const phone = devices['iPhone 13'];
  const shot = (p, n) => (SHOTS ? p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }) : null);
  const stockOf = (size) => q("SELECT v.stock FROM product_variants v JOIN products p ON p.id=v.product_id WHERE p.slug='classic-cotton-tee' AND v.size=?", size).stock;
  const lastOrder = () => q('SELECT * FROM orders ORDER BY id DESC');
  const statusOf = (id) => q('SELECT status FROM orders WHERE id=?', id).status;

  // Affiliate
  const a = await (await browser.newContext({ ...phone })).newPage();
  await a.goto(B + '/register');
  await a.fill('[name=name]', 'Sara Affiliate'); await a.fill('[name=email]', 'sara@test.com'); await a.fill('[name=password]', 'password123');
  await a.click('form button[type=submit]');
  await a.goto(B + '/account/affiliate');
  const link = await a.inputValue('#reflink');

  // Shopper arrives through the affiliate link
  const v = await (await browser.newContext({ ...phone })).newPage();
  await v.goto(link);
  check('footer mentions PayPal', (await v.textContent('.footer')).includes('PayPal'));
  const m0 = stockOf('M');
  const buyTee = async (size, qty = 1) => {
    await v.goto(B + '/p/classic-cotton-tee');
    await v.click(`label.size:has-text("${size}")`);
    await v.fill('#qty', String(qty));
    await v.click('button:has-text("Buy now")');
  };
  const checkout = async (method = 'paypal') => {
    if (!v.url().endsWith('/checkout')) await v.goto(B + '/checkout');
    await v.fill('[name=email]', 'buyer@x.com'); await v.fill('[name=phone]', '+44 7700 900000');
    await v.fill('[name=name]', 'Ana Buyer'); await v.selectOption('[name=country]', 'GB');
    await v.fill('[name=address]', '10 Baker Street'); await v.fill('[name=city]', 'London'); await v.fill('[name=postal_code]', 'NW1 6XE');
    await v.check(`input[name=payment_method][value=${method}]`);
    await v.click('form.form button[type=submit]');
  };

  /* 1. Redirect to PayPal with the right amount */
  await buyTee('M', 2);
  check('PayPal offered at checkout', !!(await v.$('input[name=payment_method][value=paypal]')));
  check('Stripe no longer offered', !(await v.$('input[name=payment_method][value=stripe]')));
  await shot(v, '60-checkout-paypal');
  await checkout();
  check('redirected to PayPal approval page', v.url().startsWith(`${MOCK}/ppapprove/`), v.url());
  check('PayPal amount = 2 x 19.00 USD', (await v.textContent('#amt')) === '38.00 USD');
  check('stock held while paying', stockOf('M') === m0 - 2);
  const o1 = lastOrder();
  check('order linked to PayPal order', o1.payment_method === 'paypal' && !!o1.paypal_order_id);
  const pp1 = (await mock()).orders[o1.paypal_order_id];
  check('PayPal order carries our order number', pp1.unit.custom_id === String(o1.id) && pp1.unit.description.includes(`#${o1.id}`));
  check('PayPal order lists the items', pp1.unit.items.length === 1 && pp1.unit.items[0].name === 'Classic Cotton Tee (Size M)' && pp1.unit.items[0].quantity === '2');

  /* 2. Cancel on PayPal */
  await v.click('#cancel');
  check('cancel returns to cart', v.url() === B + '/cart' && (await v.textContent('.flash')).includes('not been charged'));
  check('cart kept after cancel', (await v.$$('.cart-item')).length === 1);
  check('stock restored after cancel', stockOf('M') === m0 && statusOf(o1.id) === 'cancelled');

  /* 3. Late approval of a cancelled checkout is never captured */
  await fetch(`${MOCK}/__pp/approve/${o1.paypal_order_id}`);
  await v.goto(`${B}/order/${o1.id}?pp=1&token=${o1.paypal_order_id}&PayerID=X`);
  check('approved-after-cancel is NOT charged', statusOf(o1.id) === 'cancelled' && (await mock()).orders[o1.paypal_order_id].status === 'APPROVED');

  /* 4. Abandon one checkout, start another: the first reservation is released */
  await checkout();
  const o2 = lastOrder();
  await v.goto(B + '/checkout');
  await checkout();
  check('abandoned order released on new checkout', statusOf(o2.id) === 'cancelled');
  check('only one reservation held', stockOf('M') === m0 - 2);

  /* 5. Forged webhook cannot mark an order paid */
  const o3 = lastOrder();
  const forged = await fetch(`${B}/paypal/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'FAKE', status: 'COMPLETED', custom_id: String(o3.id), amount: { value: '38.00', currency_code: 'USD' }, supplementary_data: { related_ids: { order_id: o3.paypal_order_id } } } }) });
  check('forged webhook accepted politely but ignored', forged.status === 200 && statusOf(o3.id) === 'unpaid');

  /* 6. Pay: approve, return, capture */
  await v.click('#pay');
  await v.waitForURL(/\/order\/\d+/);
  const paid = q('SELECT * FROM orders WHERE id=?', o3.id);
  check('captured and marked paid on return', paid.status === 'paid' && !!paid.paypal_capture_id && !!paid.paid_at, paid.status);
  check('success page shown', (await v.textContent('h1')).includes("It's yours"));
  await shot(v, '61-paypal-paid');
  check('stock taken once', stockOf('M') === m0 - 2);
  await v.goto(B + '/cart');
  check('cart emptied after payment', (await v.$$('.cart-item')).length === 0);
  check('commission 10% pending', q('SELECT amount_cents, status FROM commissions WHERE order_id=?', o3.id).amount_cents === 380);
  await v.goto(`${B}/order/${o3.id}?pp=1`);
  check('reloading the return page does not capture twice', (await mock()).stats.captures === 1);

  /* 7. Approve, then close the tab: the webhook makes us capture */
  await buyTee('L');
  await checkout();
  const o4 = lastOrder();
  await v.click('#closetab');
  await sleep(500);
  check('approve-then-close captured via webhook', statusOf(o4.id) === 'paid');

  /* 8. Card declined at capture: order released, customer not charged */
  await buyTee('S');
  await checkout();
  const o5 = lastOrder();
  const s0 = stockOf('S');
  await v.click('#decline');
  await v.waitForURL(/\/order\/\d+/);
  check('declined payment cancels order', statusOf(o5.id) === 'cancelled' && stockOf('S') === s0 + 1);
  check('customer told they were not charged', (await v.textContent('main')).includes('not charged'));

  /* 9. Payment held for review (PENDING), then completed by PayPal */
  await buyTee('S');
  await checkout();
  const o6 = lastOrder();
  await v.click('#pending');
  await v.waitForURL(/\/order\/\d+/);
  check('pending payment keeps order waiting', statusOf(o6.id) === 'unpaid' && !!q('SELECT paypal_capture_id FROM orders WHERE id=?', o6.id).paypal_capture_id);
  check('customer sees "confirming your payment"', (await v.textContent('h1')).includes('Confirming'));
  await fetch(`${MOCK}/__pp/complete/${q('SELECT paypal_order_id FROM orders WHERE id=?', o6.id).paypal_order_id}`);
  await sleep(300);
  check('PayPal completing the review marks it paid', statusOf(o6.id) === 'paid');

  /* 10. Wrong amount captured: not accepted */
  await buyTee('S');
  await checkout();
  const o7 = lastOrder();
  await v.click('#underpay');
  await v.waitForURL(/\/order\/\d+/);
  check('wrong amount not accepted as paid', statusOf(o7.id) === 'unpaid');

  /* 11. Refunds: from the admin, and from the PayPal dashboard */
  const m = await (await browser.newContext({ ...phone })).newPage();
  await m.goto(B + '/login');
  await m.fill('[name=email]', 'admin@store.local'); await m.fill('[name=password]', 'admin12345');
  await m.click('form button[type=submit]');
  await m.goto(`${B}/admin/orders/${o3.id}`);
  check('admin shows PayPal transaction', (await m.textContent('main')).includes('PayPal transaction'));
  await shot(m, '62-admin-paypal-order');
  m.once('dialog', (d) => d.accept());
  await m.click('button:has-text("via PayPal")');
  check('admin refund through PayPal', (await m.textContent('.flash')).includes('Refunded') && statusOf(o3.id) === 'refunded');
  check('refund reached PayPal', (await mock()).refunds.includes(q('SELECT paypal_capture_id c FROM orders WHERE id=?', o3.id).c));
  check('commission cancelled on refund', q('SELECT status FROM commissions WHERE order_id=?', o3.id).status === 'cancelled');
  await fetch(`${MOCK}/__pp/refund-in-dashboard/${o4.paypal_order_id}`);
  await sleep(300);
  check('refund made in PayPal dashboard is picked up', statusOf(o4.id) === 'refunded');

  /* 12. Settings */
  await m.goto(B + '/admin/settings');
  check('settings show PayPal connected (sandbox)', (await m.textContent('main')).includes('sandbox: test payments only'));
  const st = await mock();
  check('every PayPal call was authorised', st.stats.authFailures === 0);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
