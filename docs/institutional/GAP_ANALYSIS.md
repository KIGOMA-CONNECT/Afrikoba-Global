# AFRIKOBA GLOBAL — Institutional Documentation Gap Analysis

Baseline date: 2026-09-07. Analyzer: AI code review against the Afrikoba Master Project
Blueprint, Sec 85 canonical set (see `README.md`). This analysis preserves existing useful
work and brings it under the canonical institutional structure; nothing below was deleted.

## Gap Matrix (27 Documents)

| # | Document (ID) | Exists? | Current Version | Complete? | Conflicts? | Missing Sections | Required Update | Owner | Priority |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Project Charter (AFK-INST-01) | YES — DRAFT | 0.1 | Yes | No | Mandate, scope, objectives, stakeholders, milestones | Approve baseline | Programme Sponsor | 1 — HIGH ✅ delivered |
| 2 | Business Requirements Document (AFK-INST-02) | YES — DRAFT | 0.1 | Yes | No | Capability map, personas, acceptance themes, new-capability integration note | Approve baseline | Product Manager | 1 — HIGH ✅ delivered |
| 3 | Product Requirements Document (AFK-INST-03) | YES — DRAFT | 0.1 | Yes | No | NFRs, release scope, flags/experiments | Approve baseline | Product Manager | 2 — MEDIUM ✅ delivered |
| 4 | System Requirements Specification (AFK-INST-04) | YES — DRAFT | 0.1 | Yes | No | Traceable FR+NFR per module with test evidence | Approve baseline | Solutions Architect | 2 — MEDIUM ✅ delivered |
| 5 | Architecture Decision Records (AFK-INST-05) | YES — DRAFT | 0.1 | Yes | Partial | ADRs ADR-001..006 backfilled (ledger engine, OTel spans, partitions, multi-country, device binding, AI register) | Add future ADRs; approve | Enterprise Architect | 1 — HIGH ✅ delivered |
| 6 | System Architecture Document (AFK-INST-06) | YES — DRAFT | 0.1 | Yes | No | Logical/data-flow/deployment topology incl. co-tenancy | Approve baseline | Enterprise Architect | 2 — MEDIUM ✅ delivered |
| 7 | Data Architecture (AFK-INST-07) | YES — DRAFT | 0.2 | Yes | No | Domains, ownership, lineage, partitions; C1 suppliers schema RESOLVED via 096 (union migration) | Approve baseline | Data Architect | 1 — HIGH ✅ delivered |
| 8 | API Specification (AFK-INST-08) | YES — DRAFT | 0.2 | Yes | No | Conventions, auth, module surface, C4 contracts standardised; OpenAPI generated code-first (`src/docs/openapi.js` + swagger.js) → `/api/v1/docs.json` + UI, guarded by test-openapi | Approve baseline | Platform Lead | 2 — MEDIUM ✅ delivered |
| 9 | Database Design (AFK-INST-09) | YES — DRAFT | 0.1 | Yes | No | Principles, core schema, indexing, partition/migration policy | Approve; ERD generation | Database Lead | 2 — MEDIUM ✅ delivered |
| 10 | Security Architecture (AFK-INST-10) | YES — DRAFT | 0.1 | Yes | No | Control catalogue mapped from audit + implementation | Approve baseline | Security Lead | 1 — HIGH ✅ delivered |
| 11 | Threat Model (AFK-INST-11) | YES — DRAFT | 0.1 | Yes | No | STRIDE asset/surface matrix + residual risks | Approve; annual re-eval | Security Lead | 1 — HIGH ✅ delivered |
| 12 | Risk Register (AFK-INST-12) | YES — DRAFT | 0.1 | Yes | No | 14 risks defined L/I/owner/treatment | Keep current post reviews | Risk Officer | 1 — HIGH ✅ delivered |
| 13 | Compliance Matrix (AFK-INST-13) | YES — DRAFT | 0.2 | Yes | No | 14 obligations→control→evidence; SAR row IMPLEMENTED (filing feature 095 + test-sar-filing) | Keep per-market licence statuses current | Compliance Officer | 1 — HIGH ✅ delivered |
| 14 | Data Governance Framework (AFK-INST-14) | YES — DRAFT | 0.3 | Yes | Yes | Standard headers done, DPIA + derivative-doc plan; C2 RESOLVED (single r/c schedule, published derivatives regenerated) | Approve as current DPO revision | DPO | 1 — HIGH ✅ delivered |
| 15 | AI Governance Framework (AFK-INST-15) | YES — DRAFT | 0.1 | Yes | No | Model inventory, lifecycle, HITL, bias, DPIA; Secretary/Project-Intelligence slots pending | Version-track future models | AI Ethics Lead | 1 — HIGH ✅ delivered |
| 16 | Financial Control Framework (AFK-INST-16) | YES — DRAFT | 0.2 | Yes | No | SoD matrix, controls, chart discipline (093) | Approve + periodic control testing | Head of Finance | 1 — HIGH ✅ delivered |
| 17 | Reconciliation Specification (AFK-INST-17) | YES — DRAFT | 0.1 | Yes | No | Scope, tolerance, break flow, controls | Approve baseline | Head of Finance | 2 — MEDIUM ✅ delivered |
| 18 | Disaster Recovery Plan (AFK-INST-18) | YES — APPROVED | 1.0 | Yes | No | (None critical) | Add OTel-incident linkage + restore verification test reference | DevSecOps Lead | 3 — LOW |
| 19 | Business Continuity Plan (AFK-INST-19) | YES — DRAFT | 0.1 | Yes | No | Tiers/RTO, restore priority, modes, comms, deputies | Approve baseline | COO / Operations | 2 — MEDIUM ✅ delivered |
| 20 | Incident Response Plan (AFK-INST-20) | YES — DRAFT | 0.1 | Yes | No | Severity matrix, roles, procedure, notification; comms templates pending | Tabletop test annually | Security Lead | 1 — HIGH ✅ delivered |
| 21 | Test Strategy (AFK-INST-21) | YES — DRAFT | 0.1 | Yes | No | Levels, CI gates, suite list (accurate to CI), flake policy | Approve baseline | QA Lead | 2 — MEDIUM ✅ delivered |
| 22 | Release Management Plan (AFK-INST-22) | YES — DRAFT | 0.1 | Yes | No | Cadence, types/gates, go-no-go, rollback | Approve baseline | Release Manager | 2 — MEDIUM ✅ delivered |
| 23 | Operations Runbook (AFK-INST-23) | YES — DRAFT | 0.1 | Yes | No | Monitoring, daily tasks, troubleshooting, DR pointer | Approve baseline | DevSecOps Lead | 2 — MEDIUM ✅ delivered |
| 24 | Service Level Agreement (AFK-INST-24) | YES — DRAFT | 0.1 | Yes | No | Availability/performance targets, escalation, exclusions, reporting | Approve baseline | COO / Operations | 3 — LOW ✅ delivered |
| 25 | Vendor Management Framework (AFK-INST-25) | YES — DRAFT | 0.1 | Yes | No | Vendor classes, lifecycle, DPA/SLA, reviews | Approve baseline | Procurement Manager | 3 — LOW ✅ delivered |
| 26 | Change Management Procedure (AFK-INST-26) | YES — DRAFT | 0.1 | Yes | No | Change tiers, RFC path, emergency path, deviation rule | Operationalise via CAB | Governance Lead | 1 — HIGH ✅ delivered |
| 27 | Internal Audit Framework (AFK-INST-27) | YES — DRAFT | 0.1 | Yes | No | Charter, scope/sampling, audit plan, reporting | Approve baseline | Internal Auditor | 2 — MEDIUM ✅ delivered |

## Existing Assets Mapped (no deletions)

| Asset (relative path) | Feeds canonical docs |
|---|---|
| `README.md` | AFK-INST-01, 03, 06 |
| `docs/MASTER_BLUEPRINT_STATUS.md` | AFK-INST-02, 04, 12 (risk flags) |
| `docs/PLATFORM_ROADMAP.md` | AFK-INST-02, 03, 21 (definition of done) |
| `docs/PASSPORT_DESIGN.md` | AFK-INST-02, 03, 16 (AFRIKOBA ID, passport score) |
| `docs/COMPLIANCE/AML_KYC_POLICY.md` | AFK-INST-13, 14, 18 (record retention) |
| `docs/COMPLIANCE/DATA_PROTECTION_POLICY.md` | AFK-INST-07, 14, 20 (72h breach) |
| `docs/DISASTER_RECOVERY_RUNBOOK.md` | AFK-INST-18, 19, 20, 23 |
| `PRIVACY_POLICY.md` | AFK-INST-14, 25 (provider list) |
| `TERMS_OF_SERVICE.md` | AFK-INST-02, 14 (user-facing legal) |
| `DATA_RETENTION_POLICY.md` | AFK-INST-07, 09, 14 |
| `GLOBAL_STANDARDS_AUDIT.md` | AFK-INST-10, 13, 21, 27 |
| `DEPLOYMENT.md` | AFK-INST-06, 22, 23 |
| `PRODUCTION_CHECKLIST.md` | AFK-INST-22, 23, 24 |
| `db/migrations/*` | AFK-INST-05 (decision trail), 07, 09, 15, 16 |
| `src/routes/*`, `src/services/*` | AFK-INST-08 (API), 15 (AI services), 16 (financialEngine) |
| `.github/workflows/ci.yml`, `scripts/test-*.js` | AFK-INST-08, 21 |

## Conflicts Detected (code vs. approved architecture)

| # | Conflict | Evidence | Action |
|---|---|---|---|
| C1 | Suppliers schema ambiguity | `db/migrations/020` defines `suppliers(business_id,...)`; migration `047` `CREATE TABLE IF NOT EXISTS suppliers` is a silent no-op in DBs that ran 020 first, while `procurementService.js` queries `suppliers(owner_user_id,...)` | RESOLVED 2026-09-07 (096): unioned 047 procurement columns onto `suppliers` idempotently (additive; existing rows/FKs intact), relaxed 020 NOT NULL on business_id/name, added partial unique index uq_suppliers_procurement_profile; procurement + commerce suppliers both work on one table (test-procurement), AI-insights financing link unchanged. |
| C2 | Docs vs. code ownership | Three overlap: `PRIVACY_POLICY.md`, `DATA_RETENTION_POLICY.md`, `docs/COMPLIANCE/DATA_PROTECTION_POLICY.md` — differing retention figures (financial records 7y vs 10y; un-implemented weekly/monthly backup tiers) | RESOLVED 2026-09-07: single source is AFK-INST-14 §3 (authoritative schedule + code evidence); all three published docs regenerated as consistent controlled derivatives (7y financial, 30d daily backups). Keep user-facing docs as derivatives; any retention change lands in the framework first. |
| C3 | No ADRs for major architecture | Central ledger, OTel tracing, partitioned journal, phone-key accounts, multi-country rails exist only in migration/service code | Backfill ADRs before further architectural drift (AFK-INST-05/P1). |
| C4 | Return-shape drift | `register` returns `user.phone_number` (test asserts `user.phone` broke); wallet transfer response omits `balance` | Capture canonical API contracts in AFK-INST-08 to stop test guesswork. |

## Recommended Sequencing (priority groups)

**P1 — Foundation (DONE 2026-09-07):** AFK-INST-05 (ADR backfill ×6), 12 (risk register),
13 (compliance matrix), 14 (data-governance source), 15 (AI governance), 16 (financial controls),
20 (incident response), 26 (change management). C2 resolved 2026-09-07: published privacy/retention
policies regenerated from AFK-INST-14 (7y financial, 30d backups). SAR filing formalised
(095 + file-sar endpoint + test-sar-filing; AFK-INST-13 row → IMPLEMENTED).

**P2 — Specs + engineering docs (DONE 2026-09-07):** AFK-INST-02/03 (requirements incl. new
capabilities), 04 (SRS, FR/NFR traceable), 06 (system architecture), 07 (data architecture; C1 → 0.2),
08 (API spec, standardises C4), 09 (database design), 10 (security architecture), 11 (threat model
STRIDE), 17 (reconciliation), 21 (test strategy; test-procurement added → 31 suites), 22 (release mgmt),
23 (ops runbook). OpenAPI generated code-first 2026-09-07 (src/docs/openapi.js + swagger.js →
/api/v1/docs + docs.json, guarded by test-openapi; AFK-INST-08 → 0.2). C1 suppliers schema reconciled
2026-09-07 (096 union migration + partial unique index; test-procurement in CI; AFK-INST-07 → 0.2).

**P3 — Business terms (DONE 2026-09-07):** AFK-INST-01 (charter), 19 (BCP), 24 (SLA), 25 (vendor
mgmt), 27 (audit program). The canonical 27-doc set is DRAFT-complete and all code-side gaps are
closed: C1 (suppliers schema) RESOLVED via 096, C2 (retention) RESOLVED, C3 (ADRs) backfilled,
C4 (API contracts) standardised + OpenAPI. Next is formal approval cycling per row owner.

Each delivery updates the registry `Status` → `DRAFT`, then `APPROVED` after the approval
authority signs the revision; the change is recorded in the document Change History.