const express = require('express');
const { db, tx, getSettings } = require('../db');
const { flash, currentAffiliate } = require('../middleware');
const payments = require('../payments');
const { COUNTRIES, countryName } = require('../countries');

const router = express.Router();

const PRODUCT_LIST_SQL = `
  SELECT p.*, c.name AS category_name, c.slug AS category_slug,
         MIN(v.price_cents) AS min_price, MAX(v.price_cents) AS max_price,
         COALESCE(SUM(v.stock), 0) AS total_stock
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
    GROUP BY p.id HAVING COUNT(v.id) > 0 ORDER BY ${order}`;
  const products = db.prepare(sql).all(...params);
  res.render('shop', { title: category ? category.name : 'Shop', products, category, q, sort });
});

router.get('/p/:slug', (req, res) => {
  const product = db.prepare(`
    SELECT p.*, c.name AS category_name, c.slug AS category_slug
    FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.slug = ? AND p.is_active = 1`).get(req.params.slug);
  if (!product) return res.status(404).render('error', { title: 'This piece is gone', message: "It sold out or is no longer available. Plenty more where it came from, though." });
  const variants = db.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order, id').all(product.id);
  const related = db.prepare(`${PRODUCT_LIST_SQL} AND p.category_id IS ? AND p.id != ? GROUP BY p.id HAVING COUNT(v.id) > 0 ORDER BY RANDOM() LIMIT 4`)
    .all(product.category_id, product.id);
  const meta = {
    description: product.description.slice(0, 160),
    image: product.image ? `${res.locals.baseUrl}${product.image}` : null,
  };
  res.render('product', { title: product.name, product, variants, related, meta });
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
  return { items, subtotal, shipping, total: subtotal + shipping };
}

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
    flash(req, 'error', v.stock > 0 ? `Only ${v.stock} left in size ${v.size}. Grab them while you can.` : `Size ${v.size} just sold out. Try another size?`);
    return res.redirect(`/p/${v.slug}`);
  }
  if (line) line.qty = newQty; else cart.push({ variantId, qty });
  req.session.cart = cart;
  flash(req, 'success', `Added to your cart: size ${v.size}.`);
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

/* ---------------- checkout (Stripe) ---------------- */

function sessionOrders(req) {
  return req.session.orders || [];
}

// If this shopper abandoned an earlier Stripe page, release that reservation before starting a new one.
async function releaseAbandoned(req) {
  const ids = sessionOrders(req);
  if (!ids.length) return;
  const open = db.prepare(`SELECT * FROM orders WHERE status = 'unpaid' AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  for (const o of open) {
    if (!o.stripe_session_id || await payments.expireSession(o.stripe_session_id)) payments.releaseUnpaid(o.id);
  }
}

router.get('/checkout', (req, res) => {
  const cart = loadCart(req);
  if (!cart.items.length) return res.redirect('/cart');
  const values = req.user ? { name: req.user.name, email: req.user.email } : {};
  res.render('checkout', { title: 'Checkout', cart, values, countries: COUNTRIES, paymentsReady: payments.enabled() });
});

router.post('/checkout', async (req, res) => {
  const cart = loadCart(req);
  if (!cart.items.length) return res.redirect('/cart');
  const f = {};
  for (const k of ['name', 'email', 'phone', 'address', 'city', 'postal_code', 'country', 'notes']) {
    f[k] = String(req.body[k] || '').trim().slice(0, 500);
  }
  const fail = (msg, status = 400) => res.status(status).render('checkout', {
    title: 'Checkout', cart, values: f, error: msg, countries: COUNTRIES, paymentsReady: payments.enabled(),
  });

  if (!payments.enabled()) return fail('Online payment is not available right now. Please try again a little later.', 503);
  if (f.name.length < 2) return fail('Please enter your full name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) return fail('Please enter a valid email so we can send your order updates.');
  if (f.phone.replace(/\D/g, '').length < 6) return fail('Please add a phone number. The courier may need it to reach you.');
  const country = countryName(f.country);
  if (!country) return fail('Please choose the country we are shipping to.');
  if (f.address.length < 4 || f.city.length < 2) return fail('Please enter your full delivery address and city.');

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
            ? `Almost! Only ${left} of ${item.product_name} (size ${item.size}) left. Please update your cart.`
            : `${item.product_name} in size ${item.size} just sold out. Please remove it from your cart.`), { userFacing: true });
        }
      }
      const info = db.prepare(`
        INSERT INTO orders (user_id, customer_name, email, phone, address, city, postal_code, country, notes,
                            subtotal_cents, shipping_cents, total_cents, status, currency, affiliate_id, commission_rate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?, ?, ?)`)
        .run(req.user ? req.user.id : null, f.name, f.email.toLowerCase(), f.phone, f.address, f.city, f.postal_code, country, f.notes,
          cart.subtotal, cart.shipping, cart.total, settings.currency, aff ? aff.id : null, aff ? settings.commission_rate : 0);
      const id = Number(info.lastInsertRowid);
      const insItem = db.prepare(`INSERT INTO order_items (order_id, product_id, variant_id, product_name, size, price_cents, qty)
                                  VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const decStock = db.prepare('UPDATE product_variants SET stock = stock - ? WHERE id = ?');
      for (const item of cart.items) {
        insItem.run(id, item.product_id, item.id, item.product_name, item.size, item.price_cents, item.qty);
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
  let session;
  try {
    session = await payments.createCheckoutSession({ order, items: cart.items, baseUrl: res.locals.baseUrl });
  } catch (err) {
    console.error('[stripe] Could not create checkout session', err.message);
    payments.releaseUnpaid(orderId);
    return fail('We could not open the payment page. You have not been charged. Please try again.', 502);
  }
  db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(session.id, orderId);
  res.redirect(303, session.url);
});

// Stripe sends shoppers here when they press "back" on the payment page.
router.get('/checkout/cancelled/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const order = sessionOrders(req).includes(id) && db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (order && order.status === 'unpaid') {
    if (!order.stripe_session_id || await payments.expireSession(order.stripe_session_id)) payments.releaseUnpaid(id);
  }
  flash(req, 'info', 'Payment cancelled. You have not been charged, and your cart is right where you left it.');
  res.redirect('/cart');
});

router.get('/order/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  let order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  const ownedBySession = sessionOrders(req).includes(id);
  const allowed = order && (ownedBySession || (req.user && (req.user.is_admin || order.user_id === req.user.id)));
  if (!allowed) return res.status(404).render('error', { title: 'Order not found', message: "We couldn't find that order. If you just paid, check your email for the confirmation link." });

  const returning = typeof req.query.session_id === 'string';
  if (returning) order = await payments.syncFromSession(order, req.query.session_id);
  // The cart is kept until payment succeeds, so a cancelled payment never loses it.
  if (ownedBySession && order.status !== 'unpaid' && order.status !== 'cancelled') {
    req.session.cart = [];
    res.locals.cartCount = 0;
  }

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id);
  res.render('order', { title: `Order #${id}`, order, items, placed: returning });
});

module.exports = router;
