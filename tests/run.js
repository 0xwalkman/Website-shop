/**
 * Runs every end-to-end suite against a fresh database, a real server and fake payment APIs.
 *   npm test              all suites
 *   npm test -- security  only suites whose name contains "security"
 * Needs Playwright:  npm i --no-save playwright && npx playwright install chromium
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 3123, MOCK_PORT = 4555;
const SUITES = ['e2e-security', 'e2e-cart', 'e2e-stripe', 'e2e-binance', 'e2e-all'].filter((s) => !process.argv[2] || s.includes(process.argv[2]));
const NODE = [process.execPath, '--disable-warning=ExperimentalWarning'];

const wait = async (url, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  throw new Error(`Timed out waiting for ${url}`);
};

async function runSuite(name) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outouf-test-'));
  const env = {
    ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: dataDir, BACKUPS: 'on', SEED_DEMO: 'true',
    BASE_URL: `http://localhost:${PORT}`, APP_URL: `http://localhost:${PORT}`, MOCK_URL: `http://localhost:${MOCK_PORT}`,
    SESSION_SECRET: 'test-secret-test-secret-test-secret-123',
    ADMIN_EMAIL: 'admin@store.local', ADMIN_PASSWORD: 'admin12345',
    STRIPE_SECRET_KEY: 'sk_test_mock', STRIPE_WEBHOOK_SECRET: 'whsec_test_mock', STRIPE_API_BASE: `http://localhost:${MOCK_PORT}`,
    BINANCE_PAY_API_KEY: 'bp_key_mock', BINANCE_PAY_SECRET_KEY: 'bp_secret_mock', BINANCE_PAY_API_BASE: `http://localhost:${MOCK_PORT}`,
    SMTP_HOST: '', TEST_DB: path.join(dataDir, 'store.db'),
  };
  const procs = [];
  const start = (args, label) => {
    const p = spawn(NODE[0], [...NODE.slice(1), ...args], { cwd: ROOT, env });
    let log = '';
    p.stdout.on('data', (d) => (log += d)); p.stderr.on('data', (d) => (log += d));
    p.log = () => log; p.label = label;
    procs.push(p);
    return p;
  };
  try {
    start([path.join(__dirname, 'mock-payments.js')], 'mock');
    const server = start(['server.js'], 'server');
    await wait(`http://localhost:${PORT}/healthz`);
    console.log(`\n=== ${name}`);
    const code = await new Promise((resolve) => {
      const t = spawn(NODE[0], [...NODE.slice(1), path.join(__dirname, `${name}.js`)], { cwd: ROOT, env, stdio: 'inherit' });
      t.on('exit', resolve);
    });
    if (code !== 0) console.log(`--- server log (${name}) ---\n${server.log().slice(-3000)}`);
    return code === 0;
  } finally {
    procs.forEach((p) => p.kill());
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

(async () => {
  try { require.resolve('playwright'); } catch {
    console.error('Playwright is required: npm i --no-save playwright && npx playwright install chromium');
    process.exit(1);
  }
  const results = [];
  for (const s of SUITES) results.push([s, await runSuite(s)]);
  console.log('\nSummary:'); results.forEach(([s, ok]) => console.log(`  ${ok ? '✔' : '✘'} ${s}`));
  process.exit(results.every(([, ok]) => ok) ? 0 : 1);
})();
