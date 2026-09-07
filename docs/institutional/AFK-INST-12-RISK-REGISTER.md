---
Document ID: AFK-INST-12
Title: Risk Register
Purpose: Consolidated risk ledger with likelihood, impact, owner and treatment for platform, financial, regulatory and operational risks.
Owner: Risk Officer
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: financialEngine, fraud/AML services, device binding, four-eyes, disaster recovery, incident response
Related Regulatory Requirements: AFK-INST-13 (Compliance Matrix) mapping of all regulatory obligations
Approval Authority: Board / Risk Committee
---

# Risk Register (AFK-INST-12)

Severity = Likelihood × Impact (L/M/H → H); treatment follows: AVOID / MITIGATE / TRANSFER / ACCEPT (with owner).

| ID | Risk | Category | Likelihood | Impact | Severity | Treatment | Owner | Status |
|----|------|----------|-----------|--------|----------|-----------|-------|--------|
| R-001 | Direct wallet writes bypassing the ledger → drift/breakage | Financial | L | H | MEDIUM-MITIGATED | Code architecture: engine is sole mutator (ADR-001); balancing-group trigger; integrity tests | Tech Lead | ACTIVE (MITIGATED) |
| R-002 | Duplicate postings under retries (idempotency failure) | Financial | L | H | MEDIUM-MITIGATED | Idempotency registry; UNIQUE reference keys; concurrency tests | Tech Lead | ACTIVE (MITIGATED) |
| R-003 | Account takeover / fraud on transfers & withdrawals | Security | M | H | HIGH | OTP+device binding (ADR-005), rate limits, fraud alerts, four-eyes on high-value | Security Lead | ACTIVE (MITIGATED) |
| R-004 | Money laundering / terrorist financing via platform | Regulatory | L | H | MEDIUM-MITIGATED | AML/CTF policy, KYC tiers, transaction monitoring, SAR to FIU (AML_KYC_POLICY) | Compliance Officer | ACTIVE (MITIGATED) |
| R-005 | Data breach / personal data exposure | Security | L | H | MEDIUM-MITIGATED | Encryption at rest/transit, least privilege, 72h breach notification, IRP (AFK-INST-20) | DPO / Security | ACTIVE (MITIGATED) |
| R-006 | Regulatory non-compliance (per-country licensing, WHT, caps) | Regulatory | M | M | MEDIUM | Compliance matrix (AFK-INST-13); country config table; legal review per new market | Compliance Officer | ACTIVE |
| R-007 | Backup/DR failure → data loss of financial ledgers | Operational | L | H | MEDIUM-MITIGATED | Daily verified backup, retention 30d, RTO<30m, DR runbook (AFK-INST-18) | DevSecOps Lead | ACTIVE (MITIGATED) |
| R-008 | Single point of failure on core banking services | Operational | M | M | MEDIUM | Partitions (ADR-003), observability, alerting, runbook; partial — replicas for reads | DevSecOps Lead | ACTIVE |
| R-009 | Supplier/procurement financing default | Credit | M | M | MEDIUM | Supplier onboarding verification, RFQ workflow, financing approval gates | Credit Officer | ACTIVE |
| R-010 | AI insight/model drift producing wrong advice | AI/Model | M | M | MEDIUM | Model register versioning, human review, deterministic heuristics (ADR-006 / AFK-INST-15) | AI Ethics Lead | ACTIVE |
| R-011 | Vendor outage (Bamboo, AzamPay, Beem, NIDA, Sentry) | Operational | M | M | MEDIUM | Vendor mgmt framework (AFK-INST-25 pending), provider abstraction, fallbacks | Procurement Manager | ACTIVE |
| R-012 | Social/event funds governance misuse (Upatu, bereavement, fundraising) | Governance | M | M | MEDIUM | Governance/meeting controls (migrations 060/062), four-eyes on disbursements, audit hooks | Governance Lead | ACTIVE |
| R-013 | Partition/archive mishap amputating historical audit data | Operational | L | H | MEDIUM-MITIGATED | partitionService guardrails, DR verification, retention policy | DevSecOps Lead | ACTIVE (MITIGATED) |
| R-014 | Cross-border FX/witthholding misclassification | Financial/Compliance | M | M | MEDIUM | countryService enrichment + reconciliation checks; regulated corridor review | Compliance Officer | ACTIVE |

> Residual risk owners review semi-annually or on material change (per AFK-INST-26). New risks (e.g. supplier-schema conflict C1) are logged here once impact is assessed.

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline from blueprint 🔶 flags + financial-core audit + DR/AML evidence | Risk Committee (pending) |