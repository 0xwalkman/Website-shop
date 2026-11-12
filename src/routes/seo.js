const express = require('express');
const { db } = require('../db');
const { DEFAULT_PAGES } = require('../pages');

const router = express.Router();

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin', 'Disallow: /account', 'Disallow: /cart', 'Disallow: /checkout',
    'Disallow: /order', 'Disallow: /login', 'Disallow: /register', 'Disallow: /forgot', 'Disallow: /reset',
    `Sitemap: ${res.locals.baseUrl}/sitemap.xml`,
  ].join('\n'));
});

router.get('/sitemap.xml', (req, res) => {
  const base = res.locals.baseUrl;
  const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const urls = [
    { loc: '/', pri: '1.0' }, { loc: '/shop', pri: '0.9' },
    ...db.prepare('SELECT slug FROM categories ORDER BY sort_order').all().map((c) => ({ loc: `/shop?category=${c.slug}`, pri: '0.8' })),
    ...db.prepare(`SELECT p.slug, p.created_at FROM products p WHERE p.is_active = 1
                   AND EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id) ORDER BY p.id DESC`).all()
      .map((p) => ({ loc: `/p/${p.slug}`, pri: '0.8', mod: p.created_at.slice(0, 10) })),
    ...Object.keys(DEFAULT_PAGES).map((slug) => ({ loc: slug === 'contact' ? '/contact' : `/page/${slug}`, pri: '0.3' })),
  ];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${xmlEsc(base + u.loc)}</loc>${u.mod ? `<lastmod>${u.mod}</lastmod>` : ''}<priority>${u.pri}</priority></url>`).join('\n')}
</urlset>`);
});

module.exports = router;
