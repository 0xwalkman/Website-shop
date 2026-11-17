// Regression tests for issues found in the security audit.
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const B = process.env.APP_URL || 'http://localhost:3123';
const db = new DatabaseSync(process.env.TEST_DB);
let failures = 0;
const check = (label, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${label} ${extra}`); if (!cond) failures++; };

// Minimal cookie-keeping client (fetch can't fake the Host header).
function client() {
  const jar = {};
  const req = (method, path, { form, headers = {} } = {}) => new Promise((resolve, reject) => {
    const u = new URL(B + path);
    const body = form ? new URLSearchParams(form).toString() : null;
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: {
      cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}),
      ...headers,
    } }, (res) => {
      for (const c of res.headers['set-cookie'] || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
      let data = ''; res.on('data', (d) => (data += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
  const csrf = async (path) => (await req('GET', path)).body.match(/name="_csrf" value="([^"]+)"/)[1];
  return { req, csrf };
}

(async () => {
  // 1. Open redirect after login
  for (const evil of ['//evil.example/', '/\\evil.example/', '/\\\\evil.example', 'https://evil.example/']) {
    const c = client();
    const t = await c.csrf('/login');
    const r = await c.req('POST', '/login', { form: { _csrf: t, email: 'admin@store.local', password: 'admin12345', next: evil } });
    check(`login redirect stays on site for ${JSON.stringify(evil)}`, r.headers.location === '/admin', r.headers.location);
  }

  // 2. Host header must never end up in emailed links
  const attacker = client();
  await attacker.req('GET', '/', { headers: { host: 'evil.example' } });
  const t = await attacker.csrf('/forgot');
  await attacker.req('POST', '/forgot', { form: { _csrf: t, email: 'admin@store.local' }, headers: { host: 'evil.example' } });
  await new Promise((r) => setTimeout(r, 500));
  const mail = db.prepare("SELECT html FROM emails WHERE subject LIKE 'Reset%' ORDER BY id DESC").get();
  check('reset email does not use attacker Host header', mail && !mail.html.includes('evil.example') && mail.html.includes(`${B}/reset/`));

  // 3. Forms without the CSRF token are rejected
  const anon = client();
  const r3 = await anon.req('POST', '/cart/add', { form: { variant_id: '1' } });
  check('POST without CSRF token rejected', r3.status === 403);

  // 4. Checkouts per visitor are limited (each one holds stock)
  const shopper = client();
  let tok = await shopper.csrf('/p/classic-cotton-tee');
  const variant = db.prepare("SELECT v.id FROM product_variants v JOIN products p ON p.id=v.product_id WHERE p.slug='classic-cotton-tee' LIMIT 1").get().id;
  await shopper.req('POST', '/cart/add', { form: { _csrf: tok, variant_id: String(variant), qty: '1' } });
  let last;
  for (let i = 0; i < 11; i++) {
    tok = await shopper.csrf('/checkout');
    last = await shopper.req('POST', '/checkout', { form: { _csrf: tok, name: 'Bot Buyer', email: 'bot@x.com', phone: '+1 555 0000', country: 'US',
      address: '1 Test St', city: 'Testville', payment_method: 'paypal' } });
  }
  check('11th checkout within an hour is refused', last.status === 429, `status=${last.status}`);
  check('only one reservation held at a time', db.prepare("SELECT COUNT(*) n FROM orders WHERE status='unpaid'").get().n === 1);

  // 5. Security headers
  const h = (await anon.req('GET', '/')).headers;
  check('security headers present', h['x-content-type-options'] === 'nosniff' && h['x-frame-options'] === 'SAMEORIGIN' && !!h['referrer-policy']);

  // 6. Private pages are not public
  const r6 = await anon.req('GET', '/admin');
  check('admin requires login', r6.status === 302 && r6.headers.location.startsWith('/login'));
  const r7 = await anon.req('GET', '/order/1');
  check('orders are private without a token', r7.status === 404);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
