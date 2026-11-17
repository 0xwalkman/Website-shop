// The emails the store sends. Each function only queues the email (see mailer.js).
const { db, getSettings } = require('./db');
const { queue, siteUrl } = require('./mailer');

const money = (cents, s) => `${s.currency_symbol}${(cents / 100).toFixed(2)}`;
const orderLink = (o) => `${siteUrl()}/order/${o.id}?t=${o.access_token}`;
const firstName = (name) => String(name || '').split(' ')[0] || 'there';

function summaryRows(o, s) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(o.id);
  const rows = items.map((i) => [`${i.qty} × ${i.product_name} (${[i.color, i.size].filter(Boolean).join(', ')})`, money(i.price_cents * i.qty, s)]);
  if (o.discount_cents) rows.push([`Discount${o.discount_code ? ` (${o.discount_code})` : ''}`, `−${money(o.discount_cents, s)}`]);
  rows.push(['Shipping', o.shipping_cents ? money(o.shipping_cents, s) : 'Free']);
  rows.push(['Total paid', money(o.total_cents, s)]);
  return { rows, totalLast: true };
}

function address(o) {
  return `${o.customer_name}, ${o.address}, ${o.city}${o.postal_code ? ' ' + o.postal_code : ''}, ${o.country}`;
}

// Called whenever an order changes status (inside the same transaction).
function orderStatus(orderId, status) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o) return;
  const s = getSettings();
  const name = firstName(o.customer_name);

  if (status === 'paid') {
    queue(o.email, `Order #${o.id} confirmed: thank you, ${name}!`, {
      heading: `It's yours, ${name}! 🎉`,
      blocks: [
        `Thanks for shopping with ${s.store_name}. Your payment went through and order #${o.id} is confirmed.`,
        summaryRows(o, s),
        `We'll pack it within ${s.processing_days} and email you a tracking number as soon as it ships to: ${address(o)}.`,
      ],
      button: { label: 'View your order', url: orderLink(o) },
    });
    const notify = s.admin_notify_email || s.contact_email;
    if (notify) {
      queue(notify, `💰 New order #${o.id}: ${money(o.total_cents, s)} (${o.payment_method === 'binance' ? 'Binance Pay' : 'PayPal'})`, {
        heading: `New paid order #${o.id}`,
        blocks: [`${o.customer_name} (${o.email}) just paid. Ship to: ${address(o)}.`, summaryRows(o, s)],
        button: { label: 'Open in admin', url: `${siteUrl()}/admin/orders/${o.id}` },
      });
    }
  } else if (status === 'shipped') {
    const tracking = o.tracking_number
      ? `Carrier: ${o.tracking_carrier || 'courier'} · Tracking number: ${o.tracking_number}`
      : 'Your tracking details will follow if the carrier provides them.';
    queue(o.email, `Your order #${o.id} is on its way 📦`, {
      heading: `Good news, ${name}: it's on its way!`,
      blocks: [`Order #${o.id} has left us and is heading to ${o.city}, ${o.country}.`, tracking,
        `Delivery usually takes ${s.delivery_estimate}. International parcels can sometimes be held briefly at customs.`],
      button: o.tracking_url ? { label: 'Track your parcel', url: o.tracking_url } : { label: 'View your order', url: orderLink(o) },
    });
  } else if (status === 'delivered') {
    queue(o.email, `Delivered: enjoy your ${s.store_name} order!`, {
      heading: `Delivered! We hope you love it, ${name}.`,
      blocks: [`Order #${o.id} has been marked as delivered. If anything isn't right, reply to this email and we'll sort it out.`,
        `Love it? Share your personal ${s.store_name} link and earn ${s.commission_rate}% in USDC on every order your friends place.`],
      button: { label: 'Get my share link', url: `${siteUrl()}/account/affiliate` },
    });
  } else if (status === 'refunded') {
    queue(o.email, `Refund for order #${o.id}`, {
      heading: 'Your refund is on its way',
      blocks: [`We've refunded ${money(o.total_cents, s)} for order #${o.id} to your original payment method (${o.payment_method === 'binance' ? 'your Binance account' : o.payment_method === 'paypal' ? 'your PayPal account or card' : 'your card'}).`,
        o.payment_method === 'binance' ? 'Binance refunds usually arrive within minutes.' : 'PayPal refunds usually show up within a few days; refunds to a card can take 5-10 business days, depending on your bank.'],
      button: { label: 'View your order', url: orderLink(o) },
    });
  } else if (status === 'cancelled' && o.paid_at) {
    queue(o.email, `Order #${o.id} has been cancelled`, {
      heading: `Order #${o.id} was cancelled`,
      blocks: ['Your order has been cancelled. If a refund is due, you will receive a separate confirmation once it has been sent.',
        'If you did not expect this, simply reply to this email.'],
      button: { label: 'View your order', url: orderLink(o) },
    });
  }
}

function withdrawalProcessed(withdrawalId) {
  const w = db.prepare('SELECT w.*, u.name, u.email FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.id = ?').get(withdrawalId);
  if (!w) return;
  const amount = `${(w.amount_cents / 100).toFixed(2)} USDC`;
  if (w.status === 'paid') {
    queue(w.email, `💸 ${amount} sent to your wallet`, {
      heading: `You just got paid, ${firstName(w.name)}!`,
      blocks: [`We've sent ${amount} to your wallet.`,
        { rows: [['Network', w.wallet_network], ['Wallet', w.wallet_address], ['Transaction', w.tx_hash || '']] },
        w.admin_note || 'Keep sharing your link. Every order brings you more.'],
      button: { label: 'See my earnings', url: `${siteUrl()}/account/affiliate` },
    });
  } else if (w.status === 'rejected') {
    queue(w.email, 'About your withdrawal request', {
      heading: 'Your withdrawal was not processed',
      blocks: [`Your request for ${amount} was declined${w.admin_note ? `: ${w.admin_note}` : '.'}`,
        'The full amount is back in your available balance. You can request it again from your earnings page.'],
      button: { label: 'Open my earnings', url: `${siteUrl()}/account/affiliate` },
    });
  }
}

function passwordReset(user, token) {
  queue(user.email, 'Reset your password', {
    heading: 'Reset your password',
    blocks: [`Hi ${firstName(user.name)}, we received a request to reset your password. The link below works for 1 hour.`],
    button: { label: 'Choose a new password', url: `${siteUrl()}/reset/${token}` },
    footnote: "If you didn't ask for this, you can ignore this email. Your password stays the same.",
  });
}

function contactMessage({ name, email, subject, message, orderId }) {
  const s = getSettings();
  const to = s.contact_email || s.admin_notify_email;
  if (!to) return false;
  queue(to, `✉️ Contact form: ${subject || 'New message'}`, {
    heading: `Message from ${name}`,
    blocks: [{ rows: [['From', `${name} <${email}>`], ['Order', orderId || 'n/a'], ['Subject', subject || '']] }, message],
    footnote: `Reply directly to ${email}.`,
  });
  return true;
}

module.exports = { orderStatus, withdrawalProcessed, passwordReset, contactMessage, orderLink };
