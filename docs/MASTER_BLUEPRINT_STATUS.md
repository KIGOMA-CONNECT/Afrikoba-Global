# AFRIKOBA — Master Blueprint Status Matrix

This document maps the 94-section "Digital Financial Infrastructure & Financial
Services Platform" master blueprint to what is **built**, **partially built**, and
**not yet built** in the current codebase. Ground truth is the repository on
`main` (backend `src/`, `db/`, and `web-dashboard/`).

Status legend: ✅ **built** · 🔶 **partial** · ⬜ **not built / next**.

---

## 1. Executive Vision & Positioning (Sec 1–2)
- ✅ Wallet + P2P + mobile-money + savings + VICOBA + ROSCA + yield + family + credit score + multi-currency.
- 🔶 Merchant, insurance, cards, QR, cross-border, commerce = partial (some exist: `merchantService`, `cardService`, `insuranceService`, P2P projects).
- ✅ Positioned as "financial operating system" (landing + product ecosystem).

## 2. Financial Core / Ledger (Sec 3–9) — **the blueprint's #1 priority**
- ✅ **Double-entry ledger**: `ledger_accounts` (chart of accounts) + `journal_entries`
  with a **DB-level balanced-group trigger** (`fn_assert_balanced_group`, migration 031).
- ✅ **Idempotency**: `financial_operations` registry + `claimOperation()` gate
  (deposit/transfer/hold/etc. are idempotent on reference).
- ✅ **Central `financialEngine.js`**: `postJournal`, `postDeposit`, `transfer`,
  `creditWallet`, `debitWallet`, `internalTransfer`, `walletToGroup`,
  `lockWallet`/`unlockWallet`/`captureLock`, hold/release/capture, `auditBalance`,
  `recordException`.
- ✅ **Adoption**: ~28 services route money movement through `financialEngine`
  (airtime, BAP, bills, business, cards, dispute, family, insurance, marketplace,
  merchant, mkoba/VICOBA, network, P2P, referral, reward, ROSCA, savings,
  split-payment, vault/yield, wallet, etc.).
- 🔶 `users.wallet_balance` remains a **projection cache** (updated alongside journal
  postings) — the ledger is authoritative; balance is derived. Some legacy direct
  mutations may remain; a full audit of every money path is an ongoing task.
- ✅ Reconciliation engine + exceptions (`reconciliation_exceptions`, migration 032).

## 3. Accounting & Product Accounting (Sec 4–5, 67–68)
- ✅ Chart of accounts seeded: CUSTOMER_WALLET, MNO_CLEARING, PLATFORM_FEES,
  COMMISSION, SUSPENSE, CARD_HOLD, FAMILY_WALLET, VICOBA_GROUP, ROSCA_POOL,
  AGENT_BALANCE, PARTNER_BALANCE, REFERRAL_REWARD, YIELD_LIABILITY, INTEREST_INCOME.
- 🔶 Formal 1000/2000/3000/4000/5000 account-numbering hierarchy not yet mirrored
  in UI/reporting; account codes use semantic names.
- ✅ Per-product separation: user / group / family wallets kept distinct in ledger.

## 4. Wallet System (Sec 9–10, 42, 44–45)
- ✅ Deposit, withdrawal, transfer, transaction history, balance, locked funds,
  P2P, statements, multi-currency balances, cards (virtual+physical model), savings.
- 🔶 Merchant/QR, scheduled transactions, beneficiaries, payment requests = partial.
- ✅ FX / multi-currency (`currencyService`): TZS primary + dynamic currencies +
  live FX preview (`/currency/rates/:from/:to`, `/currency/currencies`). (Sec 45)
- ✅ Yield pool separated from wallet money (`YIELD_LIABILITY`). (Sec 44)

## 5. VICOBA / ROSCA / Savings (Sec 15–17)
- ✅ VICOBA: groups, members, contributions, shares, social fund, loans + multi-sig
  approvals, group wallet, share-outs & dividends, division history.
- ✅ ROSCA: circles, schedules, member ordering, auto-collection, payout,
  missed-payment handling, **trust score from history** (`rosca_trust_history`).
- ✅ Savings: goal savings (`savings_goals`), auto-save, fixed deposits, savings
  challenge — all through the financial engine.
- ✅ **Budgeting & spend control (new, Phase 3)**: per-category monthly budgets,
  spend-vs-budget progress, over-budget alerts, savings rate — migration 043.
- ⬜ Vaults/Spaces as a dedicated UI page/feature (goal savings exist in service
  model but no surfaced "Vaults" product page yet).

## 6. Credit / Trust / AI Financial Intelligence (Sec 18–21, 38)
- ✅ Business & user **credit engine**: `creditScoreService`, `financialPassportService`,
  `creditScoreService` → `/api/credit`, and the Credit Score dashboard (0–850 gauge,
  pillars, capacity, explained dimensions, triggers, recalc).
- ✅ **AFRIKOBA Trust Score** from contribution/history behaviour (ROSCA scoring).
- ✅ **AI Financial Intelligence (Phase 8, migrations 046)**: self-hosted
  `aiInsightService` produces bank-grade insights (spending concentration, cashflow
  forecast, savings rate, budget health, anomaly detection, credit readiness, loan
  relief, monthly digest) + aggregate Financial Health Score, persisted to an
  auditable `ai_insights` table and scored per a `ai_model_register` governance
  ledger (`afri-ai-1.0`); exposed via `/api/ai` and the "AI Insights" dashboard tab;
  model/AI governance register now tracked (improves the "partial" fraud-engine
  posture — `fraudDetectionService`, `financialMonitoring`, `smartAlertService`,
  `spendingAnalyticsService` continue to feed heuristics).

## 7. Payments / Merchant / Business (Sec 11–13)
- ✅ P2P, deposits, withdrawals, settlements, mobile-money callbacks (idempotent,
  HMAC-verified), provider abstraction (`azampayService`).
- 🔶 Merchant platform: `merchantService`, `businessService`, cards exist; QR,
  invoices, payroll, procurement = partial/not surfaced.
- 🟡 Marketplace + escrow + disputes + seller verification exist (Phase 4/6 partial):
  marketplace orders, escrow milestones, delivery evidence, admin-ruled escrow
  disputes (migrations 038–041).

## 8. Family Finance (Sec 14)
- ✅ `familyService` + `familyRoutes` — family wallet, members, allowances,
  family transfers (ledger-backed). Extended UI/guardian controls = partial.

## 9. Compliance / AML / KYC / Data Governance / RBAC / Audit (Sec 22–28)
- ✅ Audit trail: `audit_logs` + `financial_audit_log` (append-only posture).
- 🔶 KYC lifecycle partial (`kycDocumentService`, `kyc_documents`, seller
  verification, identity verification).
- 🔶 AML/sanctions monitoring = heuristics (`fraudDetectionService`); full case
  management / regulatory reporting = not built.
- 🔶 RBAC partial (admin role exists; full ABAC / four-eyes maker-checker =
  not built). Security middleware: XSS, SQLi, CSRF, input-length guards, OTP/TOTP,
  rate limits — ✅ tested.

## 10. Reconciliation / Observability / Backup-DR / Testing (Sec 29–34, 51–54, 63–64)
- ✅ Reconciliation cron + exceptions + `reconciliation_exceptions` table.
- ✅ Concurrency-critical financial tests: idempotency + debit=credit enforced.
- 🔶 Structured observability / OpenTelemetry / data warehouse / BI = not built.
- 🔶 Formal backup/DR runbooks = not built (DB container backup exists).

## 11. API / Developer Platform / Cross-Border (Sec 46–48, 81)
- 🔶 Public API surface exists (many `/api/*`), Swagger docs in non-prod.
- ⬜ OAuth2/API-key developer portal, sandbox, SDKs, webhook simulator = not built.
- 🔶 Multi-currency + FX built (regional groundwork); country/regulator abstraction
  = not built.

## 12. Commerce / Procurement / Escrow / Marketplace (Sec 39–41, 80)
- 🔶 Marketplace + escrow + disputes built (migrations 038–041).
- ✅ Procurement & supplier network (Phase 9, migration 047): supplier onboarding
  (`suppliers`), RFQ requests + open bids (`procurement_requests`/`procurement_bids`)
  with publish→award workflow, and **supplier working-capital financing**
  (`supplier_financing`) disbursed idempotently through the financial engine
  (`SUSPENSE` DR / `CUSTOMER_WALLET` CR, `SUPPLIER_FINANCING` txn) — `/api/procurement`
  + "Procurement & Goods" page. Frontend procurement UI previously absent → now surfaced.

## 13. Governance / Risk / Docs (Sec 55–62, 83–90)
- 🔶 Dispute lifecycle (`disputeService`), support cases partial.
- 🔶 Risk register / compliance matrix / formal docs set = partially documented
  in `docs/PLATFORM_ROADMAP.md`; a full 27-doc set is not yet written.
- ⬜ Role-based four-eyes, fraud operations centre dashboards, feature flags,
  experimentation framework = not built. Model/AI governance register now tracked via
  `ai_model_register` (Phase 8).

---

## Blueprint "First Engineering Priority" (Sec 65–66, 75, 92)
The blueprint instructs: audit every money mutation → chart of accounts → central
ledger → account abstraction → migrate services sequentially → reconciliation.
**Status:** the central ledger core is **largely built and widely adopted**:
- ✅ Chart of accounts + double-entry journal + balanced-group DB trigger.
- ✅ Idempotency registry + financial engine primitives.
- ✅ ~28 services already move money through the engine.
- 🔶 Remaining audit: enumerate any legacy direct `wallet_balance` mutations not yet
  routed through `financialEngine` and migrate them (ongoing hardening).

---

## New this session
- ✅ Landing page redesign ("Enterprise Financial Operating System"): Yield
  Calculator, Huduma Zetu services, Yield Pool, Hatua Rahisi (4-step), Soko la
  Miradi projects, brand CTA + footer. Deployed.
- ✅ **Budgeting & spend control** (Phase 3): migration 043, `/api/budget`
  (routes + `budgetService`), `web-dashboard/src/pages/Budget.jsx`, nav + i18n
  (sw/en). Deployed & verified (routes 401-gated, bundle served).

## Suggested next candidates
1. **Vaults/Spaces** product page (surfaces existing goal-savings engine as a
   branded "Vaults/Spaces" experience — Monzo/Revolut parity).
2. **Merchant QR + payment links** (surface existing merchant/card infrastructure).
3. **Financial Health engine** recommendations surfaced in Dashboard (uses
   `spendingAnalyticsService` + new `budgetService` overview).
4. Remaining **financial-core audit** of any non-ledger balance mutations.
