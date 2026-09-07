# AFRIKOBA GLOBAL — Institutional Documentation Gap Analysis

Baseline date: 2026-09-07. Analyzer: AI code review against the Afrikoba Master Project
Blueprint, Sec 85 canonical set (see `README.md`). This analysis preserves existing useful
work and brings it under the canonical institutional structure; nothing below was deleted.

## Gap Matrix (27 Documents)

| # | Document (ID) | Exists? | Current Version | Complete? | Conflicts? | Missing Sections | Required Update | Owner | Priority |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Project Charter (AFK-INST-01) | Partial | n/a | No | No | Purpose/scope, stakeholders, success criteria, governance, charter authority | Draft from README.md + blueprint scope; formal sign-off | Programme Sponsor | 1 — HIGH |
| 2 | Business Requirements Document (AFK-INST-02) | Partial | n/a | No | No | Business capability catalogue, user needs, acceptance criteria, traceability to blueprint | Consolidate from PLATFORM_ROADMAP.md + MASTER_BLUEPRINT_STATUS.md; baseline BRD | Product Manager | 1 — HIGH |
| 3 | Product Requirements Document (AFK-INST-03) | Partial | n/a | No | No | Feature definitions, NFRs, release scope, personas | Consolidate from README/PASSPORT_DESIGN.md; add NFR baseline | Product Manager | 2 — MEDIUM |
| 4 | System Requirements Specification (AFK-INST-04) | Partial | n/a | No | No | Traceable SRS (FR/NFR per module), environment matrix | Derive from MASTER_BLUEPRINT_STATUS.md service/route inventory | Solutions Architect | 2 — MEDIUM |
| 5 | Architecture Decision Records (AFK-INST-05) | No | n/a | No | Partial | ADR index exists nowhere; decisions live in commit history + migration names | Backfill trending-source ADRs: central ledger engine, OTel tracing, partitioned journal tables, multi-country rails, phone-key accounts | Enterprise Architect | 1 — HIGH |
| 6 | System Architecture Document (AFK-INST-06) | Partial | n/a | No | No | Service inventory, data flow, deployment topology, tech stack rationale | Consolidate DEPLOYMENT.md + README; add diagram + component register | Enterprise Architect | 2 — MEDIUM |
| 7 | Data Architecture (AFK-INST-07) | Partial | n/a | No | No | Logical ERD, data flows, ownership, lineage, partitioning/archival design | Build from `db/migrations/` + `docs/COMPLIANCE/DATA_PROTECTION_POLICY.md` | Data Architect | 1 — HIGH |
| 8 | API Specification (AFK-INST-08) | No | n/a | No | No | Endpoint catalogue, versioning, auth scheme, error envelope, rate limits | Generate from `src/routes/*`; add OpenAPI + versioning + deprecation policy | Platform Lead | 2 — MEDIUM |
| 9 | Database Design (AFK-INST-09) | Partial | n/a | No | No | Schema-at-rest ERD (migrations are source of truth but undocumented), index plan, retention hooks | Document from migrations 000–094; reconcile schema gaps | Database Lead | 2 — MEDIUM |
| 10 | Security Architecture (AFK-INST-10) | Partial | n/a | No | No | Control catalogue mapped to layers, key management, device binding, RBAC design | Consolidate GLOBAL_STANDARDS_AUDIT.md + security findings; add control matrix | Security Lead | 1 — HIGH |
| 11 | Threat Model (AFK-INST-11) | No | n/a | No | No | Asset inventory, STRIDE per surface, DREAD ratings, mitigations | Present (assets: wallets, KYC docs, OTP, webhooks, USSD HMAC, four-eyes) | Security Lead | 1 — HIGH |
| 12 | Risk Register (AFK-INST-12) | Partial | n/a | No | No | Unified risk ledger with L/I, owner, treatment; current risks only flagged inline | Consolidate 🔶 flags from MASTER_BLUEPRINT_STATUS.md + ROBOT lease/regulatory items | Risk Officer | 1 — HIGH |
| 13 | Compliance Matrix (AFK-INST-13) | Partial | 1.0 | No | No | Regulatory obligations → controls → evidence per market (TZ/KE/UG/…), migration 089 data | Merge AML_KYC_POLICY.md + multi-country config + WHT rules; add evidence links | Compliance Officer | 1 — HIGH |
| 14 | Data Governance Framework (AFK-INST-14) | YES — PARTIAL | 1.0 | No | Yes | Standard headers, data quality/DPIA, ownership, breach ops link to IRP | Migrate to canonical ID + add DPIA/quality; reconcile PRIVACY_POLICY + DATA_RETENTION_POLICY + DATA_PROTECTION_POLICY (3 overlapping) | DPO | 1 — HIGH |
| 15 | AI Governance Framework (AFK-INST-15) | No | n/a | No | No | AI model inventory (risk scoring, insights, meeting secretary, project intelligence), transparency, HITL, audit | Trace `ai*Service.js` + migrations 057/060; establish governance | AI Ethics Lead | 1 — HIGH |
| 16 | Financial Control Framework (AFK-INST-16) | Partial | 1.0 | No | No | SOX-style control mapping (segregation, four-eyes, balancing-group trigger, fee rules), sign-off | Consolidate financial-core audit (26 wallet writes, balancing trigger, chart 093) | Head of Finance | 1 — HIGH |
| 17 | Reconciliation Specification (AFK-INST-17) | Partial | n/a | No | No | Daily recon of wallet ↔ ledger ↔ external (AzamPay/Beem), break handling, tolerance | Write spec against financialEngine + `chart-of-accounts` + txn/ledger parity checks | Head of Finance | 2 — MEDIUM |
| 18 | Disaster Recovery Plan (AFK-INST-18) | YES — APPROVED | 1.0 | Yes | No | (None critical) | Add OTel-incident linkage + restore verification test reference | DevSecOps Lead | 3 — LOW |
| 19 | Business Continuity Plan (AFK-INST-19) | Partial | n/a | No | No | BIA, RTO/RPO per critical function, comms plan, staff/deputy coverage | Extend DR runbook into BCP; add VICOBA/payroll continuity | COO / Operations | 2 — MEDIUM |
| 20 | Incident Response Plan (AFK-INST-20) | No | n/a | No | No | Severity matrix, response team, comms, evidence, post-incident review | Draft from DISASTER_RECOVERY_RUNBOOK.md + DATA_PROTECTION_POLICY §7 (72h breach) | Security Lead | 1 — HIGH |
| 21 | Test Strategy (AFK-INST-21) | Partial | 1.0 | No | No | Levels, CI gates, coverage targets, UAT/staging env policy | Consolidate `scripts/test-*.js` + `.github/workflows/ci.yml` + GLOBAL_STANDARDS_AUDIT.md | QA Lead | 2 — MEDIUM |
| 22 | Release Management Plan (AFK-INST-22) | Partial | 1.0 | No | No | Versioning, promotion, rollback, go/no-go criteria | Baseline from DEPLOYMENT.md + PRODUCTION_CHECKLIST.md | Release Manager | 2 — MEDIUM |
| 23 | Operations Runbook (AFK-INST-23) | Partial | 1.0 | No | No | Monitoring/alerting runbooks (OTel traces, partitions, backups, queues) | Extend DEPLOYMENT.md + add trace/partition health checks | DevSecOps Lead | 2 — MEDIUM |
| 24 | Service Level Agreement (AFK-INST-24) | No | n/a | No | No | Availability/throughput targets, credits, escalation, measurement | Define per tier (wallet transfers, payouts, USSD latency) | COO / Operations | 3 — LOW |
| 25 | Vendor Management Framework (AFK-INST-25) | No | n/a | No | No | Vendor register (Bamboo, AzamPay, Beem, NIDA, Sentry), due diligence, SLAs, exit | New; derive provider list from PRIVACY_POLICY §4.1 | Procurement Manager | 3 — LOW |
| 26 | Change Management Procedure (AFK-INST-26) | No | n/a | No | No | CAB structure, RFC template, approval tiers, emergency change path; governs this set | New; publish RFC path for all ADR/doc changes | Governance Lead | 1 — HIGH |
| 27 | Internal Audit Framework (AFK-INST-27) | Partial | n/a | No | No | Audit charter, schedule, sampling, evidence, independence | Re-frame GLOBAL_STANDARDS_AUDIT.md as recurring audit program | Internal Auditor | 2 — MEDIUM |

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
| C1 | Suppliers schema ambiguity | `db/migrations/020` defines `suppliers(business_id,...)`; migration `047` `CREATE TABLE IF NOT EXISTS suppliers` is a silent no-op in DBs that ran 020 first, while `procurementService.js` queries `suppliers(owner_user_id,...)` | Flag for review: reconcile suppliers schema or procurement join (see AFK-INST-09). Do NOT auto-fix in code beyond what the AI-insights query work-around did (link financing via `request_id`+`business_id`). |
| C2 | Docs vs. code ownership | Three overlap: `PRIVACY_POLICY.md`, `DATA_RETENTION_POLICY.md`, `docs/COMPLIANCE/DATA_PROTECTION_POLICY.md` — differing retention figures held in one place | Consolidate under AFK-INST-14; keep user-facing docs as published derivatives with single source of truth. |
| C3 | No ADRs for major architecture | Central ledger, OTel tracing, partitioned journal, phone-key accounts, multi-country rails exist only in migration/service code | Backfill ADRs before further architectural drift (AFK-INST-05/P1). |
| C4 | Return-shape drift | `register` returns `user.phone_number` (test asserts `user.phone` broke); wallet transfer response omits `balance` | Capture canonical API contracts in AFK-INST-08 to stop test guesswork. |

## Recommended Sequencing (priority groups)

1. **P1 — Foundation (registry + control docs):** AFK-INST-05 (ADR backfill), 12 (risk register),
   13 (compliance matrix), 14 (single data-governance source), 15 (AI governance), 16 (financial controls),
   20 (incident response), 26 (change management).
2. **P2 — Specs + engineering docs:** AFK-INST-02/03 (re-baseline requirements incl. new capabilities),
   06/07/08/09 (architecture/API/db design), 11 (threat model), 17 (reconciliation), 21/22/23 (test/release/ops).
3. **P3 — Business terms:** AFK-INST-01 (charter), 19 (BCP), 24 (SLA), 25 (vendor mgmt), 27 (audit program).

Each delivery updates the registry `Status` → `DRAFT`, then `APPROVED` after the approval
authority signs the revision; the change is recorded in the document Change History.