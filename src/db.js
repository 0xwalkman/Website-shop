const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'store.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  referral_code TEXT NOT NULL UNIQUE,
  referred_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  wallet_address TEXT,
  wallet_network TEXT,
  wallet_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  image TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  image TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS product_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  subtotal_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  affiliate_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  variant_id INTEGER REFERENCES product_variants(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  size TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  qty INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS referral_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  affiliate_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visitor_hash TEXT,
  landing TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  affiliate_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  order_amount_cents INTEGER NOT NULL,
  rate REAL NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  wallet_address TEXT NOT NULL,
  wallet_network TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  tx_hash TEXT,
  admin_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_orders_affiliate ON orders(affiliate_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_clicks_affiliate ON referral_clicks(affiliate_id);
CREATE INDEX IF NOT EXISTS idx_commissions_affiliate ON commissions(affiliate_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
`);

/* ---------- helpers ---------- */

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const DEFAULT_SETTINGS = {
  store_name: 'Threadline',
  tagline: 'Everyday clothing, delivered.',
  currency_symbol: '$',
  shipping_cents: '500',
  free_shipping_over_cents: '10000',
  commission_rate: '10',
  min_withdrawal_cents: '1000',
  commission_hold_note: 'Commissions become available once the referred order is delivered.',
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return {
    ...s,
    shipping_cents: parseInt(s.shipping_cents, 10) || 0,
    free_shipping_over_cents: parseInt(s.free_shipping_over_cents, 10) || 0,
    commission_rate: parseFloat(s.commission_rate) || 0,
    min_withdrawal_cents: parseInt(s.min_withdrawal_cents, 10) || 0,
  };
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'item';
}

function uniqueSlug(table, base, excludeId = null) {
  const root = slugify(base);
  let slug = root;
  let i = 2;
  const stmt = db.prepare(`SELECT id FROM ${table} WHERE slug = ? AND id IS NOT ?`);
  while (stmt.get(slug, excludeId)) slug = `${root}-${i++}`;
  return slug;
}

function generateReferralCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const exists = db.prepare('SELECT 1 FROM users WHERE referral_code = ?');
  let code;
  do {
    code = Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
  } while (exists.get(code));
  return code;
}

function createUser({ name, email, password, isAdmin = false, referredBy = null }) {
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(
    'INSERT INTO users (name, email, password_hash, is_admin, referral_code, referred_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, email.toLowerCase(), hash, isAdmin ? 1 : 0, generateReferralCode(), referredBy);
  return Number(info.lastInsertRowid);
}

/* ---------- bootstrap admin ---------- */

function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@store.local').toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(existing.id);
    return;
  }
  const anyAdmin = db.prepare('SELECT 1 FROM users WHERE is_admin = 1').get();
  if (anyAdmin && !process.env.ADMIN_EMAIL) return;
  const password = process.env.ADMIN_PASSWORD || 'admin12345';
  createUser({ name: 'Store Admin', email, password, isAdmin: true });
  console.log(`[setup] Admin account created: ${email}${process.env.ADMIN_PASSWORD ? '' : ' / admin12345 (change it!)'}`);
}

/* ---------- demo data ---------- */

function seedDemo() {
  if (process.env.SEED_DEMO === 'false') return;
  if (db.prepare('SELECT 1 FROM categories').get()) return;

  const cats = [
    ['T-Shirts', 1], ['Hoodies', 2], ['Jeans', 3], ['Dresses', 4],
  ];
  const catIds = {};
  const insCat = db.prepare('INSERT INTO categories (name, slug, sort_order) VALUES (?, ?, ?)');
  const insProd = db.prepare('INSERT INTO products (category_id, name, slug, description) VALUES (?, ?, ?, ?)');
  const insVar = db.prepare('INSERT INTO product_variants (product_id, size, price_cents, stock, sort_order) VALUES (?, ?, ?, ?, ?)');

  tx(() => {
    for (const [name, order] of cats) {
      catIds[name] = Number(insCat.run(name, slugify(name), order).lastInsertRowid);
    }
    const products = [
      ['T-Shirts', 'Classic Cotton Tee', 'Soft 100% organic cotton tee with a relaxed fit.', [['S', 1900], ['M', 1900], ['L', 1900], ['XL', 2200]]],
      ['T-Shirts', 'Oversized Graphic Tee', 'Heavyweight oversized tee with a minimal print.', [['S', 2900], ['M', 2900], ['L', 2900], ['XL', 3200]]],
      ['Hoodies', 'Everyday Zip Hoodie', 'Brushed fleece inside, durable zip, kangaroo pockets.', [['S', 4900], ['M', 4900], ['L', 4900], ['XL', 5400], ['XXL', 5900]]],
      ['Hoodies', 'Cropped Pullover', 'Cropped fit pullover hoodie in garment-dyed fleece.', [['XS', 4500], ['S', 4500], ['M', 4500], ['L', 4500]]],
      ['Jeans', 'Straight Leg Denim', 'Rigid 13oz denim, straight leg, mid rise.', [['28', 5900], ['30', 5900], ['32', 5900], ['34', 5900], ['36', 6400]]],
      ['Dresses', 'Linen Midi Dress', 'Breathable linen midi dress with adjustable straps.', [['XS', 6900], ['S', 6900], ['M', 6900], ['L', 6900]]],
    ];
    for (const [cat, name, desc, variants] of products) {
      const pid = Number(insProd.run(catIds[cat], name, slugify(name), desc).lastInsertRowid);
      variants.forEach(([size, price], i) => insVar.run(pid, size, price, 20, i));
    }
  });
  console.log('[setup] Demo categories and products created (set SEED_DEMO=false to skip).');
}

ensureAdmin();
seedDemo();

module.exports = { db, tx, getSettings, setSetting, slugify, uniqueSlug, createUser, generateReferralCode };
