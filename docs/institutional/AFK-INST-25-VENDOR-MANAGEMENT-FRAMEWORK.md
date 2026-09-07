---
Document ID: AFK-INST-25
Title: Vendor Management Framework
Purpose: Lifecycle, due diligence, contracts and oversight of third parties that touch Afrikoba's money, data or infrastructure.
Owner: Procurement/Corporate Services (with Security/DPO)
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: SLA (AFK-INST-24), BCP (AFK-INST-19), Data Governance (AFK-INST-14), Compliance (AFK-INST-13)
Related Regulatory Requirements: GDPR/PDPA transfers (AFK-INST-13/14), payment-licensing provider posture (DEPLOYMENT.md §7)
Approval Authority: Procurement Lead + DPO + Head of Finance
---

# Vendor Management Framework (AFK-INST-25)

## 1. Purpose & scope

Governs all third parties processing money, restricted/PII data or providing infrastructure for
Afrikoba Global. Vendors are classed by criticality; controls scale with class.

## 2. Registered vendor classes (from code/config)

| Class | Examples | Data/funds exposure | Reviews |
|-------|----------|---------------------|---------|
| C1 – Payment rails | AzamPay (disbursements/collections) | Funds + PII | Annual + SLA |
| C2 – Messaging | Beem (OTP + notifications) | PII phone | Annual + SLA |
| C3 – Identity | NIDA IDs | Biometric/ID data | Annual + DP |
| C4 – Observability | Sentry | Error logs (potentially contains PII snippets) | Annual + data-retention review |
| C5 – Infrastructure | VPS/PaaS/K8s + managed Postgres | All data at rest | Annual + security questionnaire |

## 3. Lifecycle

- **Onboarding due diligence:** ownership, licensing (BOT/payment for C1), DP & security posture
  questionnaire, SOC/ISO where available, subcontractor chain, exit path, notice-of-breach terms.
- **Contracting:** DPA (GDPR/PDPA-compatible) with purpose/retention/transfer clauses; SLA + credit
  schedule (AFK-INST-24); IRP notification obligations flowing into AFK-INST-20.
- **Operations:** monitored keys/endpoints (HMAC/webhooks); status-page linkage in BCP (AFK-INST-19
  §8); reconciliation of settlements (AFK-INST-17); secrets in env, never in repo.
- **Review:** annual re-risk by class; quarterly reconciliation of provider settlement vs ledger;
  contract/DPA re-negotiation at renewal; immediate review on incident/breach involving vendor.
- **Exit & offboarding:** data return/deletion evidence, key revocation, de-provisioning, user comms.

## 4. Sub-processors & delegation

- Sub-processor changes require DPO approval and (for C1) financial sign-off; updates to provider
  list are approved changes (AFK-INST-26).

## 5. Roles

| Role | Responsibility |
|------|---------------|
| Procurement Lead | Contracts, SLA/credit, lifecycle admin |
| DPO | DPAs, transfers, retention, incident notifications |
| Head of Finance | Money-rail posture, settlement reconciliation |
| DevSecOps | Technical controls, key/secret rotation, status-page monitoring |

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline vendor framework from providers used (Beem/AzamPay/NIDA/Bamboo/Sentry) + BCP pointer | Procurement Lead (pending) |