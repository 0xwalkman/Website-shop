/**
 * Transactional email with an outbox table.
 *
 * Emails are inserted into the `emails` table (inside the same database transaction as the change
 * that caused them) and delivered by a background sender. With SMTP configured they are sent through
 * your email provider; without it they are written to data/outbox/ so nothing is lost while testing.
 */
const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');
const { db, getSettings } = require('./db');

const OUTBOX_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'outbox');
let transport = null;
let rememberedBase = null;

const smtpConfigured = () => Boolean(process.env.SMTP_HOST);

function getTransport() {
  if (!transport) {
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transport;
}

// Public URL used in email links. BASE_URL is preferred; otherwise the first request's host is used.
function siteUrl() {
  return (process.env.BASE_URL || rememberedBase || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
}
function rememberBase(url) {
  if (!rememberedBase) rememberedBase = url;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Builds a simple, mobile-friendly email.
 * blocks: array of strings (paragraphs) or { rows: [[label, value], ...] }
 */
function render({ heading, blocks = [], button, footnote }) {
  const s = getSettings();
  const htmlBlocks = blocks.map((b) => {
    if (typeof b === 'string') return `<p style="margin:0 0 14px;line-height:1.55">${esc(b)}</p>`;
    if (b.rows) {
      return `<table style="width:100%;border-collapse:collapse;margin:0 0 16px">${b.rows.map(([k, v], i) => `
        <tr><td style="padding:6px 0;color:#555;${i === b.rows.length - 1 && b.totalLast ? 'font-weight:700;color:#111;border-top:1px solid #eee' : ''}">${esc(k)}</td>
        <td style="padding:6px 0;text-align:right;${i === b.rows.length - 1 && b.totalLast ? 'font-weight:700;border-top:1px solid #eee' : ''}">${esc(v)}</td></tr>`).join('')}</table>`;
    }
    return '';
  }).join('');
  const btn = button ? `<p style="margin:22px 0"><a href="${esc(button.url)}" style="background:#141414;color:#fff;text-decoration:none;padding:13px 22px;border-radius:10px;font-weight:600;display:inline-block">${esc(button.label)}</a></p>` : '';
  const contact = s.contact_email ? `Questions? Just reply or write to ${esc(s.contact_email)}.` : '';
  const html = `<!doctype html><html><body style="margin:0;background:#f7f6f3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#141414">
  <div style="max-width:520px;margin:0 auto;padding:28px 18px">
    <div style="font-weight:800;font-size:22px;letter-spacing:-.03em;margin-bottom:18px">${esc(s.store_name)}</div>
    <div style="background:#fff;border-radius:14px;padding:24px 22px">
      <h1 style="font-size:21px;margin:0 0 14px;line-height:1.25">${esc(heading)}</h1>
      ${htmlBlocks}${btn}
      ${footnote ? `<p style="margin:14px 0 0;color:#777;font-size:13px;line-height:1.5">${esc(footnote)}</p>` : ''}
    </div>
    <p style="color:#888;font-size:12px;line-height:1.5;margin:16px 4px">${contact}<br>${esc(s.store_name)}${s.business_address ? ' · ' + esc(s.business_address) : ''}</p>
  </div></body></html>`;
  const text = [heading, '', ...blocks.map((b) => (typeof b === 'string' ? b : b.rows.map(([k, v]) => `${k}: ${v}`).join('\n'))),
    button ? `\n${button.label}: ${button.url}` : '', footnote ? `\n${footnote}` : '', contact ? `\n${contact}` : ''].join('\n');
  return { html, text };
}

const insert = db.prepare('INSERT INTO emails (to_addr, subject, html, text) VALUES (?, ?, ?, ?)');

// Queue an email. Safe to call inside a transaction: it is only sent after the current code finishes.
function queue(to, subject, content) {
  if (!to) return;
  const { html, text } = render(content);
  insert.run(String(to).trim(), subject, html, text);
  setImmediate(() => flush().catch((e) => console.error('[mail]', e.message)));
}

let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    const pending = db.prepare("SELECT * FROM emails WHERE status = 'queued' ORDER BY id LIMIT 20").all();
    for (const m of pending) {
      if (!smtpConfigured()) {
        fs.mkdirSync(OUTBOX_DIR, { recursive: true });
        fs.writeFileSync(path.join(OUTBOX_DIR, `${String(m.id).padStart(5, '0')}.html`),
          `<!-- To: ${esc(m.to_addr)} | Subject: ${esc(m.subject)} -->\n${m.html}`);
        db.prepare("UPDATE emails SET status = 'logged', sent_at = datetime('now') WHERE id = ?").run(m.id);
        console.log(`[mail] (SMTP not configured, saved to data/outbox) To: ${m.to_addr} | ${m.subject}`);
        continue;
      }
      try {
        const s = getSettings();
        await getTransport().sendMail({
          from: process.env.MAIL_FROM || `${s.store_name} <${s.contact_email || process.env.SMTP_USER}>`,
          replyTo: s.contact_email || undefined,
          to: m.to_addr, subject: m.subject, html: m.html, text: m.text,
        });
        db.prepare("UPDATE emails SET status = 'sent', attempts = attempts + 1, sent_at = datetime('now'), error = NULL WHERE id = ?").run(m.id);
      } catch (err) {
        const failed = m.attempts + 1 >= 5;
        db.prepare('UPDATE emails SET attempts = attempts + 1, error = ?, status = ? WHERE id = ?')
          .run(String(err.message).slice(0, 500), failed ? 'failed' : 'queued', m.id);
        console.error(`[mail] Could not send #${m.id} to ${m.to_addr}: ${err.message}`);
        break; // provider problem: try again on the next run
      }
    }
  } finally {
    flushing = false;
  }
}

setInterval(() => flush().catch((e) => console.error('[mail]', e.message)), 60 * 1000).unref();

module.exports = { queue, flush, siteUrl, rememberBase, smtpConfigured, render };
