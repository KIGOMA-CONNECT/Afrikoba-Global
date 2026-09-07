---
Document ID: AFK-INST-01
Title: Project Charter
Purpose: Formal mandate, scope, objectives, stakeholders and success criteria for the Afrikoba Global program.
Owner: Programme Sponsor
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: All platform modules governed by this charter
Related Regulatory Requirements: AFK-INST-13 (compliance obligations are gating criteria)
Approval Authority: Board of Directors / Programme Sponsor
---

# Project Charter (AFK-INST-01)

## 1. Mandate

Afrikoba Global (Afrique-Bank of Kawawa? / cooperative digital banking) is chartered to deliver a
pan-African digital banking & financial-inclusion platform that unifies individual wallets,
cooperative banking (VICOBA/M-Koba), rotating savings groups (ROSCA), P2P crowdfunding, project
finance, governance/digital-meeting tools and USSD/feature-phone access — on a single auditable
double-entry ledger.

Authority: The **Afrikoba Master Project Blueprint**, Sec 85 (Project Documentation Set) among other
sections, is the approved source of truth. The original Afrikoba vision remains authoritative
unless explicitly changed via AFK-INST-26 (Change Management).

## 2. Scope

- **In-scope:** backend API + web dashboard + Flutter mobile + USSD; wallet, savings/VICOBA/ROSCA
  (incl. M-Koba), lending (micro/business/agri), P2P/marketplace/escrow, merchant/payments,
  business (invoices/payroll/budget), procurement & supplier financing, field partners, social/event
  funds (Upatu, bereavement, fundraising, event savings), governance (meetings, chat, AI secretary,
  resolutions), project intelligence & controlled project finance with HITL approval, AI financial
  intelligence, and ops/observability/compliance (chart of accounts, tracing, partitions, four-eyes,
  AML/KYC, device security, multi-country compliance).
- **Out-of-scope:** proprietary hardware/regulated deposit-taking; operating as a licensed bank
  without the required BOT/CMSA/payment licences (see DEPLOYMENT.md §7 go-live criteria for what is
  required per market).

## 3. Objectives & success criteria

| Objective | Success criteria |
|-----------|-------------------|
| Money correctness | Every transfer/deposit/withdrawal/split/disbursement posts balanced DR=CR, is idempotent, and audited |
| Financial inclusion | USSD parity for core reads; Swahili/English UX; low-friction KYC tiers |
| Trust & safety | Device binding, four-eyes controls, AML/CTF monitoring, 72h breach response (AFK-INST-20) |
| Scale | Partitioned ledger/audit, stateless JWT, read-replica ready, outbox-driven async |
| Governance | 27-doc institutional set governed by AFK-INST-26; ADRs logged (AFK-INST-05) |

## 4. Stakeholders

| Stakeholder | Interest |
|-------------|----------|
| Users (individuals, groups, merchants) | Wallet, savings, credit, inclusion |
| Group leaders / VICOBA-ROSCA admins | Group governance, revenue distribution |
| Field partners | Remote onboarding + credit decisioning |
| Investors (P2P/marketplace) | Escrow-protected returns |
| Regulators (BoT, CMSA, ODPC, TCRA, FIU per market) | Licensing, WHT/caps, ML/TF, DP |
| Admin/Risk/Compliance/Finance ops | Dashboards, reconciliation, reporting |
| Engineering | Maintainable modular codebase, CI/CD |

## 5. Governance

- **Steering/approvals:** Board + Programme Sponsor for material scope; CAB for change control
  (AFK-INST-26); Product/Compliance/Finance/Security single-owner accountability per doc registry.
- **Decision rights:** enterprise/security/data architects; DPO for data; Head of Finance for money.

## 6. Milestones (high level)

| Milestone | Evidence |
|-----------|----------|
| Core ledger + wallet + cooperatives live | Financial core audit + CI suites |
| Inclusion rails (USSD, mobile, i18n) | USSD suite; Flutter builds; dashboard i18n |
| Commerce/governance/social capabilities | Commerce + procurement; governance/event modules |
| Institutional readiness | 27-doc set governed by AFK-INST-26 (this set) |
| Regulated go-live | DEPLOYMENT.md §7 checklist per market |

## 7. Budget & resources (pointer)

Operational cost centres: hosting (VPS/PaaS/K8s), managed Postgres, providers (Beem SMS, AzamPay,
NIDA, Bamboo, Sentry), compliance/legal advisory. Detailed budget owned by CFO; vendor SLAs per AFK-INST-25.

## 8. Assumptions & constraints

- Postgres is the single system of record; migrations are the schema source of truth.
- Original vision authoritative until an explicit approved change (Afrikoba new capabilities
  incorporated via controlled revisions — AFK-INST-26).

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline charter consolidating README + blueprint scope | Programme Sponsor (pending) |