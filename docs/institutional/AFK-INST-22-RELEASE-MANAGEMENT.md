---
Document ID: AFK-INST-22
Title: Release Management Plan
Purpose: Release cadence, promotion, rollback, go/no-go criteria and release scope control for Afrikoba Global.
Owner: Release Manager
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: Deployment (DEPLOYMENT.md), CI/CD (gates), feature flags (080), change mgmt (AFK-INST-26)
Related Regulatory Requirements: AFK-INST-13 controls; go-live checklist (DEPLOYMENT.md §7)
Approval Authority: Release Manager / CAB
---

# Release Management Plan (AFK-INST-22)

## 1. Release cadence

- Trunk-based on `main`; CI must pass before merge.
- Promotion: feature work merges → CI (backend suites + dashboard build + flutter checks) →
  manual go/no-go for money/compliance-impacting releases → prod deploy (Compose/PaaS/K8s per DEPLOYMENT.md).
- Hotfix path for SEV-1/2 (AFK-INST-20) with emergency ratification (AFK-INST-26).

## 2. Release types & gates

| Type | Gate | Rollback |
|------|------|----------|
| Routine feature | CI + tests + dashboard build | Revert commit + redeploy previous tag |
| Money/compliance | + finance sign-off + go-live checklist + scalable release plan § | Feature-flag disable + re-run reconciliation |
| DB migration | migration-reviewed; idempotent; partition/archive pre-check | roll-forward migration (idempotent) |
| Emergency | IC approval; 24h CAB | Immediate rollback |

## 3. Compatibility & deployment safety

- DB migrations run idempotently at app boot (`runMigrations.js`) — no manual schema step.
- Backwards-compatible adds on `/api`; `/api/v1` sunset policy per AFK-INST-08.
- Multi-step (split/calcl) jobs via `src/jobs/runAll.js` on system scheduling.

## 4. Go / no-go criteria (production)

- All CI green on `main`; secrets rotated; CORS allowlist exact; payment providers prod-ready;
- KYC/AML/BoT/CMSA/PDPA posture per DEPLOYMENT.md §7; monitoring (Sentry/Uptime) active;
- DR restore tested; new-feature flags stable.

## 5. Communication & sign-off

- Release notes per release; CAB sign-off for compliance/money changes; rollback owners named per release.

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline from deployment guide + go-live checklist + CI | Release Manager (pending) |