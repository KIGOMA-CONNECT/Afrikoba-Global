---
Document ID: AFK-INST-05
Title: Architecture Decision Records
Purpose: Immutable log of architecture decisions (ADRs) with context, options and consequences; the backfill baseline for decisions currently expressed only in migration/service code.
Owner: Enterprise Architect
Status: DRAFT
Version: 0.2
Effective Date: 2026-09-07
Last Review Date: 2026-09-08
Related Systems/Modules: financialEngine, telemetry/trace, ledger partitions, multi-country rails, device security, procured AI, four-eyes governance, outbox/event bus, chart of accounts, OpenAPI, field partners, SAR/TCRA regulatory surfaces
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
| ADR-007 | Multi-signature + four-eyes dual-control governance for privileged money actions | ACCEPTED | 2026-09-08 |
| ADR-008 | Feature flags + A/B experimentation layered on deterministic assignment | ACCEPTED | 2026-09-08 |
| ADR-009 | Monthly-range partitioning of journal and audit tables (re-confirmed) + sequence resync | ACCEPTED | 2026-09-08 |
| ADR-010 | Formal chart of accounts numbering (1000…5000) as classification overlay | ACCEPTED | 2026-09-08 |
| ADR-011 | Code-first OpenAPI contract as the canonical API specification | ACCEPTED | 2026-09-08 |
| ADR-012 | Transaction-aware outbox + event bus with exactly-once dedup | ACCEPTED | 2026-09-08 |
| ADR-013 | Field-partner funding pool as a ledger-partner overlay (Kiva-style) | ACCEPTED | 2026-09-08 |
| ADR-014 | FIU SAR filing trail + TCRA USSD shortcode registry as regulatory surfaces | ACCEPTED | 2026-09-08 |

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

## ADR-007 — Multi-signature + four-eyes dual-control governance for privileged money actions

**Context.** High-value transfers, loan disbursements, refunds and role changes were single-actor.
**Decision.** Migration 052 gates high-value wallet transfers via an executor registry;
migration 081 adds generalised `four_eyes_policies`/`four_eyes_requests`/`four_eyes_approvals`
(role-enforced, no-self-approval, quorum 1–3, dispatches to registered executors, retry on FAILED);
migration 058 provides N-of-M treasury multi-sig for internal treasuries.
**Consequences.** Privileged actions are maker-checked with an immutable request/approval trail;
new executors register in `fourEyesRoutes.js` and reuse the same lifecycle (ADMIN_PROMOTE_ROLE,
ADMIN_DEMOLE_ROLE, ADMIN_LARGE_REFUND, VICOBA/CREDIT/BUSINESS loan disbursers, card settle/refund,
lending-circle + kilimo disbursers). No-self-approval and role checks are DB- and service-enforced.

## ADR-008 — Feature flags + A/B experimentation layered on deterministic assignment

**Context.** Shipping risky features unscoped blocked safe rollout; product wanted measured launches.
**Decision.** Migration 080 `feature_flags`/`flag_evaluations` (fail-closed, kill-switch, per-user
overrides, role audience, expiry, SHA256 rollout bucket — every decision logged); migration 081
`experiments`/`experiment_assignments`/`experiment_events` with deterministic weighted variant
assignment (SHA256 bucket on `key:userId`, sticky via ON CONFLICT), lifecycle DRAFT→ARCHIVED and
reporting with uplift/z-score/WIN-LOSS-NEUTRAL.
**Consequences.** Features and experiments are governed centrally and testable in CI
(`test-features.js` / `test-experiments.js`); RUNNING experiments require an enabled flag
and immutable variants; rollout is auditable per user.

## ADR-009 — Monthly-range partitioning of journal and audit tables (re-confirmed) + sequence resync

**Context.** Migration 088 rebuilt `journal_entries`/`audit_logs` as monthly partitions; on DBs with
a legacy same-named sequence the implicit new default bound to `*_seq1` that 088's setval missed —
live sequence (429) lagged MAX(id) (1925), quietly breaking the serial contract in production-shaped DBs.
**Decision.** This ADR adopts partitioning as accepted for the financial core AND mandates migration
090 `sequence_resync`: name-agnostic `setval` of the sequence actually referenced by each table's
`id` default, `GREATEST(max_id, last_value)` — idempotent, never lowers. `partitionService.js`
ensures current+future partitions on boot + cron and supports DETACH-archive; healthy state is
exposed at `GET /api/ops/partitions`, and `test-partitions.js` + `test-restore-verify.js` re-assert
the serial contract post-migration.
**Consequences.** Future partition/DDL rebuilds must apply the name-agnostic sequence resync pattern;
CI now exercises the partitioned schema path; retention/compaction is DETACH-based, documented in AFK-INST-07/09.

## ADR-010 — Formal chart of accounts numbering (1000…5000) as classification overlay

**Context.** Ledger accounts carried semantic `account_type` but no standard accounting class numbering.
**Decision.** Migration 093 adds `chart_number` with CHECK-aligned ranges (ASSET 1000–1999, LIABILITY
2000–2999, EQUITY 3000–3999, REVENUE 4000–4999, EXPENSE 5000–5999), backfilled from `account_type`,
unique when non-null. `chartOfAccountsService.js` exposes a grouped view with journal balances;
`account_id` FKs are untouched — the number is a pure classification mirror.
**Consequences.** Finance can produce standard-class chart reports without remodelling; a unique
`chart_number` prevents double-classification; the overlay is additive (verified by test-chart-of-accounts).

## ADR-011 — Code-first OpenAPI contract as the canonical API specification

**Context.** Consumer/test return-shape drift (C4) recurred because contracts lived in prose and tests
guessed shapes.
**Decision.** `src/docs/openapi.js` (swagger-jsdoc annotations over the AFK-INST-08 module surface,
C4 contracts and security schemes) is wired via `src/config/swagger.js`; spec published code-first at
`/api/v1/docs.json` + swagger-ui (non-prod). `scripts/test-openapi.js` guards the spec. AFK-INST-08 §4
records canonical shapes.
**Consequences.** API documentation is generated from the same source as routes — drift is caught by CI;
tests and consumers reference the spec instead of guessing; spec regeneration is a code change (reviewed like code).

## ADR-012 — Transaction-aware outbox + event bus with exactly-once dedup

**Context.** Distributed side-effects (SMS, merchant payout execution, notifications) after money
movement were fire-and-forget — at-least-once retries risked duplicates or silent loss.
**Decision.** Migration 087 `outbox_events` (status PENDING/DELIVERED/FAILED/DEAD, attempts, backoff,
`reference_id UNIQUE` dedup): producers enqueue in the SAME DB transaction as the money movement;
`outboxService.dispatchOutbox` claims due rows `FOR UPDATE SKIP LOCKED`, exponential backoff
5s→30min cap, dead-letters past `max_attempts`, requeueable. Producers: VICOBA loan approval,
merchant payout execution; consumers registered in `server.js`; cron + admin `/api/outbox`.
**Consequences.** Exactly-once enqueue (dedup on reference) with at-least-once dispatch; money movement
never blocks on side-effect failure (guard `.catch(() => {})`); observability via ledger + `outbox_events`.

## ADR-013 — Field-partner funding pool as a ledger-partner overlay (Kiva-style)

**Context.** External lending networks need partner-held funding pools disbursed to borrower wallets
without mixing with customer or company money.
**Decision.** Migration 091: `field_partners` overlay (`user_id` unique partial, operator, `available_balance`)
and `field_partner_loans`/`field_partner_repayments`; `fieldPartnerService` funds/disburses/repays via
`PARTNER_BALANCE` ↔ `CUSTOMER_WALLET`/`SUSPENSE` engine postings; invariant `available_balance` mirrors
`PARTNER_BALANCE` net (test-field-partners 29 checks). Disbursements check the pool FOR UPDATE.
**Consequences.** Partner capital is explicit in the ledger; a partner pool can never be over-disbursed;
borrower-level money stays on-platform and ledger-integrity-tested.

## ADR-014 — FIU SAR filing trail + TCRA USSD shortcode registry as regulatory surfaces

**Context.** Regulatory obligations (AML SAR filing; TCRA USSD shortcode approval) had no system of record.
**Decision.** Migration 095 `sar_filings` (multiple filings per `aml_cases`, reference/agency/summary,
filed_by) mirror latest filing onto `aml_cases`; `POST /api/admin/aml/cases/:id/file-sar` + `SAR_FILED`
audit. Migration 097 `supported_countries.ussd_shortcode`/`_status` (PENDING|APPROVED CHECK, TZ `*150*87`)
with admin PUT lifecycle + `COUNTRY_UPDATED` audit, surfaced via `/api/countries` and `/me`.
**Consequences.** SAR and shortcode posture are queryable and audit-trailed; AFK-INST-13 rows map to
implemented controls with CI suites (test-sar-filing 20, test-tcra-ussd 22); field status lives in the
country table and is administered, not hardcoded.

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Backfill of six ADRs from migration/service evidence (Gap C3) | Governance Lead (pending) |
| 0.2 | 2026-09-08 | AI code review | Backfill ADR-007..014 (four-eyes, flags/experiments, partition resync, chart numbering, code-first OpenAPI, outbox, field-partner pool, SAR/TCRA rails) from migration 052/058/080/081/087/088/090/091/093/095/097 + service evidence (Gap C3 continuation) | Governance Lead (pending) |