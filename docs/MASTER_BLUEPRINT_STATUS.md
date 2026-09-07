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
- ✅ **`transactions.total_charged` convention (documented)**: `total_charged` is flow-specific by design — **debit flows** (deposits, airtime, bills, transfers, savings, cross-border) store `wallet_amount + commission` (invariant: `wallet_amount > 0` & type ≠ ROSCA_PAYOUT ⇒ `total_charged == wallet_amount + commission`); **credit payouts** (`ROSCA_PAYOUT`) store the credited amount (`total_charged == wallet_amount`, fee in `commission`); **merchant flows** keep `wallet_amount = 0` (recipient is a merchant balance/MNO, not a customer wallet) — `MERCH-*` rows: `wallet_amount=0, commission=0, total_charged>0`; `MERCHANT_PAYOUT` (`MPO-*`): gross in `total_charged`, fee in `commission`. Ledger/journals are the source of truth; `scripts/test-ledger-integrity.js` encodes these invariants permanently.
- ✅ **Ledger-integrity regression net** (`scripts/test-ledger-integrity.js`, wired into CI): zero unbalanced journal groups, zero orphan transaction FKs (`wallet_ledger`/`journal_entries`), no negative wallet balances, the `total_charged` conventions above, and serials ahead of table max ids. This suite caught a real migration 088 gap: on databases where a legacy sequence name existed, the rebuilt partitioned `journal_entries`/`audit_logs` default bound to PG-generated `_seq1` sequences that 088's `setval` never touched (live seq 429 vs MAX(id) 1925 — invisible in CI because fresh DBs have no legacy sequence). Fix: migration 090 `sequence_resync` — name-agnostic `setval` of the sequence actually referenced by each table's `id` default, `GREATEST(max_id, last_value)` (idempotent, never lowers).

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
- ✅ **KYC lifecycle built** (migrations 082+083: `kyc_documents` reconciled to `document_url` + `file_hash`/`rejection_reason`/`document_number`/`issued_country`/`submitted_via`/`reviewed_at`; `kycDocumentService` upload/list/pending (claimant name+phone)/verify with auto `kyc_level` upgrade (ID→2, +SELFIE→3)/biographic profile (NIDA uniqueness)/status; routes in `advancedRoutes.js` incl. `POST /kyc/profile`, `GET /kyc/status`; `requireKycLevel` gate reusable; `Kyc.jsx` member + admin review page at `/dashboard/kyc`).
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
- ✅ **Feature flags + experimentation framework built** (migration 080, `/api/features` + admin `/api/features/admin`, `FeatureFlags.jsx`).
- ✅ **Fraud operations centre dashboard built** (`/api/fraud-ops`, `FraudOps.jsx`).
- ✅ **Role-based four-eyes built + extended** (migration 081 + 082: `four_eyes_policies`/`four_eyes_requests`/`four_eyes_approvals`; maker-checker with role enforcement, no-self-approval, quorum 1–3, registered executors, retry; `/api/admin/four-eyes`, gated by `FOUR_EYES` flag, `FourEyes.jsx`). Executors: `ADMIN_PROMOTE_ROLE`, `ADMIN_DEMOTE_ROLE`, `ADMIN_LARGE_REFUND`, plus (migration 082) `VICOBA_LOAN_DISBURSE`, `VICOBA_SOCIAL_FUND_DISBURSE`, `CARD_ADMIN_SETTLE`, `CARD_ADMIN_REFUND`, `CREDIT_LOAN_DISBURSE`, `BUSINESS_LOAN_DISBURSE` with convenience launchers (`/actions/vicoba-loan-disburse|vicoba-social-disburse|card-settle|card-refund|credit-loan-disburse|business-loan-disburse`) — card settle/refund move money via `cardService` (capture/unlock), loan disburse wraps `savingsCreditService.adminDisburseMicroLoan` / `businessService.adminDisburseLoan`, VICOBA executors wrap `vicobaService.approveLoan`/`approveSocialFundDisbursement` (actor fallback = approving admin).
- ✅ **A/B experimentation engine built** (migration 081: `experiments`/`experiment_assignments`/`experiment_events`; deterministic weighted assignment, audience targeting, event tracking, report with uplift + z-score + WIN/LOSS/NEUTRAL verdict; `/api/experiments` consumer + admin, gated by `EXPERIMENTS` flag, `Experiments.jsx`).

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
- ✅ **Full dispute lifecycle (user + reviewer workbench)**: migration 084 adds
  `resolution_type`, `resolved_amount`, `notes TEXT[]`, `assigned_to`, `escalated_at`
  to `disputes` + indexes on status/assignee, and seeds four-eyes policies
  `LENDING_CIRCLE_DISBURSE` + `KILIMO_AGRI_LOAN_DISBURSE` (and the previously-missing
  `TREASURY` ledger account the kilimo disbursement sources from). `disputeService.js`
  rebuilt: `createDispute`/`getUserDisputes` (kept), `getAllDisputes` (fixed joins to
  users/transactions/marketplace orders), `listDisputeStats`, `getDisputeDetail`,
  `addDisputeNote`, `startDisputeReview` (OPEN→UNDER_REVIEW), `escalateDispute`
  (UNDER_REVIEW→MEDIATION), `decideDispute` (REFUND via credits from SUSPENSE with a
  compliant `transactions` row, or REJECT; escrow disputes declined with guidance).
  New `disputeRoutes.js` at `/api/v1/disputes` (member queue + `/admin/*` guarded by
  `ADMIN|SUPPORT|COMPLIANCE`); legacy `/banking/disputes` removed; marketplace
  `resolve` widened to the same reviewer roles.
- ✅ **Four-eyes on the remaining admin disbursements**: executors +
  convenience launchers `/actions/lending-circle-disburse`, `/actions/kilimo-loan-disburse`
  in `fourEyesRoutes.js` (`disburseCampaign`, `disburseAgriLoan`). Fixed latent bugs in
  the kilimo path: `agri_loans` has no `updated_at` column (removed from UPDATEs) and the
  disbursement now balances against the registered `TREASURY` ledger account.
- ✅ **Expiry-aware KYC**: `kycDocumentService` gains `enforceKycLevel(userId, level)`
  (expires past-dated APPROVED docs, recomputes `kyc_level`, preserves stored level for
  legacy doc-less users so `/auth/kyc`-bumped accounts aren't broken) and
  `runExpirySweep()` (platform-wide sweep + downgrade, wired into the recurrence job and
  a new admin `POST /admin/kyc/sweep`). `requireKycLevel` is now async + DB-backed;
  document stats include EXPIRED. Gating: kilimo loan apply, lending-circle campaign
  create, and marketplace seller verify now demand KYC level 2.
- ✅ **Frontend**: new `Disputes.jsx` (member list/create + reviewer workbench with stats,
  queue filter, review/escalate/refund/reject/notes) wired into App/Layout/i18n sw/en;
  `Kyc.jsx` shows EXPIRED red badge + admin expiry-sweep button.
- ✅ **Regression**: new `scripts/test-disputes.js` (28 checks, incl. 4-eyes-role queue +
  refund ledger mechanics); `test-four-eyes.js` extended to 70 (circle + agri-loan
  disbursement through the engine); `test-kyc.js` extended to 30 (expiry sweep,
  downgrade, gate 403, legacy doc-less compat). All wired into CI; dashboard build green.
- ✅ **Landing page redesign** ("Enterprise Financial Operating System"): Yield
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
- ✅ **Four-eyes extended to VICOBA / card / high-value loan ops + full KYC lifecycle**:
  migrations 082 (`four_eyes_policies` seeds for `VICOBA_LOAN_DISBURSE`,
  `VICOBA_SOCIAL_FUND_DISBURSE`, `CARD_ADMIN_SETTLE`, `CARD_ADMIN_REFUND`,
  `CREDIT_LOAN_DISBURSE`, `BUSINESS_LOAN_DISBURSE` + KYC doc columns) and 083
  (`kyc_documents` schema reconciliation: `document_url` standardisation +
  `file_hash`/`rejection_reason`/`document_number`/`issued_country`/`submitted_via`/
  `reviewed_at`/`reviewer_note`). Six new four-eyes executors + convenience
  launchers in `fourEyesRoutes.js`; `kycDocumentService.js` reworked (upload with
  document metadata, admin review queue exposing claimant `full_name`/`phone_number`,
  verify with auto `kyc_level` upgrade, biographic profile with unique-NIDA guard,
  KYC status); `advancedRoutes.js` adds `POST /kyc/profile` + `GET /kyc/status`;
  `Kyc.jsx` page (member docs/profile + admin review queue with stats) wired into
  App/Layout/i18n. Regression: `test-kyc.js` (22) new; `test-four-eyes.js` extended
  to 60 (card refund/settle money-movement + loan/VICOBA FAILED guards); older
  suites now honour `TEST_BASE` env for local runs.

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
- ✅ **Step-Up Authentication for Sensitive Operations** (migration 068: `stepup_tokens`). `stepUpAuthService.js` requires a fresh second-factor (TOTP via `otplib`, or a step-up SMS OTP via `authService.sendOtp/verifyOtp`) before high-value actions and issues a short-lived (10 min), single-use, purpose-scoped step-up token (`TREASURY_EXECUTE`, `PAYROLL_PAY`, `LARGE_WITHDRAWAL`, `ADMIN_ACTION`). `requireStepUp(purpose)` middleware validates + consumes the token; wired onto treasury proposal sign (`POST /api/admin/treasury/proposals/:id/sign`) and payroll pay (`POST /api/payroll/runs/:id/approve`). Endpoints: `POST /api/auth/stepup/request`, `POST /api/auth/stepup/verify`. Step-up tokens purged by the recurrence scheduler. Frontend `useStepUp` hook + verification modal in the Payroll page. Backend i18n `AUTH_STEPUP_*` keys (sw/en).
- ✅ **2FA Enrollment UI** (self-service TOTP onboarding). Backend TOTP enrollment endpoints in `authRoutes.js`: `POST /api/auth/totp/setup` (returns `secret` + `otpauthUrl`), `POST /api/auth/totp/enable` (verify code then enable), `POST /api/auth/totp/disable`, `GET /api/auth/totp/status` — built on `totpService.js` (`setupTotp`/`verifyAndEnable`/`disableTotp`/`getTotpStatus`). New Security page at `/dashboard/security` (`Security.jsx`) renders the otpauth URI as a scannable QR code via `qrcode` and walks users through enable/disable. Always-visible `nav.security` item + `nav.security` i18n keys (sw/en). Complements the existing TOTP login challenge (`/api/auth/totp-login`).
- ✅ **Trust-Score Credit Limits** (`creditLimitService.js`). `getCreditLimit(userId)` derives an exposure cap from the member's trust tier (PREMIUM 0.25×/cap 20M, TRUSTED 0.15×/10M, STANDARD 0.10×/5M, MONITORED 0.05×/2M) with a credit-score factor (0.5–1.5 scale around 600) and a 90-day inflow base, fully capped. `existingExposure(userId)` sums open micro-loan balances (`due_amount - paid_amount`) and VICOBA loan request outstanding balances (defensive) to compute live exposure. `enforceCreditLimit(userId, amount)` rejects any new borrowing that would push combined exposure above the limit — wired into `applyMicroLoan` in `savingsCreditService.js` (402 with explainable Swahili reasons). New endpoint `GET /api/credit/limit` returns `{ creditLimit, existingExposure, available }`.
- ✅ **Enhanced Admin Audit / Health Ops Dashboard** (`opsRoutes.js` mounted at `/api/ops`). `GET /api/ops/dashboard` aggregates DB health + table stats, financial-health snapshot (reconciliation status, open exceptions, txn aging), security posture (total/active users, 2FA enrollment, active step-up tokens), recurrence summary (active rules, 24h failures), recent audit log, execution events, and live process/system info (uptime, memory, node). `GET /api/ops/audit` lists `audit_logs` (via new `listAudit` in `auditService.js`, LEFT JOIN users on id cast, with `action`/`entity_type` filters), and `GET /api/ops/system`. All admin-only (`requireRoles('ADMIN')`). New admin Ops Dashboard page at `/dashboard/ops` (`Ops.jsx`) + admin-only `nav.ops` i18n keys (sw/en).
- ✅ **P2P SECONDARY MARKET + AUTO-INVEST** (migration 069: `p2p_secondary_listings`, plus `p2p_secondary_bids` for future bid flow, and `p2p_auto_invest_rules`). `p2pMarketplaceService.js` implements: `createListing` (validates shares against `investments` minus already-listed amounts, locked transactionally), `listListings` (join projects + seller), `buyListing` (double-entry ledger money movement via `fin.debitWallet`/`fin.creditWallet` through SUSPENSE, atomic share ownership transfer between investment records, listing → SOLD), `getAutoInvestRule` / `upsertAutoInvestRule` (per-user ON CONFLICT upsert: enabled, min ROI %, preferred sectors, max per-project, budget cap, running `total_auto_invested`), and `executeAutoInvestForProject` (matches enabled rules against a project's ROI/sector/budget, executes `p2p.invest` best-effort and credits `total_auto_invested`). Routes at `/api/secondary/*` (`/listings`, `/listings/:id/buy`, `/auto-invest`). Frontend `SecondaryMarket.jsx` at `/dashboard/secondary` — sell-from-portfolio form (`/p2p/portfolio`), active listings table with one-click buy, auto-invest rule editor (sw/en i18n).
- ✅ **KIVA-STYLE LENDING CIRCLES & CROWDFUNDED LOANS** (migration 069: `field_partners`, `lending_circles`, `lending_circle_members`, `crowdfund_campaigns`, `crowdfund_contributions`). `lendingCircleService.js` implements `createFieldPartner`, `listFieldPartners`, `createCircle` (auto-adds leader as LEADER member), `joinCircle`, `createCampaign`, `listCampaigns` (joins circle + borrower), `contribute` (wallet debit via engine, contribution table, campaign FUNDING→FULLY_FUNDED when target met) and admin `disburseCampaign` (credits borrower from SUSPENSE, status → DISBURSED). Routes at `/api/circles/*` (`/partners`, `/circles`, `/circles/:id/join`, `/campaigns`, `/campaigns/:id/contribute`, `/admin/campaigns/:id/disburse`). Frontend `LendingCircles.jsx` at `/dashboard/circles` — partner trust scores, circle management, campaign creation + contributions, admin disbursement (sw/en i18n).
- ✅ **KILIMO AGRI-FINANCE** (migration 069: `farm_profiles`, `agri_input_suppliers` seeded with Yara/Simba/Kilimo Bora, `agri_loans`, `agri_offtake_agreements`). `kilimoAgriService.js` implements `createFarmProfile`, `listFarmProfiles`, `applyAgriLoan` (INPUT_FINANCING / HARVEST_CYCLE / EQUIPMENT + optional supplier), admin `disburseAgriLoan` (engine credit, sets `repayment_due_date`, status → DISBURSED), `repayAgriLoan` (debit to TREASURY, → REPAID on full payment), `createOfftakeAgreement` (committed crop price/quantity against a loan). Routes at `/api/kilimo/*` (`/farms`, `/loans`, `/loans/:id/repay`, `/offtakes`, `/admin/loans/:id/disburse`). Frontend `Kilimo.jsx` at `/dashboard/kilimo` — farm profiles, loan application & repayment, offtake contracts, admin disbursement (sw/en i18n).
- ✅ **FEATURE FLAGS + EXPERIMENTATION** (migration 080: `feature_flags`, `flag_evaluations`). `featureFlagService.js` implements deterministic flag evaluation (`isEnabled` fail-closed; kill-switch absolute; per-user overrides beat rollout; role-based `audience`; optional `expires_at`; SHA256 bucket for `rollout_percent`) with every decision logged to `flag_evaluations` (ON/DISABLED/EXPIRED/MISSING/ROLE_BLOCKED/ROLLOUT_OFF/OVERRIDE_ON). `requireFeature(flagKey)` middleware returns 403 `FEATURE_DISABLED`. Routes at `/api/features` (self evaluation list + `POST /evaluate`) and `/api/features/admin` (CRUD, `GET /:flagKey/analytics` 30-day decisions + trend, `GET /:flagKey/evaluations` — admin-only). Seeded flags: `EVENTS_STAGE5`, `FRAUD_OPS_DASHBOARD`, `ONBOARDING_V2` (enabled/100%). Frontend `FeatureFlags.jsx` at `/dashboard/features` — enable/disable + rollout editing, analytics drawer, evaluations table (sw/en i18n).
- ✅ **FRAUD OPERATIONS CENTRE** (`fraudOpsService.js` + `fraudOpsRoutes.js` mounted at `/api/fraud-ops`, gated `requireRoles('ADMIN')` + `requireFeature('FRAUD_OPS_DASHBOARD')`). Dashboard aggregation (`GET /dashboard`): alert totals/open/resolved by severity, AML case totals/open/closed by status, per-user risk score summary (avg, profiled count, level bands from latest `ai_risk_assessments`), priority queues, top flagged users. `GET /alerts` (filter severity/limit), `POST /alerts/:id/resolve`, `GET /cases`, `GET /cases/:id` (case + notes), `POST /cases` (open AML case via `governanceService.openAmlCase`), `PUT /cases/:id`, `POST /cases/:id/notes` (`addAmlNote`). Frontend `FraudOps.jsx` at `/dashboard/fraud-ops` — overview / alerts / cases / risk tabs (sw/en i18n).
- ✅ **Event reminders sent_date timezone fix** (`eventService.runEventReminders`): `today` now derived from DB `CURRENT_DATE` instead of UTC `new Date().toISOString().slice(0,10)` — previously, between 21:00–24:00 UTC (00:00–03:00 EAT next day) reminders were stamped with the previous EAT day, breaking dedup (`sent_date = CURRENT_DATE` never matched → sweep re-sent every run) and the reminder assertions.
- ✅ **FX-in-reports + multi-currency currency UI parity**: events reports (JSON/CSV/PDF) now include FX conversions and multi-currency totals; dashboard currency selector UI parity across accounts; mobile app onboarding card parity (first-run "afrikoba_onboarded" flag + dashboard onboarding card).
- ✅ **ROLE-BASED FOUR-EYES** (migration 081: `four_eyes_policies`, `four_eyes_requests`, `four_eyes_approvals`). `fourEyesService.js` implements maker-checker with role enforcement: policy (`action_code` UNIQUE, `required_approvers` 1–3, `approver_roles`, `allow_self_approve`, `enabled`), requests (PENDING/APPROVED/REJECTED/EXECUTED/FAILED/CANCELLED + JSONB payload + `execution_result`/`error`), approvals with a `UNIQUE(request_id, approver_id)` guard, no-self-approval, quorum dispatch to a registered executor, and retry for FAILED. Executors registered from `fourEyesRoutes.js`: `ADMIN_PROMOTE_ROLE` (only PROMOTABLE roles ADMIN/OPS/COMPLIANCE/SUPPORT), `ADMIN_DEMOTE_ROLE` (non-promotable targets), `ADMIN_LARGE_REFUND` (transactional `financialEngine.creditWallet` from SUSPENSE). Routes at `/api/admin/four-eyes` (`/policies` GET/PUT, `/requests` POST/GET + per-request approve/reject/cancel/retry, `/actions/promote-role|demote-role|large-refund`), gated `requireRoles('ADMIN')` + `requireFeature('FOUR_EYES')`. Seeded policies for the three actions. Frontend `FourEyes.jsx` at `/dashboard/four-eyes` — policies (rotate count / enable-disable), requests queue with approve/reject/retry + payload detail, action launchers (sw/en i18n).
- ✅ **A/B EXPERIMENTATION ENGINE** (migration 081: `experiments`, `experiment_assignments`, `experiment_events`). `experimentService.js` implements deterministic weighted variant assignment (SHA256 bucket on `key:userId`, stickiness via `ON CONFLICT DO NOTHING`), status lifecycle DRAFT/RUNNING/PAUSED/STOPPED/ARCHIVED (RUNNING requires its feature flag enabled; variants immutable while RUNNING), role/user-id audience targeting, event tracking (only RUNNING + assigned users), and reports — per-variant assigned/events/primary rate, uplift %, z-score (two-proportion), WIN/LOSS/NEUTRAL verdict vs control, daily trend. Routes at `/api/experiments` (`POST /assign`, `POST /track` for any auth user; admin CRUD + start/pause/stop + `/report`, `/assignments`, `/events` under `/admin`), gated `requireRoles('ADMIN')` + `requireFeature('EXPERIMENTS')`. Frontend `Experiments.jsx` at `/dashboard/experiments` — create modal (flag, variants, audience, metrics), lifecycle buttons, report cards with uplift/verdict, trend bars, event ledger (sw/en i18n).
- ✅ **CONNECTED MERCHANT ACCOUNTS + SETTLEMENTS** (migration 085: `merchants` link + `connected_merchant_accounts`, `merchant_payouts`). `merchantPayoutService.js` implements `getConnectedAccount`/`upsertConnectedAccount` (MNO_PHONE or BANK, resets to PENDING on re-KYC), `requestPayout` (validates ACTIVE account + balance, reserves via `MERCHANT_BALANCE` debit + fee credit + `MNO_CLEARING`/`BANK_CLEARING` net credit at execute time), `adminExecutePayout` (transactional journal DR MERCHANT_BALANCE gross / CR PLATFORM_FEES fee / CR MNO_CLEARING net + `transactions` row + audit, PENDING→EXECUTED), `creditMerchantProceeds` (DR CUSTOMER_WALLET / CR MERCHANT_BALANCE when a connected account is ACTIVE). Routes at `/api/merchant/connected`, `/api/merchant/payouts` (merchant), `/api/merchant/admin/*` (connected list/patch, payout queue/execute — ADMIN/OPS/COMPLIANCE/SUPPORT). Frontend Merchant.jsx payout/settlement section (sw/en i18n); also fixed the pre-existing broken legacy `payMerchant` path that never credited `wallet_amount`. `scripts/test-merchant-payouts.js` — 30 checks (ledger math, reserve→execute, re-execute block, RBAC) wired into CI.
- ✅ **L3 HIGH-VALUE LENDING GATES** (`config.lending { highValueLoanThreshold: 1,000,000 TZS, highValueKycLevel: 3 }`, env-overridable via `HIGH_VALUE_LOAN_THRESHOLD`/`HIGH_VALUE_KYC_LEVEL`). `kycDocumentService.enforceHighValueKyc` reuses the DB-backed `enforceKycLevel` and throws 403 `KYC_LEVEL_REQUIRED` + `kycLevel`. Gated borrow paths: kilimo `applyAgriLoan`, lending-circle `createCampaign`, business `applyBusinessLoan`, micro-credit `applyMicroLoan`, VICOBA `requestLoan` (applicant-level). Error handlers (`errorHandler.js`, `securityHardening.js`) pass `kycLevel` through. `scripts/test-lending-gates.js` — 23 checks (threshold boundary, doc-less legacy pass-through, per-flow gate, authorization unaffected) wired into CI after test-kyc. Also fixed the pre-existing kilimo `farm_id`/`farmId` snake-camel bug that 500ed every real agri-loan INSERT.
- ✅ **KILIMO SEASONS + HARVEST/YIELD + AGRONOMIST ADVISORIES** (migration 086: `farm_seasons`, `agri_advisories` + indexes). `kilimoAgriService.js` — `createSeason`/`listSeasons` (ACTIVE/COMPLETED/CANCELLED), `completeHarvest` (marks COMPLETED + rolls `historical_yield_tons` up into `farm_profiles`), `createAdvisory`/`listAdvisories` (ADMIN sees all, AGRONOMIST their own, farmer their farm's), `actionAdvisory` (ISSUED→ACTIONED). Routes at `/api/kilimo/farms/:farmId/seasons`, `/api/kilimo/seasons/:seasonId/harvest`, `/api/kilimo/advisories` (post gated ADMIN/AGRONOMIST), `/api/kilimo/advisories/:advisoryId/action`. `scripts/test-kilimo-seasons.js` — 18 checks wired into CI after test-lending-gates.
- ✅ **TRANSACTION-AWARE OUTBOX + EVENT BUS** (migration 087: `outbox_events` with `reference_id UNIQUE` exactly-once dedup, `status` PENDING/DELIVERED/FAILED/DEAD, `attempts`/`max_attempts`, `next_attempt_at`, `last_error`). `outboxService.js` — `enqueueOutbox({ eventType, payload, reference, tx })` writes in the producer's SAME transaction, `dispatchOutbox` claims due rows with `FOR UPDATE SKIP LOCKED` and exponential backoff (5s…30min cap), marks DEAD past `max_attempts`, `getOutboxStats`, `listPending`, `requeueDead`, `registerHandler`. Producers wired: VICOBA loan approval + merchant payout execution (enqueue inside their existing `client` transactions — the `.catch(() => {})` guard means outbox can never break money movement). Consumers registered in `server.js`: `MERCHANT_PAYOUT_EXECUTED` → notification (resolve merchant user_id), `VICOBA_LOAN_APPROVED` → notification, plus deterministic `OUTBOX_TEST`/`OUTBOX_RETRY`. Admin endpoints `/api/outbox` (stats, dispatch, pending, dead/requeue — ADMIN/OPS); per-minute dispatcher cron in `src/jobs/runAll.js`. `scripts/test-outbox.js` — 17 checks (dedup, RBAC, retry→eventual delivery, dead-letter→requeue, real consumer side-effects) wired into CI.
- ✅ **MOBILE MERCHANT PARITY** (`mobile/`). `MerchantScreen.dart` — merchant registration, connected payout account (status badge, held balance, MNO_PHONE/BANK setup incl. re-KYC reset), settlement request (amount dialog gated on ACTIVE account), payout history with status badges. Registered in the home drawer as "Mfanyabiashara" (icon `storefront_outlined`); `flutter analyze` clean.
- ✅ **VAULTS / SPACES SAVINGS (goal-based)**: `savings_goals` (migration 013) + `savingsGoalService.js` (getGoals/createGoal/updateGoal/deposit/withdraw) + `savingsCreditService.js` (fixed deposits + summary) mounted at `/api/vaults` (list/create/patch/deposit/withdraw/deposits/summary). This pass fixed a pre-existing 500 on every deposit/withdraw: the `transactions` inserts used invalid columns (`amount`/`description` don't exist) and status `'COMPLETED'` (invalid under `transactions_status_check` — now `'SUCCESS'` with `wallet_amount` + `commission=0` + `total_charged`, category mapped from `spending_categories 'Savings'`). `scripts/test-vault.js` — 20 checks (seed 150k, deposit monet math, completion-at-target, over-deposit/over-withdraw blocks, cross-user isolation, journal-posting DR+CR balance, fixed-deposit smoke) wired into CI. Mobile parity: `VaultScreen.dart` ("Vaults (Akiba)") — summary card (saved vs target), create vault, deposit/withdraw dialogs, progress bars, completion badge, fixed (locked) deposits section; `flutter analyze` clean.
- ✅ **VICOBA JOIN CODES + INVITE ACCEPT FLOW** (already built + tested; roadmap marked done): `vicoba_groups.join_code` (unique invite code per group), `vicobaService.joinGroup` by join code, `inviteMembers` SMSs the join code to prospective members, `/invitations/:id/accept|reject` consumes invite → auto-join, invite inbox + join-code entry on mobile `VicobaScreen.dart`, full invite/join coverage in `scripts/test-vicoba.js` + vicoba-inbox stage in CI.
- ✅ **REDIS CACHING + READ REPLICAS**: `src/utils/cache.js` — pluggable read-through cache: `REDIS_URL` → ioredis (dep present), else in-memory TTL Map (LRU eviction, `CACHE_MAX_KEYS` default 5000, `CACHE_DEFAULT_TTL_MS` default 30s) with get/set/del/bust(prefix)/flush/stats (hits/misses/sets/deletes/evictions/flushes). `src/config/replica.js` — optional read-only replica pool via `DB_REPLICA_HOST/PORT/USER/PASSWORD/NAME`; `queryRead(text, params)` routes reads to the replica (probe + unhealthy fallback to primary) and is pool-compatible (exposes `.query`); counters surfaced in ops stats. Wired cache-first on hot reads: `/api/services/catalog` (per-user 20s, busted on subscribe/unsubscribe), `/api/vaults` list/summary/deposits (15s per-user, busted on every vault mutation), `/api/admin/dashboard` (10s). Ops endpoints `/api/cache/stats` (ADMIN/OPERATOR, cache + replica info) and `/api/cache/flush` (ADMIN). CI runs without `REDIS_URL`/`DB_REPLICA_*` → deterministic in-memory/primary path. `scripts/test-caching.js` — 23 checks (unit: set/get/miss/TTL/del/bust/stats; replica fallback counters; HTTP: catalog cache hits via stats endpoint, vault-write bust, RBAC gating on cache ops, flush resets counters) wired into CI.
- ✅ **PARTITIONED LEDGER + AUDIT** (migration 088): `journal_entries` (double-entry ledger, ~2 rows per money movement) and `audit_logs` (privileged-action trail) rebuilt as **monthly declarative RANGE partitions** (UTC month boundaries), `PRIMARY KEY (id, posted_at|created_at)` — old months can be `DETACH`ed/archived without grinding on the parent. Data migrated in-transaction (ids preserved, sequences `setval`), FK targets verified clear (only outbound FKs `account_id`/`transaction_id`/`user_id`, fully supported by partitioned tables). The DB-level deferred balanced-group trigger (`trg_journal_balanced`) recreated on the partitioned parent (still enforces per entry_group at COMMIT). **Not partitioned** (documented, safe): `outbox_events` (UNIQUE `reference_id` dedup constraint would change conflict semantics), `flag_evaluations` (small), `transactions` (FK target of `journal_entries`). `partitionService.js` — `ensureAll`/`createPartition`/`listPartitions`/`archivePartition` (DETACH + rename to `archive_*`, data stays queryable), `ensureAll` runs at server boot + a daily cron keeps current+12 future months provisioned. Admin `GET /api/ops/partitions` (partitioned state, partition counts, latest + recent bounds). `scripts/test-partitions.js` — 22 checks (relkind `'p'`, 13 monthly partitions, manager idempotency, ledger+audit row routing into correct month partition, balanced-trigger still rejects unbalanced groups, archive DETACH mechanics, RBAC on the ops endpoint) wired into CI after test-caching.
- ✅ **USSD (MNO RAILS & FEATURE-PHONE CHANNEL)**: `src/routes/ussdRoutes.js` + `ussdService.js` implementing a fully-functional, session-based interactive USSD menu. Supports registration checks (unregistered phone gets welcome/signup END card), main menu navigation (`1. Salio` - wallet balance, `2. Kuhamisha` - money transfer, `3. VICOBA` - group details, `4. Upatu` - ROSCA details, `5. Uwekezaji` - active P2P projects list, `6. Msaada` - support card). Money transfer is transaction-aware: locks the sender record, verifies balance, assigns an idempotent `USSD-` prefixed reference, and runs through `financialEngine.internalTransfer` (resulting in a balanced ledger journal and corresponding transaction/wallet_ledger lines). Security is enforced at the gateway layer via `verifyUssdSignature` (HMAC-SHA256 of payload elements with a shared `USSD_SECRET` + 120s timestamp replay guard) and per-phone rate limiting (`ussdRateLimit` - max 10 requests/minute). `scripts/test-ussd.js` — 32 checks (payload validations, valid/stale/tampered HMAC signature guards, rate limiters, balance menus, non-membership END notices, P2P lists, and end-to-end success/insufficient money transfer flows) wired into CI after the partitions suite.
- ✅ **SERVICE CATALOG LOCK/GATING (FRONTEND COMPLETE)**: `web-dashboard/src/pages/Services.jsx` is fully complete and translated (sw/en), featuring catalog list views and interactive join/leave toggles (calling `/services/subscribe` / `/unsubscribe`). Detailed feature pages (e.g., `Savings.jsx`, `LendingCircles.jsx`, etc.) are wrapped in the `<ServiceLock serviceKey="...">` component, which fetches the subscriber state from the `/services/catalog` cache and gates non-subscribers with an elegant, in-page onboarding card that prompts them to "Join the service" with a single click. Deployed and verified.
- ✅ **MULTI-COUNTRY DEPLOYMENT & REGULATORY LICENSING** (migration 089): `supported_countries` gains compliance attributes — `calling_code` (MSISDN→country resolution), `max_daily_transfer_limit`, `withholding_tax_rate`, `kyc_doc_type_required`, `regulatory_license_status` (LICENSED/SANDBOX/PENDING with CHECK), `regulatory_license_name`, `local_support_phone`, `local_compliance_email`; seeded per corridor (TZ=LICENSED/Bank of Tanzania, KYC NIDA, 10% WHT, 20M/day; KE/UG/RW/BI/ZM/NG/GH per regulator). `user_daily_transfer_totals` (PK user,country,UTC date) enforces daily caps; `GOVERNMENT_WHT` (LIABILITY) + `REMITTANCE_CLEARING` (ASSET) ledger accounts added. `countryService.js` — `getCountryByPhone` (longest calling-code match), `getCountryForUser` (country_code flag → phone fallback), `getRegulatoryConfig`, `computeWithholdingTax`, `enforceDailyTransferLimit`/`recordDailyTransfer` (transaction-scoped, 402 `REGULATORY_DAILY_LIMIT`), and `executeTransfer` now applies source-country withholding tax (DR wallet → CR `GOVERNMENT_WHT`) and enforces/records the daily cap atomically. New API: `GET /api/countries` (active countries + calling codes + license snapshot) and `GET /api/countries/me` (my country config + `todayUsage`/`remaining`) — auth-gated; admin tunes limits via existing `PUT /api/admin/countries/:id` (whitelist widened). This pass also fixed a latent bug the suite exposed: `executeTransfer` targeted `REMITTANCE_CLEARING` which was never seeded — now idempotently seeded. `scripts/test-multi-country.js` — 31 checks (calling-code/license listings, per-country regulatory config via `/me`, fee+principal+withholding wallet math, `GOVERNMENT_WHT` journal postings, daily-cap 402 enforcement, admin limit tuning, cumulative usage reporting, RBAC) wired into CI after the USSD suite.
