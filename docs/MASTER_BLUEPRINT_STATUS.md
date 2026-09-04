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
- ✅ **Governance Access Control & Retention** (migration 062: `governance_access_grants`, `governance_retention_policies`; confidential + retention flags on documents and transcripts; `governanceAccessControlService.js` enforcing canView permission checks — confidential records default to officers-only with explicit GRANT/DENY per member or role; retention policies per record type; `/api/governance/*/access`, `/access-grants`, `/retention-policies`, `/can-view` endpoints; Access & Retention tab in Governance page).
- ✅ **Deeper AI Secretary + Zero-Knowledge Voting + Auto-Triggered Loans + Governance Analytics** (migration 063: `secret_ballot` on proposals, `ai_structured` on minutes, `governance_analytics`, `governance_secret_ballot_box`).
  - **Deeper AI Secretary**: `parseTranscript` regex-based parser detects agenda topics, decisions (with extracted amounts), disagreements, responsible members/roles, and deadlines from raw transcripts → structured minutes stored in `ai_structured`, with action items auto-persisted into the action-items ledger.
  - **Zero-knowledge / secret-ballot voting**: proposals support `secretBallot`; votes recorded anonymously in `governance_secret_ballot_box` (never linked to who voted how) — system counts but never exposes voter identity.
  - **Auto-trigger VICOBA loan from resolution**: `triggerVicobaLoan` chains Resolution(passed) → execution(PENDING) → `vicoba.requestLoan` → `vicoba.approveLoan` (disbursement + ledger) → execution(EXECUTED) with `VL-<loanId>` reference. `/api/governance/resolutions/:id/trigger-loan`.
  - **Governance analytics**: `computeGovernanceAnalytics` tracks attendance %, resolution pass rate, avg decision time (hrs), action-item completion rate + overdue count; persisted daily; `/api/governance/analytics` (+ trend). Analytics tab in Governance page.
  - **Pending item wired**: `canView` permission now enforced on document listing via `listDocumentsForUser` (confidential docs hidden from unauthorized members).
- ✅ **AI Risk Engine + Recommendation Engine + Confidence/Explainability** (migration 064: `ai_risk_assessments`, `ai_recommendations`, `ai_decision_explanations`). `aiRiskRecommendationService.js` computes a per-user 0-100 risk score (LOW/MEDIUM/HIGH/CRITICAL) from behavioural features (burn rate, trust score, credit score, overdue loans, liquidity runway, balance), with weighted explainable factors, model confidence, and highest-impact feature attribution. Derives prioritized actionable recommendations (Savings/Budget/Credit/Risk/Investment) with expected-impact estimates. Logs every decision to an explainability + model-governance ledger (`afri-risk-1.0`, `afri-reco-1.0` registered in `ai_model_register`). Endpoints: `/api/ai/risk(evaluate)`, `/recommendations`, `/recommendations/:id/dismiss`, `/explanations`. New AI Intelligence page at `/dashboard/ai` (`AiIntelligence.jsx`) with Risk / Recommendations / Explainability tabs.
- ✅ **AI Budget / BOQ Analysis** (migration 065: `ai_market_rates`, `ai_budget_analyses`). `aiBudgetBoqService.js` (`afri-boq-1.0`) analyzes project BOQ/quotation line items against seeded BOT reference market rates, flags overpriced (>25% above reference) / underpriced / fair items line-by-line, computes total vs market-reference variance, and classifies budget health (HEALTHY/WATCH/OVERPRICED/UNDERPRICED) with a confidence score and recommendations. Endpoints: `POST /api/ai/budget/analyze`, `GET /api/ai/budget`, `GET /api/ai/budget/rates`. Added as a Budget/BOQ tab on the AI Intelligence page.
- ✅ **Automated Payroll Engine** (migration 066: `payroll_schedules`, `payroll_schedule_entries`, `payroll_runs`, `payroll_payslips`). `payrollService.js` manages recurring compensation: create/pause pay schedules (daily/weekly/biweekly/monthly) tied to a multi-sig treasury wallet, add salary entries with base + bonus/deduction adjustments, generate payroll runs (DRAFT→PENDING_APPROVAL→PAID/PARTIAL/FAILED), and approve+pay — debiting the treasury wallet and crediting each recipient's customer wallet via the financial engine with per-payslip `PAY-*` ledger refs. Endpoints mounted at `/api/payroll`: `GET /payslips` (self), `POST/GET /schedules`, `POST /schedules/:id/entries`, `PATCH /schedules/:id/status`, `POST /runs`, `GET /runs`, `POST /runs/:id/approve`, `GET /runs/:id/payslips`. New admin Payroll page at `/dashboard/payroll`.
- ✅ **Recurrence Automation Scheduler** (migration 067: `recurrence_rules`, `recurrence_executions`). `recurrenceService.js` provides a background interval-driven scheduler (started from `server.js`, gated by `DISABLE_CRON`, tunable via `RECURRENCE_INTERVAL_MS`) that auto-dispatches due recurring tasks to their services: `AUTO_SAVINGS` (sweep wallet→savings pool with ledger postings), `CONTRIBUTION_CYCLE` (auto-create next VICOBA contribution cycle), `PAYROLL_RUN` (auto-generate+approve payroll for an active schedule), plus a `STANDING_INSTRUCTION` placeholder. Every execution is recorded to `recurrence_executions`. Endpoints: `POST/GET /api/recurrence/rules`, `PATCH /api/recurrence/rules/:id`, `GET /api/recurrence/executions`, `POST /api/recurrence/sweep`. New admin Recurrence page at `/dashboard/recurrence`.
