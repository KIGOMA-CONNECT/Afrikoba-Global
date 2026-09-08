---
Document ID: AFK-INST-09
Title: Database Design
Purpose: Schema design, ERD orientation, indexing, partitioning, retention and migration policy with the migration directory as the system of record.
Owner: Database Lead
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: PostgreSQL 16; migrations; partitionService (088)
Related Regulatory Requirements: AFK-INST-14 retention/archival
Approval Authority: Data Architect / DB Lead + CAB for breaking schema changes
---

# Database Design (AFK-INST-09)

## 1. System of record

`db/migrations/*.sql` (001–094) applied by `scripts/runMigrations.js`; this doc summarises
design intent — migrations are authoritative.

## 2. Design principles

- Migrations are sequential and idempotent (IF NOT EXISTS / tracked in schema_migrations).
- Money correctness: journal DR=CR DB trigger; balance CHECK constraints; UNIQUE idempotency references.
- Growth: hot/write-heavy tables partitioned (journal_entries, audit_logs) monthly RANGE; read workload on replicas.
- Formal numbering: every ledger account carries `account_type` + `chart_number` in a type-specific range (093).

## 3. Core schema highlights

| Table/concern | Keys/comments |
|---------------|----------------|
| `users` | phone_number (VARCHAR 15, canonical), wallet_balance (engine-mutated only), device_policy (092) |
| `ledger_accounts` | account_code (semantic) + account_type + chart_number (093) |
| `journal_entries` | partitioned (088); DR/CR balanced via trigger |
| `audit_logs` | append-only; partitioned (088) |
| `ai_insights`/`ai_model_register` | insight rows + versioned model register (046) |
| `request_telemetry`/`trace_spans` | span_id/kind/operation + trace tree (094) |
| `supported_countries` | WHT/caps/KYC doc/license per market (089) |
| `suppliers` | unified commerce+procurement (096: 047 columns unioned onto 020 table; partial unique index uq_suppliers_procurement_profile) — see Data Architecture §5 |

## 4. Indexing plan

- 47+ performance indexes on high-traffic tables (users.phone, tx refs, ledger accounts, partitions keys).
- Query access patterns (dashboard, analytics, ops) drive additional covering indexes; list maintained in ops.

## 5. Partitioning & archival

- `partitionService.js`: ensure/create/list/archive (DETACH) on boot + cron; `GET /api/ops/partitions` health.
- Alignment with AFK-INST-14 retention (7y ledger/audit archive before delete).

## 6. Migration policy

- New feature needing schema → new numbered migration (next free: 096 after 095).
- Destructive DDL requires CAB via AFK-INST-26; recreate/repair path documented before apply.
- Sequence resync handled (090) after bulk loads.

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline from migrations 001–094 + partition + chart numbering | DB Lead (pending) |
| 0.2 | 2026-09-07 | AI code review | C1 RESOLVED via 096: procurement columns unioned onto `suppliers`; partial unique index added; next-free migration → 096 | DB Lead (pending) |