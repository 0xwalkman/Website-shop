const express = require('express');
const { getPage } = require('../pages');
const notify = require('../notify');
const { flash } = require('../middleware');

const router = express.Router();

router.get('/page/:slug', (req, res) => {
  if (req.params.slug === 'contact') return res.redirect(301, '/contact');
  const page = getPage(req.params.slug);
  if (!page) return res.status(404).render('error', { title: 'Page not found', message: 'This page does not exist.' });
  res.render('page', { title: page.title, page, meta: { description: `${page.title} | ${res.locals.settings.store_name}` } });
});

const contactLimiter = require('../ratelimit').createLimiter(60 * 60 * 1000);
const limited = (ip) => contactLimiter.hit(ip) > 5;

router.get('/contact', (req, res) => {
  const values = req.user ? { name: req.user.name, email: req.user.email } : {};
  if (typeof req.query.order === 'string') values.order = req.query.order.slice(0, 12);
  res.render('contact', { title: 'Contact us', page: getPage('contact'), values });
});

router.post('/contact', (req, res) => {
  const v = {};
  for (const k of ['name', 'email', 'order', 'subject', 'message']) v[k] = String(req.body[k] || '').trim().slice(0, k === 'message' ? 5000 : 200);
  const fail = (msg) => res.status(400).render('contact', { title: 'Contact us', page: getPage('contact'), values: v, error: msg });
  if (req.body.website) return res.redirect('/contact?sent=1'); // honeypot field filled in: almost certainly a bot
  if (v.name.length < 2) return fail('Please tell us your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) return fail('Please enter a valid email so we can reply.');
  if (v.message.length < 5) return fail('Please write a message.');
  if (limited(req.ip)) return fail("You've sent several messages already. Please wait a little before sending another.");
  const ok = notify.contactMessage({ name: v.name, email: v.email, subject: v.subject, message: v.message, orderId: v.order });
  if (!ok) return fail('Our inbox is not set up yet. Please try again later.');
  flash(req, 'success', `Thanks, ${v.name.split(' ')[0]}! Your message is on its way. We'll reply to ${v.email}.`);
  res.redirect('/contact');
});

module.exports = router;
