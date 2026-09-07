---
Document ID: AFK-INST-19
Title: Business Continuity Plan
Purpose: Coordinate business continuity across outage severity, restore priorities, communication and resumption procedures for Afrikoba Global.
Owner: Head of Engineering (BCP coordinator)
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: DR runbook (AFK-INST-18), IRP (AFK-INST-20), backups/backupService, partitions (088), multi-country
Related Regulatory Requirements: AFK-INST-13 (continuity evidence), financial controls (AFK-INST-16)
Approval Authority: BCP Committee / Board
---

# Business Continuity Plan (AFK-INST-19)

## 1. Purpose & scope

Business continuity for Afrikoba Global covers extended unavailability of the platform, provider
rails, or key people — restoring minimum viable service (MVS) and then full service within agreed
RTOs. Full technical recovery steps live in the DR runbook (AFK-INST-18); this plan adds the
business-side coordination, prioritisation and comms.

## 2. Continuity tiers & RTOs

| Tier | Services | RTO | RPO | Notes |
|------|----------|-----|-----|-------|
| T1 – Money critical | Wallet/P2P/VICOBA lending reads+writes, deposits/withdrawals, ledger, reconciliation | ≤30 min DR failover | ≤24h | Backups verified daily (30d retention) |
| T2 – Commerce/inclusion | Merchant, invoices, payroll, procurement, USSD | ≤4h | ≤24h | USSD shares T1 read paths |
| T3 – Digital/governance | Meetings, AI secretary, project intelligence | ≤8h | ≤24h | Degraded acceptable briefly |
| T4 – Everything else | Reporting, experiments, social funds | ≤24h | ≤24h | Batch catch-up |

## 3. Restore priorities (order)

1. Restore DB from latest verified backup + run migrations (idempotent) + validate `/health/db`.
2. Start API; verify chart-of-accounts totals and partition integrity; drain outbox/dead-letter.
3. Replay or reconcile any in-flight provider callbacks (AzamPay/Beem) — idempotency keys prevent double-posting.
4. Verify reconciliation (AFK-INST-17) clean before re-opening external rails.

## 4. Modes of continuity

- **Normal** — full platform, all countries.
- **Limited operating mode** — degrade non-T1 modules; cap high-risk actions; enable read-only for T3/T4.
- **Minimum viable service** — T1 only; manual/offline decisioning for partner credit ops if field-partner API down.
- **Recovery** — restore T1→T4 in priority order; log deviations via AFK-INST-26.

## 5. Communication plan

- Internal: IRP alert on Ops channel; BCP coordinator owns status updates; CAB severity joint calls.
- External: regulator notification per AFK-INST-13/20 (72h breach timeline); provider status (Beem/AzamPay) tracked on their dashboards; user comms only when material (funds safety).

## 6. People & single points of failure

- Every critical function has a named deputy (finance, payments, security, DB, mobile/web).
- Runbooks (AFK-INST-23) are the execution reference; knowledge is not held by one person.

## 7. Testing & review

- Quarterly BCP tabletop; semi-annual DR restore exercise (proves RTO/RPO); annual full review tied to AFK-INST-26 change cycles. IRP postmortems feed BCP lessons (AFK-INST-20 §post-incident).

## 8. Maintenance (record of continuity vendors)

| Provider | Role | Dependency tier | Status link |
|----------|------|-----------------|-------------|
| Host/VPS/PaaS/K8s | Compute + network | T1 | dashboard |
| Managed Postgres | System of record | T1 | dashboard |
| Backups | 30d verified | T1 | backupService + verify script |
| Beem | SMS/OTP rails | T2 | provider status |
| AzamPay | Deposits/payouts | T1 | provider status |
| Sentry | Error/monitoring | T3 | status |
| NIDA | Identity verification | T2 | partner status |

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline BCP tied to DR runbook + IRP + tiered continuity | BCP Committee (pending) |