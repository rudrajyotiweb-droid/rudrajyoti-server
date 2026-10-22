# Rudra Jyoti — Backend API

Express 5 + MongoDB (Mongoose) API for the devotee site (`client-site`) and the admin panel (`admin-site`).
Phone OTP via **Message Central**, payments via **Paytm**, images and videos stored **in MongoDB (GridFS)**.

## Run

```bash
pnpm install
cp .env.example .env      # fill in the values (a working .env for this project already exists)
pnpm seed                 # upload client-site images to the DB + insert the catalog + first super admin
pnpm dev                  # http://localhost:5000  (auto-restarts on file changes)
pnpm start                # production
```

Health check: `GET /health` → `{ status: "ok", db: "connected" }`.

| Script | What it does |
|---|---|
| `pnpm seed` | Idempotent. Inserts what is missing; never overwrites edits made in the admin. |
| `pnpm seed:fresh` | Wipes **catalog & content** (pujas, temples, products, banners, pages, coupons, settings…) and reseeds. Users, bookings, orders and payments are kept. |
| `pnpm create-admin -- --email a@b.in --password "…" --name "Admin"` | Reset the admin password (or create the admin account) from the command line, e.g. if the password is forgotten. |

First admin login: `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from `.env`. **Change the password** after the first sign-in (Admin → Settings → My account) and turn on 2FA there.

## Going live: Message Central + Paytm

Both run in a safe test mode until you add keys (production refuses to start in test mode):

| Feature | Test mode (`.env`) | Live |
|---|---|---|
| OTP | `OTP_PROVIDER=console` — the OTP is `OTP_DEV_CODE` (default `123456`) and is printed in the server log | `OTP_PROVIDER=messagecentral` + `MESSAGE_CENTRAL_CUSTOMER_ID`, `MESSAGE_CENTRAL_PASSWORD` (plain password; it is Base64-encoded for you). `MESSAGE_CENTRAL_FLOW_TYPE=SMS` or `WHATSAPP`. |
| Payments | `PAYMENT_PROVIDER=mock` — the site shows a "TEST MODE" confirm dialog instead of a gateway | `PAYMENT_PROVIDER=paytm` + `PAYTM_MID`, `PAYTM_MERCHANT_KEY`, `PAYTM_WEBSITE` (`WEBSTAGING` for staging, `DEFAULT` for live) and `PAYTM_HOST` (`https://securegw-stage.paytm.in` or `https://securegw.paytm.in`). |

Paytm flow: the API calls `initiateTransaction` → the browser opens Paytm JS Checkout → when it reports back, the site calls `POST /api/v1/payments/verify`, and the API asks Paytm's **order-status API** (the source of truth) before marking anything paid. The amount is checked against the order. Paytm's redirect callback (`/api/v1/payments/paytm/callback`, checksum-verified) and a background job every 5 minutes cover closed tabs and lost networks. `API_PUBLIC_URL` must be the public HTTPS URL of this API so Paytm can reach the callback.

## Environment

Every variable is documented in `.env.example` and validated at start-up (`src/config/env.js`); a missing or invalid value stops the server with a readable message instead of failing later. Generate secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

MongoDB Atlas: allow the server's IP in **Network Access**, otherwise the API exits with "Could not connect to MongoDB".

## API overview (`/api/v1`)

Responses are `{ data, meta? }`; errors are `{ error: { code, message, details? } }` with a proper HTTP status.

**Public** — `GET /site`, `/home`, `/pujas`, `/pujas/:slug`, `/chadhava`, `/chadhava/:slug`, `/temples`, `/temples/:slug`, `/categories`, `/products`, `/products/:slug`, `/addons`, `/reviews`, `/faqs`, `/pages/:slug`, `/posts`, `/search?q=`; `POST /contact`, `POST /events` (anonymous funnel/traffic counters).

**Auth (devotee)** — `POST /auth/otp/send`, `/auth/otp/verify` → access token (15 min) + rotating refresh token (30 days), `POST /auth/refresh`, `/auth/logout`, `GET /auth/me`.

**Account** — profile, family, addresses, wishlist, bookings, orders (cancel / return), notifications, support tickets, reviews (only after a performed puja / delivered order).

**Checkout** — `POST /checkout/coupon`, `/checkout/puja`, `/checkout/chadhava`, `/checkout/order` (online or COD), `/checkout/retry`. Prices, coupons, stock and shipping are always computed on the server.

**Payments** — `POST /payments/verify`, `GET /payments/:orderId`, `POST /payments/paytm/callback`, `POST /payments/mock/complete` (test mode only).

**Admin** (`/admin`, JWT, every change written to the audit log) — auth + TOTP 2FA, dashboard, alerts, counts, reports, CRUD for pujas (duplicate, cancel-with-refunds, master video), chadhava, temples, add-ons, categories, products (+ stock adjustments & inventory log), bookings (status, bulk status, cancel + refund, per-booking video), orders (status flow, AWB, bulk), payments (sync, full/partial refunds), customers (block, notes), coupons, banners (+ reorder), reviews, tickets, pages, posts, FAQs, home page config, settings, push/in-app campaigns, media library uploads.

**Media** — `GET /media/<key>` streams images and videos from GridFS with ETag, caching and HTTP Range (video seeking).

## Reliability & security

- Fails fast on bad config; retries the DB connection; graceful shutdown on SIGINT/SIGTERM; `unhandledRejection` is logged instead of crashing; returns 503 while the DB is down.
- One central error handler maps validation, duplicate-key, cast, upload-size, JWT and DB errors to clean responses — stack traces never reach clients in production.
- Every input is validated with zod; `$`/`.` keys are stripped from bodies (NoSQL injection); helmet, CORS allow-list, compression and rate limits (global, auth, OTP, payments, contact).
- OTP: 30 s resend cooldown, 5 sends/hour and 5 attempts per code, per phone.
- Payments: idempotent state transitions (conditional updates), amount verification, atomic stock reservation with release on failure/expiry, atomic refund guard against double refunds.
- Admin: bcrypt passwords, lockout after 5 failed logins, optional TOTP 2FA, token revocation on password/role change.
- Uploads: type detected from file bytes (not the browser's claim), size limits from `.env`.

## Structure

```
src/server.js           start-up, DB connect, graceful shutdown
src/app.js              middleware stack, /health, /media, /api/v1
src/config/             env validation, MongoDB connection
src/models/             Mongoose schemas (user, admin, catalog, commerce, content)
src/routes/             public, auth, account, checkout, payments, admin/*
src/services/           messageCentral, otp, paytm, payments, pricing, media (GridFS), settings, notify, audit, tokens
src/jobs/reconcile.js   payment reconciliation, booking auto-close at cutoff, refund status polling
src/seed/               data.json (extracted from client-site/src/data) + seed.js
src/scripts/            createAdmin.js
```
