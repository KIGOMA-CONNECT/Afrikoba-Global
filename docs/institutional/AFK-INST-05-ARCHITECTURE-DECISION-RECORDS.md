---
Document ID: AFK-INST-05
Title: Architecture Decision Records
Purpose: Immutable log of architecture decisions (ADRs) with context, options and consequences; the backfill baseline for decisions currently expressed only in migration/service code.
Owner: Enterprise Architect
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: financialEngine, telemetry/trace, ledger partitions, multi-country rails, device security, procured AI
Related Regulatory Requirements: None directly; ADR-004 feeds Compliance Matrix (WHT/migrations 089)
Approval Authority: Governance Lead (CAB) per AFK-INST-26
---

# Architecture Decision Records (AFK-INST-05)

Each ADR is immutable. Corrections are recorded as a new ADR that supersedes an earlier one.
This index is the canonical ADR log for Afrikoba Global until a dedicated collection is
authorised; new ADRs MUST be appended here and their status changed to APPROVED.

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| ADR-001 | Central double-entry ledger engine for all money movement | ACCEPTED | 2026-09-07 |
| ADR-002 | Trace-level OpenTelemetry spans via AsyncLocalStorage | ACCEPTED | 2026-09-07 |
| ADR-003 | Monthly-range partitioning of journal and audit tables | ACCEPTED | 2026-09-07 |
| ADR-004 | Multi-country compliance rails (calling codes, WHT, caps) | ACCEPTED | 2026-09-07 |
| ADR-005 | Trusted-device binding for high-risk money actions | ACCEPTED | 2026-09-07 |
| ADR-006 | Self-hosted AI insight generation governed by model register | ACCEPTED | 2026-09-07 |

## ADR-001 — Central double-entry ledger engine for all money movement

**Context.** Money moved through many services (wallet, VICOBA, ROSCA, cards, loans).
Direct wallet writes created drift and made reconciliation hard.
**Decision.** Centralise in `src/services/financialEngine.js`: every mutation goes through
`creditWallet`, `debitWallet`, holds, internal transfer and group mirroring; `postJournal`
writes balanced DR/CR pairs enforced by a DB trigger (violations rejected); idempotency
registry prevents duplicate postings.
**Consequences.** ~28 services route money through the engine; audit show all 26
`users.wallet_balance` writes live inside the engine. Ledger integrity is testable
(`test-ledger-integrity.js`). Front-ends and services cannot move money without engine primitives.

## ADR-002 — Trace-level OpenTelemetry spans via AsyncLocalStorage

**Context.** Request-level telemetry existed but not child span relationships, so ops could
not correlate DB `postJournal` work with its parent request.
**Decision.** Migration 094 adds `trace_spans` + `request_telemetry.span_id/span_kind/operation`;
`src/utils/trace.js` (zero external-dependency) uses `AsyncLocalStorage` to propagate
`{traceId, parentSpanId}` across async boundaries; `telemetry.js` opens a ROOT span per request
and `startSpan()` opens CHILD spans inside services; trace trees are queryable at
`GET /api/ops/tracing/:traceId`.
**Consequences.** Distributed span trees without a collector dependency; spans persisted
(observability retained even if the collector/export is inactive); ERROR status spans persist failures.

## ADR-003 — Monthly-range partitioning of journal and audit tables

**Context.** `journal_entries` and `audit_logs` grew unbounded; deletes/compaction were risky
for an append-only financial core.
**Decision.** Migration 088 created declarative monthly RANGE partitions; `partitionService.js`
ensures partitions on boot + cron, lists them, and DETACH-es archives for retention drift;
blocked-type CHECKs preserve semantics.
**Consequences.** Retention/archival aligned with DATA_RETENTION_POLICY schedules; partition
health visible at `GET /api/ops/partitions`; future data-model changes must respect the
partition key.

## ADR-004 — Multi-country compliance rails (calling codes, WHT, caps)

**Context.** Pan-African expansion required per-country rules, currency/FX, withholding tax
and KYC doc types.
**Decision.** Migration 089 seeded `supported_countries` enrichment, `user_daily_transfer_totals`
daily caps per residency, `GOVERNMENT_WHT` + `REMITTANCE_CLEARING` ledger accounts and
MSISDN→country resolution; `GET /api/countries` + `/me` expose config & usage; admin can tune limits.
**Consequences.** Cross-border transfers withhold tax per residency; caps enforce compliance;
Operations must keep the country table updated with license/status changes (feeds AFK-INST-13).

## ADR-005 — Trusted-device binding for high-risk money actions

**Context.** OTP alone did not stop account-takeover on transfers/withdrawals.
**Decision.** Migration 092: `x-device-fingerprint` trusted-device registry, per-user
`device_policy` (PERMISSIVE/TRUSTED_ONLY), per-device sliding-window rate limiter and
first-seen-device `fraud_alerts`; enforced on transfer/withdraw.
**Consequences.** Device binding gates high-risk actions by default; legitimate new devices
trigger fraud alerts instead of hard failure; UX shows device management in web/mobile dashboards.

## ADR-006 — Self-hosted AI insight generation governed by a model register

**Context.** AI insights must be explainable and auditable; no external model call latency/DP concerns.
**Decision.** Self-hosted `aiInsightService` with deterministic heuristics over on-platform data;
every generation batch posts to `ai_model_register` (model `afri-ai-1.0`) and persists
insights in `ai_insights`; insight types cover spend, cashflow, budget, credit, loan relief,
invoice/payroll/procurement health.
**Consequences.** Models are versioned and auditable per AFK-INST-15; retraining/vision changes
are backward-compatible by new model version; no user data leaves the platform.

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Backfill of six ADRs from migration/service evidence (Gap C3) | Governance Lead (pending) |