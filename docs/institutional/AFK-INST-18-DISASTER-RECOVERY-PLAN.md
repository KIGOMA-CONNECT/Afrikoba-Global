---
Document ID: AFK-INST-18
Title: Disaster Recovery Plan
Purpose: DR strategy, backup/restore verification, RTO/RPO targets and recovery procedures for the Afrikoba production platform.
Owner: DevSecOps Lead
Status: APPROVED
Version: 1.0
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: Backups (backupService.js), DB migration/boot (runMigrations.js, initDb.js), recovery runbook (docs/DISASTER_RECOVERY_RUNBOOK.md), telemetry (054/094: request_telemetry, trace_spans), partitions (088), restore verification (scripts/test-restore-verify.js)
Related Regulatory Requirements: AFK-INST-13 record retention (7y financial); AFK-INST-14 backup tiers (30d daily)
Approval Authority: DevSecOps Lead / CAB
---

# Disaster Recovery Plan (AFK-INST-18)

## 1. Objective

Guarantee business continuity, zero data loss for double-entry financial ledgers, and rapid
recovery (target RTO `< 30 minutes`, RPO `< 24 hours`) in the event of hardware failure, database
corruption, or regional outage. This plan is the canonical DR document; the operational
step-by-step lives in `docs/DISASTER_RECOVERY_RUNBOOK.md` (controlled derivative).

## 2. Backup topology & retention

- **Automated frequency:** daily 02:00 EAT via `src/services/backupService.js` (`startBackupScheduler`).
- **Storage location:** `./backups/` (persistent Docker volume in production).
- **Retention:** 30 days (`BACKUP_RETENTION_DAYS=30`); minimum last 7 daily backups kept regardless of age.
- **Tooling:** `pg_dump` plain SQL (custom `PGDUMP_PATH`/`PSQL_PATH` overridable per environment).
- **Post-backup verification:** `verifyBackup` checks file content for `CREATE TABLE`, `COPY`, `CREATE INDEX`.

## 3. Restore verification (automated, gated in CI)

Every restore path is proven by `scripts/test-restore-verify.js` (wired into CI):

| Check | Evidence |
|-------|----------|
| Backup is restorable | pg_dump → scratch DB → `psql` restore with `ON_ERROR_STOP=1`; exit 0 |
| Structural parity | scratch table count == source (299 public tables) |
| Row parity | users / transactions / wallet_ledger / journal_entries / audit_logs / ledger_accounts / supported_countries / schema_migrations counts match |
| Financial integrity | zero unbalanced journal groups; no negative wallet balances |
| Serializable IDs | serial `last_value >= MAX(id)` for core tables (guards sequence-resync regression, cf. migration 090) |
| Partitioning | `journal_entries`/`audit_logs` remain declaratively partitioned; month partitions present |
| Migration replay | all `schema_migrations.version` rows present after restore |
| Cleanup | scratch DB dropped with `WITH (FORCE)`; no residue |

CI also installs the PostgreSQL client (`postgresql-client`) so `pg_dump`/`psql` are available on
the runner. A restore that regresses (partitioned ledger, tandem balance, sequence state) fails the
pipeline — the same signal a corrupted production backup would produce.

## 4. Recovery procedures

### Scenario A: database corruption / point-in-time recovery
1. `docker compose stop app` (stop writes).
2. Locate latest verified backup: `ls -lt backups/ | head -n 5`.
3. Restore: `psql -h <db> -U <user> -d afrikoba_global < backups/afrikoba_backup_<TIMESTAMP>.sql`.
4. Restart app + replay migrations: `docker compose restart app; node scripts/runMigrations.js`.
5. Verify health: `/api/v1/health`; financially, run the same checks as section 3.

### Scenario B: complete server rebuild
1. Provision new host (Ubuntu 22.04 LTS / Docker / Compose); clone repo to `/var/www/afrikoba`.
2. Restore `.env`; restore DB dump into Docker volume.
3. `docker compose up -d --build`.
4. Verify: `/api/v1/health`, ledger-integrity suite, **restore verification suite**.

## 5. RTO & RPO

- **RTO:** `< 30 minutes`.
- **RPO:** `< 24 hours` (up to 1 hour with incremental WAL archiving — staged upgrade, documented future ADR).

## 6. Incident / telemetry linkage

- Trace-level spans (migration 094 `trace_spans`, root rows in `request_telemetry`) carry
  `trace_id`/`span_id`; restore/DR events are correlated by the incident trace in the Ops tracing UI
  (`GET /api/ops/tracing/:traceId`).
- All DR restorations are recorded in `audit_logs` (`action = 'DR_RESTORE'`) so recovery activity is
  attributable and reconcilable (AFK-INST-27 internal audit scope).

## 7. Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 1.0 | 2026-09-07 | DevSecOps Lead | Baseline consolidated with `docs/DISASTER_RECOVERY_RUNBOOK.md`; RTO/RPO, retention, scenario procedures | CAB (approved) |
| 1.0 | 2026-09-08 | AI code review | Added restore verification (scripts/test-restore-verify.js, 29 checks) + OTel incident linkage | DevSecOps Lead (pending re-review) |