// Emergency: turn off two-step login for an account (e.g. lost phone).
// Usage on the server:  node --disable-warning=ExperimentalWarning scripts/reset-2fa.js owner@example.com
const { db } = require('../src/db');
const email = String(process.argv[2] || '').toLowerCase();
if (!email) { console.error('Usage: node scripts/reset-2fa.js <email>'); process.exit(1); }
const r = db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = 0 WHERE email = ?').run(email);
console.log(r.changes ? `Two-step login turned off for ${email}. Log in with the password and turn it on again.` : `No account found for ${email}.`);
