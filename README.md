# Threadline: a mobile-first clothing store with a USDC affiliate program

A clothing shop built with Node.js, Express, EJS and SQLite (the `node:sqlite` module that ships with Node). There are no native modules and no database server to install.

## Features

**Storefront (mobile first)**
- Home page, category chips, search and sorting, plus a bottom tab bar on phones
- Product page with a size picker. Each size has its own **price and stock**
- Cart, guest checkout with cash on delivery, and an order confirmation page
- Customer accounts with order history

**Admin panel** (`/admin`)
- Dashboard: revenue, orders, low-stock sizes and pending withdrawal requests
- **Categories**: add, edit and delete, with an optional image
- **Products**: name, category, description, image and visibility, plus any number of **sizes, each with its own price and stock**
- **Orders**: change the status (pending → paid → shipped → delivered / cancelled). Cancelling an order puts its items back in stock
- **Affiliates**: clicks, orders, balances and wallet for each user
- **Withdrawals**: copy the user's wallet, send the USDC, then paste the transaction hash and mark the request as paid (or reject it)
- **Settings**: store name, currency, shipping fee, free-shipping threshold, **commission rate (default 10%)** and minimum withdrawal

**Affiliate program**
- Every registered user gets a personal link: `/r/CODE`. Adding `?ref=CODE` to any page works too
- A visitor is credited to the referrer for 30 days through a cookie. Users cannot earn from their own purchases
- The referrer earns **10% of the order subtotal**. Shipping is not counted
- A commission is **pending** until the admin marks the order **delivered**. It then becomes **available**. Cancelled orders cancel the commission
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
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@store.local` / `admin12345` | Creates the admin on first start. **Change these.** |
| `SESSION_SECRET` | random | Set this, or everyone is logged out on every restart |
| `BASE_URL` | taken from the request | Public URL used in affiliate links, e.g. `https://shop.example.com` |
| `COOKIE_SECURE` | `false` | Set to `true` when serving over HTTPS |
| `SEED_DEMO` | `true` | Set to `false` to start without the demo products |
| `DATA_DIR` | `./data` | Where the SQLite database is stored |

Uploaded images are saved in `./uploads`. Back up `data/` and `uploads/`.

## Notes
- Payment is cash on delivery. Online card or crypto checkout can be added later in `src/routes/shop.js`.
- USDC payouts are sent **manually** by the admin from the store's wallet. The site records each request and its transaction hash; it does not hold any private keys.
