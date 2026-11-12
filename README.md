# Outouf: a mobile-first clothing store with a USDC affiliate program

A clothing shop built with Node.js, Express, EJS and SQLite (the `node:sqlite` module that ships with Node). There are no native modules and no database server to install.

## Features

**Storefront (mobile first)**
- Home page, category chips, search and sorting, plus a bottom tab bar on phones
- Product page with a size picker. Each size has its own **price and stock**
- Cart and guest checkout with a country picker. **Shipping is free worldwide by default**
- **Two ways to pay: card (Stripe) or Binance Pay (crypto).** Customers choose at checkout, and only the methods you have set up are shown. Items are held while the customer pays and released if they cancel or abandon the payment page
- Order tracking: paid → shipped → delivered
- Customer accounts with order history

**Admin panel** (`/admin`)
- Dashboard: revenue, orders, low-stock sizes and pending withdrawal requests
- **Categories**: add, edit and delete, with an optional image
- **Products**: name, category, description, image and visibility, plus any number of **sizes, each with its own price and stock**
- **Orders**: paid orders appear automatically once Stripe confirms the payment. Mark them shipped and delivered, cancel them (items go back in stock), or **refund through Stripe** with one button. Abandoned checkouts are hidden behind their own filters
- **Affiliates**: clicks, orders, balances and wallet for each user
- **Withdrawals**: copy the user's wallet, send the USDC, then paste the transaction hash and mark the request as paid (or reject it)
- **Settings**: store name, currency (USD, EUR, GBP and more), shipping fee (default **free**), **commission rate (default 10%)**, minimum withdrawal, and Stripe connection status

**Affiliate program**
- Every registered user gets a personal link: `/r/CODE`. Adding `?ref=CODE` to any page works too
- A visitor is credited to the referrer for 30 days through a cookie. Users cannot earn from their own purchases
- The referrer earns **10% of the order subtotal**. Shipping is not counted
- Commissions are only created for **paid** orders. A commission is **pending** until the admin marks the order **delivered**, and then becomes **available**. Cancelling or refunding the order cancels the commission
- The dashboard shows available, pending, withdrawn and in-payout amounts, link clicks, orders, sales, conversion rate, a 14-day chart, and the full history of commissions and withdrawals
- Users save a **USDC wallet** (Ethereum, Base, Polygon, Arbitrum, Optimism or Solana). The address format is checked, and saving it requires the account password
- Withdrawal requests are checked against the available balance and the minimum amount. Requested funds are held until the admin pays or rejects the request

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
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@store.local` / `admin12345` | Creates the admin on first start. **Change these.** |
| `SESSION_SECRET` | random | Set this, or everyone is logged out on every restart |
| `BASE_URL` | taken from the request | Public URL used in affiliate links, e.g. `https://shop.example.com` |
| `COOKIE_SECURE` | `false` | Set to `true` when serving over HTTPS |
| `SEED_DEMO` | `true` | Set to `false` to start without the demo products |
| `DATA_DIR` | `./data` | Where the SQLite database is stored |

Uploaded images are saved in `./uploads`. Back up `data/` and `uploads/`.

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
