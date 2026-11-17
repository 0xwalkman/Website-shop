/**
 * Privacy-friendly visitor statistics: no cookies, no IP addresses stored.
 * Counts page views per day/path/referring site, and unique visitors per day using a
 * one-way hash of (day, IP, browser) that cannot be linked across days.
 */
const crypto = require('node:crypto');
const { db } = require('./db');

const SALT = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SKIP = /^\/(admin|account|public|uploads|stripe|paypal|binance|order|reset|login|logout|forgot|r\/)/;
const BOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|curl|wget|python|headless|lighthouse/i;

const addView = db.prepare(`INSERT INTO page_views (day, path, referrer, views) VALUES (?, ?, ?, 1)
                            ON CONFLICT(day, path, referrer) DO UPDATE SET views = views + 1`);
const addVisitor = db.prepare('INSERT OR IGNORE INTO daily_visitors (day, visitor_hash) VALUES (?, ?)');

function track(req, res, next) {
  if (req.method !== 'GET' || SKIP.test(req.path) || BOTS.test(req.get('user-agent') || '') || req.get('purpose') === 'prefetch') return next();
  res.on('finish', () => {
    if (res.statusCode !== 200 || !String(res.get('content-type') || '').includes('text/html')) return;
    try {
      const day = new Date().toISOString().slice(0, 10);
      let referrer = '';
      try {
        const host = new URL(req.get('referer') || '').hostname.replace(/^www\./, '');
        if (host && host !== String(req.hostname).replace(/^www\./, '')) referrer = host.slice(0, 80);
      } catch { /* no or invalid referrer */ }
      addView.run(day, req.path.slice(0, 120), referrer);
      const hash = crypto.createHmac('sha256', SALT).update(`${day}|${req.ip}|${req.get('user-agent') || ''}`).digest('hex').slice(0, 20);
      addVisitor.run(day, hash);
    } catch (err) {
      console.error('[analytics]', err.message);
    }
  });
  next();
}

// Daily visitor hashes are only needed to count uniques; drop them after 90 days.
setInterval(() => db.prepare("DELETE FROM daily_visitors WHERE day < date('now', '-90 days')").run(), 6 * 3600 * 1000).unref();

function report(days = 30) {
  const since = `date('now', '-${days - 1} days')`;
  const daily = [];
  const visitors = Object.fromEntries(db.prepare(`SELECT day, COUNT(*) AS n FROM daily_visitors WHERE day >= ${since} GROUP BY day`).all().map((r) => [r.day, r.n]));
  const views = Object.fromEntries(db.prepare(`SELECT day, SUM(views) AS n FROM page_views WHERE day >= ${since} GROUP BY day`).all().map((r) => [r.day, r.n]));
  const orders = Object.fromEntries(db.prepare(`SELECT date(paid_at) AS day, COUNT(*) AS n, SUM(total_cents) AS cents FROM orders
    WHERE paid_at IS NOT NULL AND status IN ('paid','shipped','delivered') AND date(paid_at) >= ${since} GROUP BY day`).all().map((r) => [r.day, r]));
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    daily.push({ day, visitors: visitors[day] || 0, views: views[day] || 0, orders: (orders[day] || {}).n || 0, cents: (orders[day] || {}).cents || 0 });
  }
  const sum = (k) => daily.reduce((s, d) => s + d[k], 0);
  const totals = { visitors: sum('visitors'), views: sum('views'), orders: sum('orders'), cents: sum('cents') };
  totals.conversion = totals.visitors ? (totals.orders / totals.visitors) * 100 : 0;

  const topProducts = db.prepare(`SELECT p.name, p.slug, SUM(v.views) AS views FROM page_views v
    JOIN products p ON v.path = '/p/' || p.slug WHERE v.day >= ${since} GROUP BY p.id ORDER BY views DESC LIMIT 10`).all();
  const topPages = db.prepare(`SELECT path, SUM(views) AS views FROM page_views WHERE day >= ${since}
    GROUP BY path ORDER BY views DESC LIMIT 10`).all();
  const referrers = db.prepare(`SELECT referrer, SUM(views) AS views FROM page_views WHERE day >= ${since} AND referrer != ''
    GROUP BY referrer ORDER BY views DESC LIMIT 10`).all();
  const affiliates = db.prepare(`SELECT u.name, u.referral_code,
      (SELECT COUNT(*) FROM referral_clicks c WHERE c.affiliate_id = u.id AND date(c.created_at) >= ${since}) AS clicks,
      (SELECT COUNT(*) FROM orders o WHERE o.affiliate_id = u.id AND o.status IN ('paid','shipped','delivered') AND date(o.paid_at) >= ${since}) AS orders
    FROM users u WHERE clicks > 0 OR orders > 0 ORDER BY orders DESC, clicks DESC LIMIT 10`).all();
  return { daily, totals, topProducts, topPages, referrers, affiliates };
}

module.exports = { track, report };
