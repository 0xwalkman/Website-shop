# Outouf: a mobile-first clothing store with a USDC affiliate program

A clothing shop built with Node.js, Express, EJS and SQLite (the `node:sqlite` module that ships with Node). There are no native modules and no database server to install.

## Features

**Storefront (mobile first)**
- Home page, category chips, search and sorting, an **On sale** filter, and a bottom tab bar on phones
- Product pages with a **photo gallery**, a **color picker**, and sizes that each have their own **price, sale price ("was") and stock**
- **Discount codes** in the cart and at checkout
- Checkout with a country picker; **free worldwide shipping** by default; a customs-duties notice
- **Card payments (Stripe)** and **Binance Pay (crypto)**. Items are held while the customer pays
- Order page with a progress tracker and the **carrier tracking link**
- **Emails**: order confirmation, shipped (with tracking), delivered, refunded, cancelled, password reset, affiliate payouts, and a new-order alert for you
- Policy pages (Shipping, Returns, Terms, Privacy, Affiliate rules), a **Contact** form, a floating **WhatsApp** button, and a cookie notice
- Search engines: sitemap, robots.txt, product structured data, link previews for WhatsApp and social media
- Customer accounts with order history and **forgot-password**

**Admin panel** (`/admin`)
- Dashboard, plus **Statistics** (visitors, orders, conversion, top products, where visitors come from), counted without cookies or personal data
- **Products**: several photos, colors, sizes, prices, sale prices and stock. **Categories**: add, edit and delete
- **Orders**: paid orders appear automatically. Mark them shipped (with a tracking number) and delivered, cancel them, or refund through Stripe
- **Discount codes**: percent or fixed amount off, with optional minimum order, use limit and expiry date
- **Affiliates** and **Withdrawals**: pay USDC, record the transaction hash, and the affiliate is emailed
- **Pages**: edit the policy pages (they start with template text that uses your Settings)
- **Team**: invite **staff** (products, orders and stats only) or other **owners**
- **Security**: **two-step login** with an authenticator app
- **Settings**: store details, contact email and WhatsApp, shipping and return promises, currency, commission rate, minimum withdrawal, and the status of Stripe, Binance Pay and email

**Affiliate program**
- Every registered user gets a personal link: `/r/CODE`. Adding `?ref=CODE` to any page works too
- Visitors are credited to the referrer for 30 days. Self-referrals don't count
- The referrer earns **10%** of the products total, after any discount and without shipping. Commissions are created only for paid orders and become **available** once the order is **delivered**
- Users save a **USDC wallet** (Ethereum, Base, Polygon, Arbitrum, Optimism or Solana); saving it requires their password
- Withdrawal requests are checked against the available balance and the minimum amount

**Going live?** Follow [DEPLOY.md](DEPLOY.md): server setup with automatic HTTPS (Docker + Caddy), payments, email, and a launch checklist.

## Run it

Requires **Node.js 22.13 or later**.

```bash
npm install
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-strong-password' SESSION_SECRET='long-random-string' npm start
```

Open http://localhost:3000. Log in with the admin account to reach `/admin`.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `STRIPE_SECRET_KEY` | none | **Required to take payments.** `sk_live_…`, or `sk_test_…` for testing. Checkout is disabled without it |
| `STRIPE_WEBHOOK_SECRET` | none | `whsec_…` from your Stripe webhook (see below). Strongly recommended |
| `BINANCE_PAY_API_KEY` / `BINANCE_PAY_SECRET_KEY` | none | Turns on Binance Pay. From the Binance merchant portal (see below) |
| `BINANCE_PAY_CURRENCY` | `USDT` | Coin USD orders are charged in, 1:1 (`USDT` or `USDC`) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | none | Your email provider. Without them, emails are saved to `data/outbox/` |
| `MAIL_FROM` | store name and contact email | Sender, e.g. `Outouf <hello@yourdomain.com>` |
| `BACKUP_KEEP_DAYS` | `14` | Daily database backups in `data/backups/`. Set `BACKUPS=off` to disable |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@store.local` / `admin12345` | Creates the admin on first start. **Change these.** |
| `SESSION_SECRET` | random | Set this, or everyone is logged out on every restart |
| `BASE_URL` | taken from the request | Public URL used in affiliate links, e.g. `https://shop.example.com` |
| `COOKIE_SECURE` | `false` | Set to `true` when serving over HTTPS |
| `SEED_DEMO` | `true` | Set to `false` to start without the demo products |
| `DATA_DIR` | `./data` | Where the SQLite database is stored |

Uploaded photos are resized (max 1600px), converted to WebP and stripped of metadata such as GPS location, then saved in `./uploads`. Back up `data/` and `uploads/`.

## Setting up Stripe

1. In the Stripe Dashboard, open **Developers → API keys** and copy the **secret key** into `STRIPE_SECRET_KEY`.
2. Open **Developers → Webhooks → Add endpoint**:
   - URL: `https://YOUR-DOMAIN/stripe/webhook`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`
   - Copy the endpoint's **signing secret** into `STRIPE_WEBHOOK_SECRET`.
3. Set `BASE_URL` to your public `https://` address so Stripe sends customers back to the right place and shows product photos.
4. Restart the site. **Admin → Settings** shows whether Stripe is connected.

To test locally, use `sk_test_…` keys and run `stripe listen --forward-to localhost:3000/stripe/webhook` with the Stripe CLI. Pay with card `4242 4242 4242 4242`, any future date and any CVC.

How payments work:
- Checkout creates an *awaiting payment* order that holds the items, then sends the customer to Stripe.
- When Stripe confirms the payment (by webhook, or when the customer returns), the order becomes **paid**. The amount and currency are checked against the order first.
- Pressing "back" on Stripe, abandoning the page, or letting it expire (1 hour) cancels the order and puts the items back in stock. Nothing is charged.
- If a webhook is ever missed, the site checks unpaid orders with Stripe every 10 minutes.

## Setting up Binance Pay

1. Apply for a Binance Pay **merchant** account, then create an API key in the merchant portal (Developers / API Management).
2. Set `BINANCE_PAY_API_KEY` and `BINANCE_PAY_SECRET_KEY` on the server and restart. The **Binance Pay** option appears at checkout and **Admin → Settings** shows it as connected.
3. Make sure `BASE_URL` is your public `https://` address. Each order tells Binance to notify `BASE_URL/binance/webhook`, so you don't need to configure a webhook in the portal.

How Binance Pay works:
- With the store in USD, the customer pays the exact total in USDT (or `BINANCE_PAY_CURRENCY`). In other store currencies, Binance converts the price at the market rate.
- **Payment is always confirmed by asking Binance's API directly**, using a request signed with your key. This happens when the customer returns, when Binance's notification arrives, and every 10 minutes for open orders. The notification itself is never trusted, so a fake one cannot mark an order paid. For USD orders, the amount and coin must match exactly.
- If the customer cancels or abandons the page, the Binance order is closed and the items go back in stock. An order Binance reports as paid but for the wrong amount is **not** cancelled. It stays "awaiting payment" (and is logged) so you can review it.
- **Refunds:** send them from the Binance merchant dashboard, then set the order to **refunded** in the admin. That puts the items back in stock and cancels the affiliate commission.

> The Binance Pay integration follows Binance's published API (v3 create order, v2 query order, close order, HMAC-SHA512 signing). It was tested against a simulated Binance Pay server. Before going live, place one small real order to confirm it works with your merchant account.

## Notes
- USDC payouts are sent **manually** by the admin from the store's wallet. The site records each request and its transaction hash; it does not hold any private keys.

## Tests

`npm test` runs four browser test suites against a real server, a fresh database and fake Stripe and Binance Pay APIs, so no money moves and no network is needed. Install Playwright once first: `npm i --no-save playwright && npx playwright install chromium`. The same tests run automatically on GitHub for every push (`.github/workflows/test.yml`).

- `e2e-security`: login redirects, Host-header poisoning, CSRF, checkout rate limits, private pages
- `e2e-stripe` / `e2e-binance`: paying, cancelling, abandoning, expiry, forged webhooks, wrong amounts, refunds
- `e2e-all`: emails, password reset, 2FA, staff, photos, colors, sale prices, discounts, tracking, pages, SEO, stats

## Lost access to two-step login?
On the server: `node --disable-warning=ExperimentalWarning scripts/reset-2fa.js you@example.com` (with Docker: `docker compose exec store node --disable-warning=ExperimentalWarning scripts/reset-2fa.js you@example.com`).
