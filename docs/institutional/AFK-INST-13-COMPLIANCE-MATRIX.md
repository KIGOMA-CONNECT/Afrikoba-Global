---
Document ID: AFK-INST-13
Title: Compliance Matrix
Purpose: Regulatory/market obligations mapped to controls and evidence across every market Afrikoba operates in.
Owner: Compliance Officer
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: AML/KYC (migrations 050/083), device security (092), multi-country compliance (089), ledger/WHT, governance/four-eyes (062/081)
Related Regulatory Requirements: Tanzania PDPA 2022, GDPR (Art 17), EAC frameworks, FATF AML/CTF, TCRA USSD, payment-licence obligations per market (migration 089)
Approval Authority: Board / Compliance Committee
---

# Compliance Matrix (AFK-INST-13)

Sources of truth consolidated here: `docs/COMPLIANCE/AML_KYC_POLICY.md`,
`docs/COMPLIANCE/DATA_PROTECTION_POLICY.md`, `GLOBAL_STANDARDS_AUDIT.md`,
migration 089 `supported_countries` (calling codes, per-country daily transfer limits,
withholding tax rates, KYC doc types, license status, local support contacts).

## Obligation → Control → Evidence

| Obligation | Control / Implementation | Evidence / Owner | Status |
|------------|--------------------------|------------------|--------|
| KYC identity verification (Tier 1–3) | OTP phone verify (L1); NIDA check (L2); ID upload+selfie+address (L3); expiry sweep (084) | AML_KYC_POLICY; `kyc_documents`; `scripts/test-kyc.js` | IMPLEMENTED |
| AML transaction monitoring / screening | Real-time blacklist + velocity + anomaly via fraud/AML services; AMLCases (050) SAR workflow with 48h resolution | AML_KYC_POLICY §3–4; `/api/fraud-ops` | IMPLEMENTED |
| Suspicious activity reporting (FIU) | SAR workflow in AML case notes; staff training required for FIU filing | AML_KYC_POLICY §4 | PARTIAL (filing process to formalise) |
| Record retention (10y KYC/transactions) | Retention schedule; partition DETACH archival (088); 7y audit/ledger policy | DATA_RETENTION_POLICY; partitionService | IMPLEMENTED |
| Data protection & privacy (PDPA/GDPR) | Encryption at rest/transit, minimal collection, consent, breach notice 72h | DATA_PROTECTION_POLICY; PRIVACY_POLICY | APPROVED (legal review ongoing nested in AFK-INST-14 consolidation) |
| Right to erasure/portability | Account deletion flow (PENDING_DELETION + 30d), export, anonymised retention | DATA_RETENTION_POLICY §3 | IMPLEMENTED |
| Per-country daily transfer caps | migration 089 `user_daily_transfer_totals`; `/api/countries/me` | test-multi-country.js (31 checks) | IMPLEMENTED |
| Cross-border withholding tax | `GOVERNMENT_WHT` + `REMITTANCE_CLEARING` accounts; per-country WHT rate | Ledger postings; compliance reporting export | IMPLEMENTED |
| Payment-licence / callings codes matrix | `supported_countries` license fields + country resolution | CountryService; admin country tuning | IMPLEMENTED (market-specific licence statuses to be kept current) |
| TCRA USSD shortcode registration | USSD HMAC rails + shortcode; registration filing pending | GLOBAL_STANDARDS_AUDIT rec.1 | ACTION REQUIRED |
| Audit immutability (money & privileged actions) | `audit_logs` append-only; four-eyes executor registry (081/082); partitioned (088) | financial-core audit; test-four-eyes.js | IMPLEMENTED |
| Consumer terms transparency | TERMS_OF_SERVICE.md (fees table, prohibited acts, arbitration) | Published doc | APPROVED (scheduled legal review) |

## Evidence register

- Test suites: `test-kyc.js` (30), `test-multi-country.js` (31), `test-four-eyes.js` (70), `test-aml?` in CI.
- Ops surfaces: Fraud Ops dashboard, RiskOps BI, ops chart-of-accounts + tracing (093/094).

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline consolidating audit + policy + migration evidence | Compliance Committee (pending) |