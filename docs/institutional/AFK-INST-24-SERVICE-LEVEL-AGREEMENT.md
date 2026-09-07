---
Document ID: AFK-INST-24
Title: Service Level Agreement
Purpose: Availability, performance, support and escalation targets for Afrikoba Global services and the supporting internal/external SLAs.
Owner: DevSecOps Lead
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: Operations Runbook (AFK-INST-23), BCP (AFK-INST-19), IRP (AFK-INST-20)
Related Regulatory Requirements: AFK-INST-13 (monitoring/evidence); payment rails reliability obligations
Approval Authority: DevSecOps Lead + Head of Finance
---

# Service Level Agreement (AFK-INST-24)

## 1. Service definitions

| Service | What it covers | Owner |
|---------|---------------|-------|
| Core money API | Wallet, transfers, deposits, withdrawals, ledger postings | Engineering |
| Savings & lending API | VICOBA/M-Koba, ROSCA, vaults/loans, escrow, merchant payouts | Engineering |
| Inclusion rails | USSD (HMAC), field-partner decisioning, notifications (Beem) | Engineering |
| Digital & governance | Meetings, chat, AI secretary, project intelligence | Engineering |
| Ops & compliance | Chart-of-accounts, traces, partitions, reconciliation, KYC | Ops/Finance |

## 2. Availability & performance targets

| Metric | Target | Measuring |
|--------|--------|-----------|
| Core API availability (Uptime monitored `/health`) | 99.5% monthly | Uptime Robot/Better Stack |
| DB readiness (`/health/db`) | 99.0% monthly | Health probe latency+uptime |
| p95 response – core money reads | <500ms | OTel trace p95 |
| p95 response – money mutations | <1s (excl. provider wait) | OTel traces |
| Reconciliation clean daily | 100% daily (breaks worked same day) | reconciliation_exceptions |
| Backup availability | 30 daily verified snapshots | backupService + verify |
| Provider settlement matching (AzamPay/Beem) | ≤T+1 | reconcile job |

## 3. Support & incident escalation

| Priority | Definition | First response | Update cadence | Target fix |
|----------|------------|---------------|----------------|------------|
| SEV-1 (Critical) | Money/service unavailable, funds-risk, breach plausible (AFK-INST-20) | ≤15 min | 30 min | ≤4h (or MVS) |
| SEV-2 (High) | Module degraded, MDC/major feature down | ≤30 min | 2h | ≤8h |
| SEV-3 (Normal) | Non-critical bug/feature-flag blast radius small | ≤4h | daily | ≤3 days |
| SEV-4 (Low) | Cosmetic/tech-debt/enhancement | ≤1 business day | weekly | sprint-bound |

All money-relevant incidents follow IRP (AFK-INST-20): roles, comms, 72h breach timeline to regulator.

## 4. Exclusions & credits

- Outages from mandated provider outages (Beem/AzamPay status page), scheduled maintenance
  (announced ≥72h, out-of-peak window), or planned migrations are excluded from uptime calculation.
- Service credits: for paying enterprises, SLA credits per AFK-INST-25 contract schedules on missed
  monthly availability target (applied as fee credit, not cash payout).

## 5. Reporting & review

- Monthly SLA report (uptime, p95, reconciliation, backup success, incidents by SEV) reviewed at
  CAB; quarterly SLA review re-baselines targets; change-driven (AFK-INST-26).

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline SLA from health checks, OTel traces, BCP/IRP and operations | DevSecOps Lead (pending) |