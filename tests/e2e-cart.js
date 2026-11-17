// Faster add-to-cart: quick add from product cards, adding without reloading, sticky bar, cart steppers.
const { chromium, devices } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const B = process.env.APP_URL || 'http://localhost:3123';
const SHOTS = process.env.SHOTS_DIR;
const db = new DatabaseSync(process.env.TEST_DB);
let failures = 0;
const check = (label, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${label} ${extra}`); if (!cond) failures++; };

// Extra products: one with colors, one single-size, one with a hostile name
function addProduct(name, slug, variants) {
  const id = Number(db.prepare('INSERT INTO products (category_id, name, slug, description) VALUES (1, ?, ?, ?)').run(name, slug, 'Test product').lastInsertRowid);
  variants.forEach(([color, size, price, stock], i) => db.prepare('INSERT INTO product_variants (product_id, color, size, price_cents, stock, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(id, color, size, price, stock, i));
}
addProduct('Two Tone Tee', 'two-tone-tee', [['Black', 'S', 2500, 5], ['Black', 'M', 2500, 0], ['White', 'S', 2700, 3]]);
addProduct('Canvas Tote', 'canvas-tote', [['', 'One size', 1500, 10]]);
addProduct('<img src=x onerror="window.pwned=1">Tee', 'xss-tee', [['', 'S', 1000, 5], ['', 'M', 1000, 5]]);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage();
  const shot = (n) => (SHOTS ? p.screenshot({ path: `${SHOTS}/${n}.png` }) : null);
  const badge = async () => p.evaluate(() => { const b = document.querySelector('.bottom-nav [data-cart-count]'); return b.hidden ? 0 : Number(b.textContent); });

  // 1. Quick add from the shop grid
  await p.goto(B + '/shop');
  await p.evaluate(() => { localStorage.setItem('cookie-ok', '1'); });
  await p.reload();
  await p.evaluate(() => { window.__noReload = true; });
  check('quick-add button on in-stock cards', (await p.$$('.quick-add')).length >= 6);
  check('empty cart shows no badge', (await badge()) === 0 && !(await p.isVisible('.topbar [data-cart-count]')));
  await p.click('.product-card:has-text("Classic Cotton Tee") .quick-add');
  await p.waitForSelector('#quick-sheet[open]');
  check('size sheet opens with product name', (await p.textContent('#qs-name')) === 'Classic Cotton Tee');
  check('add button waits for a size', (await p.isDisabled('#qs-add')) && (await p.textContent('#qs-add')) === 'Select a size');
  await p.click('#qs-sizes .size-btn:has-text("M")');
  check('button shows price once size chosen', (await p.textContent('#qs-add')) === 'Add to cart · $19.00');
  await shot('50-quick-add-sheet');
  await p.click('#qs-add');
  await p.waitForSelector('#cart-toast.show');
  check('sheet closes after adding', !(await p.$('#quick-sheet[open]')));
  check('confirmation names item and size', (await p.textContent('#toast-item')).includes('Classic Cotton Tee · M'));
  check('cart badge updates to 1', (await badge()) === 1);
  check('stayed on the shop page, no reload', p.url() === B + '/shop' && (await p.evaluate(() => window.__noReload === true)));
  await shot('51-added-toast');
  check('"+" icon comes back after adding', !!(await p.$('.product-card:has-text("Classic Cotton Tee") .quick-add svg')));

  // 2. Colors in the quick-add sheet
  await p.click('.product-card:has-text("Two Tone Tee") .quick-add');
  await p.waitForSelector('#quick-sheet[open]');
  check('color chips shown', (await p.$$('#qs-colors .color-chip')).length === 2);
  check('sold-out size disabled', await p.isDisabled('#qs-sizes .size-btn:has-text("M")'));
  check('only in-stock size auto-selected', (await p.textContent('#qs-add')) === 'Add to cart · $25.00');
  await p.click('#qs-colors .color-chip:has-text("White")');
  check('switching color updates price', (await p.textContent('#qs-add')) === 'Add to cart · $27.00');
  await p.click('#qs-add');
  await p.waitForFunction(() => document.querySelector('#toast-item').textContent.includes('White / S'));
  check('white tee added', (await badge()) === 2);

  // 3. One-size item adds straight away, no sheet
  await p.click('.product-card:has-text("Canvas Tote") .quick-add');
  await p.waitForFunction(() => document.querySelector('#toast-item').textContent.includes('Canvas Tote'));
  check('one-size item added without a sheet', !(await p.$('#quick-sheet[open]')) && (await badge()) === 3);
  await p.goto(B + '/cart');
  const tote = await p.textContent('.cart-item:has-text("Canvas Tote")');
  check('one-size label reads naturally in cart', tote.includes('One size') && !tote.includes('Size One size'));
  await p.goto(B + '/shop');

  // 4. Hostile product names show as text
  await p.click('.product-card:has(.pname:text-matches("onerror")) .quick-add');
  await p.waitForSelector('#quick-sheet[open]');
  check('product name rendered as text, not HTML', (await p.textContent('#qs-name')).includes('<img') && !(await p.evaluate(() => window.pwned)));
  await p.keyboard.press('Escape');

  // 5. Product page: add without reload, stock limit, sticky bar, buy now
  await p.goto(B + '/p/classic-cotton-tee');
  await p.evaluate(() => { window.__noReload = true; });
  await p.click('label.size:has-text("L")');
  await p.click('.actions .btn.outline');
  await p.waitForFunction(() => document.querySelector('#toast-item').textContent.includes('· L'));
  check('product page add keeps you on the page', (await p.evaluate(() => window.__noReload === true)) && (await badge()) === 4);
  await p.fill('#qty', '20');
  await p.click('.actions .btn.outline');
  await p.waitForSelector('#add-form .flash.error');
  check('stock limit explained inline', (await p.textContent('#add-form .flash.error')).includes('Only 19 more available in L'));
  check('badge unchanged after refused add', (await badge()) === 4);
  await p.fill('#qty', '1');
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await p.waitForSelector('#sticky-buy:not([hidden])');
  check('sticky add bar appears after scrolling', await p.isVisible('#sticky-add'));
  await shot('52-sticky-bar');
  await p.click('#sticky-add');
  await p.waitForFunction(() => Number(document.querySelector('.bottom-nav [data-cart-count]').textContent) === 5);
  check('sticky bar adds to cart', (await badge()) === 5);
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.click('button:has-text("Buy now")');
  await p.waitForURL(B + '/checkout');
  check('"Buy now" still goes to checkout', p.url() === B + '/checkout');

  // 6. Cart steppers
  await p.goto(B + '/cart');
  const line = '.cart-item:has-text("Canvas Tote")';
  await p.click(`${line} button[aria-label="One more"]`);
  check('+ adds one', (await p.textContent(`${line} .qty-stepper span`)) === '2');
  await p.click(`${line} button[aria-label="One less"]`);
  check('− removes one', (await p.textContent(`${line} .qty-stepper span`)) === '1');
  await shot('53-cart-steppers');
  await p.click(`${line} button[aria-label="Remove"]`);
  check('bin icon removes the line', !(await p.$(line)));

  // 7. Without JavaScript the normal forms still work
  const nojs = await (await browser.newContext({ ...devices['iPhone 13'], javaScriptEnabled: false })).newPage();
  await nojs.goto(B + '/p/everyday-zip-hoodie');
  await nojs.click('label.size:has-text("M")');
  await nojs.click('.actions .btn.outline');
  check('no-JS add to cart works with a page reload', (await nojs.textContent('.flash')).includes('Added to your cart'));

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
