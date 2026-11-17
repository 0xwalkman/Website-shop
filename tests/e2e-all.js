const { chromium, devices } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const totp = require('../src/totp');
const B = process.env.APP_URL || 'http://localhost:3123';
const MOCK = process.env.MOCK_URL || 'http://localhost:4555';
const SHOTS = process.env.SHOTS_DIR; // set to save screenshots
const db = new DatabaseSync(process.env.TEST_DB);
const q = (sql, ...a) => db.prepare(sql).get(...a);
const qa = (sql, ...a) => db.prepare(sql).all(...a);
let failures = 0;
const check = (label, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${label} ${extra}`); if (!cond) failures++; };
const IMG = path.join(__dirname, 'fixtures', 'photo.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastEmail = (to, subjectLike) => q("SELECT * FROM emails WHERE to_addr = ? AND subject LIKE ? ORDER BY id DESC", to, `%${subjectLike}%`);
const linkIn = (html, re) => { const m = html.match(re); return m && m[0].replace(/&amp;/g, '&'); };

(async () => {
  const browser = await chromium.launch();
  const phone = devices['iPhone 13'];
  const shot = (p, n) => (SHOTS ? p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }) : null);
  const newPage = async () => (await browser.newContext({ ...phone })).newPage();

  /* ---------- Admin: settings, 2FA ---------- */
  const m = await newPage();
  await m.goto(B + '/login');
  await m.fill('[name=email]', 'admin@store.local'); await m.fill('[name=password]', 'admin12345');
  await m.click('form button[type=submit]');
  check('2FA reminder on dashboard', (await m.textContent('main')).includes('turn on two-step login'));
  await m.goto(B + '/admin/settings');
  await m.fill('[name=contact_email]', 'hello@outouf.test');
  await m.fill('[name=whatsapp_number]', '+212 600 112233');
  await m.fill('[name=business_name]', 'Outouf Trading');
  await m.click('form.form button[type=submit]');
  check('settings saved', (await m.textContent('.flash')).includes('Settings saved'));

  await m.goto(B + '/admin/security');
  await shot(m, '40-admin-2fa-setup');
  const secret = (await m.textContent('.setup-steps code')).replace(/\s/g, '');
  await m.fill('[name=code]', totp.codeAt(secret, Math.floor(Date.now() / 30000)));
  await m.click('form.form button[type=submit]');
  check('2FA enabled', q("SELECT totp_enabled FROM users WHERE email='admin@store.local'").totp_enabled === 1);
  // Log in again: password + code
  const m2 = await newPage();
  await m2.goto(B + '/login');
  await m2.fill('[name=email]', 'admin@store.local'); await m2.fill('[name=password]', 'admin12345');
  await m2.click('form button[type=submit]');
  check('login asks for 2FA code', m2.url().endsWith('/login/2fa'));
  await m2.fill('[name=code]', '000000'); await m2.click('form button[type=submit]');
  check('wrong code rejected', (await m2.textContent('.flash.error')).includes("didn't work"));
  await sleep(31000); // next 30-second window, so the code differs from the one used to enable
  await m2.fill('[name=code]', totp.codeAt(secret, Math.floor(Date.now() / 30000)));
  await m2.click('form button[type=submit]');
  check('2FA login reaches admin', m2.url().endsWith('/admin'));

  /* ---------- Admin: product with photos, colors, sale ---------- */
  await m.goto(B + '/admin/products/new');
  await m.fill('[name=name]', 'Boxy Linen Shirt');
  await m.selectOption('[name=category_id]', { label: 'T-Shirts' });
  await m.fill('[name=description]', 'Breezy linen shirt with a boxy cut.');
  await m.setInputFiles('[name=images]', [IMG, IMG, IMG]);
  // rows: replace defaults (S, M, L, XL) with Black S/M and White S/M (white on sale)
  const rows = await m.$$('.variant-row');
  const data = [['Black', 'S', '40', '', '5'], ['Black', 'M', '40', '', '5'], ['White', 'S', '35', '50', '5'], ['White', 'M', '35', '50', '3']];
  for (const [i, r] of rows.entries()) {
    const d = data[i];
    await r.$eval('input[name="v_color[]"]', (el, v) => (el.value = v), d[0]);
    await r.$eval('input[name="v_size[]"]', (el, v) => (el.value = v), d[1]);
    await r.$eval('input[name="v_price[]"]', (el, v) => (el.value = v), d[2]);
    await r.$eval('input[name="v_compare[]"]', (el, v) => (el.value = v), d[3]);
    await r.$eval('input[name="v_stock[]"]', (el, v) => (el.value = v), d[4]);
  }
  await m.click('.sticky-actions button[type=submit]');
  check('product with colors created', (await m.textContent('.flash')).includes('created'));
  const pid = q("SELECT id FROM products WHERE slug='boxy-linen-shirt'").id;
  check('3 photos stored', qa('SELECT * FROM product_images WHERE product_id=?', pid).length === 3);
  check('photos converted to WebP', qa('SELECT path FROM product_images WHERE product_id=?', pid).every((r) => r.path.endsWith('.webp')));
  check('cover image set', !!q('SELECT image FROM products WHERE id=?', pid).image);
  await shot(m, '41-admin-product-colors');
  // bad sale price is rejected
  await m.$eval('.variant-row input[name="v_compare[]"]', (el) => (el.value = '10'));
  await m.click('.sticky-actions button[type=submit]');
  check('"was" price lower than price rejected', (await m.textContent('.flash.error')).includes('must be higher'));

  /* ---------- Admin: discount code, page edit, team ---------- */
  await m.goto(B + '/admin/discounts');
  await m.fill('[name=code]', 'welcome10'); await m.fill('[name=value]', '10');
  await m.click('form.form button[type=submit]');
  check('discount created', !!q("SELECT * FROM discount_codes WHERE code='WELCOME10'"));
  await m.goto(B + '/admin/pages/returns');
  const body = await m.inputValue('[name=body]');
  await m.fill('[name=body]', body + '\n\n**Test edit marker.**');
  await m.click('form.form button[type=submit]');
  await m.goto(B + '/admin/team');
  await m.fill('[name=email]', 'staff@outouf.test'); await m.fill('[name=name]', 'Sam Staff');
  await m.click('form.form button[type=submit]');
  await sleep(300);
  const invite = lastEmail('staff@outouf.test', 'team');
  check('staff invite emailed', !!invite);
  const s = await newPage();
  await s.goto(linkIn(invite.html, /http:\/\/localhost:3123\/reset\/[A-Za-z0-9_-]+/));
  await s.fill('[name=password]', 'staffpass123'); await s.click('form button[type=submit]');
  check('staff set password and is logged in', s.url().endsWith('/admin'));
  await s.goto(B + '/admin/settings');
  check('staff blocked from settings', (await s.textContent('h1')).includes('Owner access only'));
  await s.goto(B + '/admin/orders');
  check('staff can open orders', (await s.textContent('h1')).includes('Orders'));
  check('staff nav hides owner tabs', !(await s.$('.admin-nav a[href="/admin/withdrawals"]')));

  /* ---------- Storefront: SEO, pages, cookie, whatsapp ---------- */
  const robots = await (await fetch(B + '/robots.txt')).text();
  check('robots.txt lists sitemap', robots.includes('Sitemap: http://localhost:3123/sitemap.xml'));
  const sitemap = await (await fetch(B + '/sitemap.xml')).text();
  check('sitemap includes new product', sitemap.includes('/p/boxy-linen-shirt'));
  check('healthz ok', (await (await fetch(B + '/healthz')).json()).ok === true);

  const a = await newPage();
  await a.goto(B + '/register');
  await a.fill('[name=name]', 'Sara Affiliate'); await a.fill('[name=email]', 'sara@test.com'); await a.fill('[name=password]', 'password123');
  await a.click('form button[type=submit]');
  await a.goto(B + '/account/affiliate');
  const link = await a.inputValue('#reflink');

  const v = await newPage();
  await v.goto(link);
  check('cookie notice shown', await v.isVisible('#cookie-note'));
  await v.click('#cookie-ok');
  check('cookie notice dismissed', !(await v.isVisible('#cookie-note')));
  check('WhatsApp button present', !!(await v.$('.wa-float[href^="https://wa.me/212600112233"]')));
  check('footer policy links', (await v.$$('.footer-links a')).length === 6);
  await v.goto(B + '/page/returns');
  check('edited returns page shown', (await v.textContent('article')).includes('Test edit marker'));
  await v.goto(B + '/page/shipping');
  check('shipping page mentions customs', (await v.textContent('article')).includes('import duties'));
  await shot(v, '42-shipping-page');
  await v.goto(B + '/shop');
  check('"On sale" filter chip', !!(await v.$('a.chip:has-text("On sale")')));
  await v.goto(B + '/shop?sale=1');
  check('sale filter shows only sale items', (await v.$$('.product-card')).length === 1);
  await v.goto(B + `/p/boxy-linen-shirt?ref=${link.split('/r/')[1]}`);
  const canonical = await v.getAttribute('link[rel=canonical]', 'href');
  check('canonical drops ?ref', canonical === 'http://localhost:3123/p/boxy-linen-shirt');
  const ld = JSON.parse(await v.textContent('script[type="application/ld+json"]'));
  check('Product structured data', ld['@type'] === 'Product' && ld.offers.lowPrice === '35.00' && ld.image.length === 3);
  check('3 gallery thumbnails', (await v.$$('.thumb-btn')).length === 3);
  check('2 color chips', (await v.$$('.color-chip')).length === 2);
  check('Black sizes visible, White hidden', (await v.$$('.size:not([hidden])')).length === 2);
  await v.click('.color-chip[data-color="White"]');
  check('White price on sale', (await v.textContent('#price')) === '$35.00' && (await v.textContent('#compare')) === '$50.00' && (await v.textContent('#save')) === 'Save 30%');
  await v.click('label.size:not([hidden]):has-text("M")');
  await shot(v, '43-product-colors-sale');
  await v.fill('#qty', '2');
  await v.click('button:has-text("Add to cart")');
  await v.waitForFunction(() => document.querySelector('#toast-item').textContent.includes('White / M'));
  check('added-to-cart confirmation names color', (await v.textContent('#toast-item')).includes('White / M'));

  /* ---------- Discount + checkout + emails ---------- */
  await v.goto(B + '/cart');
  await v.fill('[name=code]', 'NOPE'); await v.click('.discount-form button');
  check('invalid code message', (await v.textContent('.flash')).includes("isn't a valid code"));
  await v.fill('[name=code]', 'welcome10'); await v.click('.discount-form button');
  check('code applied', (await v.textContent('.discount-row')).includes('−$7.00'));
  check('cart total 63.00', (await v.textContent('.row.total')).includes('$63.00'));
  await shot(v, '44-cart-discount');
  await v.goto(B + '/checkout');
  await v.fill('[name=email]', 'buyer@x.com'); await v.fill('[name=phone]', '+33 6 00 00 00 00');
  await v.fill('[name=name]', 'Lea Buyer'); await v.selectOption('[name=country]', 'FR');
  await v.fill('[name=address]', '3 Rue de Rivoli'); await v.fill('[name=city]', 'Paris'); await v.fill('[name=postal_code]', '75001');
  check('customs note at checkout', (await v.textContent('.customs-note')).includes('import duties'));
  check('terms agreement line', !!(await v.$('a[href="/page/terms"]')));
  await v.check('input[name=payment_method][value=paypal]');
  await v.click('form.form button[type=submit]');
  check('PayPal charged discounted total', (await v.textContent('#amt')) === '63.00 USD');
  await v.click('#pay');
  await v.waitForURL(/\/order\/\d+/);
  await sleep(500);
  const order = q("SELECT * FROM orders WHERE status='paid' ORDER BY id DESC");
  check('order stores discount', order.discount_code === 'WELCOME10' && order.discount_cents === 700 && order.total_cents === 6300);
  check('order item stores color', q('SELECT color FROM order_items WHERE order_id=?', order.id).color === 'White');
  check('discount use counted once', q("SELECT uses FROM discount_codes WHERE code='WELCOME10'").uses === 1);
  check('commission = 10% of discounted subtotal', q('SELECT amount_cents FROM commissions WHERE order_id=?', order.id).amount_cents === 630);
  const conf = lastEmail('buyer@x.com', 'confirmed');
  check('confirmation email to customer', !!conf && conf.html.includes('White, M') && conf.html.includes('WELCOME10'));
  check('new-order alert to store', !!lastEmail('hello@outouf.test', 'New order'));
  // Email link opens the order on another device
  const other = await newPage();
  await other.goto(linkIn(conf.html, /http:\/\/localhost:3123\/order\/\d+\?t=[0-9a-f]+/));
  check('email link opens order without login', (await other.textContent('h1')).includes(`Order #${order.id}`));
  const guess = await newPage();
  await guess.goto(`${B}/order/${order.id}?t=deadbeef`);
  check('wrong token is refused', (await guess.textContent('h1')).includes('Order not found'));

  /* ---------- Tracking ---------- */
  await m.goto(B + `/admin/orders/${order.id}`);
  await m.click('label.size:has-text("shipped")');
  await m.click('form.form button[type=submit]');
  check('shipping without tracking blocked', (await m.textContent('.flash.error')).includes('tracking number'));
  await m.click('label.size:has-text("shipped")');
  await m.selectOption('[name=tracking_carrier]', 'DHL Express');
  await m.fill('[name=tracking_number]', 'JD014600006281');
  await m.click('form.form button[type=submit]');
  await sleep(300);
  const shipped = lastEmail('buyer@x.com', 'on its way');
  check('shipped email has DHL tracking link', !!shipped && shipped.html.includes('tracking-id=JD014600006281'));
  await other.goto(B + `/order/${order.id}`);
  check('customer sees tracking card', (await other.textContent('.tracking-card')).includes('JD014600006281'));
  await shot(other, '45-order-tracking');

  /* ---------- Forgot password ---------- */
  const f = await newPage();
  await f.goto(B + '/forgot');
  await f.fill('[name=email]', 'sara@test.com'); await f.click('form button[type=submit]');
  check('forgot page gives neutral answer', (await f.textContent('.flash')).includes('If an account exists'));
  await f.goto(B + '/forgot');
  await f.fill('[name=email]', 'nobody@test.com'); await f.click('form button[type=submit]');
  check('unknown email gets same answer', (await f.textContent('.flash')).includes('If an account exists'));
  await sleep(300);
  const reset = lastEmail('sara@test.com', 'Reset');
  const resetUrl = linkIn(reset.html, /http:\/\/localhost:3123\/reset\/[A-Za-z0-9_-]+/);
  await f.goto(resetUrl);
  await f.fill('[name=password]', 'newpassword456'); await f.click('form button[type=submit]');
  check('reset logs in', f.url().endsWith('/account'));
  await a.goto(B + '/account/affiliate');
  check('old session signed out after reset', a.url().includes('/login'));
  await f.goto(B + '/logout').catch(() => {});
  const f2 = await newPage();
  await f2.goto(resetUrl);
  check('reset link works only once', (await f2.textContent('h1')).includes('expired'));

  /* ---------- Contact form ---------- */
  await v.goto(B + '/contact');
  await v.fill('[name=name]', 'Lea Buyer'); await v.fill('[name=email]', 'buyer@x.com');
  await v.fill('[name=order]', String(order.id)); await v.fill('[name=message]', 'Can I change the size?');
  await v.click('form.form button[type=submit]');
  check('contact flash', (await v.textContent('.flash')).includes('on its way'));
  await sleep(300);
  check('contact email reached store inbox', !!lastEmail('hello@outouf.test', 'Contact form'));

  /* ---------- Stats ---------- */
  await m.goto(B + '/admin/stats');
  const tiles = await m.$$eval('.stat', (els) => els.map((e) => e.innerText.replace(/\n/g, ': ')));
  check('stats count visitors', /Visitors: [1-9]/.test(tiles.join('|')), tiles.join(' | '));
  check('stats count paid order', tiles.some((t) => t.startsWith('Paid orders: 1')));
  check('most viewed product listed', (await m.textContent('main')).includes('Boxy Linen Shirt'));
  await shot(m, '46-admin-stats');

  /* ---------- Emails all logged (no SMTP in test) ---------- */
  const st = qa('SELECT status, COUNT(*) n FROM emails GROUP BY status');
  check('all emails processed (saved to outbox)', st.length === 1 && st[0].status === 'logged', JSON.stringify(st));

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
