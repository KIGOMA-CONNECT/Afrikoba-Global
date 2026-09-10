---
Document ID: AFK-INST-21
Title: Test Strategy
Purpose: Test levels, coverage targets, environments, CI gates and acceptance criteria for Afrikoba Global.
Owner: QA Lead
Status: DRAFT
Version: 1.0
Effective Date: 2026-09-07
Last Review Date: 2026-09-09
Related Systems/Modules: All; scripts/test-*.js; .github/workflows/ci.yml
Related Regulatory Requirements: AFK-INST-13 evidence (test suites prove controls)
Approval Authority: QA Lead / CAB
---

# Test Strategy (AFK-INST-21)

## 1. Test levels

| Level | Scope | Where |
|-------|-------|-------|
| Unit | Services/utils (engine, ledger math, fee/split/WHT) | Node tests |
| Integration/Regression | End-to-end API + DB against a seeded Postgres | `scripts/test-*.js` (44 suites) + CI |
| Frontend build | Web dashboard Vite build; Flutter analyze/test/build | CI |
| Load/Security | k6 load + security scripts (`.github/workflows/k6.yml`, manual vs staging) | staging |
| Continuous monitoring | `uptime.yml` health probes sitting on `/health` + landing + `/api/v1/docs.json` | scheduled |
| UAT/Regression on release | Stable behaviour proof for money math | CI on `main` |

## 2. Coverage targets

- Money correctness: every transfer/deposit/withdrawal/split/disbursement asserts fee math,
  ledger DR=CR, wallet deltas, idempotency (e.g. test-ledger-integrity, test-all, multisplit).
- Security/RBAC: 401/403 on protected ops across suites (device binding, chart-of-accounts, tracing, AI).
- Ops/observability: chart numbering (21 checks), tracing spans (19), partitions, outbox, trace trees.
- Coverage by domain mapped in the suites below.

## 3. CI gates (`.github/workflows/ci.yml`)

- Backend: `npm run db:setup` → `npm run seed` → `npm run db:migrate` → start server
  (RATE_LIMIT_DISABLED=true DISABLE_CRON=true on :3000) → run suite list → fail on exit≠0.
- Dashboard: Vite build. Mobile: flutter analyze + test + build.
- Server log uploaded on failure for triage.

## 4. Backend regression suite list (wired in CI)

test-all, test-services, test-vicoba, test-rosca, test-p2p, test-events-stage4,
test-events-stage5, test-vicoba-inbox, test-features, test-four-eyes, test-experiments,
test-kyc, test-lending-gates, test-kilimo-seasons, test-disputes, test-support, test-currency, test-qr, test-insurance, test-cards, test-merchant-payouts,
test-outbox, test-vault, test-caching, test-partitions, test-ussd, test-multi-country,
test-ledger-integrity, test-field-partners, test-device-binding, test-chart-of-accounts,
test-tracing, test-ai-insights, test-sar-filing, test-openapi, test-procurement, test-tcra-ussd,
test-recurrence, test-payment-requests, test-merchant-invoices, test-marketplace,
test-family-guardian, test-projection-cache, test-restore-verify.

## 5. Known flakiness & rerun policy

- `test-kilimo-seasons` exact-count flake on a shared dev DB — intentionally not weakened.
- `test-kyc` transient CI flake — rerun green. CI job re-runs on flake per infra policy.

## 6. Acceptance (Definition of Done)

Per roadmap §6: backend endpoint + validation/RBAC; idempotent + transactional; SMS where
expected; dashboard UI wired; test proving money math; audit-log entry for money/privileged actions.

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline from CI workflow + suite inventory + standards audit | QA Lead (pending) |
| 0.2 | 2026-09-07 | AI code review | Added test-procurement (C1 suppliers reconciliation / procurement lifecycle / financing) → 31 suites | QA Lead (pending) |
| 0.3 | 2026-09-07 | AI code review | Added test-tcra-ussd (097 shortcode registry / admin lifecycle / RBAC) → 32 suites | QA Lead (pending) |
| 0.4 | 2026-09-08 | AI code review | Added test-restore-verify (AFK-INST-18 DR: pg_dump→restore→integrity, 29 checks) → 33 suites | QA Lead (pending) |
| 0.5 | 2026-09-08 | AI code review | Added test-recurrence (STANDING_INSTRUCTION recurring transfers: SI-* idempotent journal transfer, recurrence_executions, RBAC, disabled-skip) → 34 suites | QA Lead (pending) |
| 0.6 | 2026-09-08 | AI code review | Added test-payment-requests (migration 098 request-to-pay: PRQ-* lifecycle, canonical transfer settlement TR-*, idempotent re-pay, cancel, expiry, RBAC, audit) → 35 suites | QA Lead (pending) |
| 0.7 | 2026-09-08 | AI code review | Added test-merchant-invoices (migration 099 merchant invoices: INV-* lifecycle, canonical merchant-payment settlement MERCH-*, idempotent re-pay, overpay/cancel/expiry guards, RBAC) → 36 suites | QA Lead (pending) |
| 0.8 | 2026-09-09 | AI code review | Added test-marketplace (marketplace money path: purchase→MARKETPLACE_ESCROW hold, evidence→settle, cancel→refund, dispute freeze + ADMIN BUYER_REFUND/SPLIT rulings with balanced journals, RBAC) → 37 suites | QA Lead (pending) |
| 0.9 | 2026-09-09 | AI code review | Added test-family-guardian (family wallet guardian controls: can_spend/spending_limit enforcement, OWNER-only invite/remove, INVITED→ACTIVE lifecycle, contribute/spend/transfer ledger + RBAC) → 38 suites | QA Lead (pending) |
| 1.0 | 2026-09-09 | AI code review | Added test-projection-cache (projection-cache audit: `wallet_balance` == `wallet_ledger` trail net across seed/transfer/PRQ/SI paths + drift-detection self-test) → 39 suites; suite list corrected to include test-marketplace/test-family-guardian; k6 + uptime CI workflows documented | QA Lead (pending) |
| 1.1 | 2026-09-09 | AI code review | Added test-support (migration 100 `resolved_at` backfill + index; member create/list/thread with `sender_phone`/`user_phone` joins, ownership 404 + RBAC 403 guards, admin queue/stats/status transitions IN_PROGRESS–RESOLVED–CLOSED with `resolution`, reopen-on-message, legacy `/api` alias; 38 checks) → 40 suites | QA Lead (pending) |
| 1.2 | 2026-09-09 | AI code review | Added test-currency (multi-currency/FX: identity/direct/inverse/triangulated rate resolution, public convert math, admin rate RBAC + guards, display currency persistence, ledgered TZS↔foreign convert with `CURRENCY_CONVERT` fx_rate/fx_base_currency evidence, round trip + insufficient funds; 41 checks) → 41 suites | QA Lead (pending) |
| 1.3 | 2026-09-09 | AI code review | Added test-qr (QR payments: STATIC/DYNAMIC create + ownership list, scan with payee `phone_number` join + scan_count + self-pay/expiry/unknown guards, pay via canonical transfer with balanced ledger journal + `qr_payments` row + QR meta txn, insufficient funds pre-guard, CSRF on anonymous DELETE, owner-only deactivate; fixed `u.phone`→`u.phone_number`/`u.name`→`u.full_name` scan join + `wallet_amount` NOT NULL on the QR txn insert; 33 checks) → 42 suites | QA Lead (pending) |
| 1.4 | 2026-09-09 | AI code review | Added test-insurance (micro-insurance: public product catalogue + category filter, purchase with canonical premium debit → balanced journal (DR CUSTOMER_WALLET = CR MNO_CLEARING) + `INSURANCE_PREMIUM` txn, product/age/insufficient-funds guards, ownership-scoped policies, renew advancing premium_paid + next_premium_date, failed renewal leaves policy intact; fixed `wallet_amount` NOT NULL on the premium + renewal txn inserts (was breaking purchase/renew end-to-end) + code-less 500s → `INSURANCE_*` 400/404 codes; 37 checks) → 43 suites | QA Lead (pending) |
| 1.5 | 2026-09-09 | AI code review | Added test-cards (virtual cards J1-J6: Luhn-valid PAN + masked number + CVV-once issuance, scheme handling, ownership-scoped manage incl. limits on blocked card, authorization holds through the engine with balanced CUSTOMER_WALLET/CARD_HOLD journal + per-txn/daily/INVALID_CVV/CARD_FROZEN/INSUFFICIENT_FUNDS decline reasons, admin-only settlement (captureLock → MNO_CLEARING) + refunds (unlockWallet) with balanced journals, statement + monthly summary; 59 checks) → 44 suites | QA Lead (pending) |