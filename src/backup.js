// Daily database backup: a consistent copy in data/backups, keeping the last 14 days.
// (Uploaded photos live in uploads/ - back that folder up with your host's volume snapshots.)
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('./db');

const DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'backups');
const KEEP = parseInt(process.env.BACKUP_KEEP_DAYS || '14', 10);

function backupNow() {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `store-${new Date().toISOString().slice(0, 10)}.db`);
  if (fs.existsSync(file)) return file;
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(DIR).filter((f) => /^store-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -KEEP);
  old.forEach((f) => fs.unlinkSync(path.join(DIR, f)));
  console.log(`[backup] Saved ${path.basename(file)}`);
  return file;
}

function schedule() {
  const run = () => { try { backupNow(); } catch (err) { console.error('[backup] failed:', err.message); } };
  setTimeout(run, 30 * 1000).unref();                 // shortly after start
  setInterval(run, 60 * 60 * 1000).unref();           // checks hourly, writes once per day
}

module.exports = { backupNow, schedule };
