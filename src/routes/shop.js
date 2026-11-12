const crypto = require('node:crypto');
const express = require('express');
const { db, tx, getSettings } = require('../db');
const { flash, currentAffiliate } = require('../middleware');
const payments = require('../payments');
const binance = require('../binance');
const { COUNTRIES, countryName } = require('../countries');
const discounts = require('../discounts');
// Each checkout holds stock for up to an hour, so limit how many one visitor can start.
const checkoutLimiter = require('../ratelimit').createLimiter(60 * 60 * 1000);
const MAX_CHECKOUTS_PER_HOUR = 10;

const router = express.Router();

// "Black / M", or just "M" for single-color items
const variantLabel = (v) => [v.color, v.size].filter(Boolean).join(' / ');

const PRODUCT_LIST_SQL = `
  SELECT p.*, c.name AS category_name, c.slug AS category_slug,
         MIN(v.price_cents) AS min_price, MAX(v.price_cents) AS max_price,
         COALESCE(SUM(v.stock), 0) AS total_stock,
         MAX(CASE WHEN v.compare_at_cents > v.price_cents THEN 1 ELSE 0 END) AS on_sale,
         COUNT(DISTINCT NULLIF(v.color, '')) AS color_count
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN product_variants v ON v.product_id = p.id
  WHERE p.is_active = 1`;

router.get('/', (req, res) => {
  const categories = db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_active = 1) AS product_count
    FROM categories c ORDER BY sort_order, name`).all();
  const products = db.prepare(`${PRODUCT_LIST_SQL} GROUP BY p.id HAVING COUNT(v.id) > 0 ORDER BY p.created_at DESC, p.id DESC LIMIT 8`).all();
  res.render('home', { title: null, categories, products });
});

router.get('/shop', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const catSlug = typeof req.query.category === 'string' ? req.query.category : '';
  const sort = typeof req.query.sort === 'string' ? req.query.sort : 'new';
  const sale = req.query.sale === '1';
  const where = [];
  const params = [];
  let category = null;
  if (catSlug) {
    category = db.prepare('SELECT * FROM categories WHERE slug = ?').get(catSlug);
    if (category) { where.push('p.category_id = ?'); params.push(category.id); }
  }
  if (q) { where.push('(p.name LIKE ? OR p.description LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const order = {
    price_asc: 'min_price ASC',
    price_desc: 'min_price DESC',
    name: 'p.name COLLATE NOCASE ASC',
  }[sort] || 'p.created_at DESC, p.id DESC';
  const sql = `${PRODUCT_LIST_SQL} ${where.length ? 'AND ' + where.join(' AND ') : ''}
    GROUP BY p.id HAVING COUNT(v.id) > 0 ${sale ? 'AND on_sale = 1' : ''} ORDER BY ${order}`;
  const products = db.prepare(sql).all(...params);
  const anySale = Boolean(db.prepare('SELECT 1 FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.is_active = 1 AND v.compare_at_cents > v.price_cents').get());
  res.render('shop', { title: sale ? 'On sale' : (category ? category.name : 'Shop'), products, category, q, sort, sale, anySale });
});

router.get('/p/:slug', (req, res) => {
  const product = db.prepare(`
    SELECT p.*, c.name AS category_name, c.slug AS category_slug
    FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.slug = ? AND p.is_active = 1`).get(req.params.slug);
  if (!product) return res.status(404).render('error', { title: 'This piece is gone', message: "It sold out or is no longer available. Plenty more where it came from, though." });
  const variants = db.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order, id').all(product.id);
  const images = db.prepare('SELECT path FROM product_images WHERE product_id = ? ORDER BY sort_order, id').all(product.id).map((i) => i.path);
  if (!images.length && product.image) images.push(product.image);
  const colors = [...new Set(variants.map((v) => v.color).filter(Boolean))];
  const related = db.prepare(`${PRODUCT_LIST_SQL} AND p.category_id IS ? AND p.id != ? GROUP BY p.id HAVING COUNT(v.id) > 0 ORDER BY RANDOM() LIMIT 4`)
    .all(product.category_id, product.id);
  const base = res.locals.baseUrl;
  const settings = res.locals.settings;
  const prices = variants.map((v) => v.price_cents);
  const meta = {
    description: product.description.slice(0, 160),
    image: product.image ? `${base}${product.image}` : null,
    canonical: `${base}/p/${product.slug}`, // affiliate links (?ref=...) all point Google at the same page
    jsonld: prices.length ? {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: product.name,
      description: product.description,
      image: images.map((i) => `${base}${i}`),
      brand: { '@type': 'Brand', name: settings.store_name },
      ...(product.category_name ? { category: product.category_name } : {}),
      offers: {
        '@type': 'AggregateOffer',
        priceCurrency: settings.currency.toUpperCase(),
        lowPrice: (Math.min(...prices) / 100).toFixed(2),
        highPrice: (Math.max(...prices) / 100).toFixed(2),
        offerCount: variants.length,
        availability: variants.some((v) => v.stock > 0) ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
        url: `${base}/p/${product.slug}`,
      },
    } : null,
  };
  res.render('product', { title: product.name, product, variants, images, colors, related, meta });
});

// Affiliate short link: /r/CODE -> home page with ?ref=CODE (tracked by middleware)
router.get('/r/:code', (req, res) => {
  res.redirect(`/?ref=${encodeURIComponent(String(req.params.code).slice(0, 32))}`);
});

/* ---------------- cart ---------------- */

function loadCart(req) {
  const raw = req.session.cart || [];
  const getVar = db.prepare(`
    SELECT v.*, p.name AS product_name, p.slug, p.image, p.is_active
    FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`);
  const items = [];
  for (const line of raw) {
    const v = getVar.get(line.variantId);
    if (!v || !v.is_active) continue;
    items.push({ ...v, qty: line.qty, line_cents: v.price_cents * line.qty });
  }
  const settings = getSettings();
  const subtotal = items.reduce((s, i) => s + i.line_cents, 0);
  const freeShip = settings.free_shipping_over_cents > 0 && subtotal >= settings.free_shipping_over_cents;
  const shipping = items.length === 0 || freeShip ? 0 : settings.shipping_cents;
  // Discount code saved in the session; re-checked on every load (it may expire or run out).
  let discount = null;
  let discountError = null;
  if (req.session.discountCode && items.length) {
    const money = (c) => `${settings.currency_symbol}${(c / 100).toFixed(2)}`;
    const r = discounts.evaluate(req.session.discountCode, subtotal, money);
    if (r.error) discountError = r.error; else discount = r;
  }
  const discountCents = discount ? discount.amount : 0;
  return { items, subtotal, shipping, discount, discountError, discountCents, total: subtotal - discountCents + shipping };
}

router.post('/cart/discount', (req, res) => {
  const code = String(req.body.code || '').trim().slice(0, 40);
  if (req.body.remove || !code) {
    delete req.session.discountCode;
    if (req.body.remove) flash(req, 'info', 'Discount code removed.');
    return res.redirect(req.body.back === 'checkout' ? '/checkout' : '/cart');
  }
  req.session.discountCode = code;
  const cart = loadCart(req);
  if (cart.discountError) {
    delete req.session.discountCode;
    flash(req, 'error', cart.discountError);
  } else if (cart.discount) {
    flash(req, 'success', `Code ${cart.discount.code} applied: ${cart.discount.label}! 🎉`);
  }
  res.redirect(req.body.back === 'checkout' ? '/checkout' : '/cart');
});

router.post('/cart/add', (req, res) => {
  const variantId = parseInt(req.body.variant_id, 10);
  const qty = Math.min(Math.max(parseInt(req.body.qty, 10) || 1, 1), 20);
  const v = db.prepare(`SELECT v.*, p.slug FROM product_variants v JOIN products p ON p.id = v.product_id
                        WHERE v.id = ? AND p.is_active = 1`).get(variantId);
  if (!v) {
    flash(req, 'error', 'Pick your size first.');
    return res.redirect(req.get('referer') || '/shop');
  }
  const cart = req.session.cart || [];
  const line = cart.find((l) => l.variantId === variantId);
  const newQty = (line ? line.qty : 0) + qty;
  if (newQty > v.stock) {
    flash(req, 'error', v.stock > 0 ? `Only ${v.stock} left in ${variantLabel(v)}. Grab them while you can.` : `${variantLabel(v)} just sold out. Try another option?`);
    return res.redirect(`/p/${v.slug}`);
  }
  if (line) line.qty = newQty; else cart.push({ variantId, qty });
  req.session.cart = cart;
  flash(req, 'success', `Added to your cart: ${variantLabel(v)}.`);
  res.redirect(req.body.buy_now ? '/checkout' : `/p/${v.slug}`);
});

router.get('/cart', (req, res) => {
  res.render('cart', { title: 'Your cart', cart: loadCart(req) });
});

router.post('/cart/update', (req, res) => {
  const variantId = parseInt(req.body.variant_id, 10);
  const qty = parseInt(req.body.qty, 10);
  let cart = req.session.cart || [];
  const v = db.prepare('SELECT stock FROM product_variants WHERE id = ?').get(variantId);
  if (!v || !qty || qty < 1) {
    cart = cart.filter((l) => l.variantId !== variantId);
  } else {
    const line = cart.find((l) => l.variantId === variantId);
    if (line) line.qty = Math.min(qty, v.stock, 20);
    if (line && line.qty < qty) flash(req, 'info', `Only ${v.stock} left in that size, so we've updated your cart.`);
  }
  req.session.cart = cart.filter((l) => l.qty > 0);
  res.redirect('/cart');
});

/* ---------------- checkout (Stripe or Binance Pay) ---------------- */

function sessionOrders(req) {
  return req.session.orders || [];
}

function paymentMethods() {
  const list = [];
  if (payments.enabled()) list.push('stripe');
  if (binance.enabled()) list.push('binance');
  return list;
}

// Closes an unpaid order's payment page (Stripe or Binance) and returns its items to stock.
async function cancelUnpaid(order) {
  if (order.payment_method === 'binance') return binance.cancelOpen(order);
  if (!order.stripe_session_id || await payments.expireSession(order.stripe_session_id)) payments.releaseUnpaid(order.id);
}

// If this shopper abandoned an earlier payment page, release that reservation before starting a new one.
async function releaseAbandoned(req) {
  const ids = sessionOrders(req);
  if (!ids.length) return;
  const open = db.prepare(`SELECT * FROM orders WHERE status = 'unpaid' AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  for (const o of open) await cancelUnpaid(o);
}

function renderCheckout(res, cart, values, extra = {}) {
  res.render('checkout', {
    title: 'Checkout', cart, values, countries: COUNTRIES,
    methods: paymentMethods(), binanceCurrency: binance.payCurrency(), ...extra,
  });
}

router.get('/checkout', (req, res) => {
  const cart = loadCart(req);
  if (!cart.items.length) return res.redirect('/cart');
  const values = req.user ? { name: req.user.name, email: req.user.email } : {};
  renderCheckout(res, cart, values);
});

router.post('/checkout', async (req, res) => {
  const cart = loadCart(req);
  if (!cart.items.length) return res.redirect('/cart');
  const f = {};
  for (const k of ['name', 'email', 'phone', 'address', 'city', 'postal_code', 'country', 'notes', 'payment_method']) {
    f[k] = String(req.body[k] || '').trim().slice(0, 500);
  }
  const fail = (msg, status = 400) => { res.status(status); renderCheckout(res, cart, f, { error: msg }); };

  const methods = paymentMethods();
  if (!methods.length) return fail('Online payment is not available right now. Please try again a little later.', 503);
  const method = methods.includes(f.payment_method) ? f.payment_method : (methods.length === 1 ? methods[0] : null);
  if (!method) return fail('Please choose how you would like to pay.');
  if (f.name.length < 2) return fail('Please enter your full name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) return fail('Please enter a valid email so we can reach you about your order.');
  if (f.phone.replace(/\D/g, '').length < 6) return fail('Please add a phone number. The courier may need it to reach you.');
  const country = countryName(f.country);
  if (!country) return fail('Please choose the country we are shipping to.');
  if (f.address.length < 4 || f.city.length < 2) return fail('Please enter your full delivery address and city.');

  if (checkoutLimiter.hit(req.ip) > MAX_CHECKOUTS_PER_HOUR) {
    return fail('Too many checkout attempts from your connection. Please wait a little and try again, or contact us.', 429);
  }
  if (cart.discountError) {
    delete req.session.discountCode;
    return fail(`${cart.discountError} We've removed it. Please review your total.`);
  }

  await releaseAbandoned(req);

  const settings = getSettings();
  const aff = currentAffiliate(req, f.email);
  let orderId;
  try {
    orderId = tx(() => {
      // Re-check stock inside the transaction; the order reserves its items until it is paid or expires.
      for (const item of cart.items) {
        const fresh = db.prepare('SELECT stock FROM product_variants WHERE id = ?').get(item.id);
        if (!fresh || fresh.stock < item.qty) {
          const left = fresh ? fresh.stock : 0;
          throw Object.assign(new Error(left
            ? `Almost! Only ${left} of ${item.product_name} (${variantLabel(item)}) left. Please update your cart.`
            : `${item.product_name} (${variantLabel(item)}) just sold out. Please remove it from your cart.`), { userFacing: true });
        }
      }
      const info = db.prepare(`
        INSERT INTO orders (user_id, customer_name, email, phone, address, city, postal_code, country, notes,
                            subtotal_cents, shipping_cents, total_cents, status, currency, payment_method, affiliate_id, commission_rate,
                            access_token, discount_code, discount_cents)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.user ? req.user.id : null, f.name, f.email.toLowerCase(), f.phone, f.address, f.city, f.postal_code, country, f.notes,
          cart.subtotal, cart.shipping, cart.total, settings.currency, method, aff ? aff.id : null, aff ? settings.commission_rate : 0,
          crypto.randomBytes(16).toString('hex'), cart.discount ? cart.discount.code : null, cart.discountCents);
      const id = Number(info.lastInsertRowid);
      const insItem = db.prepare(`INSERT INTO order_items (order_id, product_id, variant_id, product_name, color, size, price_cents, qty)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const decStock = db.prepare('UPDATE product_variants SET stock = stock - ? WHERE id = ?');
      for (const item of cart.items) {
        insItem.run(id, item.product_id, item.id, item.product_name, item.color, item.size, item.price_cents, item.qty);
        decStock.run(item.qty, item.id);
      }
      return id;
    });
  } catch (err) {
    if (err.userFacing) return fail(err.message);
    throw err;
  }

  req.session.orders = [...sessionOrders(req), orderId].slice(-20);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  let redirectTo;
  try {
    if (method === 'binance') {
      redirectTo = await binance.createOrder({ order, items: cart.items, baseUrl: res.locals.baseUrl });
    } else {
      const session = await payments.createCheckoutSession({ order, items: cart.items, baseUrl: res.locals.baseUrl });
      db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(session.id, orderId);
      redirectTo = session.url;
    }
  } catch (err) {
    console.error(`[${method}] Could not open payment page:`, err.message);
    payments.releaseUnpaid(orderId);
    return fail('We could not open the payment page. You have not been charged. Please try again.', 502);
  }
  res.redirect(303, redirectTo);
});

// Stripe and Binance Pay send shoppers here when they press "back" on the payment page.
router.get('/checkout/cancelled/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const order = sessionOrders(req).includes(id) && db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (order && order.status === 'unpaid') await cancelUnpaid(order);
  const fresh = order && db.prepare('SELECT status FROM orders WHERE id = ?').get(id);
  if (fresh && fresh.status === 'paid') return res.redirect(`/order/${id}`); // paid after all
  flash(req, 'info', 'Payment cancelled. You have not been charged, and your cart is right where you left it.');
  res.redirect('/cart');
});

router.get('/order/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  let order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  // Links in emails carry a secret token (?t=...) so the customer can open the order on any device.
  if (order && typeof req.query.t === 'string' && order.access_token) {
    const a = Buffer.from(req.query.t), b = Buffer.from(order.access_token);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) req.session.orders = [...sessionOrders(req), id].slice(-20);
  }
  const ownedBySession = sessionOrders(req).includes(id);
  const allowed = order && (ownedBySession || (req.user && (req.user.is_admin || order.user_id === req.user.id)));
  if (!allowed) return res.status(404).render('error', { title: 'Order not found', message: "We couldn't find that order on this device. If you ordered while logged in, you'll find it under My account." });

  const returning = typeof req.query.session_id === 'string' || req.query.bp === '1';
  if (typeof req.query.session_id === 'string') order = await payments.syncFromSession(order, req.query.session_id);
  // Binance: check on every visit while unpaid, so "Refresh" on the waiting screen works.
  if (order.payment_method === 'binance' && order.status === 'unpaid') order = await binance.sync(order);
  // The cart is kept until payment succeeds, so a cancelled payment never loses it.
  if (ownedBySession && order.status !== 'unpaid' && order.status !== 'cancelled') {
    req.session.cart = [];
    delete req.session.discountCode;
    res.locals.cartCount = 0;
  }

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id);
  res.render('order', { title: `Order #${id}`, order, items, placed: returning });
});

module.exports = router;
