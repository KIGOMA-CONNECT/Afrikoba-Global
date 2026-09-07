---
Document ID: AFK-INST-15
Title: AI Governance Framework
Purpose: AI model lifecycle, transparency, bias control, human-in-the-loop and auditability for all in-platform AI (credit, risk, insights, meeting secretary, project intelligence).
Owner: AI Ethics Lead
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: aiInsightService (046), aiRiskRecommendationService, financialPassport, AI Meeting Secretary, AI Project Intelligence (057), ai_model_register
Related Regulatory Requirements: EAC AI/DP frameworks, GDPR Art 22 (automated decisioning safeguards)
Approval Authority: Board / AI Ethics Committee
---

# AI Governance Framework (AFK-INST-15)

## 1. Model inventory

| Model/Feature | Purpose | Type | Data | Versioned? |
|---------------|---------|------|------|-----------|
| afri-ai-1.0 (AI Insights, 046) | Financial health, cashflow, budget, credit readiness, loan relief, digest | Rule/heuristic engine over transaction data | On-platform tx, ledger | Yes — `ai_model_register` |
| Commerce/ops insights (INVOICE_CASHFLOW, PAYROLL_HEALTH, PROCUREMENT_HEALTH) | Invoice/payroll/procurement health & alerts | Heuristic | business_invoices, payroll_runs, procurement | Yes — same register |
| Financial Passport score | Credit/trust gating | Deterministic score (5 governance factors) | Passport/credit data | Yes — score versioned |
| AI Meeting Secretary (060) | Digital-meeting minutes/actions | NLP/LLM (feature) | Meetings content | TBD — on integration |
| AI Project Intelligence (057) | Parse unstructured project docs | NLP/LLM (feature) | project_documents | TBD — on integration |

## 2. Lifecycle & human-in-the-loop

- **Design**: proposed models documented here + ADR (ADR-006 for insights).
- **Validation**: deterministic heuristics verified by tests (test-ai-insights.js, 13 checks);
  threshold decisions (e.g. alert when overdue>pending, payroll>130%) reviewed by RiskOps.
- **Deployment**: feature-flagged where risky; model version written to `ai_model_register`
  on every generation batch (audit trail incl. scope_user_id + insight_count).
- **Monitoring & review**: insights are dismissible by users (feedback), bias sampling
  reviewed quarterly, model drift reviewed on data-pattern change.
- **Retirement**: superseding versions documented; historical rows retained for audit.

## 3. Transparency & explanation

- Every surfaced insight states title, body, metric, model_version, generated_at
  (Insights page renders `insight_type · model_version · created_at`).
- Lending/passport decisions are deterministic with enumerated reasons; no black-box scores.

## 4. Bias & fairness controls

- Score/insight inputs must be measurable, non-protected features; sampling checks for
  gender/region skew on credit & passport outcomes quarterly; any disparity = PDPA review.

## 5. Data minimization & DPIA

- Models consume on-platform data only; no external data exports; DPIA on any new
  personal-data-consuming model (per AFK-INST-14 §5).

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline covering existing afri-ai-1.0 + new commerce insights; scope TBD items for Secretary/Project Intelligence | AI Ethics Lead (pending) |