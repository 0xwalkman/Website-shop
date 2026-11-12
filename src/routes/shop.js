const express = require('express');
const { db, tx, getSettings } = require('../db');
const { flash, currentAffiliate } = require('../middleware');
const { commissionStatusFor } = require('../affiliate');

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
  if (!product) return res.status(404).render('error', { title: 'Not found', message: 'This product is not available.' });
  const variants = db.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order, id').all(product.id);
  const related = db.prepare(`${PRODUCT_LIST_SQL} AND p.category_id IS ? AND p.id != ? GROUP BY p.id HAVING COUNT(v.id) > 0 ORDER BY RANDOM() LIMIT 4`)
    .all(product.category_id, product.id);
  res.render('product', { title: product.name, product, variants, related });
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
    flash(req, 'error', 'Please choose a size.');
    return res.redirect(req.get('referer') || '/shop');
  }
  const cart = req.session.cart || [];
  const line = cart.find((l) => l.variantId === variantId);
  const newQty = (line ? line.qty : 0) + qty;
  if (newQty > v.stock) {
    flash(req, 'error', v.stock > 0 ? `Only ${v.stock} left in size ${v.size}.` : `Size ${v.size} is out of stock.`);
    return res.redirect(`/p/${v.slug}`);
  }
  if (line) line.qty = newQty; else cart.push({ variantId, qty });
  req.session.cart = cart;
  flash(req, 'success', `Added to cart (size ${v.size}).`);
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
    if (line && line.qty < qty) flash(req, 'info', `Only ${v.stock} available.`);
  }
  req.session.cart = cart.filter((l) => l.qty > 0);
  res.redirect('/cart');
});

/* ---------------- checkout ---------------- */

router.get('/checkout', (req, res) => {
  const cart = loadCart(req);
  if (!cart.items.length) return res.redirect('/cart');
  const values = req.user ? { name: req.user.name, email: req.user.email } : {};
  res.render('checkout', { title: 'Checkout', cart, values });
});

router.post('/checkout', (req, res) => {
  const cart = loadCart(req);
  if (!cart.items.length) return res.redirect('/cart');
  const f = {};
  for (const k of ['name', 'email', 'phone', 'address', 'city', 'notes']) f[k] = String(req.body[k] || '').trim().slice(0, 500);
  const fail = (msg) => res.status(400).render('checkout', { title: 'Checkout', cart, values: f, error: msg });

  if (f.name.length < 2) return fail('Please enter your full name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) return fail('Please enter a valid email.');
  if (f.phone.replace(/\D/g, '').length < 6) return fail('Please enter a valid phone number.');
  if (f.address.length < 4 || f.city.length < 2) return fail('Please enter your delivery address and city.');

  const settings = getSettings();
  const aff = currentAffiliate(req, f.email);

  let orderId;
  try {
    orderId = tx(() => {
      // Re-check stock inside the transaction
      for (const item of cart.items) {
        const fresh = db.prepare('SELECT stock FROM product_variants WHERE id = ?').get(item.id);
        if (!fresh || fresh.stock < item.qty) {
          throw Object.assign(new Error(`Sorry, ${item.product_name} (${item.size}) only has ${fresh ? fresh.stock : 0} left.`), { userFacing: true });
        }
      }
      const info = db.prepare(`
        INSERT INTO orders (user_id, customer_name, email, phone, address, city, notes,
                            subtotal_cents, shipping_cents, total_cents, status, affiliate_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(req.user ? req.user.id : null, f.name, f.email.toLowerCase(), f.phone, f.address, f.city, f.notes,
          cart.subtotal, cart.shipping, cart.total, aff ? aff.id : null);
      const id = Number(info.lastInsertRowid);
      const insItem = db.prepare(`INSERT INTO order_items (order_id, product_id, variant_id, product_name, size, price_cents, qty)
                                  VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const decStock = db.prepare('UPDATE product_variants SET stock = stock - ? WHERE id = ?');
      for (const item of cart.items) {
        insItem.run(id, item.product_id, item.id, item.product_name, item.size, item.price_cents, item.qty);
        decStock.run(item.qty, item.id);
      }
      if (aff && settings.commission_rate > 0) {
        // Commission is calculated on the product subtotal (shipping excluded).
        const amount = Math.floor(cart.subtotal * settings.commission_rate / 100);
        db.prepare(`INSERT INTO commissions (affiliate_id, order_id, order_amount_cents, rate, amount_cents, status)
                    VALUES (?, ?, ?, ?, ?, ?)`)
          .run(aff.id, id, cart.subtotal, settings.commission_rate, amount, commissionStatusFor('pending'));
      }
      return id;
    });
  } catch (err) {
    if (err.userFacing) return fail(err.message);
    throw err;
  }

  req.session.cart = [];
  req.session.orders = [...(req.session.orders || []), orderId].slice(-20);
  res.redirect(`/order/${orderId}?placed=1`);
});

router.get('/order/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  const allowed = order && (
    (req.session.orders || []).includes(id) ||
    (req.user && (req.user.is_admin || order.user_id === req.user.id))
  );
  if (!allowed) return res.status(404).render('error', { title: 'Not found', message: 'Order not found.' });
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id);
  res.render('order', { title: `Order #${id}`, order, items, placed: req.query.placed === '1' });
});

module.exports = router;
