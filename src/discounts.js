const { db } = require('./db');

/**
 * Checks a discount code against a cart subtotal.
 * Returns { code, amount, label } when it applies, or { error } explaining why not.
 */
function evaluate(rawCode, subtotalCents, money) {
  const code = String(rawCode || '').trim();
  if (!code) return { error: 'Enter a code.' };
  const d = db.prepare('SELECT * FROM discount_codes WHERE code = ?').get(code);
  if (!d || !d.active) return { error: `"${code}" isn't a valid code.` };
  const today = new Date().toISOString().slice(0, 10);
  if (d.expires_at && d.expires_at < today) return { error: `"${d.code}" has expired.` };
  if (d.max_uses != null && d.uses >= d.max_uses) return { error: `"${d.code}" has been fully used.` };
  if (subtotalCents < d.min_subtotal_cents) {
    return { error: `"${d.code}" needs an order of at least ${money(d.min_subtotal_cents)}. Add ${money(d.min_subtotal_cents - subtotalCents)} more to use it.` };
  }
  const amount = d.kind === 'percent'
    ? Math.floor(subtotalCents * d.value / 100)
    : Math.min(d.value, subtotalCents);
  if (amount <= 0) return { error: `"${d.code}" doesn't apply to this cart.` };
  return { code: d.code, amount, label: d.kind === 'percent' ? `${d.value}% off` : `${money(d.value)} off` };
}

module.exports = { evaluate };
