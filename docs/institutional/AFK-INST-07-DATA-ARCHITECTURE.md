---
Document ID: AFK-INST-07
Title: Data Architecture
Purpose: Logical/physical data architecture, data flows, ownership, lineage and quality controls across the Afrikoba platform.
Owner: Data Architect
Status: DRAFT
Version: 0.2
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: All migrations 001–094; ledger/partition (088), trace/telemetry (094), device (092), countries (089)
Related Regulatory Requirements: AFK-INST-14 (retention), AFK-INST-13 (records)
Approval Authority: Data Architect / CAB
---

# Data Architecture (AFK-INST-07)

## 1. Logical domains

| Domain | Representative tables |
|--------|------------------------|
| Identity & KYC | `users`, `otp_codes`, `kyc_documents` (083), devices (092) |
| Money/ledger (canonical) | `ledger_accounts` (093 chart numbers), `journal_entries` (partitioned 088), `wallet_ledger`, idempotency registry |
| Savings/VICOBA/ROSCA | goals/vaults, groups, pools, contributions |
| Lending/credit | credit scores, passports, agri (kilimo), micro/business loans |
| Commerce/procurement | business_invoices (020), payroll_runs/items, suppliers (020), procurement (047), supplier_financing |
| Governance/social | governance_* (060/062), events (075–079), social_fund, meetings/chat |
| Observability/AI | ai_insights/ai_model_register (046), request_telemetry + trace_spans (094), fraud alerts, audit_logs (088) |
| Misc product | cards, budget, vaults, referral, recurrence, notifications, outbox (087), experiments (081) |

## 2. Ownership & lineage

- Ledger/money: Head of Finance (single mutator = financialEngine).
- Identity/KYC/AI-signal/telemetry: see AFK-INST-14 §2 RACI.
- Lineage note: every ledger row originates in a `postJournal` call; trace_spans carry the
  parent operation for that row (ADR-002).

## 3. Physical design

- Migrations 001–094 applied idempotently by `scripts/runMigrations.js` (tracked via schema_migrations).
- Partitioning: `journal_entries` + `audit_logs` monthly declarative RANGE (088); `partitionService`
  creates/lists/archives DETACH on boot + cron.
- Indexing: 47+ indexes across high-traffic tables; UNIQUE references for idempotency.
- Constraints: balances CHECK, chart_number range CHECK + unique index (093), journal DR=CR DB trigger.

## 4. Data quality controls

- Parameterized queries + Zod validation.
- Reconciliation cron → `reconciliation_exceptions`.
- Retention/archival per AFK-INST-14 §3 (DETACH + archive before delete of aged rows).

## 5. Known schema issue (C1 — suppliers)

`db/migrations/020` defines `suppliers(business_id,name,phone,total_paid)`. Migration `047`
`CREATE TABLE IF NOT EXISTS suppliers` is a silent no-op when 020 ran first, while
`procurementService.js` queries `suppliers(owner_user_id,...)`. **RESOLVED 2026-09-07 (096):** the
047 procurement columns (`owner_user_id`, `business_name`, `category`, `description`, `rating`,
`verified`) were unioned onto the commerce `suppliers` table idempotently — additive only, existing
rows and FKs untouched — and the 020 NOT NULL on `business_id`/`name` relaxed (commerce callers
always supply them). A partial unique index `uq_suppliers_procurement_profile` restores 047's
`UNIQUE(owner_user_id,business_name)` among procurement profiles. Both feature sets now share one
table; `test-procurement.js` proves end-to-end. The AI-insights query continues to link financing
through `request_id` + `business_id` (see AFK-INST-15/business insights).

## 6. Backup & archival

- Daily verified backup (retention 30d, min 7 kept); DR runbook (AFK-INST-18) restore steps.
- Archive strategy aligns monthly partition DETACH with 7y retention policy.

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline from migrations + ledger/partition evidence; logs C1 | Data Architect (pending) |
| 0.2 | 2026-09-07 | AI code review | C1 RESOLVED: 096 unions procurement columns onto `suppliers` (partial unique index); test-procurement added | Data Architect (pending) |