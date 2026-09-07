---
Document ID: AFK-INST-02
Title: Business Requirements Document
Purpose: Business capabilities, user needs and acceptance criteria across all product lines, including the newly-added Afrikoba capabilities.
Owner: Product Manager
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: All modules (see capabilities map)
Related Regulatory Requirements: AFK-INST-13 (Compliance Matrix) obligations feeding product acceptance
Approval Authority: Board / Product Steering
---

# Business Requirements Document (AFK-INST-02)

## 1. Product vision

Afrikoba is a pan-African digital banking, cooperative-banking (VICOBA/M-Koba), rotating
savings (ROSCA) and P2P investment platform unified on one ledger. It also extends to
project finance, governance/digital-meeting tools and financial inclusion (USSD/feature-phones).

## 2. Capability map (business → module)

| Business capability | Primary module/route | KYC gate | Money? |
|---------------------|----------------------|----------|--------|
| Wallet (deposit, transfer, withdraw, statements) | /api/wallet | L1+ | Yes (engine) |
| VICOBA / M-Koba (shares, loans, social fund) | /api/vicoba, /api/mkoba | L2+ | Yes (engine) |
| ROSCA (pool, rotation, payout) | /api/rosca | L2+ | Yes (engine) |
| P2P crowdfunding (projects, escrow, splits) | /api/p2p | L2+ | Yes (engine) |
| Cards (virtual/physical model) | /api/cards | L2+ | Yes (engine) |
| Savings (goals, challenges, vaults, credit) | /api/savings | L1+ | Yes (engine) |
| Lending (micro-loans, business, agri-kilimo) | /api/credit, /api/kilimo | L3 for high value | Yes (engine) |
| Payments (merchant QR, payment links, bills) | /api/merchant, /api/payments | L1+ | Yes (engine) |
| Business (invoices, payroll, budget) | /api/business, /api/payroll, /api/budget | L2+ | Payroll yes |
| Procurement & supplier financing | /api/procurement | L2+ | Yes (financing) |
| Field partners (Kiva-style onboarding) | /api/field-partners | L2+ | No |
| Social/event funds (Upatu, bereavement, fundraising, event savings) | /api/events, /api/social-fund | L2+ | Yes (engine) |
| Governance: digital meetings, group chat, AI secretary, resolutions | /api/governance | L2+ | No |
| Project intelligence + automated project management + HITL approval | /api/projects | L2+ | Yes (project finance) |
| AI financial intelligence (insights, cashflow, credit) | /api/ai | L1+ | No |
| USSD & feature-phone access | /api/ussd (HMAC) | L1+ | Yes (engine) |

## 3. Personas & needs

| Persona | Needs |
|---------|-------|
| Individual (rural/urban) | Wallet, savings, USSD access, micro-loans, financial health feedback |
| VICOBA/ROSCA member | Group shares, loans, social fund, meeting records |
| Group leader | Group administration, resolution management, revenue distribution design |
| Merchant/SME | QR & payment links, invoices, payroll, budget, procurement financing |
| Field partner | Remote onboarding + credit decisioning support |
| Investor (P2P/marketplace) | Project discovery, escrow-protected investment, milestone refunds |
| Admin/Risk/Compliance/Finance ops | Dashboards for fraud, AML, four-eyes, reconciliation, chart of accounts, tracing |
| Regulator | WHT/caps reporting, audit records, licensing data (supported_countries) |

## 4. Acceptance criteria themes

1. **Money correctness** (definition of done § in roadmap): 1 txn + 2 balanced ledger entries + audit; idempotent retries; DR=CR enforced.
2. **Security**: OTP + device binding on transfer/withdraw; RBAC on admin ops; four-eyes on privileged money actions.
3. **Sustainability**: feature flags for progressive rollout; non-intrusive USSD session flows.
4. **Inclusion**: Swahili/English i18n on web + mobile; USSD parity for core reads.

## 5. Newly-added capabilities vs. original vision

The original Afrikoba vision remains authoritative. The capabilities below were added to the
platform and MUST be governed via AFK-INST-26 revisions of the affected docs — they do not
replace the approved architecture: AI Project Intelligence (057), Automated Project
Management & human-in-the-loop approval, Digital Upatu, Social/Bereavement Funds, Social
Event Fundraising, Event Savings, Digital Meetings, Group Chat, AI Meeting Secretary,
Governance/Resolution Management (060, 062), Project Finance, Controlled Project Accounts,
Revenue Distribution, Payroll, Reinvestment, Reserves.

**Gap status:** BRD baseline needs approval + field validation before P2 tests are formalised.

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline from capability inventory (routes/services) + roadmap | Product Manager (pending) |