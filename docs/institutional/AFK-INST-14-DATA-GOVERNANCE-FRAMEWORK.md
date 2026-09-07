---
Document ID: AFK-INST-14
Title: Data Governance Framework
Purpose: Single source of truth for data ownership, classification, quality, retention, DPIA and privacy operating rules; supersedes the pre-canonical PRIVACY_POLICY / DATA_RETENTION_POLICY / DATA_PROTECTION_POLICY split (which remain as user-facing derivatives and legal exhibits).
Owner: Data Protection Officer
Status: DRAFT
Version: 0.2
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: KYC (083), telemetry/traces (094), partitions (088), AI insights (046), device security (092)
Related Regulatory Requirements: Tanzania PDPA 2022; GDPR Art 5, 17; EAC data-protection frameworks
Approval Authority: Board / DPO
---

# Data Governance Framework (AFK-INST-14)

## 1. Data classification

| Class | Examples | Handling |
|-------|----------|----------|
| PUBLIC | Marketing page, prices, country tables | Public; no restrictions |
| INTERNAL | Analytics aggregates, ops metrics, telemetry sums | Least privilege; internal use only |
| CONFIDENTIAL | Balances, transaction history, VICOBA/ROSCA participation | Role-based access; PII masking; 401/403 gates |
| RESTRICTED | KYC docs, NIDA numbers, TOTP/PIN/OTP secrets, session data | Encrypted at rest; access request req.; breach-sensitive |

## 2. Data ownership & RACI

| Domain | Owner | Custodian (system) |
|--------|-------|--------------------|
| Identity & KYC | DPO | Auth/KYC services + kyc_documents |
| Wallet & ledger | Head of Finance | financialEngine + ledger_accounts |
| AI signals | AI Ethics Lead | ai_insights / ai_model_register |
| Telemetry/traces | DevSecOps Lead | request_telemetry / trace_spans |
| Governance & meetings content | Governance Lead | governance_* (060/062) |
| Social/event funds | COO / Operations | social event modules |

## 3. Retention (single schedule)

Adopted from `DATA_RETENTION_POLICY.md` and enforced across tables:

| Data | Period | Enforced by |
|------|--------|-------------|
| OTP codes / idempotency keys | 1h / 24h | cleanup cron |
| Sessions / notifications | 24h / 90d | cleanup cron |
| Analytics events | 2y | batch delete |
| Transactions / ledger / audit | 7y | partition DETACH archive (088) |
| KYC docs | account-closure + 1y | kyc expiry/archival |
| Telemetry traces | 90d (reporting keep) | retention job (ops) |

## 4. Data quality

- Constraints + check constraints at DB (PP: balances CHECK, journal DR/CR trigger).
- Reconciliation cron surfaces breaks via `reconciliation_exceptions`.
- Ownership changes must be approved; lineage recorded in PRD/AF DI docs when data flows change.

## 5. DPIA trigger

A DPIA is required for: new biometric/selfie capture, cross-border transfer of Restricted-class data,
new marketing/AI analytics on personal data, vendor access to Restricted data. Outcome recorded here.

## 6. User-facing documents (derivatives)

- `PRIVACY_POLICY.md`, `DATA_RETENTION_POLICY.md`, `TERMS_OF_SERVICE.md`,
  `docs/COMPLIANCE/DATA_PROTECTION_POLICY.md` — must be regenerated from this framework
  (C2 conflict resolved: this file is the source; published pages are controlled derivatives).

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline from DATA_PROTECTION_POLICY + DATA_RETENTION_POLICY + PRIVACY_POLICY | DPO (pending) |
| 0.2 | 2026-09-07 | AI code review | Added DPIA trigger + derivative-doc guidance | DPO (pending) |