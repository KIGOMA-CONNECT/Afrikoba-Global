---
Document ID: AFK-INST-23
Title: Operations Runbook
Purpose: Day-to-day operational procedures, monitoring, alerting and troubleshooting for the production Afrikoba platform.
Owner: DevSecOps Lead
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: Deployment (DEPLOYMENT.md §5), partitions (088), outbox (087), backups (backupService), telemetry (094), DR (018)
Related Regulatory Requirements: AFK-INST-13 records; uptime commitments (SLA P3 AFK-INST-24)
Approval Authority: DevSecOps Lead / CAB
---

# Operations Runbook (AFK-INST-23)

## 1. Monitoring & alerting

- Uptime on `/health` (liveness) + `/health/db` (readiness) via UptimeRobot/Better Stack.
- Sentry for errors; JSON logs to stdout (Grafana/CloudWatch/Loki connection recommended).
- Ops surfaces: `GET /api/ops/dashboard`, `/api/ops/partitions`, `/api/ops/tracing/:traceId`,
  `/api/ops/chart-of-accounts` — used for capacity + accounting diagnostics.

## 2. Daily / weekly tasks

| Task | Command/Procedure |
|------|-------------------|
| DB backup verify | `scripts/backup-db.sh` + verification script post-backup (retention 30d) |
| Cron jobs | `node src/jobs/runAll.js` (P2P splits, collections) on system scheduling |
| Partition health | `GET /api/ops/partitions`; `partitionService` ensures monthly partitions |
| Outbox drain check | `/api/outbox` (SKIP LOCKED, backoff, dead-letter) |
| Dependency audit | `npm audit` monthly; base image upgrades |

## 3. Troubleshooting guides

- **Sync/latency on money APIs** → check Sentry traces (`/api/ops/tracing/:traceId`),
  DB locks (`SELECT * FROM pg_locks`), outbox backlog; engage IRP if degraded (AFK-INST-20).
- **Break in reconciliation** → triage via `reconciliation_exceptions`; adjust via engine only (AFK-INST-17).
- **Partition miss** → run `partitionService` ensure; alert on drift.
- **Webhook missing/callback stuck** → verify HMAC + IP allowlist, replay via idempotency key.
- **WHT/cap misconfig** → country table admin endpoint; rerun compliance reporting.

## 4. DR ops (pointer)

Full DR/restore in `docs/DISASTER_RECOVERY_RUNBOOK.md` (AFK-INST-18): stop app → restore
`backups/afrikoba_backup_<TS>.sql` → `runMigrations.js` → restart → verify `/health/db`.

## 5. Security hygiene

- Rotate secrets (JWT/WEBHOOK/USSD/AzamPay/Beem) on rotation schedule; never in repo;
- Device-policy defaults reviewed with binding posture (092); review IR log.

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline from deployment guide + ops endpoints + backups | DevSecOps Lead (pending) |