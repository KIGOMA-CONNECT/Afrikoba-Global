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
  ✅ Merchant QR + payment links now surfaced (see Sec 7).
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
- ✅ **Vaults/Spaces product page**: branded goal-savings + fixed-deposits
  experience (`Vaults.jsx`) with per-vault auto-save toggle wired to
  `/savings/goals/:id/auto-save`. (sw/en i18n, deployed).

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
- ✅ **Financial Health + AI recommendations on Dashboard**: Dashboard.jsx pulls
  `/api/ai/insights` and surfaces top 3 AI-powered insights inline alongside the
  existing health stats card. (sw/en i18n, deployed).

## 7. Payments / Merchant / Business (Sec 11–13)
- ✅ P2P, deposits, withdrawals, settlements, mobile-money callbacks (idempotent,
  HMAC-verified), provider abstraction (`azampayService`).
- 🔶 Merchant platform: `merchantService`, `businessService`, cards exist; QR,
  invoices, payroll, procurement = partial/not surfaced.
- ✅ **Merchant QR + shareable payment links**: `qrCodeService` (create, scan,
  pay, deactivate) + `paymentLinkService` (create, list, resolve by code, pay,
  deactivate) wired to `/api/merchant`. Shareable payment link URLs at
  `/pay/:code` with a public `PaymentLink.jsx` page. Merchant.jsx surfaces both
  QR codes and payment links with copy-to-clipboard. (sw/en i18n, deployed).<span style="display:none">4
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
  management / regulatory reporting = **built** (migration 050: `aml_cases` +
  `aml_case_notes` on top of `fraud_alerts`; assign/investigate/resolve + notes).
- ✅ **Four-eyes RBAC** wired end-to-end for high-value wallet transfers (migration 050
  `approval_flows`/`approval_actions` + migration 052 `config_settings` threshold; executor
  registry in `governanceService`; `walletRoutes` gate + `WALLET_TRANSFER` executor; admin
  bypass; `RiskOps.jsx` approvals UI + Wallet pending indicator). Security middleware: XSS, SQLi, CSRF,
  input-length guards, OTP/TOTP, rate limits — ✅ tested.

## 10. Reconciliation / Observability / Backup-DR / Testing (Sec 29–34, 51–54, 63–64)
- ✅ Reconciliation cron + exceptions + `reconciliation_exceptions` table.
- ✅ Concurrency-critical financial tests: idempotency + debit=credit enforced.
- 🔶 Structured observability / BI **built** (migration-free `observabilityService`:
  business KPIs, transaction-by-type breakdown, fraud-severity rollups; surfaced in
  admin RiskOps BI tab). OpenTelemetry/trace-level = still open.
- 🔶 Formal backup/DR runbooks = not built (DB container backup exists).

## 11. API / Developer Platform / Cross-Border (Sec 46–48, 81)
- ✅ Public API surface exists (many `/api/*`), Swagger docs in non-prod.
- ✅ **Developer portal / API keys / sandbox / webhook simulator** (migration 049):
  `developerService` (create/list/revoke/delete API keys, webhook simulator,
  delivery log, sandbox ping) + `developerRoutes` mounted at `/api/developer`.
  `Developer.jsx` page with 3 tabs: API Keys, Sandbox, Webhooks. Key format
  `ak_live_*`, SHA-256 hashed. (sw/en i18n, deployed).
- 🔶 Multi-currency + FX built (regional groundwork); country/regulator abstraction
  **built** (migration 051: `supported_countries` with currency/region/fee schedule;
  `countryService.quoteTransfer` — FX + fee quote for cross-border corridors;
  seeded TZ/KE/UG/RW/BI/ZM/NG/GH; admin RiskOps Countries tab).

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
- ✅ **Financial-core audit (complete)**: grepped every `wallet_balance` write across
  `src/` — all 26 `users.wallet_balance` mutations live inside `financialEngine.js`
  (its own `creditWallet`/`debitWallet`/group/wallet/hold/internal-transfer
  primitives). No production service sets `users.wallet_balance` directly; VICOBA/
  ROSCA/Savings/P2P/cards/family all route through the engine, and group projections
  (`group_wallet_balance`) are paired via `fin.walletToGroup`/`fin.groupToWallet`.
  Only non-engine write is `scripts/test-all.js` (a standalone test harness).

---

## New this session
- ✅ Landing page redesign ("Enterprise Financial Operating System"): Yield
  Calculator, Huduma Zetu services, Yield Pool, Hatua Rahisi (4-step), Soko la
  Miradi projects, brand CTA + footer. Deployed.
- ✅ **Budgeting & spend control** (Phase 3): migration 043, `/api/budget`
  (routes + `budgetService`), `web-dashboard/src/pages/Budget.jsx`, nav + i18n
  (sw/en). Deployed & verified (routes 401-gated, bundle served).
- ✅ **Vaults/Spaces product page**: `Vaults.jsx` enhanced with per-vault
  auto-save toggle (`/savings/goals/:id/auto-save`), sw/en i18n keys for
  auto-save and frequency options.
- ✅ **Merchant QR + shareable payment links**: migration 048 (`payment_links`
  table), `paymentLinkService.js` (create/list/resolve/pay/deactivate),
  new routes in `merchantRoutes.js`, `Merchant.jsx` payment-links section,
  public `/pay/:code` page (`PaymentLink.jsx`), sw/en i18n.
- ✅ **Dashboard Financial Health + AI insights**: `Dashboard.jsx` now pulls
  `/api/ai/insights` and surfaces top 3 AI-powered insights inline below the
  existing health stats card; `dashboard.ai_insights` i18n keys.
- ✅ **Developer portal / API keys / sandbox / webhook simulator**: migration 049
  (`api_keys` + `webhook_deliveries`), `developerService.js`,
  `developerRoutes.js` at `/api/developer`, `Developer.jsx` (3-tab page),
  `nav.developer` + full `dev.*` i18n sw/en.

## Suggested next candidates
- ✅ **Four-eyes RBAC** (migration 050 `approval_flows`/`approval_actions` + migration 052
  `config_settings` threshold). Executor registry wired end-to-end into wallet transfers
  (`WALLET_TRANSFER`); approval triggers `transferWallet` atomically; failure reverts
  to PENDING. Admins bypass. `/wallet/pending-approvals` + Wallet page indicator. (Live.)
- ✅ **Observability / BI** (`observabilityService` KPIs; admin RiskOps BI tab).
- ✅ **Fraud ops + AML case management** (migration 050 `aml_cases`/`aml_case_notes` + alert workbench).
- ✅ **Country/regulator abstraction** (migration 051 `supported_countries` + FX quote).
- ✅ **Wire maker-checker gate into live high-value wallet transfers** (migration 052, executor registry).
- ✅ **Cross-border transfer execution** (`countryService.executeTransfer`: fee calculation, FX conversion, ledger posting via `fin.debitWallet` for fee and principal into remittance clearing, transaction logging, audit trail, `/api/admin/countries/transfer` endpoint).
- ✅ **Wire maker-checker gate into loan disbursements** (business & credit admin disburse routes gated by high-value threshold with `BUSINESS_LOAN_DISBURSE` and `CREDIT_LOAN_DISBURSE` executors).
- ✅ **Afrikoba Social Fund / Msaada** (migration 053: `social_fund_rules`, `social_fund_cases`, `social_fund_contributions`, `social_fund_payouts`; event-based cooperative support like Rambirambi, medical, emergency, disaster; privacy controls for anonymous contributions; dedicated ledger integration via `SOCIAL_FUND_CLEARING`; `/api/social/cases` endpoints).
- ✅ **AI Project Intake & Automated Decomposition + Waterfall Distribution** (migration 053: `project_decompositions`, `controlled_project_accounts`, `project_revenue_waterfall`; automated WBS breakdown into phases/tasks/estimated costs; revenue distribution waterfall for investor shares, owner share, reserves, and reinvestment).
- ✅ **Formal backup/DR runbooks & automated backup verification** (`docs/DISASTER_RECOVERY_RUNBOOK.md`, `backupService.js` automated daily backups with SQL integrity verification and retention management, plus `/api/admin/backup/*` management endpoints).
- ✅ **OpenTelemetry / Trace-level observability** (migration 054: `request_telemetry` table; `src/middleware/telemetry.js` assigning `X-Trace-ID` headers, measuring request durations, tracking HTTP statuses and user contexts, and persisting metrics asynchronously).
- ✅ **Analytics Data Warehouse Pipeline** (migration 055: `analytics_daily_aggregates` table; `analyticsWarehouseService.js` aggregating daily transaction volumes, fee collections, active users, and new user signups into historical rollups; `/api/admin/warehouse/metrics` & `/aggregate` endpoints).
- ✅ **AI Cash-Flow Forecasting & Financial Anomaly Detection** (migration 056: `cashflow_forecasts` & `financial_anomalies` tables; `aiCashFlowService.js` forecasting 30-day predicted inflows/outflows and detecting single-transaction anomalies; `/api/admin/ai/forecasts` & `/anomalies` endpoints).
- ✅ **AI Document Intelligence Parser Engine** (migration 057: `project_documents` table; `aiDocumentIntelligenceService.js` parsing unstructured project proposals, BOQs, quotations, and contracts into structured line items, cost totals, and confidence metrics; `/api/admin/ai/documents/*` endpoints).
- ✅ **Multi-Signature Treasury Workflows** (migration 058: `treasury_wallets`, `treasury_proposals`, `treasury_signatures`; `treasuryMultiSigService.js` implementing N-of-M signature thresholds, self-approval rejection, atomic treasury transfer execution on reaching required signatures; `/api/admin/treasury/proposals/*` endpoints).
- ✅ **Project Monitoring & Variance Tracking (EVM)** (migration 059: `project_monitoring` & `project_milestones` tables; `projectMonitoringService.js` implementing earned value management with cost variance (CV), schedule variance (SV), CPI/SPI indices, and health classification (ON_TRACK/AT_RISK/OVER_BUDGET/BEHIND_SCHEDULE/COMPLETED); `/api/admin/projects/*/monitoring` & `/milestones` endpoints).
- ✅ **AFRIKOBA DIGITAL GROUP GOVERNANCE & COLLABORATION ENGINE** (migration 060: `governance_meetings`, `governance_attendees`, `governance_agenda_items`, `governance_channels`, `governance_chat_messages`, `governance_documents`, `governance_constitutions`, `governance_proposals`, `governance_votes`, `governance_resolutions`, `governance_action_items`, `governance_minutes`, `governance_transcripts`). `governanceEngineService.js` implements the full meeting → discussion → decision → resolution → responsibility → execution → audit trail pipeline with AI Secretary (transcription, minutes generation, decision extraction, action-item detection). Vote validation against group constitution (quorum & voting threshold). Immutable, versioned resolutions with amendments. Searchable institutional memory (Knowledge Vault) across chat/minutes/resolutions/documents. On-platform chat with context channels (General, Finance, Loans, Investment, Social Fund, Project, Announcements, Meeting). `/api/governance/*` routes + `Governance.jsx` page at `/dashboard/governance`. Works beyond VICOBA: cooperatives, SACCOs, associations, alumni, workplace, investment clubs, partnerships, community orgs.
- ✅ **Governance → Financial Decision Linkage** (migration 061: `governance_financial_executions`; `governanceFinancialLinkageService.js` binding approved financial resolutions to workflow execution and ledger records, capturing target entity, amount, ledger reference, and audit trail — every financial action has an immutable governance authorization; `/api/governance/financial-executions*` + `/financial/audit-trail` endpoints; Resolution Finances tab in Governance page).
