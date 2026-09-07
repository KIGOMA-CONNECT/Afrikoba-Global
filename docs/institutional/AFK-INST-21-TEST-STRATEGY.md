---
Document ID: AFK-INST-21
Title: Test Strategy
Purpose: Test levels, coverage targets, environments, CI gates and acceptance criteria for Afrikoba Global.
Owner: QA Lead
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: All; scripts/test-*.js; .github/workflows/ci.yml
Related Regulatory Requirements: AFK-INST-13 evidence (test suites prove controls)
Approval Authority: QA Lead / CAB
---

# Test Strategy (AFK-INST-21)

## 1. Test levels

| Level | Scope | Where |
|-------|-------|-------|
| Unit | Services/utils (engine, ledger math, fee/split/WHT) | Node tests |
| Integration/Regression | End-to-end API + DB against a seeded Postgres | `scripts/test-*.js` (30 suites) + CI |
| Frontend build | Web dashboard Vite build; Flutter analyze/test/build | CI |
| Load/Security | k6 load + security scripts | staging |
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
test-kyc, test-lending-gates, test-kilimo-seasons, test-disputes, test-merchant-payouts,
test-outbox, test-vault, test-caching, test-partitions, test-ussd, test-multi-country,
test-ledger-integrity, test-field-partners, test-device-binding, test-chart-of-accounts,
test-tracing, test-ai-insights, test-sar-filing, test-openapi.

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