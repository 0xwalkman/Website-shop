const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { db, tx, setSetting, uniqueSlug } = require('../db');
const { flash, parseMoney, toArray } = require('../middleware');
const { balances, NETWORKS } = require('../affiliate');
const payments = require('../payments');
const binance = require('../binance');

const router = express.Router();
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const ORDER_STATUSES = ['unpaid', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded'];
// Statuses an admin can set by hand. "refunded" goes through the Stripe refund button instead.
const MANUAL_STATUSES = ['paid', 'shipped', 'delivered', 'cancelled'];
// Stripe settles these with two decimals, which matches how prices are stored.
const CURRENCIES = { usd: '$', eur: '€', gbp: '£', cad: 'CA$', aud: 'A$', chf: 'CHF', aed: 'AED', sar: 'SAR', mad: 'MAD' };

function removeUpload(file) {
  if (file && file.startsWith('/uploads/')) {
    fs.unlink(path.join(UPLOAD_DIR, path.basename(file)), () => {});
  }
}
function uploadedPath(req) {
  return req.file ? `/uploads/${req.file.filename}` : null;
}

router.use((req, res, next) => {
  res.locals.adminPendingWithdrawals = db.prepare("SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'pending'").get().n;
  res.locals.adminPendingOrders = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'").get().n; // paid, waiting to ship
  next();
});

/* ---------------- dashboard ---------------- */

router.get('/', (req, res) => {
  const s = {
    revenue: db.prepare("SELECT COALESCE(SUM(total_cents),0) AS v FROM orders WHERE status IN ('paid','shipped','delivered')").get().v,
    orders: db.prepare("SELECT COUNT(*) AS v FROM orders WHERE status IN ('paid','shipped','delivered')").get().v,
    products: db.prepare('SELECT COUNT(*) AS v FROM products').get().v,
    customers: db.prepare('SELECT COUNT(*) AS v FROM users WHERE is_admin = 0').get().v,
    commissionsOwed: db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS v FROM commissions WHERE status IN ('pending','approved')").get().v,
    paidOut: db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS v FROM withdrawals WHERE status = 'paid'").get().v,
    lowStock: db.prepare(`SELECT v.*, p.name AS product_name, p.id AS pid FROM product_variants v
                          JOIN products p ON p.id = v.product_id WHERE v.stock <= 3 ORDER BY v.stock LIMIT 10`).all(),
  };
  const recent = db.prepare("SELECT * FROM orders WHERE paid_at IS NOT NULL OR status NOT IN ('unpaid', 'cancelled') ORDER BY id DESC LIMIT 8").all();
  res.render('admin/dashboard', { title: 'Dashboard', s, recent });
});

/* ---------------- categories ---------------- */

router.get('/categories', (req, res) => {
  const categories = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
                                 FROM categories c ORDER BY sort_order, name`).all();
  res.render('admin/categories', { title: 'Categories', categories, edit: null });
});

router.get('/categories/:id/edit', (req, res) => {
  const edit = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!edit) return res.redirect('/admin/categories');
  const categories = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
                                 FROM categories c ORDER BY sort_order, name`).all();
  res.render('admin/categories', { title: 'Edit category', categories, edit });
});

router.post('/categories', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const sort = parseInt(req.body.sort_order, 10) || 0;
  if (!name) {
    removeUpload(uploadedPath(req));
    flash(req, 'error', 'Category name is required.');
    return res.redirect('/admin/categories');
  }
  db.prepare('INSERT INTO categories (name, slug, image, sort_order) VALUES (?, ?, ?, ?)')
    .run(name, uniqueSlug('categories', name), uploadedPath(req), sort);
  flash(req, 'success', `Category "${name}" created.`);
  res.redirect('/admin/categories');
});

router.post('/categories/:id', (req, res) => {
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!cat) return res.redirect('/admin/categories');
  const name = String(req.body.name || '').trim().slice(0, 80) || cat.name;
  const sort = parseInt(req.body.sort_order, 10) || 0;
  let image = cat.image;
  if (req.file) { removeUpload(cat.image); image = uploadedPath(req); }
  else if (req.body.remove_image) { removeUpload(cat.image); image = null; }
  const slug = name !== cat.name ? uniqueSlug('categories', name, cat.id) : cat.slug;
  db.prepare('UPDATE categories SET name = ?, slug = ?, image = ?, sort_order = ? WHERE id = ?').run(name, slug, image, sort, cat.id);
  flash(req, 'success', 'Category updated.');
  res.redirect('/admin/categories');
});

router.post('/categories/:id/delete', (req, res) => {
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (cat) {
    db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id);
    removeUpload(cat.image);
    flash(req, 'success', `Category "${cat.name}" deleted. Its products are now uncategorised.`);
  }
  res.redirect('/admin/categories');
});

/* ---------------- products ---------------- */

router.get('/products', (req, res) => {
  const catId = parseInt(req.query.category, 10) || null;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const where = [];
  const params = [];
  if (catId) { where.push('p.category_id = ?'); params.push(catId); }
  if (q) { where.push('p.name LIKE ?'); params.push(`%${q}%`); }
  const products = db.prepare(`
    SELECT p.*, c.name AS category_name, MIN(v.price_cents) AS min_price, MAX(v.price_cents) AS max_price,
           COALESCE(SUM(v.stock),0) AS total_stock, GROUP_CONCAT(v.size, ', ') AS sizes
    FROM products p LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN product_variants v ON v.product_id = p.id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    GROUP BY p.id ORDER BY p.id DESC`).all(...params);
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all();
  res.render('admin/products', { title: 'Products', products, categories, catId, q });
});

function productForm(res, { product, variants, error, status = 200 }) {
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all();
  res.status(status).render('admin/product-form', {
    title: product.id ? 'Edit product' : 'New product',
    product, variants, categories, error,
  });
}

// Parses the variant rows (size / price / stock) from the form.
function parseVariants(body) {
  const ids = toArray(body.v_id);
  const sizes = toArray(body.v_size);
  const prices = toArray(body.v_price);
  const stocks = toArray(body.v_stock);
  const rows = [];
  const seen = new Set();
  for (let i = 0; i < sizes.length; i++) {
    const size = String(sizes[i] || '').trim().slice(0, 20);
    const priceRaw = prices[i];
    if (!size && !priceRaw) continue; // empty row
    const price = parseMoney(priceRaw);
    const stock = parseInt(stocks[i], 10);
    const row = { id: parseInt(ids[i], 10) || null, size, price_cents: price, priceRaw, stock: Number.isFinite(stock) ? stock : 0 };
    rows.push(row);
    if (!size) return { rows, error: 'Every size row needs a size label (e.g. S, M, L, 32).' };
    if (seen.has(size.toLowerCase())) return { rows, error: `Size "${size}" is listed twice.` };
    seen.add(size.toLowerCase());
    if (!Number.isFinite(price) || price <= 0) return { rows, error: `Please enter a valid price for size ${size}.` };
    if (row.stock < 0) return { rows, error: `Stock for size ${size} cannot be negative.` };
  }
  if (!rows.length) return { rows, error: 'Add at least one size with a price.' };
  return { rows, error: null };
}

function readProduct(body) {
  return {
    name: String(body.name || '').trim().slice(0, 120),
    description: String(body.description || '').trim().slice(0, 5000),
    category_id: parseInt(body.category_id, 10) || null,
    is_active: body.is_active ? 1 : 0,
  };
}

router.get('/products/new', (req, res) => {
  productForm(res, {
    product: { is_active: 1 },
    variants: ['S', 'M', 'L', 'XL'].map((size) => ({ size, price_cents: null, stock: 10 })),
  });
});

router.post('/products', (req, res) => {
  const p = readProduct(req.body);
  const { rows, error } = parseVariants(req.body);
  const err = !p.name ? 'Product name is required.' : error;
  if (err) {
    removeUpload(uploadedPath(req));
    return productForm(res, { product: p, variants: rows, error: err, status: 400 });
  }
  const id = tx(() => {
    const info = db.prepare('INSERT INTO products (category_id, name, slug, description, image, is_active) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.category_id, p.name, uniqueSlug('products', p.name), p.description, uploadedPath(req), p.is_active);
    const pid = Number(info.lastInsertRowid);
    const ins = db.prepare('INSERT INTO product_variants (product_id, size, price_cents, stock, sort_order) VALUES (?, ?, ?, ?, ?)');
    rows.forEach((r, i) => ins.run(pid, r.size, r.price_cents, r.stock, i));
    return pid;
  });
  flash(req, 'success', `Product "${p.name}" created.`);
  res.redirect(`/admin/products/${id}/edit`);
});

router.get('/products/:id/edit', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.redirect('/admin/products');
  const variants = db.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order, id').all(product.id);
  productForm(res, { product, variants });
});

router.post('/products/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.redirect('/admin/products');
  const p = { ...readProduct(req.body), id: existing.id, image: existing.image, slug: existing.slug };
  const { rows, error } = parseVariants(req.body);
  const err = !p.name ? 'Product name is required.' : error;
  if (err) {
    removeUpload(uploadedPath(req));
    return productForm(res, { product: p, variants: rows, error: err, status: 400 });
  }
  let image = existing.image;
  if (req.file) { removeUpload(existing.image); image = uploadedPath(req); }
  else if (req.body.remove_image) { removeUpload(existing.image); image = null; }
  const slug = p.name !== existing.name ? uniqueSlug('products', p.name, existing.id) : existing.slug;

  tx(() => {
    db.prepare('UPDATE products SET category_id = ?, name = ?, slug = ?, description = ?, image = ?, is_active = ? WHERE id = ?')
      .run(p.category_id, p.name, slug, p.description, image, p.is_active, existing.id);
    const keep = [];
    const upd = db.prepare('UPDATE product_variants SET size = ?, price_cents = ?, stock = ?, sort_order = ? WHERE id = ? AND product_id = ?');
    const ins = db.prepare('INSERT INTO product_variants (product_id, size, price_cents, stock, sort_order) VALUES (?, ?, ?, ?, ?)');
    rows.forEach((r, i) => {
      if (r.id && upd.run(r.size, r.price_cents, r.stock, i, r.id, existing.id).changes) keep.push(r.id);
      else keep.push(Number(ins.run(existing.id, r.size, r.price_cents, r.stock, i).lastInsertRowid));
    });
    const del = db.prepare('DELETE FROM product_variants WHERE product_id = ? AND id = ?');
    for (const v of db.prepare('SELECT id FROM product_variants WHERE product_id = ?').all(existing.id)) {
      if (!keep.includes(v.id)) del.run(existing.id, v.id);
    }
  });
  flash(req, 'success', 'Product saved.');
  res.redirect(`/admin/products/${existing.id}/edit`);
});

router.post('/products/:id/delete', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (product) {
    db.prepare('DELETE FROM products WHERE id = ?').run(product.id);
    removeUpload(product.image);
    flash(req, 'success', `Product "${product.name}" deleted.`);
  }
  res.redirect('/admin/products');
});

/* ---------------- orders ---------------- */

router.get('/orders', (req, res) => {
  const status = ORDER_STATUSES.includes(req.query.status) ? req.query.status : '';
  // By default hide checkouts that were never paid (abandoned Stripe pages); they have their own filters.
  const where = status ? 'WHERE o.status = ?' : "WHERE o.paid_at IS NOT NULL OR o.status NOT IN ('unpaid', 'cancelled')";
  const orders = db.prepare(`
    SELECT o.*, u.name AS affiliate_name, (SELECT SUM(qty) FROM order_items WHERE order_id = o.id) AS item_count
    FROM orders o LEFT JOIN users u ON u.id = o.affiliate_id
    ${where} ORDER BY o.id DESC LIMIT 200`).all(...(status ? [status] : []));
  res.render('admin/orders', { title: 'Orders', orders, status, statuses: ORDER_STATUSES });
});

router.get('/orders/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.redirect('/admin/orders');
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  const commission = db.prepare(`SELECT c.*, u.name AS affiliate_name, u.email AS affiliate_email
                                  FROM commissions c JOIN users u ON u.id = c.affiliate_id WHERE c.order_id = ?`).get(order.id);
  res.render('admin/order', { title: `Order #${order.id}`, order, items, commission, statuses: order.payment_method === 'binance' && order.paid_at ? [...MANUAL_STATUSES, 'refunded'] : MANUAL_STATUSES, stripeReady: payments.enabled() });
});

router.post('/orders/:id/status', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  const status = req.body.status;
  // Binance Pay refunds are made in the Binance merchant dashboard, then recorded here by hand.
  const allowed = order && (MANUAL_STATUSES.includes(status) || (status === 'refunded' && order.payment_method === 'binance' && order.paid_at));
  if (!allowed) return res.redirect('/admin/orders');
  if (status !== order.status) {
    // Stock and the affiliate commission follow the status (cancelling returns items to stock).
    tx(() => payments.applyStatus(order, status));
    flash(req, 'success', `Order #${order.id} is now ${status}.`);
  }
  res.redirect(`/admin/orders/${order.id}`);
});

router.post('/orders/:id/refund', async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.redirect('/admin/orders');
  if (order.payment_method !== 'stripe' || !order.stripe_payment_intent || !payments.enabled() || ['unpaid', 'refunded'].includes(order.status)) {
    flash(req, 'error', 'This order has no Stripe payment to refund.');
  } else {
    try {
      await payments.refundOrder(order);
      flash(req, 'success', `Refunded ${(order.total_cents / 100).toFixed(2)} ${order.currency.toUpperCase()} for order #${order.id}. Items are back in stock and the affiliate commission was cancelled.`);
    } catch (err) {
      flash(req, 'error', `Stripe refused the refund: ${err.message}`);
    }
  }
  res.redirect(`/admin/orders/${order.id}`);
});

/* ---------------- affiliates & withdrawals ---------------- */

router.get('/affiliates', (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.name, u.email, u.referral_code, u.wallet_address, u.wallet_network, u.created_at,
      (SELECT COUNT(*) FROM referral_clicks r WHERE r.affiliate_id = u.id) AS clicks,
      (SELECT COUNT(*) FROM orders o WHERE o.affiliate_id = u.id AND o.status != 'cancelled') AS orders
    FROM users u ORDER BY orders DESC, clicks DESC, u.id DESC LIMIT 500`).all();
  for (const u of users) u.bal = balances(u.id);
  res.render('admin/affiliates', { title: 'Affiliates', users, networks: NETWORKS });
});

router.get('/withdrawals', (req, res) => {
  const status = ['pending', 'paid', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const withdrawals = db.prepare(`
    SELECT w.*, u.name, u.email FROM withdrawals w JOIN users u ON u.id = w.user_id
    WHERE w.status = ? ORDER BY w.id ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 200`).all(status);
  res.render('admin/withdrawals', { title: 'Withdrawals', withdrawals, status, networks: NETWORKS });
});

router.post('/withdrawals/:id', (req, res) => {
  const w = db.prepare("SELECT * FROM withdrawals WHERE id = ? AND status = 'pending'").get(req.params.id);
  if (!w) return res.redirect('/admin/withdrawals');
  const action = req.body.action;
  const note = String(req.body.note || '').trim().slice(0, 500) || null;
  if (action === 'paid') {
    const txHash = String(req.body.tx_hash || '').trim().slice(0, 200);
    if (!txHash) {
      flash(req, 'error', 'Please paste the transaction hash of the USDC transfer.');
      return res.redirect('/admin/withdrawals');
    }
    db.prepare("UPDATE withdrawals SET status = 'paid', tx_hash = ?, admin_note = ?, processed_at = datetime('now') WHERE id = ?")
      .run(txHash, note, w.id);
    flash(req, 'success', `Withdrawal #${w.id} marked as paid.`);
  } else if (action === 'reject') {
    db.prepare("UPDATE withdrawals SET status = 'rejected', admin_note = ?, processed_at = datetime('now') WHERE id = ?")
      .run(note, w.id);
    flash(req, 'success', `Withdrawal #${w.id} rejected; the amount is back in the user's balance.`);
  }
  res.redirect('/admin/withdrawals');
});

/* ---------------- settings ---------------- */

router.get('/settings', (req, res) => {
  res.render('admin/settings', { title: 'Settings', currencies: CURRENCIES, stripeReady: payments.enabled(), webhookReady: Boolean(process.env.STRIPE_WEBHOOK_SECRET), binanceReady: binance.enabled(), binanceCurrency: binance.payCurrency() });
});

router.post('/settings', (req, res) => {
  const b = req.body;
  const errors = [];
  const name = String(b.store_name || '').trim().slice(0, 60);
  if (name) setSetting('store_name', name);
  setSetting('tagline', String(b.tagline || '').trim().slice(0, 140));
  if (CURRENCIES[b.currency]) {
    setSetting('currency', b.currency);
    setSetting('currency_symbol', CURRENCIES[b.currency]);
  }

  const moneyFields = { shipping: 'shipping_cents', free_shipping_over: 'free_shipping_over_cents', min_withdrawal: 'min_withdrawal_cents' };
  for (const [field, key] of Object.entries(moneyFields)) {
    const v = parseMoney(b[field]);
    if (Number.isFinite(v)) setSetting(key, v); else errors.push(field.replace(/_/g, ' '));
  }
  const rate = parseFloat(b.commission_rate);
  if (Number.isFinite(rate) && rate >= 0 && rate <= 90) setSetting('commission_rate', rate); else errors.push('commission rate');

  flash(req, errors.length ? 'error' : 'success', errors.length ? `Invalid value for: ${errors.join(', ')}.` : 'Settings saved.');
  res.redirect('/admin/settings');
});

module.exports = router;
