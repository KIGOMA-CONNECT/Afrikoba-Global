---
Document ID: AFK-INST-17
Title: Reconciliation Specification
Purpose: Reconciliation flows, tolerance rules, break management, controls and evidence across wallet ↔ ledger ↔ external providers.
Owner: Head of Finance
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: financialEngine, ledger_accounts (093), reconciliation cron + exceptions, outbox (087), azampay/beem, partitions (088)
Related Regulatory Requirements: AFK-INST-13 (records), AFK-INST-16 (financial controls)
Approval Authority: Head of Finance / CAB
---

# Reconciliation Specification (AFK-INST-17)

## 1. Objectives

- Prove `users.wallet_balance` always reconciles to the ledger (every change through engine).
- Prove external flows (AzamPay deposits/withdrawals, Beem SMS, MNO callbacks) settle to ledger without double-posting.
- Expose and manage breaks via `reconciliation_exceptions`.

## 2. Reconciliation scope & frequency

| Reconciliation | Scope | Frequency | Owner |
|----------------|-------|-----------|-------|
| Ledger balance vs wallet rows | Full double-entry parity (asset/liability totals) | Real-time + daily | Finance |
| Journal DR vs CR | Balancing trigger (DB-enforced) | Real-time | DB/Finance |
| Chart-of-accounts balance | Per-account journal_balance vs totals (093) | Daily | Finance |
| External settlements | AzamPay/MNO callbacks vs ledger (idempotent) | Daily | Payments |
| Outbox delivery | Dispatched vs dead-letter | Continuous | DevSecOps |
| Partition/archive integrity | DETACH counts vs retention | Weekly | DB |

## 3. Tolerance rules

- Zero-tolerance for any unidirectional (unbalanced) posting — DB rejects.
- Breaks > TZS threshold (configurable `RECON_TOLERANCE`, default small) raised as exceptions with owner assignment.
- Timing settlement differences (provider vs ledger) flagged as `PENDING` breaks until resolved.

## 4. Break management flow

```
Break logged in reconciliation_exceptions
   → triage by owner (finance/payments/ops)
   → resolve (adjustment via financialEngine ONLY — no raw SQL money writes)
   → verify balances re-run clean
   → review by four-eyes if adjustment is a money movement
   → close with evidence
```

## 5. Controls & evidence

- All adjustments go through `postJournal` (engine) — never direct ledger writes.
- Reconciliations logged; evidence retained per AFK-INST-14 (7y).
- Ops dashboards surface chart-of-accounts totals + partition health + tracing for re-run diagnostics.

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline from reconciliation cron, chart/partition ops and provider callbacks | Head of Finance (pending) |