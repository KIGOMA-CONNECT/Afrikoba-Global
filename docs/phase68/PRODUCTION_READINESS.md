# Phase 68 — Production Readiness Review (non-AzamPay)

Date: 2026-10-30. Branch `phase68-deposit-atomicity-fix`, HEAD `29ee21e`.
Status: **Phase 68 OPEN**. Withdrawals/payouts remain **CLOSED**. AzamPay stays parked.
Nothing committed, pushed, merged, or deployed.

## 1. Summary
- All money-path suites pass (14/14, 5/5, 3/3, 25/25, 12/12, 229/229, 10/10, 7/7).
- Production config validates required secrets in production mode (JWT, DB password, webhook secret, SMS provider, CORS, contract base URL).
- Health endpoints present: `/health`, `/health/db`, `/health/ready`.
- Rate limiting present (auth, API, device, USSD) and disableable only via env flags.
- DR exercise passed: disposable DB dumped, restored to a scratch DB, all invariants green, scratch DB dropped, dump removed.
- AzamPay contract remains unverified (S2/D1) — deposits and payouts stay gated closed.

## 2. Configuration and secrets
- `src/config/index.js` `validateConfig()` fails fast in production if JWT secret is default, DB password missing/default, `WEBHOOK_SECRET` missing, no SMS provider, CORS is `*`, or `CONTRACT_BASE_URL` is not HTTPS.
- Secrets are read from environment; no hardcoded production credentials in source.
- `AZAMPAY_ENABLED`, `AZAMPAY_PAYOUT_CONTRACT_VERIFIED`, `AZAMPAY_STATUS_CONTRACT_VERIFIED` all default to false/unset → withdrawals and auto-credit stay closed.
- `WEBHOOK_SECRET` and `ALLOWED_WEBHOOK_IPS` are set in production (names only verified).
- Residual: CI DB credential was printed in earlier session output and remains valid for that container (S8, authorization needed to rotate); production-derived data in the disposable DB (S8).

## 3. Logging, audit and monitoring
- `logAudit` on withdrawal creation, dispatch refusal/uncertainty; reconciliation exceptions deduped per reference/type.
- `reconciliation_exceptions` records `LEDGER_ORPHAN`, `BALANCE_MISMATCH`, `BALANCE_RECON_DIFF`, deposit/withdrawal exceptions.
- Sentry DSN optional; logging via `logger`.
- `metricsService` exposes open exceptions by type.

## 4. Rate limits and abuse controls
- `authRateMax`, `apiRateMax`, `otpRateMax`, `deviceRateMax`, OTP cooldown, OTP send-log cap.
- `RATE_LIMIT_DISABLED` / `DISABLE_RATE_LIMIT` env flags (must be unset in production).
- Device trust, KYC level, wallet freeze, fraud checks on withdrawal.
- Idempotency middleware (S3) user-scoped + atomic claim.
- Webhook replay protection (S4) now uses Redis when configured (multi-replica safe, 24h TTL) with in-memory fallback; state machine remains authoritative.

## 5. Health checks
- `/health`, `/health/db`, `/health/ready` (verified in `src/server.js`).
- Recommended: wire `/health/ready` into the container orchestrator's readiness probe (owner/ops action).

## 6. Migration replay
- No schema migration was added in Phase 68 (explicitly avoided).
- `fn_financial_invariants()` and deferred trigger `fn_assert_balanced_group` remain the DB-level guards.
- DR exercise confirmed a full dump/restore preserves invariants.

## 7. Dependency advisories
- Backend: proxy-addr CVE-2026-90711 not reachable with `trust proxy = 1` (verified); installed tree 2.0.8.
- Dashboard: vite/esbuild/react-router remain on major-bump advisories (S7, migration review needed).

## 8. Topology (unresolved)
- S5: public request path and `trust proxy = 1` mapping unverified. If no proxy appends `X-Forwarded-For`, webhook IP allowlist and rate limits can be spoofed. Operator action required.

## 9. DR exercise result
- pg_dump of disposable DB → restore to scratch DB: exit 0.
- Invariants on scratch: all 4 checks `t`.
- Unbalanced journal groups on scratch: 0.
- Scratch DB dropped; dump file removed. No production data touched.

## 10. Remaining blockers (AzamPay + owner/ops)
- S2/D1 AzamPay contract unverified (BLOCKED - needs official contract + sandbox).
- S4 webhook replay cache: hardened with Redis backing; in-memory fallback remains (low risk).
- S5 topology of req.ip (ops action required).
- S7 dashboard deps (migration review).
- S8 CI credential rotation (authorization).
- S9 four-eyes: config flag WITHDRAWAL_FOUR_EYES_ENABLED + threshold added (default OFF); wiring into withdrawal route pending owner policy/threshold.
- Matrix coverage for VICOBA/ROSCA/loans/escrow/project finance (code, non-blocking).
- Service-level claimOperation opt-in for projectFinance/merchantPayout/network (code, non-blocking).

## 11. Final test evidence
- `reconciliation-coverage.phase68.test.js`: 5/5
- `money-path-integrity.phase68.test.js`: 14/14
- `p2p-invest.phase68.test.js`: 3/3
- `financial-amount-guard.phase68.test.js`: 229/229
- `withdrawal-dispatch-d1.test.js`: 12/12
- `deposit-atomicity.phase68.test.js`: 25/25
- `deposit-verification.phase68.test.js`: 35/35
- `idempotency.phase68.test.js`: 10/10
- `regressionFinancialEnginePhase62.test.js`: 6/6
- `regressionFinancialEnginePhase68.test.js`: 5/5 groups
- `regressionVicobaLoanAccountingPhase66.test.js`: 15/15
- `regressionVicobaProfitPayoutPhase65.test.js`: 10/10
- `azampay-payout-classification.test.js`: 7/7
- `git diff --check`: exit 0
- `git stash@{0}`: untouched
