---
Document ID: AFK-INST-27
Title: Internal Audit Framework
Purpose: Audit charter, scope, schedule, sampling and reporting for independent assurance over Afrikoba Global's controls.
Owner: Internal Audit Lead
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: Financial Controls (AFK-INST-16), Compliance Matrix (AFK-INST-13), Risk Register (AFK-INST-12), Audit log trails + four-eyes + chart-of-accounts
Related Regulatory Requirements: AFK-INST-13 obligation→control→evidence model
Approval Authority: Audit Committee / Board
---

# Internal Audit Framework (AFK-INST-27)

## 1. Charter

Internal Audit provides independent, risk-based assurance over money movements, data protection,
AI governance, AML/KYC and operational controls. Reports to the Audit Committee with free access
to records, systems, staff and management; scope is not restricted by management.

## 2. Objectives

1. Confirm every money movement is balanced, authorised (four-eyes where required), idempotent and audited.
2. Verify compliance controls in AFK-INST-13 operate as designed (obligation→control→evidence sampling).
3. Verify AI actions are governed by AFK-INST-15 (model register, HITL, audit trails).
4. Confirm data handling matches AFK-INST-14 (data inventory, retention, DPIA log).
5. Track residual risks in AFK-INST-12 and any conflicts (shared DB, providers) to closure.

## 3. Scope & sampling

| Domain | Audit focus | Evidence/sampling |
|--------|-------------|-------------------|
| Ledger integrity | DR=CR, chart numbering, wallet↔ledger parity | `ledger_accounts` (093), chart totals, reconciliation_exceptions (AFK-INST-17) |
| Money paths | Transfers, splits, WHT/caps, escrow, payouts | financialEngine journals; test-ledger-integrity + multisplit evidence |
| Four-eyes | Threshold-triggered approval workflow | Admin approvals + audit log; test-four-eyes |
| AML/KYC | Tiers, expiry downgrades, monitoring alerts | kyc service + documents; test-kyc |
| AI | Model register adherence, refresh triggers, dismissal/review trails | model_register + ai insights; test-ai-insights |
| Data protection | Retention, transfers, DPIA, breach log | AFK-INST-14 inventory; backup/verification |
| Ops & BCP | Partitions, archives, backups, DR exercise results | partition health; DR runbook results |
| Providers | Settlement rec, DPA currency, status-page plans | reconciliation + AFK-INST-25 vendor reviews |

Built-in audit-friendly surfaces: `/api/ops/audit-log`, `/api/ops/tracing/:traceId`,
`/api/ops/chart-of-accounts`, `/api/ops/partitions`, `reconciliation_exceptions`.

## 4. Audit plan & scheduling

- **Business-as-usual:** continuous automated checks (regression suites act as control evidence) + quarterly
  domain audits + annual full-scope audit plan approved by the Audit Committee.
- **For-cause:** on incidents (AFK-INST-20), breach notifications, vendor critical incidents, or residual-risk spikes.
- **Sampling method:** risk-based: 100% for high-risk money paths on material amounts; statistical sample on high-volume,
  low-value items; judgement sample on new modules in first post-release quarter (AFK-INST-22 release window).

## 5. Reporting & follow-up

- Findings rated Critical/High/Medium/Low with control gap + owner + due date.
- Critical/high findings reported to the Audit Committee within 5 business days; remediation tracked
  to closure; repeat findings escalate per AFK-INST-12 appetite.
- External assurance mapping: the standards/audit already run (GLOBAL_STANDARDS_AUDIT.m) integ with
  internal independent review (four-eyes functioning as compensating control pending dedicated IA resource).

## 6. Independence & rotation

- Auditors avoid managing audited functions; sampling/evidence automation lives in ops tooling to
  reduce human access; findings are written for the Audit Committee, not sys ops staff.

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline IA framework from controls inventory + ops surfaces + standards audit | Internal Audit Lead (pending) |