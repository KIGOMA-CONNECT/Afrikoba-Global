---
Document ID: AFK-INST-20
Title: Incident Response Plan
Purpose: IR procedures, severity, escalation, communications and lessons learned for security, availability and data incidents on the Afrikoba platform.
Owner: Security Lead
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: telemetry/traces (094), fraud alerts, device binding (092), DR runbook (018), data breach notice (014/20), Sentry
Related Regulatory Requirements: PDPA/GDPR breach-notification (72h); FIU/regulator notification
Approval Authority: Security Committee / Board for material incidents
---

# Incident Response Plan (AFK-INST-20)

## 1. Classification

| Severity | Definition | Examples | Response time |
|----------|-----------|----------|----------------|
| SEV-1 | Loss of funds, PII breach, full outage, regulatory event | Ledger corruption, mass KYC leak, wallet DB down | 5 min escalate / 15 min response |
| SEV-2 | Degraded service, high-risk fraud spike, partial outage | USSD timeout, transfer latency, device-binding misconfig | 15 / 30 min |
| SEV-3 | Minor telemetry noise, small bugs, cosmetic | Trace gaps, one-off anomaly | 1hr / on-duty |

## 2. Roles

| Role | Responsibility |
|------|----------------|
| Incident Commander | Decision-making, comms, SEV-level owner |
| Tech/App responder | Diagnostics, rollback/fix (deploy via release mgmt AFK-INST-22) |
| DB/Infra responder | DB restores, partitions, backups (DR runbook AFK-INST-18) |
| Press/legal/compliance lead | External + regulator notification, holds on comms |
| Recorder | Timeline + evidence (audit_logs, trace_spans, Sentry) |

## 3. Procedure

1. **Detect** via Sentry, health checks, fraud ops, partition/otel ops dashboards, alerts.
2. **Classify** severity; open incident channel; assign IC.
3. **Contain**: rate-limit/flag-flag gate high-risk actions; revoke suspicious tokens/devices;
   freeze accounts for fraud (fraud ops).
4. **Eradicate/Recover**: fix + rollback, replay via idempotency, DB restore (AFK-INST-18).
5. **Notify**: data breach → within 72h regulator + affected users (GDPR/PDPA); FIU for ML/SAR.
6. **Post-incident review** within 5 days → add to register (AFK-INST-12), adopt action items.

## 4. Communication templates (work in progress)

- Internal: `[SEV-1] Latency/outage on <service>` + status updates on timeline.
- Regulator/irruption external gateway bluebundle; approved by compliance before sending.

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline; extends DATA_PROTECTION_POLICY §7 and DR runbook §3 | Security Lead (pending) |