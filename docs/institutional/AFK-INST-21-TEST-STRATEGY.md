---
Document ID: AFK-INST-21
Title: Test Strategy
Purpose: Test levels, coverage targets, environments, CI gates and acceptance criteria for Afrikoba Global.
Owner: QA Lead
Status: DRAFT
Version: 1.12
Effective Date: 2026-09-07
Last Review Date: 2026-09-10
Related Systems/Modules: All; scripts/test-*.js; .github/workflows/ci.yml
Related Regulatory Requirements: AFK-INST-13 evidence (test suites prove controls)
Approval Authority: QA Lead / CAB
---

# Test Strategy (AFK-INST-21)

## 1. Test levels

| Level | Scope | Where |
|-------|-------|-------|
| Unit | Services/utils (engine, ledger math, fee/split/WHT) | Node tests |
| Integration/Regression | End-to-end API + DB against a seeded Postgres | `scripts/test-*.js` (51 suites) + CI |
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
test-kyc, test-lending-gates, test-kilimo-seasons, test-disputes, test-support, test-currency, test-qr, test-insurance, test-cards, test-saccos-foundation, test-saccos-shares, test-saccos-savings, test-saccos-credit,
test-merchant-payouts,
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
| 1.5 | 2026-09-09 | AI code review | Added test-cards (virtual cards J1-J6: Luhn-valid PAN + masked number + CVV-once issuance with sha256(PAN)/CVV hashing, scheme prefixes + default/custom limits, ownership-scoped list/detail/statement with no PAN/CVV leak, limits update, freeze/unfreeze/block state machine, authorize → AUTH_HOLD via `lockWallet` with balanced CUSTOMER_WALLET/CARD_HOLD journal + decline-reason logging (CVV/per-txn/daily/insufficient), admin-only settlement (`captureLock` → MNO_CLEARING) + refunds (`unlockWallet`) both idempotent on auth_reference, statement + monthly summary; code-less 400/403/404 badge errors → `CARD_*` codes + `WALLET_INSUFFICIENT_FUNDS`; 71 checks) → 44 suites | QA Lead (pending) |
| 1.6 | 2026-09-10 | AI code review | Added test-saccos-foundation (SACCOS Digital Core increment 1, migration 101: org registration with unique code/name + config-driven JSONB setup + founder OWNER "0001" ACTIVE, compliance boundary row (regulatory_status TECH_INFRA, legal_entity), membership lifecycle invite-by-identity-phone with per-SACCOS member_number/accept/suspend/exit/re-invite-on-EXITED, GOV OWNER/BOARD/MEMBER RBAC (BOARD invites, OWNER-only activate/suspend), cross-entity isolation (non-member + cross-SACCOS reads 404, no enumeration), platform ADMIN oversight; routes env-gated `SACCOS_ENABLED=false` by default; 39 checks) → 45 suites | QA Lead (pending) |
| 1.7 | 2026-09-10 | AI code review | Added test-saccos-shares (SACCOS increment 2, migration 102: share subscription ledgered on the shared double-entry core — `debitWallet` DR CUSTOMER_WALLET / CR per-entity EQUITY `SACCOS<id>_SHARES_CAPITAL` + `financial_operations` claim + `SACCOS_SHARE_PURCHASE` txn + holdings base-cost motion; config-driven `shareStructure` {shareValue,minShares,maxShares,autoApprove}; PENDING/APPROVED/REJECTED lifecycle with OWNER/BOARD decisions; reject refunds via `creditWallet` on a fresh `-R` reference (DR equity / CR wallet) with txn marked `reversed_at`/`reversed_ref` (SUCCESS is terminal — no illegal status flip); summary totals; cross-entity isolation incl. per-entity equity codes; 38 checks) → 46 suites | QA Lead (pending) |
| 1.8 | 2026-09-10 | AI code review | Added test-saccos-savings (SACCOS increment 3, migration 103: member savings on the shared double-entry core — deposit `debitWallet` DR CUSTOMER_WALLET / CR per-entity LIABILITY `SACCOS<id>_SAVINGS_LIABILITY` (auto-upserted) + `SACCOS_SAVINGS_DEPOSIT` txn + movement; config-driven `savings` {savingsType,minDeposit,maxDeposit,minBalanceToRetain,autoApproveWithdrawals}; auto-approved withdrawal releases via `creditWallet` DR liability / CR wallet with `SACCOS_SAVINGS_WITHDRAWAL` txn + balance decrement; PENDING gated withdrawals reserve funds (SUM pending) and move nothing until OWNER/BOARD approve (`creditWallet` + movement APPROVED) — rejections are free (no reversal journal, SUCCESS terminal preserved); `SAV-<saccosId>-<memberNo>` account numbers, member RBAC 403, cross-entity isolation 404 incl. distinct liability codes, platform ADMIN oversight, audit trail; 38 checks) → 47 suites | QA Lead (pending) |
| 1.9 | 2026-09-10 | AI code review | Added test-saccos-credit (SACCOS increment 4, migration 104: loan applications SCL-* → OWNER/BOARD approval → disbursement on the shared double-entry core — `claimOperation` + `postJournal` DR per-entity ASSET `SACCOS<id>_LOANS_RECEIVABLE` / CR CUSTOMER_WALLET, `SACCOS_LOAN_DISBURSEMENT` txn; flat-interest `total_repayable = principal * (1 + rate% * months/12)` with proportional principal/interest repayment split — DR CUSTOMER_WALLET / CR LOANS_RECEIVABLE principal + CR `SACCOS<id>_INTEREST_INCOME` (REVENUE) — idempotent on REP-* refs, `WALLET_INSUFFICIENT_FUNDS` guard, close at zero outstanding (CLOSED + application REPAID); config-driven `lending` {interestRate,minAmount,maxAmount,maxTermMonths,maxActiveLoans,autoDisburse}; manual disburse + reject paths; member RBAC 403, cross-entity isolation 404 incl. distinct ASSET/REVENUE codes, platform ADMIN oversight, audit trail; 49 checks — caught + fixed a real summary bug (active_loans counted all loans, not only ACTIVE)) → 48 suites | QA Lead (pending) |
| 1.10 | 2026-09-10 | AI code review | Added test-saccos-governance (SACCOS increment 5, migration 105: entity-scoped collective decisioning on the SACCOS membership model — `saccos_resolutions` RES-* (DRAFT→OPEN→PASSED/REJECTED/CANCELLED) + `saccos_resolution_votes` (one vote FOR/AGAINST/ABSTAIN per member per resolution, enforced UNIQUE); OWNER/BOARD propose/open/close/cancel, ACTIVE members vote while OPEN (no money → no journal, every transition + vote audit-logged); closing tally: quorum = cast/ACTIVE members ≥ quorumPercent%, decision = FOR/cast ≥ decisionThresholdPercent% → PASSED else REJECTED; config `governance` {allowMemberVoting,quorumPercent,decisionThresholdPercent,votingDays} incl. officers-only voting mode (member vote 403); member RBAC 403, cross-entity isolation 404, platform ADMIN oversight on reads + summary, audit trail; 28 checks) → 49 suites | QA Lead (pending) |
| 1.11 | 2026-09-10 | AI code review | Added test-saccos-accounting (SACCOS increment 6, migration 106: entity-scoped bookkeeping + financial statements on the shared ledger — OWNER/BOARD open an accounting period PER-* (one OPEN at a time, SACCOS_ACC_PERIOD_ALREADY_OPEN), book internal journals ACC-* through it via `claimOperation` + `postJournal` against per-entity `SACCOS<id>_*` ledger accounts (EXPENSE: DR GENERAL_EXPENSE / CR OPERATING_CASH; INCOME: DR OPERATING_CASH / CR OTHER_INCOME), idempotent on reference (retry dedup), then close into immutable CLOSED with a statements snapshot (reopen CLOSED→OPEN is the only escape; booking into closed/no-period state → SACCOS_ACC_PERIOD_OPEN); statements computed from ledger_accounts + journal_entries scoped to the entity — chart (grouped ASSET/EXPENSE/REVENUE), trial balance (balanced true, DR=CR), income statement (revenue/expense/net), balance sheet (assets = liabilities + equity incl. net income) — members read, OWNER/BOARD write, cross-entity 404 (S2 books never touch S1 balances), platform ADMIN oversight, audit trail; 36 checks) → 50 suites | QA Lead (pending) |
| 1.12 | 2026-09-10 | AI code review | Added test-saccos-investments (SACCOS increment 7, FINAL, migration 107: entity-scoped member term investments — OWNER/BOARD define products INVP-* {minAmount, maxAmount, annualRatePercent, termMonths, ACTIVE/ARCHIVED}; members subscribe INV-* auto-approved or OWNER/BOARD-approved (config.investments.autoApprove) — subscription = `debitWallet` DR CUSTOMER_WALLET / CR per-entity LIABILITY `SACCOS<id>_INVESTMENTS_LIABILITY` + `SACCOS_INVESTMENT_SUBSCRIPTION` txn (insufficient funds rejected); redeems at maturity (flat interest = principal * rate% * term/12) via a 3-leg journal DR LIABILITY (principal) + DR `SACCOS<id>_INVESTMENT_INTEREST_EXPENSE` (EXPENSE) / CR CUSTOMER_WALLET, idempotent on RED-* with wallet FOR UPDATE; redeem before maturity → SACCOS_INV_NOT_MATURED, redeem CLOSED → SACCOS_INV_STATE, member-of-owner redeem → 403; reject path leaves PENDING→REJECTED with no funds moved; min/max guards SACCOS_INV_BELOW_MIN/ABOVE_MAX; cross-entity 404, ADMIN oversight summaries, audit trail; 32 checks — fixed a real maturity-date bug (pg DATE parsed as JS Date broke string comparison, letting an early redemption through)) → 51 suites | QA Lead (pending) |