---
Document ID: AFK-INST-26
Title: Change Management Procedure
Purpose: Formal change control for the institutional documentation set and production changes; governs how the 27 canonical documents, ADRs, architecture and code drift are approved and versioned.
Owner: Governance Lead
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: all; feature flags (080), four-eyes (081), governance (060/062)
Related Regulatory Requirements: AFK-INST-13 controls; audited environment
Approval Authority: Change Advisory Board (CAB) / Board for material changes
---

# Change Management Procedure (AFK-INST-26)

## 1. Scope

- Changes to any of the 27 institutional documents (see `docs/institutional/README.md`).
- Architecture / architecture-significant code (money paths, ledger, security, compliance).
- Production-config changes (feature flags, device_policy defaults, WHT rates, thresholds, releases).
- Incident-driven emergency changes.

## 2. Change types & approval tiers

| Type | Examples | Approval |
|------|----------|----------|
| DOC (document revision) | Update of a 27-doc document per AFK-INST-? | Owner + affected control owner |
| RFC/ADR (architecture) | New ADR, ledger/new account, new integration | CAB |
| COMPLIANCE | WHT rate, per-country limit, KYC tier change | Compliance Officer + CAB |
| FEATURE/FLAG | Production feature rollout/rollback | CAB (or risk owner, flag-controlled) |
| EMERGENCY | Fix SEV-1/2 hole; immediate compliance need | IC + 24h CAB ratification |

## 3. Standard workflow (applies to 27-doc revisions)

1. Identify affected document(s) (registry README mandatory fields).
2. Create/update ADR or RFC: reason, business driver.
3. Impact assessment: security, financial, regulatory, operational.
4. Obtain required approval (tier above).
5. Update document version + record in the Change History table.
6. Only then update implementation (code must follow approved spec).
7. Audit marker: log in `audit_logs`/governance where privileged.

## 4. Emergency change path

- Authorised by Incident Commander; implement + technical test; retroactive CAB approval within 24h;
  retrospective RFC/diff recorded; triggers AFK-INST-20 review when applicable.

## 5. Deviation & conflict rule

- Conflicts between code and approved architecture (e.g. supplier-schema C1, API shape C4) are
  flagged to CAB and either RFC'd or explicitly ACCEPTED — never quietly auto-redefined.
- No major financial/governance/security/architectural decision may exist only in code or
  informal notes.

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline establishing the change control governing the institutional set | Governance Lead (pending) |