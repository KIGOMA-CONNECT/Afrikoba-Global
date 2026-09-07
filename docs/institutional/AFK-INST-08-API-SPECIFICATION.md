---
Document ID: AFK-INST-08
Title: API Specification
Purpose: Public/internal API contracts, versioning, auth, errors, rate limits and deprecation policy; canonical contracts to stop return-shape drift (Gap C4).
Owner: Platform Lead
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: All route modules (see inventory); middleware; developer portal (049)
Related Regulatory Requirements: AFK-INST-13 (compliance endpoints), PDPA/GDPR (data-subject endpoints)
Approval Authority: Platform Lead / CAB for breaking changes
---

# API Specification (AFK-INST-08)

## 1. Conventions

- Base paths: `/api/v1` (canonical) with `/api` backward-compat (180-day sunset after a versioned change is announced).
- JSON over HTTPS; requests validated with Zod on every route (`src/validations/schemas.js`).
- Success envelope: `{ success: true, ...data }`; Error envelope:
  `{ success:false, code:'AUTH_*'|'WALLET_*', message, requestId }` (requestId present; `stack` only in dev).
- Idempotency: financial mutations honour `Idempotency-Key` header; unique references prevent double-posting.
- Pagination: `page`/`limit` (max 100) with metadata.
- Rate limits: 15-min windows — OTP 20, Auth 40, API 1000; device-scoped limits on transfer/withdraw.

## 2. Auth

- OTP phone verify → JWT (Bearer); optional password/PIN; TOTP 2FA for privileged actions.
- RBAC roles surfaced in claims (`role`); admin ops require ADMIN + often a four-eyes executor.
- Webhooks/USSD authenticated by HMAC signature (WEBHOOK_SECRET / USSD_SECRET) + ip allowlist.

## 3. Module surface (representative)

| Module | Routes prefix | Key endpoints |
|--------|---------------|---------------|
| Auth | /api/auth | send-otp, register, login-password, totp |
| Wallet | /api/wallet | balance, deposit, transfer, withdraw, statements, holdings |
| VICOBA | /api/vicoba (+ /api/mkoba) | groups, shares, loans, social fund, meetings |
| ROSCA | /api/rosca | pools, contributions, rotations, payouts |
| P2P | /api/p2p | projects, invest, milestones, escrow, splits |
| AI | /api/ai | insights (+ /refresh, /:id/dismiss), cashflow, health |
| Analytics | /api/banking/analytics | spending, trend, top-recipients, averages, health |
| Merchant | /api/merchant | QR, payment links, payouts, invoices |
| Business | /api/business, /api/payroll, /api/budget | invoices, payroll runs, budgets |
| Procurement | /api/procurement | suppliers, RFQs, bids, supplier financing |
| Field partners | /api/field-partners | partner registration, credit decisioning |
| Ops/Admin | /api/ops, /api/admin | chart-of-accounts, tracing/:traceId, partitions, countries, fraud-ops, four-eyes, features, experiments |
| Devices | /api/devices | trusted-device registry, device_policy |
| Countries | /api/countries | config, /me (usage/limits) |
| USSD | /api/ussd (HMAC) | menu, balance, portfolio, transfer |

## 4. Known contracts to standardise (C4)

- `POST /api/auth/register` returns `user.phone_number` (canonical) — tests must assert `phone_number`, NOT `phone`.
- Wallet transfer returns `{ success, referenceId, amount, message }` — no `balance` in transfer response; clients must not rely on it.
- `POST /api/ai/insights/:id/dismiss` returns `{ dismissed: { id } }` (not a boolean).

## 5. Versioning & deprecation

- Non-breaking additions: additive only; no field removal without a major version bump.
- Breaking change: document in a new `/api/vN+1`, announce ≥ 180 days, keep `/api` alias during overlap, then archive.
- Swagger/OpenAPI served at `/api/v1/docs` in non-prod.

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline from route inventory + standards audit; standardises C4 contracts | Platform Lead (pending) |