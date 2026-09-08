# AFRIKOBA GLOBAL — Institutional Documentation Registry

This registry identifies the **Canonical Afrikoba Institutional Documentation Set** as
defined by the **Afrikoba Master Project Blueprint, Section 85 — Project Documentation Set**.

The 27 documents below are the authoritative institutional record for Afrikoba Global.
No document in this set may be invented, renamed, removed, merged, or replaced outside
a controlled revision approved through the Change Management Procedure (AFK-INST-26).

## Source Hierarchy

Authority order for resolving conflicts:

1. Approved Master Project Blueprint
2. Approved Architecture / Governance documents
3. Approved ADRs
4. Approved Product and System Requirements
5. Implementation code

**Code must not silently redefine the approved architecture.** Where code conflicts with
the approved architecture, flag the conflict for review rather than changing the
architecture automatically. See `GAP_ANALYSIS.md` for the current conflict log.

## Mandatory Document Metadata Header

Every document in the canonical set MUST carry the following header block at the top:

```markdown
---
Document ID: AFK-INST-01
Title: Project Charter
Purpose: <one-line statement of why this document exists>
Owner: <role>
Status: DRAFT | APPROVED | REVIEW
Version: 0.1
Effective Date: YYYY-MM-DD
Last Review Date: YYYY-MM-DD
Related Systems/Modules: <comma-separated list>
Related Regulatory Requirements: <laws/standards or "None">
Approval Authority: <role/board record>
---
```

Each revision MUST record an entry in the document's **Change History** section:

```markdown
## Change History
| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | YYYY-MM-DD | <author> | Initial baseline from master blueprint | <approver> |
```

## Canonical Set (27 Documents)

| ID | Title | Purpose | Owner | Status | Version | Effective | Last Review |
|----|-------|---------|-------|--------|---------|-----------|-------------|
| AFK-INST-01 | Project Charter | Formal mandate, scope, objectives, stakeholders and success criteria for the Afrikoba Global program. | Programme Sponsor | DRAFT | 0.1 | 2026-09-07 | 2026-09-07 |
| AFK-INST-02 | Business Requirements Document | Business capabilities, user needs and acceptance criteria across all product lines. | Product Manager | DRAFT | 0.1 | 2026-09-07 | 2026-09-07 |
| AFK-INST-03 | Product Requirements Document | Product scope, feature definitions, non-functional product requirements and release scope. | Product Manager | DRAFT | 0.1 | 2026-09-07 | 2026-09-07 |
| AFK-INST-04 | System Requirements Specification | Traceable system-level functional and non-functional requirements. | Solutions Architect | DRAFT | 0.6 | 2026-09-07 | 2026-09-08 |
| AFK-INST-05 | Architecture Decision Records | Immutable log of architecture decisions (ADRs) with context and consequences. | Enterprise Architect | DRAFT | 0.2 | 2026-09-07 | 2026-09-08 |
| AFK-INST-06 | System Architecture Document | End-to-end system architecture: services, data flow, integration, deployment. | Enterprise Architect | DRAFT | 0.1 | 2026-09-07 | 2026-09-07 |
| AFK-INST-07 | Data Architecture | Logical/physical data architecture, data flows, ownership, lineage. | Data Architect | DRAFT | 0.2 | 2026-09-07 | 2026-09-07 |
| AFK-INST-08 | API Specification | Public/internal API contracts, versions, auth, errors, deprecation policy. | Platform Lead | DRAFT | 0.2 | 2026-09-07 | 2026-09-07 |
| AFK-INST-09 | Database Design | Schema design, ERD, indexing, partitioning, retention, migration policy. | Database Lead | DRAFT | 0.2 | 2026-09-07 | 2026-09-07 |
| AFK-INST-10 | Security Architecture | Security controls across layers: identity, transport, data, network, app. | Security Lead | DRAFT | 0.1 | 2026-09-07 | 2026-09-07 |
| AFK-INST-11 | Threat Model | Asset inventory, attack surfaces, threats, mitigations and residual risk. | Security Lead | DRAFT | 0.1 | 2026-09-07 | 2026-09-07 |
| AFK-INST-12 | Risk Register | Consolidated risk ledger with likelihood, impact, owner and treatment. | Risk Officer | DRAFT | 0.1 | 2026-09-07 | 2026-09-07 |
| AFK-INST-13 | Compliance Matrix | Regulatory/market obligations mapped to controls and evidence. | Compliance Officer | DRAFT | 0.3 | 2026-09-07 | 2026-09-07 |
| AFK-INST-14 | Data Governance Framework | Data ownership, quality, classification, retention, DPIA and privacy operating rules (single source; C2 resolved). | Data Protection Officer | DRAFT | 0.3 | 2026-09-07 | 2026-09-07 |
| AFK-INST-15 | AI Governance Framework | AI model lifecycle, transparency, bias, human-in-the-loop and auditability. | AI Ethics Lead | DRAFT | 0.1 | 2026-09-07 | 2026-09-07 |
| AFK-INST-16 | Financial Control Framework | Financial controls, segregation of duties, reconciliation, fee/ledger rules. | Head of Finance | DRAFT | 0.2 | 2026-09-07 | 2026-09-07 |
| AFK-INST-17 | Reconciliation Specification | Reconciliation flows, tolerance rules, break management and controls. | Head of Finance | DRAFT | 0.1 | 2026-09-07 | 2026-09-07 |
| AFK-INST-18 | Disaster Recovery Plan | DR strategy, backup/restore verification, RTO/RPO and recovery procedures. | DevSecOps Lead | APPROVED | 1.0 | 2026-09 | 2026-09-08 |
| AFK-INST-19 | Business Continuity Plan | Continuity of business operations under major disruption. | COO / Operations | DRAFT | 0.1 | 2026-09-07 | 2026-09-07 |
| AFK-INST-20 | Incident Response Plan | IR procedures, severity, escalation, comms and lessons learned. | Security Lead | DRAFT | 0.1 | 2026-09-07 | 2026-09-07 |
| AFK-INST-21 | Test Strategy | Test levels, coverage targets, environments, CI gates and acceptance. | QA Lead | DRAFT | 0.6 | 2026-09-07 | 2026-09-08 |
| AFK-INST-22 | Release Management Plan | Release cadence, promotion, rollback and go/no-go rules. | Release Manager | DRAFT | 0.1 | 2026-09-07 | 2026-09-07 |
| AFK-INST-23 | Operations Runbook | Day-to-day operational procedures, monitoring, alerting and troubleshooting. | DevSecOps Lead | DRAFT | 0.1 | 2026-09-07 | 2026-09-07 |
| AFK-INST-24 | Service Level Agreement | Internal/external SLAs, availability targets and penalty/credit rules. | COO / Operations | DRAFT | 0.1 | 2026-09-07 | 2026-09-07 |
| AFK-INST-25 | Vendor Management Framework | Supplier lifecycle, due diligence, contracts, SLAs and exit management. | Procurement Manager | DRAFT | 0.1 | 2026-09-07 | 2026-09-07 |
| AFK-INST-26 | Change Management Procedure | Formal change control for the institutional set and production changes. | Governance Lead | DRAFT | 0.1 | 2026-09-07 | 2026-09-07 |
| AFK-INST-27 | Internal Audit Framework | Audit charter, scope, schedule, sampling and reporting standards. | Internal Auditor | DRAFT | 0.1 | 2026-09-07 | 2026-09-07 |

**Status legend:** `DRAFT` = in progress · `APPROVED` = board/policy approved · `REVIEW` =
approved but due for scheduled review · `PARTIAL` = meaningful existing material that must be
consolidated under the canonical document (see `GAP_ANALYSIS.md`) · `GAP` = no canonical
document exists yet.

## Incorporation of New Capabilities

The following production capabilities exist in implementation and MUST be incorporated
into the relevant institutional documents through **controlled revisions** — they do NOT
create a replacement architecture:

- AI Project Intelligence (Bamboo integration, migration 057)
- Automated Project Management / Human-in-the-loop Project Approval
- Digital Upatu, Social/Bereavement Funds, Social Event Fundraising, Event Savings
- Digital Meetings, Group Chat, AI Meeting Secretary
- Governance/Resolution Management (migrations 060, 062)
- Project Finance, Controlled Project Accounts, Revenue Distribution
- Payroll, Reinvestment, Reserves

Primary incorporation targets: AFK-INST-02/03 (requirements), AFK-INST-16/17 (finance, revenue
distribution, payroll, reserves), AFK-INST-14/15 (governance data & AI meeting secretary),
AFK-INST-27 (audit of social/project funds). The original Afrikoba vision remains authoritative
unless an explicit approved change is made.

## Change Control

Any feature requiring a change to the 27-document set follows AFK-INST-26:

1. Identify the affected document(s).
2. Create/update the relevant ADR or change request.
3. Record the architectural/business reason.
4. Assess security, financial, regulatory and operational impact.
5. Obtain required approval.
6. Update the document version.
7. Record the change in the change history.
8. Update implementation only after the approved specification is established.

No major financial, governance, security or architectural decision should exist only in
source code or informal developer notes.

## Related

- `GAP_ANALYSIS.md` — Document → Exists? → Version → Complete? → Conflicts? → Missing → Required Update → Owner → Priority
- `docs/MASTER_BLUEPRINT_STATUS.md` — implementation status of every platform module
- `docs/PLATFORM_ROADMAP.md` — capability roadmap and definition of done
- `docs/PASSPORT_DESIGN.md` — AFRIKOBA ID / digital passport reference design