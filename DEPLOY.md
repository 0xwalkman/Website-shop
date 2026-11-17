# Launching Outouf

This guide takes the store from this repository to a live, secure website. Budget about an hour.

## 1. What you need

| | Examples | Rough cost |
|---|---|---|
| A domain | Namecheap, Cloudflare, GoDaddy | ~$10-15/year |
| A server | Hetzner, DigitalOcean, Vultr, Contabo (Ubuntu, 1 GB RAM is enough to start) | ~$5-7/month |
| PayPal Business account | paypal.com/business | per transaction |
| Binance Pay merchant account | merchant.binance.com | per transaction |
| Email sending (SMTP) | Resend, Postmark, Brevo, Mailgun, or Google Workspace | free tiers available |

## 2. Put the store on the server (Docker, recommended)

```bash
# on a fresh Ubuntu server
curl -fsSL https://get.docker.com | sh
git clone <this repository> outouf && cd outouf
cp .env.example .env
nano .env          # fill in every value (see comments in the file)
docker compose up -d
```

Before starting, point your domain's **A record** at the server's IP address. Caddy gets the HTTPS certificate automatically once DNS works. Open `https://yourdomain.com`.

Useful commands:

```bash
docker compose logs -f store                 # see what the store is doing
docker compose pull && docker compose up -d --build   # update after pulling new code
docker compose cp store:/app/data/backups ./backups   # copy backups off the server
docker compose exec store node --disable-warning=ExperimentalWarning scripts/reset-2fa.js you@example.com
```

**Without Docker:** any host that runs Node.js 22.13+ with a persistent disk works (Render, Railway, Fly.io with a volume). Run `npm ci --omit=dev && npm start`, put `data/` and `uploads/` on the persistent disk, and set the same environment variables.

## 3. Connect payments

**PayPal** (developer.paypal.com → My Apps & Credentials → Live → create an app):
1. Copy the Client ID and Secret into `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` and set `PAYPAL_ENV=live`.
2. In the app, add a webhook to `https://yourdomain.com/paypal/webhook` with events `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`.
3. Test first with `PAYPAL_ENV=sandbox` and the sandbox app's keys.

**Binance Pay** (merchant portal → API management): copy the API key and secret into `BINANCE_PAY_API_KEY` / `BINANCE_PAY_SECRET_KEY`. No webhook setup is needed; each order tells Binance where to notify.

Restart (`docker compose up -d`). **Admin → Settings** shows the status of PayPal, Binance Pay and email.

## 4. Connect email

Put your provider's SMTP details in `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and set `MAIL_FROM` to an address on your domain. In your provider's dashboard, **verify your domain** (they give you DNS records: SPF, DKIM). Without that, emails land in spam.

Until SMTP is set, emails are saved in `data/outbox/` instead of being sent, so nothing is lost while you test.

## 5. Launch checklist

- [ ] HTTPS works and `http://` redirects to `https://`
- [ ] `SESSION_SECRET` is a long random string; `COOKIE_SECURE=true`; `BASE_URL` is your https address
- [ ] Logged in with the owner account, **changed the password**, and turned on **two-step login** (Admin → Security)
- [ ] Admin → Settings: store name, contact email, WhatsApp, business details, shipping and return times
- [ ] Admin → Pages: read and adjust **every** policy page (starter text, not legal advice)
- [ ] Demo products deleted (or started with `SEED_DEMO=false`), real products and photos added
- [ ] Test order **paid with PayPal** in sandbox mode, then one small **live** PayPal payment, refunded from Admin with **Refund via PayPal**
- [ ] Test order **paid with Binance Pay** (small amount), then refund it from the Binance merchant dashboard and mark it refunded
- [ ] Order confirmation, shipping and password-reset emails arrive (check spam)
- [ ] Shipped an order with a tracking number and opened the tracking link from the email
- [ ] Affiliate flow: registered a second account, bought through its link, saw the commission
- [ ] Submitted the sitemap (`https://yourdomain.com/sitemap.xml`) in Google Search Console
- [ ] Backups: confirmed a file appears in `data/backups/` after a day, and copied one off the server

## 6. Ongoing

- **Backups:** the database is copied daily to `data/backups` (14 days kept). Also enable your host's volume/disk snapshots: they cover product photos too. Copy a backup off the server regularly.
- **Updates:** `git pull && docker compose up -d --build`.
- **Affiliate payouts:** USDC payouts may have tax/reporting implications where you are based. Check with an accountant before paying out large amounts.
