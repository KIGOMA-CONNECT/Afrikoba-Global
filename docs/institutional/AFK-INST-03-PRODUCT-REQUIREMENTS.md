---
Document ID: AFK-INST-03
Title: Product Requirements Document
Purpose: Product scope, feature definitions, non-functional requirements (NFRs) and release scope for Afrikoba Global.
Owner: Product Manager
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: All product surfaces (web-dashboard, Flutter mobile, USSD)
Related Regulatory Requirements: AFK-INST-13 compliance obligations bind product behavior
Approval Authority: Product Steering / CAB
---

# Product Requirements Document (AFK-INST-03)

## 1. Product scope

Surfaces: Web dashboard (`web-dashboard/`), Flutter mobile (`mobile/`), USSD/feature-phone
(`ussdRoutes.js`), and public payment-link pages (`/pay/:code`). Backend `/api` + `/api/v1`.

## 2. NFRs

| NFR | Target | Evidence |
|-----|--------|----------|
| Availability | Core money APIs ≥ 99.5%; graceful degradation | Health + readiness probes; SLA baseline (AFK-INST-24 P3) |
| Performance | Wallet ops sub-second p95 on compute; DB tuned (47 indexes) | Analytics/ops dashboards; load tests (k6) |
| Security | OWASP Top 10 mitigated; secrets never in repo | Global standards audit (PASS) |
| Scalability | Stateless JWT; read-replica ready; partitioning; Redis fallback | DEPLOYMENT.md §1, migrations 087/088 |
| Maintainability | Modular services; migration-based schema; CI gates | Repository structure |
| Accessibility/Inclusion | Swahili/English i18n; USSD parity for core reads | i18n sw/en keys; USSD suite |

## 3. Release scope & feature backlog (P-framework)

| Tier | Examples | Gate |
|------|----------|------|
| Shipped & CI-tested | See inventory (routes × services) with `scripts/test-*.js` in CI | Definition-of-done §1–6 |
| Partial/surfaced | Marketplace escrow, disputes, procurement financing edge, AI UI depth | Complete remaining acceptance |
| New-capability consolidation | Project finance, governance meetings, revenue distribution, reserves | Controlled spec revisions (AFK-INST-26) |

## 4. Release scope for current sprint

- Web dashboard AI-insights parity: surface INV/PAYROLL/PROCUREMENT insights (done 2026-09-07).
- P1/P2 institutional docs (this set).
- Mobile parity maintained for field-partners + device security; merchant features surface on home drawer.

## 5. Feature flags & experiments

`/api/features` + admin `/api/features/admin` (080); A/B experiments governed by
`/api/experiments` (081). New features must be flag-gated before broad rollout.

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline PRD consolidated from README, roadmap, deployment guide | Product Manager (pending) |