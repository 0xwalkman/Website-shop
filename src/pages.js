/**
 * Policy / info pages. Starter text lives here; once edited in Admin -> Pages the edited version is
 * stored in the `pages` table. {{placeholders}} are filled from Admin -> Settings.
 *
 * IMPORTANT: the starter text is a sensible template, not legal advice. Have it reviewed for the
 * countries you sell to.
 */
const { db, getSettings } = require('./db');

const DEFAULT_PAGES = {
  shipping: {
    title: 'Shipping & delivery',
    body: `## Free shipping, worldwide
Every {{store_name}} order ships free, wherever you are. No minimum order.

## When will my order arrive?
- **Processing:** we pack and send orders within {{processing_days}} of payment.
- **Delivery:** most parcels arrive within {{delivery_estimate}} after they ship. Remote areas can take a little longer.
- You'll get an email with your **tracking number** as soon as your order ships.

## Customs, duties and import taxes
For deliveries outside the country we ship from, your local customs office may charge **import duties or taxes**. These are set by your country, are not included in our prices, and are paid by the recipient, usually when the parcel arrives. We can't predict the exact amount, so check with your local customs office if you are unsure.

If a parcel is refused because duties were not paid, we may not be able to refund the original shipping or return costs.

## Wrong address or lost parcel?
Double-check your address at checkout. If you spot a mistake, contact us right away, before your order ships. If your tracking hasn't moved for 10 days, [get in touch](/contact) and we'll look into it with the carrier.`,
  },
  returns: {
    title: 'Returns & refunds',
    body: `## {{returns_days}}-day returns
Not the right fit? You can return unworn items in their original condition, with tags attached, within **{{returns_days}} days** of delivery.

## How to return
1. [Contact us](/contact) with your order number and the items you'd like to return.
2. We'll reply with the return address and instructions.
3. Send the items back. Please use a tracked service: we can't refund parcels that never reach us.

## Refunds
Once we receive and check your return, we refund the items to your **original payment method**:
- **Card payments:** refunds usually appear within 5-10 business days, depending on your bank.
- **Binance Pay:** refunds are sent back to your Binance account.

Return shipping costs are paid by the customer unless the item arrived damaged or we sent the wrong item.

## Damaged or wrong item?
We're sorry! [Contact us](/contact) within 7 days of delivery with your order number and a photo, and we'll fix it with a replacement or a full refund, including shipping.

## Exchanges
The fastest way to get a different size is to return the original item and place a new order.`,
  },
  terms: {
    title: 'Terms of service',
    body: `These terms apply when you use the {{store_name}} website and buy from us. By placing an order you agree to them.

## Who we are
{{store_name}}{{business_line}}. You can reach us at {{contact_line}}.

## Orders and prices
- Prices are shown in the store currency and include the item price; shipping is free unless stated otherwise at checkout.
- Your order is confirmed once payment has been received. We may cancel and fully refund an order if an item is unavailable, if there is an obvious pricing error, or if we suspect fraud.
- Import duties and taxes charged by your country are not included (see [Shipping](/page/shipping)).

## Payment
We accept card payments through Stripe and crypto payments through Binance Pay. We never see or store your full card details.

## Returns
See our [Returns & refunds policy](/page/returns).

## Accounts
Keep your password safe. You are responsible for activity on your account. We may suspend accounts that are used for fraud or abuse.

## Affiliate program
Taking part in the affiliate program is subject to the [Affiliate program rules](/page/affiliate-terms).

## Liability
We do our best to describe products accurately; colours may vary slightly on different screens. To the extent allowed by law, our liability for any order is limited to the amount you paid for it. Nothing in these terms limits rights you have under consumer law in your country.

## Changes
We may update these terms from time to time. The version on this page at the time of your order applies to that order.`,
  },
  privacy: {
    title: 'Privacy policy',
    body: `This policy explains what personal data {{store_name}} collects and why.

## What we collect
- **Orders:** your name, email, phone number and delivery address, so we can deliver your order and contact you about it.
- **Accounts:** your name, email and a securely hashed password. Affiliates also provide a crypto wallet address for payouts.
- **Payments:** handled by Stripe or Binance Pay. We receive confirmation of payment but never your full card details.
- **Statistics:** anonymous page-view counts. We don't use advertising trackers or sell your data.

## Cookies
We only use cookies the store needs to work: one to keep your cart and login, and one to remember which affiliate link you arrived from (for 30 days). We do not use advertising or tracking cookies.

## Who we share data with
Only with services that help us run the store: our payment providers (Stripe, Binance Pay), the shipping carrier delivering your parcel, our email provider and our hosting provider.

## How long we keep it
Order records are kept as long as required for accounting and tax purposes. You can ask us to delete your account at any time.

## Your rights
You can ask to see, correct or delete your personal data by writing to {{contact_line}}. If you are in the EU or UK, you can also complain to your local data protection authority.`,
  },
  'affiliate-terms': {
    title: 'Affiliate program rules',
    body: `Share {{store_name}} and earn **{{commission_rate}}%** of the orders you bring in.

## How it works
- Every registered user gets a personal link. When someone clicks it and pays for an order within **30 days**, the order is credited to you.
- You earn {{commission_rate}}% of the order value **excluding shipping and after any discount code**.
- Your commission becomes **available** once the order is delivered. Cancelled or refunded orders don't earn commission.

## Getting paid
- Payouts are sent in **USDC** to the wallet you save in your account. Double-check your wallet address and network: crypto sent to a wrong address cannot be recovered.
- The minimum withdrawal is **{{min_withdrawal}} USDC**. Requests are reviewed and paid manually.
- You are responsible for any taxes due on your earnings in your country.

## Not allowed
- Buying through your own link, or using fake or duplicate accounts.
- Spam, misleading claims, or advertising on our brand name in search ads.
- Offering cashback or incentives we haven't approved.

We may withhold commissions earned in breach of these rules and close accounts that abuse the program. We may change the commission rate for future orders; commissions already earned keep their original rate.`,
  },
  contact: {
    title: 'Contact us',
    body: `We're here to help with orders, sizing, returns, or anything else. Send us a message below, or reach us directly at {{contact_line}}. We usually reply within 1-2 business days.

**Have an order question?** Include your order number so we can help faster.`,
  },
};

function vars() {
  const s = getSettings();
  const contact = [s.contact_email, s.whatsapp_number && `WhatsApp ${s.whatsapp_number}`].filter(Boolean).join(' or ');
  return {
    store_name: s.store_name,
    contact_email: s.contact_email,
    contact_line: contact || 'the contact form on our [Contact page](/contact)',
    business_line: s.business_name || s.business_address
      ? ` is operated by ${[s.business_name, s.business_address].filter(Boolean).join(', ')}`
      : '',
    returns_days: s.returns_days,
    processing_days: s.processing_days,
    delivery_estimate: s.delivery_estimate,
    commission_rate: s.commission_rate,
    min_withdrawal: (s.min_withdrawal_cents / 100).toFixed(2),
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Small, safe Markdown subset: ## headings, paragraphs, - and 1. lists, **bold**, [links](/path or https://...)
function renderMarkdown(src) {
  const inline = (t) => esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s"]*)\)/g, (m, text, url) => {
      const ext = url.startsWith('http');
      return `<a href="${url}"${ext ? ' target="_blank" rel="noopener"' : ''}>${text}</a>`;
    });
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (const raw of String(src).replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    let m;
    if (!line) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flushPara(); flushList();
      const level = Math.min(m[1].length + 1, 4);
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
    } else if ((m = line.match(/^[-*]\s+(.*)$/)) || (m = line.match(/^\d+[.)]\s+(.*)$/))) {
      flushPara();
      const tag = /^\d/.test(line) ? 'ol' : 'ul';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(m[1]);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return out.join('\n');
}

function fill(text) {
  const v = vars();
  return String(text).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in v ? v[k] : m));
}

function getPage(slug) {
  const def = DEFAULT_PAGES[slug];
  const row = db.prepare('SELECT * FROM pages WHERE slug = ?').get(slug);
  if (!row && !def) return null;
  const title = row ? row.title : def.title;
  const body = row ? row.body : def.body;
  return { slug, title: fill(title), html: renderMarkdown(fill(body)), raw: body, rawTitle: title, edited: Boolean(row), updated_at: row && row.updated_at };
}

const listPages = () => Object.keys(DEFAULT_PAGES).map(getPage);

function savePage(slug, title, body) {
  if (!DEFAULT_PAGES[slug]) return false;
  db.prepare(`INSERT INTO pages (slug, title, body, updated_at) VALUES (?, ?, ?, datetime('now'))
              ON CONFLICT(slug) DO UPDATE SET title = excluded.title, body = excluded.body, updated_at = excluded.updated_at`)
    .run(slug, title, body);
  return true;
}
const resetPage = (slug) => db.prepare('DELETE FROM pages WHERE slug = ?').run(slug);

module.exports = { DEFAULT_PAGES, getPage, listPages, savePage, resetPage, renderMarkdown };
