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
  const stats = async (p) => (await p.$$eval('.stat', els => els.map(e => e.innerText.replace(/\n/g, ': ')))).join(' | ');
  const stockOf = (size) => q("SELECT v.stock FROM product_variants v JOIN products p ON p.id=v.product_id WHERE p.slug='classic-cotton-tee' AND v.size=?", size).stock;

  // Affiliate
  const a = await (await browser.newContext({ ...phone })).newPage();
  await a.goto(B + '/register');
  await a.fill('[name=name]', 'Sara Affiliate'); await a.fill('[name=email]', 'sara@test.com'); await a.fill('[name=password]', 'password123');
  await a.click('form button[type=submit]');
  await a.goto(B + '/account/affiliate');
  const link = await a.inputValue('#reflink');
  await shot(a, '20-affiliate-empty');

  // Visitor via link
  const vctx = await browser.newContext({ ...phone });
  const v = await vctx.newPage();
  await v.goto(link);
  await shot(v, '10-home');
  check('announce bar shows free worldwide shipping', (await v.textContent('.announce')).includes('Free shipping worldwide'));
  await v.goto(B + '/p/classic-cotton-tee');
  await shot(v, '11-product');
  const ogDesc = await v.getAttribute('meta[property="og:description"]', 'content');
  check('product has og:description', ogDesc && ogDesc.startsWith('The tee you reach for first'));
  const stockM0 = stockOf('M');
  await v.click('label.size:has-text("M")');
  await v.fill('#qty', '2');
  await v.click('button:has-text("Add to cart")');
  await v.goto(B + '/cart');
  check('cart shows free worldwide shipping', (await v.textContent('.summary')).includes('Free, worldwide'));
  await v.goto(B + '/checkout');

  const fillCheckout = async () => {
    await v.fill('[name=email]', 'buyer@x.com'); await v.fill('[name=phone]', '+212 600 000000');
    await v.fill('[name=name]', 'Yasmine Buyer'); await v.selectOption('[name=country]', 'MA');
    await v.fill('[name=address]', '12 Rue Atlas'); await v.fill('[name=city]', 'Marrakesh'); await v.fill('[name=postal_code]', '40000');
  };
  await fillCheckout();
  await shot(v, '12-checkout');
  // 1) Cancel on Stripe page -> cart intact, stock restored
  await v.click('form.form button[type=submit]');
  check('redirected to Stripe page', v.url().startsWith(MOCK + '/pay/'), v.url());
  check('Stripe amount = 2 x 19.00', (await v.textContent('#amt')) === '3800 usd');
  check('stock reserved while on Stripe page', stockOf('M') === stockM0 - 2);
  await v.click('#cancel');
  check('cancel returns to cart', v.url() === B + '/cart');
  check('cancel flash shown', (await v.textContent('.flash')).includes('not been charged'));
  check('cart still has items', (await v.$$('.cart-item')).length === 1);
  check('stock restored after cancel', stockOf('M') === stockM0);

  // 2) Abandon (navigate away), then check out again -> old reservation released
  await v.goto(B + '/checkout'); await fillCheckout(); await v.click('form.form button[type=submit]');
  const abandonedId = q("SELECT id FROM orders ORDER BY id DESC").id;
  await v.goto(B + '/checkout'); await fillCheckout(); await v.click('form.form button[type=submit]');
  check('abandoned order released on new checkout', q('SELECT status FROM orders WHERE id=?', abandonedId).status === 'cancelled');
  check('only one reservation held', stockOf('M') === stockM0 - 2);

  // 3) Pay (with webhook)
  await v.click('#pay');
  await v.waitForURL(/\/order\/\d+/);
  const paidId = Number(v.url().match(/order\/(\d+)/)[1]);
  await shot(v, '13-order-paid');
  check('success page headline', (await v.textContent('h1')).includes("It's yours"));
  const o = q('SELECT * FROM orders WHERE id=?', paidId);
  check('order paid with payment intent', o.status === 'paid' && o.stripe_payment_intent && o.paid_at, JSON.stringify({ s: o.status, pi: o.stripe_payment_intent }));
  check('order country stored', o.country === 'Morocco' && o.postal_code === '40000');
  check('stock decremented once', stockOf('M') === stockM0 - 2);
  await v.goto(B + '/cart');
  check('cart emptied after payment', (await v.$$('.cart-item')).length === 0);
  const c = q('SELECT * FROM commissions WHERE order_id=?', paidId);
  check('commission 10% pending', c && c.amount_cents === 380 && c.status === 'pending', JSON.stringify(c));

  // 4) Pay without webhook -> confirmed on return via session lookup
  await v.goto(B + '/p/linen-midi-dress');
  await v.click('button:has-text("Buy now")');
  await fillCheckout(); await v.click('form.form button[type=submit]');
  await v.click('#paysilent');
  await v.waitForURL(/\/order\/\d+/);
  const silentId = Number(v.url().match(/order\/(\d+)/)[1]);
  check('paid without webhook via return URL', q('SELECT status FROM orders WHERE id=?', silentId).status === 'paid');

  // 5) Stripe expiry webhook
  await v.goto(B + '/p/classic-cotton-tee');
  await v.click('label.size:has-text("L")'); await v.click('button:has-text("Buy now")');
  await fillCheckout(); await v.click('form.form button[type=submit]');
  const expId = q('SELECT id FROM orders ORDER BY id DESC').id;
  const stockL = stockOf('L');
  await fetch(MOCK + '/__expire_all');
  check('expired session cancels order', q('SELECT status FROM orders WHERE id=?', expId).status === 'cancelled');
  check('expired session restores stock', stockOf('L') === stockL + 1);

  // 6) Bad webhook signature
  const bad = await fetch(B + '/stripe/webhook', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bad' } });
  check('forged webhook rejected', bad.status === 400);

  // Affiliate sees pending earnings; abandoned/unpaid not counted
  await a.goto(B + '/account/affiliate');
  const st1 = await stats(a);
  check('affiliate pending = 3.80 + 6.90', st1.includes('On the way: 10.70 USDC') && st1.includes('Orders: 2'), st1);

  // Admin
  const m = await (await browser.newContext({ ...phone })).newPage();
  await m.goto(B + '/login');
  await m.fill('[name=email]', 'admin@store.local'); await m.fill('[name=password]', 'admin12345');
  await m.click('form button[type=submit]');
  await m.goto(B + '/admin/orders');
  const listed = await m.$$eval('.list-item', els => els.length);
  check('admin default list hides abandoned checkouts', listed === 2, `listed=${listed}`);
  await m.goto(B + '/admin/orders/' + paidId);
  await shot(m, '14-admin-order');
  await m.click('label.size:has-text("delivered")');
  await m.click('form.form button[type=submit]');
  check('commission approved on delivery', q('SELECT status FROM commissions WHERE order_id=?', paidId).status === 'approved');
  await m.goto(B + '/admin/orders/' + silentId);
  m.once('dialog', d => d.accept());
  await m.click('button:has-text("Refund")');
  check('refund flash', (await m.textContent('.flash')).includes('Refunded'));
  check('order refunded', q('SELECT status FROM orders WHERE id=?', silentId).status === 'refunded');
  check('commission cancelled on refund', q('SELECT status FROM commissions WHERE order_id=?', silentId).status === 'cancelled');
  const refunds = await (await fetch(MOCK + '/__refunds')).json();
  check('refund sent to Stripe', refunds.length === 1 && refunds[0].payment_intent === q('SELECT stripe_payment_intent pi FROM orders WHERE id=?', silentId).pi);
  await m.goto(B + '/admin/settings');
  await shot(m, '15-admin-settings');

  await a.goto(B + '/account/affiliate');
  const st2 = await stats(a);
  check('affiliate: 3.80 available, nothing pending', st2.includes('Available: 3.80 USDC') && st2.includes('On the way: 0.00 USDC'), st2);
  await shot(a, '16-affiliate-dashboard');
  await v.goto(B + '/cart'); await shot(v, '17-empty-cart');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
