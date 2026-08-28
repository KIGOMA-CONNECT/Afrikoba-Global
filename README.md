# Afrikoba Global

**Integrated Core Digital Banking, VICOBA Automation, ROSCA Engine & P2P Investment Ecosystem**

Afrikoba Global is a pan-African digital banking & financial-inclusion platform. It unifies
individual wallets, cooperative banking (VICOBA / M-Koba), rotating savings groups (ROSCA),
P2P investments, family wallets, and a full Business & Commerce OS — all on one tech stack
with bank-grade security and multi-currency support.

> Vision: *"stronger than any other"* — a compliant, secure, super-app fintech built for
> Tanzania, Kenya, Uganda and the wider continent.

---

## Feature Layers

| Layer | Area | Highlights |
|------|------|-----------|
| **A** | Security H1–H20 | Helmet/CSP, rate limiting (granular + global), JWT hardening, OTP brute-force protection, 2FA/TOTP, idempotency keys, audit logs, SQL injection guard, webhook HMAC + replay protection, device fingerprinting, backup scheduler |
| **B** | Core Banking B1–B11 | Wallet deposit/withdraw/transfer, accounts, statements, scheduled & recurring payments, P2P, currency conversion |
| **C** | Advanced C1–C10 | Domestic transfers, bank payments, split payments, VICOBA loans/repayment, loan products, disaster recovery |
| **D** | Smart D1–D10 | Spending insights & predictions, budget alerts, debt collection, reward points, auto-subscriptions, calendar bills, business insights & tips, transaction categories |
| **E** | Ecosystem E1–E8 | QR payments, in-app chat, bill payments (utility), airtime top-ups (cross-network), statement export (PDF/CSV), backup codes, security challenges, insurance packages |
| **F** | Network F1–F8 | Agent network (apply/verify/cash-in/cash-out/settlement), bulk payments, scheduled payments cron, cross-border remittances (corridors + pickup), webhook subscriptions, merchant loyalty, AI spending insights, enhanced referral tiers |
| **G** | Family & Next-Gen G1–G5 | Family/shared wallets (invite, join, contribute, spend, transfer), multi-currency balances + FX, biometric/device binding with challenge, offline operation queue + sync, round-up savings |
| **H** | Business & Commerce H1–H10 | Business accounts & withdrawals, payment links, tax-aware invoicing, inventory with low-stock alerts, batch payroll, supplier payments, sales analytics, business loans (apply → admin approve → disburse → repay), tax/compliance register, staff roles + POS sessions |
| **I** | Savings & Credit I1–I10 | Savings goals with contributions, auto-save rules (daily/weekly/monthly), fixed deposits with maturity interest & early-withdrawal penalty, credit score & limit engine, personal micro-loans with installment schedules + early payoff (waives remaining installments), guarantors (20% reserved until disbursement), credit report |
| **J** | Virtual Cards J1–J6 | On-demand virtual Visa/Mastercard-style cards (Luhn-valid PAN + single-view CVV, masked storage, hashed PAN/CVV), daily & per-transaction limits, freeze/unfreeze, block (reported lost), purchase authorization with wallet holds (AUTH_HOLD → locked_balance), merchant settlement releasing the hold, pre-settlement refunds, card statement & monthly spend summary |

Additional modules: VICOBA & M-Koba automation (constitution, shares, meetings with fines,
profit distribution, member/loan-ageing reports), ROSCA engine, P2P investment marketplace with
escrow milestones + rigorous audit trail.

---

## Tech Stack

- **Runtime:** Node.js (Express 4, `require` CJS)
- **Database:** PostgreSQL (base schema + appended `db/migrations/*.sql`)
- **Cache / shared rate-limit store:** Redis (optional; auto-fallback to in-memory)
- **Security:** Helmet, express-rate-limit, `rate-limit-redis`, bcryptjs, jsonwebtoken, otplib, zod
- **Monitoring:** Sentry (optional), structured JSON logging
- **Docs:** Swagger UI (served at `/api/v1/docs`)
- **Clients:** React/Vite web dashboard (`web-dashboard/`), Flutter mobile app (`mobile/`)

---

## Getting Started (Local Development)

Prerequisites: Node.js 18+, PostgreSQL (16/17/18).

```bash
# 1. Prepare environment
cp .env.example .env        # fill in DB_* credentials for your local PG

# 2. Create the database & load base schema + seed
createdb afrikoba_global
node scripts/initDb.js      # applies db/schema.sql
node scripts/seedDb.js      # official/debut data (admin user, demo groups)

# 3. Apply feature migrations (idempotent, tracked in schema_migrations)
node scripts/runMigrations.js

# 4. Run the API
npm start                   # http://localhost:3000
npm run dev                 # auto-reload

# 5. Run the full integration suite (test server needs rate-limit bypass)
#    RATE_LIMIT_DISABLED=true node src/server.js
node scripts/test-all.js
```

Seed admin login (from `seedDb.js`): see your `.env`/seed — admin phone
`255712000001` is used by the integration suite.

> **Rate limits in tests:** integration tests simulate many users from one IP, so the
> server must start with `RATE_LIMIT_DISABLED=true` (or `DISABLE_RATE_LIMIT=true`).
> Production must **never** set these — all limiters stay fully active.

---

## API Overview

All endpoints live under `/api/v1/*` (canonical) with backward-compatible `/api/*` aliases.
Interactive docs: Swagger UI at `/api/v1/docs`.

Key route families:

| Prefix | Purpose |
|--------|---------|
| `/auth` | OTP, register, login, KYC, sessions, backup codes |
| `/wallet` | Deposit, withdraw, transfer, balance, statements |
| `/vicoba`, `/mkoba` | Cooperative banking automation |
| `/rosca` | Rotating savings & credit engine |
| `/p2p` | Investment projects, escrow milestones |
| `/admin` | Platform administration |
| `/banking`, `/advanced`, `/smart` | C/D-series features |
| `/eco` | QR, chat, bills, airtime, export, insurance |
| `/network` | Agents, bulk, scheduled, remittance, webhooks, loyalty, insights, referrals |
| `/family` | Family wallets, multi-currency, biometric, offline, round-up |
| `/business` | Business & Commerce OS (H-series) |
| `/savings` | Savings goals, auto-save rules, fixed deposits, savings summary (I-series) |
| `/credit` | Credit score & limit, micro-loans, installments, guarantors, credit report (I-series) |
| `/cards` | Virtual cards: issue, limits, freeze/block, purchase authorization, settle/refund (admin), statement, summary (J-series) |
| `/payments` | Payment webhooks (AzamPay callbacks, HMAC protected) |
| `/ussd` | USSD gateway |
| `/currency` | FX rates |
| `/notifications`, `/referrals`, `/analytics`, `/services`, `/totp` | Supporting modules |

Health checks: `GET /health` (liveness) and `GET /health/db` (readiness).

---

## Configuration

Copy `.env.example` → `.env` and fill in real values. Critical variables:

- `DB_*` — PostgreSQL connection
- `JWT_SECRET` — generate with `openssl rand -hex 48`
- `WEBHOOK_SECRET` — callback signature key
- `BEEM_API_KEY` / `BEEM_SECRET_KEY` — SMS (OTP delivery)
- `AZAMPAY_*` — payment checkout (set `AZAMPAY_ENV=production` for live)
- `CORS_ORIGINS` — real origins in production (no `*`)
- `CONTRACT_BASE_URL` — must be `https://...` in production

The config **fails fast in production**: if critical values are missing/default,
the server refuses to start (`src/config/index.js` → `validateConfig`).

---

## Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full guide. Quick path:

```bash
cp .env.example .env   # fill in real secrets
docker compose up -d --build
```

The Docker stack: PostgreSQL 16 (with nightly `pg_dump` backups to `./backups/`),
Redis 7 (shared rate-limit store), and the API/image that **auto-runs migrations
on startup** (`node scripts/runMigrations.js`) before serving. Recommended
front-line: Caddy or Nginx with automatic TLS, or a PaaS (Render/Railway/Fly.io).

### Compliance notes

A production launch requires (see DEPLOYMENT.md): real AzamPay + Beem credentials,
Bank of Tanzania (BoT) approval for money-transmission services, CMSA registration if
offering securities-style returns, ODPC/PDPA data-controller registration, and a review
of the bundled policies (`PRIVACY_POLICY.md`, `TERMS_OF_SERVICE.md`,
`DATA_RETENTION_POLICY.md`, `GLOBAL_STANDARDS_AUDIT.md`, `PRODUCTION_CHECKLIST.md`).

---

## Testing

- `scripts/test-all.js` — full integration suite through the live API (268 checks across
  layers A–J). Run against a server started with `RATE_LIMIT_DISABLED=true`.
- `scripts/test-p2p.js`, `scripts/security-test.js` — focused suites (P2P escrow, security).

CI (`.github/workflows/ci.yml`) runs the backend suite against a Postgres service
container, builds the web dashboard, and lints/tests the Flutter mobile app.

---

## Repository Layout

```
src/
  server.js            Express app (security middleware stack, mounts all routes)
  config/              env config, redis, swagger
  middleware/          security hardening, rate limits, auth, API-key, data guards
  routes/              versioned route files (one per feature family)
  services/            business logic per feature family
  jobs/                scheduled jobs (cron: reconciliation, ROSCA payouts, scheduled payments, backups)
db/
  schema.sql           base schema
  seed.sql             seed data
  migrations/          001..NNN feature migrations (idempotent)
scripts/
  initDb.js, seedDb.js, runMigrations.js, test-all.js, ...
web-dashboard/         React/Vite admin & customer dashboard (single-origin)
mobile/                Flutter mobile app (secure token storage)
docker-compose.yml / Dockerfile / DEPLOYMENT.md   production deployment
```

---

## License

Proprietary — © Afrikoba Group. All rights reserved (`UNLICENSED`).

---

Made in Tanzania 🇹🇿 · stronger than any other.