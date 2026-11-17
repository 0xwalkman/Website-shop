const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { db, tx, setSetting, uniqueSlug } = require('../db');
const { flash, parseMoney, toArray } = require('../middleware');
const { balances, NETWORKS } = require('../affiliate');
const paypal = require('../paypal');
const { applyStatus } = require('../orders');
// Binance Pay (and older card orders) are refunded outside the store, then recorded here by hand.
// PayPal orders are refunded with the "Refund via PayPal" button instead.
const manualRefundAllowed = (order) => Boolean(order.paid_at) && order.payment_method !== 'paypal';
const binance = require('../binance');
const notify = require('../notify');
const pages = require('../pages');
const mailer = require('../mailer');

const router = express.Router();
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const ORDER_STATUSES = ['unpaid', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded'];
// Statuses an admin can set by hand. "refunded" is set by the refund flow (PayPal button, or manual for Binance).
const MANUAL_STATUSES = ['paid', 'shipped', 'delivered', 'cancelled'];
// Currencies PayPal accepts with 2 decimals (Binance Pay converts any of them).
const CURRENCIES = { usd: '$', eur: '€', gbp: '£', cad: 'CA$', aud: 'A$', chf: 'CHF' };

function removeUpload(file) {
  if (file && file.startsWith('/uploads/')) {
    fs.unlink(path.join(UPLOAD_DIR, path.basename(file)), () => {});
  }
}
// Single "image" upload (categories). Product photos use the multi-file "images" field.
function uploadedPath(req) {
  const f = req.files && req.files.image && req.files.image[0];
  return f ? `/uploads/${f.filename}` : null;
}

// Staff can work on products, categories, orders and stats. Everything touching money,
// payouts, customers' affiliate data, policies, settings and the team is owner-only.
const OWNER_ONLY = /^\/(discounts|affiliates|withdrawals|pages|settings|team)(\/|$)|^\/orders\/\d+\/refund$/;
router.use((req, res, next) => {
  res.locals.isOwner = Boolean(req.user.is_admin);
  if (!req.user.is_admin && OWNER_ONLY.test(req.path)) {
    return res.status(403).render('error', { title: 'Owner access only', message: 'Ask the store owner if you need access to this section.' });
  }
  next();
});

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
  if (uploadedPath(req)) { removeUpload(cat.image); image = uploadedPath(req); }
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

function productForm(res, { product, variants, images = [], error, status = 200 }) {
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all();
  res.status(status).render('admin/product-form', {
    title: product.id ? 'Edit product' : 'New product',
    product, variants, images, categories, error,
  });
}

// Parses the variant rows (color / size / price / sale price / stock) from the form.
function parseVariants(body) {
  const ids = toArray(body.v_id);
  const colors = toArray(body.v_color);
  const sizes = toArray(body.v_size);
  const prices = toArray(body.v_price);
  const compares = toArray(body.v_compare);
  const stocks = toArray(body.v_stock);
  const rows = [];
  const seen = new Set();
  for (let i = 0; i < sizes.length; i++) {
    const color = String(colors[i] || '').trim().slice(0, 30);
    const size = String(sizes[i] || '').trim().slice(0, 20);
    const priceRaw = prices[i];
    const compareRaw = String(compares[i] || '').trim();
    if (!size && !priceRaw && !color) continue; // empty row
    const price = parseMoney(priceRaw);
    const compare = compareRaw ? parseMoney(compareRaw) : null;
    const stock = parseInt(stocks[i], 10);
    const label = [color, size].filter(Boolean).join(' / ');
    const row = { id: parseInt(ids[i], 10) || null, color, size, price_cents: price, priceRaw, compare_at_cents: compare, compareRaw, stock: Number.isFinite(stock) ? stock : 0 };
    rows.push(row);
    if (!size) return { rows, error: 'Every row needs a size label (e.g. S, M, L, 32, or "One size").' };
    const key = `${color.toLowerCase()}|${size.toLowerCase()}`;
    if (seen.has(key)) return { rows, error: `"${label}" is listed twice.` };
    seen.add(key);
    if (!Number.isFinite(price) || price <= 0) return { rows, error: `Please enter a valid price for ${label}.` };
    if (compareRaw && (!Number.isFinite(compare) || compare <= price)) {
      return { rows, error: `The "was" price for ${label} must be higher than its price (leave it empty if it's not on sale).` };
    }
    if (row.stock < 0) return { rows, error: `Stock for ${label} cannot be negative.` };
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

const galleryUploads = (req) => ((req.files && req.files.images) || []).map((f) => `/uploads/${f.filename}`);
const discardUploads = (req) => [uploadedPath(req), ...galleryUploads(req)].forEach(removeUpload);

function saveVariants(productId, rows) {
  const keep = [];
  const upd = db.prepare('UPDATE product_variants SET color = ?, size = ?, price_cents = ?, compare_at_cents = ?, stock = ?, sort_order = ? WHERE id = ? AND product_id = ?');
  const ins = db.prepare('INSERT INTO product_variants (product_id, color, size, price_cents, compare_at_cents, stock, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
  rows.forEach((r, i) => {
    if (r.id && upd.run(r.color, r.size, r.price_cents, r.compare_at_cents, r.stock, i, r.id, productId).changes) keep.push(r.id);
    else keep.push(Number(ins.run(productId, r.color, r.size, r.price_cents, r.compare_at_cents, r.stock, i).lastInsertRowid));
  });
  const del = db.prepare('DELETE FROM product_variants WHERE product_id = ? AND id = ?');
  for (const v of db.prepare('SELECT id FROM product_variants WHERE product_id = ?').all(productId)) {
    if (!keep.includes(v.id)) del.run(productId, v.id);
  }
}

// Adds new photos, removes ticked ones, applies the chosen cover, and keeps products.image = cover photo.
function saveGallery(productId, req) {
  const removeIds = toArray(req.body.remove_image_ids).map(Number);
  for (const img of db.prepare('SELECT * FROM product_images WHERE product_id = ?').all(productId)) {
    if (removeIds.includes(img.id)) {
      db.prepare('DELETE FROM product_images WHERE id = ?').run(img.id);
      removeUpload(img.path);
    }
  }
  let next = (db.prepare('SELECT MAX(sort_order) AS m FROM product_images WHERE product_id = ?').get(productId).m ?? -1) + 1;
  const ins = db.prepare('INSERT INTO product_images (product_id, path, sort_order) VALUES (?, ?, ?)');
  for (const path of galleryUploads(req)) ins.run(productId, path, next++);
  const cover = parseInt(req.body.cover_image_id, 10);
  if (cover && !removeIds.includes(cover)) {
    db.prepare('UPDATE product_images SET sort_order = sort_order + 1 WHERE product_id = ?').run(productId);
    db.prepare('UPDATE product_images SET sort_order = 0 WHERE id = ? AND product_id = ?').run(cover, productId);
  }
  const first = db.prepare('SELECT path FROM product_images WHERE product_id = ? ORDER BY sort_order, id LIMIT 1').get(productId);
  db.prepare('UPDATE products SET image = ? WHERE id = ?').run(first ? first.path : null, productId);
}

const productImages = (id) => db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY sort_order, id').all(id);

router.get('/products/new', (req, res) => {
  productForm(res, {
    product: { is_active: 1 },
    variants: ['S', 'M', 'L', 'XL'].map((size) => ({ color: '', size, price_cents: null, stock: 10 })),
  });
});

router.post('/products', (req, res) => {
  const p = readProduct(req.body);
  const { rows, error } = parseVariants(req.body);
  const err = !p.name ? 'Product name is required.' : error;
  if (err) {
    discardUploads(req);
    return productForm(res, { product: p, variants: rows, error: err, status: 400 });
  }
  const id = tx(() => {
    const info = db.prepare('INSERT INTO products (category_id, name, slug, description, is_active) VALUES (?, ?, ?, ?, ?)')
      .run(p.category_id, p.name, uniqueSlug('products', p.name), p.description, p.is_active);
    const pid = Number(info.lastInsertRowid);
    saveVariants(pid, rows);
    saveGallery(pid, req);
    return pid;
  });
  flash(req, 'success', `Product "${p.name}" created.`);
  res.redirect(`/admin/products/${id}/edit`);
});

router.get('/products/:id/edit', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.redirect('/admin/products');
  const variants = db.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order, id').all(product.id);
  productForm(res, { product, variants, images: productImages(product.id) });
});

router.post('/products/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.redirect('/admin/products');
  const p = { ...readProduct(req.body), id: existing.id, image: existing.image, slug: existing.slug };
  const { rows, error } = parseVariants(req.body);
  const err = !p.name ? 'Product name is required.' : error;
  if (err) {
    discardUploads(req);
    return productForm(res, { product: p, variants: rows, images: productImages(existing.id), error: err, status: 400 });
  }
  const slug = p.name !== existing.name ? uniqueSlug('products', p.name, existing.id) : existing.slug;
  tx(() => {
    db.prepare('UPDATE products SET category_id = ?, name = ?, slug = ?, description = ?, is_active = ? WHERE id = ?')
      .run(p.category_id, p.name, slug, p.description, p.is_active, existing.id);
    saveVariants(existing.id, rows);
    saveGallery(existing.id, req);
  });
  flash(req, 'success', 'Product saved.');
  res.redirect(`/admin/products/${existing.id}/edit`);
});

router.post('/products/:id/delete', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (product) {
    const imgs = productImages(product.id);
    db.prepare('DELETE FROM products WHERE id = ?').run(product.id);
    imgs.forEach((i) => removeUpload(i.path));
    removeUpload(product.image);
    flash(req, 'success', `Product "${product.name}" deleted.`);
  }
  res.redirect('/admin/products');
});

/* ---------------- orders ---------------- */

router.get('/orders', (req, res) => {
  const status = ORDER_STATUSES.includes(req.query.status) ? req.query.status : '';
  // By default hide checkouts that were never paid (abandoned payment pages); they have their own filters.
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
  res.render('admin/order', {
    title: `Order #${order.id}`, order, items, commission,
    statuses: manualRefundAllowed(order) ? [...MANUAL_STATUSES, 'refunded'] : MANUAL_STATUSES,
    paypalReady: paypal.enabled(), carriers: Object.keys(CARRIERS),
  });
});

// Known carriers get a direct tracking link; anything else goes to 17TRACK, which covers most carriers worldwide.
const CARRIERS = {
  'DHL Express': (n) => `https://www.dhl.com/global-en/home/tracking/tracking-express.html?tracking-id=${n}`,
  FedEx: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
  UPS: (n) => `https://www.ups.com/track?tracknum=${n}`,
  USPS: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
  Aramex: (n) => `https://www.aramex.com/track/results?ShipmentNumber=${n}`,
  'Royal Mail': (n) => `https://www.royalmail.com/track-your-item#/tracking-results/${n}`,
  'Canada Post': (n) => `https://www.canadapost-postescanada.ca/track-reperage/en#/details/${n}`,
  'Australia Post': (n) => `https://auspost.com.au/mypost/track/details/${n}`,
  Other: (n) => `https://t.17track.net/en#nums=${n}`,
};
function trackingFrom(body) {
  const number = String(body.tracking_number || '').trim().replace(/\s+/g, '').slice(0, 60);
  if (!number) return {};
  const carrier = CARRIERS[body.tracking_carrier] ? body.tracking_carrier : 'Other';
  const custom = String(body.tracking_url || '').trim();
  const url = /^https:\/\/[^\s"<>]+$/.test(custom) ? custom.slice(0, 300) : CARRIERS[carrier](encodeURIComponent(number));
  return { number, carrier: carrier === 'Other' ? (String(body.tracking_carrier_other || '').trim().slice(0, 40) || 'Courier') : carrier, url };
}

router.post('/orders/:id/status', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  const status = req.body.status;
  const allowed = order && (MANUAL_STATUSES.includes(status) || (status === 'refunded' && manualRefundAllowed(order)));
  if (!allowed) return res.redirect('/admin/orders');
  const t = trackingFrom(req.body);
  if (status === 'shipped' && order.status !== 'shipped' && !t.number && !req.body.no_tracking) {
    flash(req, 'error', 'Add a tracking number (or tick "ship without tracking") so the customer can follow their parcel.');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  tx(() => {
    // Save tracking first so the "shipped" email includes it.
    if (t.number) {
      db.prepare('UPDATE orders SET tracking_carrier = ?, tracking_number = ?, tracking_url = ? WHERE id = ?')
        .run(t.carrier, t.number, t.url, order.id);
    }
    if (status !== order.status) applyStatus(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id), status);
  });
  flash(req, 'success', status !== order.status
    ? `Order #${order.id} is now ${status}.${['paid', 'shipped', 'delivered', 'refunded'].includes(status) ? ' The customer has been emailed.' : ''}`
    : 'Order updated.');
  res.redirect(`/admin/orders/${order.id}`);
});

router.post('/orders/:id/refund', async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.redirect('/admin/orders');
  if (order.payment_method !== 'paypal' || !order.paypal_capture_id || !paypal.enabled() || ['unpaid', 'refunded'].includes(order.status)) {
    flash(req, 'error', 'This order has no PayPal payment to refund.');
  } else {
    try {
      await paypal.refundOrder(order);
      flash(req, 'success', `Refunded ${(order.total_cents / 100).toFixed(2)} ${order.currency.toUpperCase()} for order #${order.id} through PayPal. Items are back in stock and the affiliate commission was cancelled.`);
    } catch (err) {
      flash(req, 'error', `PayPal refused the refund: ${err.message}`);
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
    notify.withdrawalProcessed(w.id);
    flash(req, 'success', `Withdrawal #${w.id} marked as paid. The affiliate has been emailed.`);
  } else if (action === 'reject') {
    db.prepare("UPDATE withdrawals SET status = 'rejected', admin_note = ?, processed_at = datetime('now') WHERE id = ?")
      .run(note, w.id);
    notify.withdrawalProcessed(w.id);
    flash(req, 'success', `Withdrawal #${w.id} rejected; the amount is back in the user's balance and they have been emailed.`);
  }
  res.redirect('/admin/withdrawals');
});

/* ---------------- security: two-factor login ---------------- */

const totp = require('../totp');
const QRCode = require('qrcode');

router.get('/security', async (req, res) => {
  let setup = null;
  if (!req.user.totp_enabled) {
    // A fresh secret is kept in the session until the user proves their app works.
    if (!req.session.totpSetup) req.session.totpSetup = totp.generateSecret();
    const url = totp.otpauthUrl(req.session.totpSetup, req.user.email, `${res.locals.settings.store_name} admin`);
    setup = { secret: req.session.totpSetup.replace(/(.{4})/g, '$1 ').trim(), qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) };
  }
  res.render('admin/security', { title: 'Security', setup });
});

router.post('/security', (req, res) => {
  const u = req.user;
  if (req.body.action === 'enable' && !u.totp_enabled) {
    const step = totp.verify(req.session.totpSetup, req.body.code);
    if (!step) { flash(req, 'error', "That code didn't match. Make sure you scanned the QR code, then enter the newest 6-digit code."); return res.redirect('/admin/security'); }
    db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_last_step = ? WHERE id = ?').run(req.session.totpSetup, step, u.id);
    delete req.session.totpSetup;
    flash(req, 'success', 'Two-step login is on. You will need your authenticator app each time you log in.');
  } else if (req.body.action === 'disable' && u.totp_enabled) {
    const step = totp.verify(u.totp_secret, req.body.code, u.totp_last_step);
    if (!step) { flash(req, 'error', "That code didn't work, so two-step login is still on."); return res.redirect('/admin/security'); }
    db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = 0 WHERE id = ?').run(u.id);
    flash(req, 'success', 'Two-step login turned off.');
  }
  res.redirect('/admin/security');
});

/* ---------------- team (owner only) ---------------- */

router.get('/team', (req, res) => {
  const team = db.prepare("SELECT id, name, email, is_admin, staff_role, totp_enabled FROM users WHERE is_admin = 1 OR staff_role IS NOT NULL ORDER BY is_admin DESC, name").all();
  res.render('admin/team', { title: 'Team', team });
});

router.post('/team', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim().slice(0, 80);
  const role = req.body.role === 'owner' ? 'owner' : 'staff';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { flash(req, 'error', 'Enter a valid email.'); return res.redirect('/admin/team'); }
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  let invited = false;
  if (!user) {
    // New person: create the account with a random password and email them a link to choose their own.
    const { createUser } = require('../db');
    const id = createUser({ name: name || email.split('@')[0], email, password: crypto.randomBytes(24).toString('hex') });
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    invited = true;
  }
  db.prepare('UPDATE users SET is_admin = ?, staff_role = ? WHERE id = ?').run(role === 'owner' ? 1 : 0, role === 'owner' ? null : 'staff', user.id);
  const token = crypto.randomBytes(32).toString('base64url');
  if (invited) {
    db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(crypto.createHash('sha256').update(token).digest('hex'), user.id, Date.now() + 7 * 24 * 3600 * 1000);
  }
  require('../mailer').queue(email, `You've been added to the ${res.locals.settings.store_name} team`, {
    heading: `Welcome to the ${res.locals.settings.store_name} team!`,
    blocks: [`${req.user.name} gave you ${role === 'owner' ? 'full owner' : 'staff'} access to the store admin.`,
      invited ? 'Choose a password to get started. This link works for 7 days.' : 'Log in with your existing account to get started.'],
    button: invited ? { label: 'Choose my password', url: `${mailer.siteUrl()}/reset/${token}` } : { label: 'Open the admin', url: `${mailer.siteUrl()}/admin` },
    footnote: 'For security, please turn on two-step login under Admin → Security.',
  });
  flash(req, 'success', `${email} now has ${role} access${invited ? ' and has been emailed an invitation' : ''}.`);
  res.redirect('/admin/team');
});

router.post('/team/:id/remove', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  const owners = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n;
  if (!target) return res.redirect('/admin/team');
  if (target.id === req.user.id) { flash(req, 'error', "You can't remove your own access."); return res.redirect('/admin/team'); }
  if (target.is_admin && owners <= 1) { flash(req, 'error', 'The store needs at least one owner.'); return res.redirect('/admin/team'); }
  db.prepare('UPDATE users SET is_admin = 0, staff_role = NULL WHERE id = ?').run(target.id);
  require('./auth').signOutEverywhere(target.id);
  flash(req, 'success', `${target.email} no longer has admin access.`);
  res.redirect('/admin/team');
});

/* ---------------- statistics ---------------- */

router.get('/stats', (req, res) => {
  res.render('admin/stats', { title: 'Statistics', r: require('../analytics').report(30) });
});

/* ---------------- discount codes ---------------- */

router.get('/discounts', (req, res) => {
  const codes = db.prepare(`SELECT d.*,
      (SELECT COUNT(*) FROM orders o WHERE o.discount_code = d.code AND o.status IN ('paid','shipped','delivered')) AS orders,
      (SELECT COALESCE(SUM(discount_cents),0) FROM orders o WHERE o.discount_code = d.code AND o.status IN ('paid','shipped','delivered')) AS given
    FROM discount_codes d ORDER BY d.active DESC, d.id DESC`).all();
  res.render('admin/discounts', { title: 'Discount codes', codes, today: new Date().toISOString().slice(0, 10) });
});

router.post('/discounts', (req, res) => {
  const b = req.body;
  const code = String(b.code || '').trim().toUpperCase();
  const kind = b.kind === 'fixed' ? 'fixed' : 'percent';
  const value = kind === 'percent' ? parseInt(b.value, 10) : parseMoney(b.value);
  const min = b.min_subtotal ? parseMoney(b.min_subtotal) : 0;
  const maxUses = b.max_uses ? parseInt(b.max_uses, 10) : null;
  const expires = /^\d{4}-\d{2}-\d{2}$/.test(b.expires_at || '') ? b.expires_at : null;
  let err = null;
  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) err = 'Codes need 3-30 letters, numbers, - or _ (e.g. SUMMER20).';
  else if (kind === 'percent' && !(value >= 1 && value <= 90)) err = 'Percent off must be between 1 and 90.';
  else if (kind === 'fixed' && !(value > 0)) err = 'Enter the amount off.';
  else if (!Number.isFinite(min) || min < 0) err = 'Minimum order is not a valid amount.';
  else if (maxUses !== null && !(maxUses > 0)) err = 'Max uses must be a positive number (or empty for unlimited).';
  else if (db.prepare('SELECT 1 FROM discount_codes WHERE code = ?').get(code)) err = `${code} already exists.`;
  if (err) { flash(req, 'error', err); return res.redirect('/admin/discounts'); }
  db.prepare('INSERT INTO discount_codes (code, kind, value, min_subtotal_cents, max_uses, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(code, kind, value, min, maxUses, expires);
  flash(req, 'success', `Code ${code} created. Share it with your customers!`);
  res.redirect('/admin/discounts');
});

router.post('/discounts/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM discount_codes WHERE id = ?').get(req.params.id);
  if (d && req.body.action === 'toggle') {
    db.prepare('UPDATE discount_codes SET active = 1 - active WHERE id = ?').run(d.id);
    flash(req, 'success', `${d.code} ${d.active ? 'paused' : 'activated'}.`);
  } else if (d && req.body.action === 'delete') {
    db.prepare('DELETE FROM discount_codes WHERE id = ?').run(d.id);
    flash(req, 'success', `${d.code} deleted. Past orders keep their discount.`);
  }
  res.redirect('/admin/discounts');
});

/* ---------------- pages ---------------- */

router.get('/pages', (req, res) => {
  res.render('admin/pages', { title: 'Pages', pages: pages.listPages() });
});

router.get('/pages/:slug', (req, res) => {
  const page = pages.getPage(req.params.slug);
  if (!page) return res.redirect('/admin/pages');
  res.render('admin/page-form', { title: `Edit: ${page.title}`, page });
});

router.post('/pages/:slug', (req, res) => {
  const slug = req.params.slug;
  if (req.body.reset) {
    pages.resetPage(slug);
    flash(req, 'success', 'Page reset to the starter text.');
  } else {
    const title = String(req.body.title || '').trim().slice(0, 120);
    const body = String(req.body.body || '').slice(0, 50000);
    if (!title || !body.trim()) { flash(req, 'error', 'Title and text are required.'); return res.redirect(`/admin/pages/${slug}`); }
    pages.savePage(slug, title, body);
    flash(req, 'success', 'Page saved.');
  }
  res.redirect(`/admin/pages/${slug}`);
});

/* ---------------- settings ---------------- */

router.get('/settings', (req, res) => {
  res.render('admin/settings', { title: 'Settings', currencies: CURRENCIES, paypalReady: paypal.enabled(), paypalLive: paypal.live(), paypalCurrencyOk: paypal.SUPPORTED_CURRENCIES.includes(res.locals.settings.currency), binanceReady: binance.enabled(), binanceCurrency: binance.payCurrency(),
    smtpReady: mailer.smtpConfigured(),
    emailStats: db.prepare("SELECT status, COUNT(*) AS n FROM emails WHERE created_at >= datetime('now', '-7 days') GROUP BY status").all(),
    failedEmails: db.prepare("SELECT id, to_addr, subject, error, created_at FROM emails WHERE status = 'failed' ORDER BY id DESC LIMIT 5").all() });
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
  const email = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  for (const key of ['contact_email', 'admin_notify_email']) {
    const v = String(b[key] || '').trim().slice(0, 160);
    if (!v || email(v)) setSetting(key, v); else errors.push(key.replace(/_/g, ' '));
  }
  const wa = String(b.whatsapp_number || '').trim();
  if (!wa || /^\+?[0-9 ()-]{7,20}$/.test(wa)) setSetting('whatsapp_number', wa); else errors.push('WhatsApp number');
  for (const key of ['business_name', 'business_address', 'processing_days', 'delivery_estimate']) {
    if (key in b) setSetting(key, String(b[key] || '').trim().slice(0, 200));
  }
  const rd = parseInt(b.returns_days, 10);
  if (rd >= 0 && rd <= 365) setSetting('returns_days', rd); else errors.push('return days');
  const rate = parseFloat(b.commission_rate);
  if (Number.isFinite(rate) && rate >= 0 && rate <= 90) setSetting('commission_rate', rate); else errors.push('commission rate');

  flash(req, errors.length ? 'error' : 'success', errors.length ? `Invalid value for: ${errors.join(', ')}.` : 'Settings saved.');
  res.redirect('/admin/settings');
});

module.exports = router;
