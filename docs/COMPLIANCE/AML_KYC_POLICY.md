# AFRIKOBA GLOBAL — Anti-Money Laundering (AML) & Know Your Customer (KYC) Policy

**Version:** 1.1  
**Status:** Formal  
**Last Updated:** September 2026  
**Derivative of:** [AFK-INST-13 Compliance Matrix](../institutional/AFK-INST-13-COMPLIANCE-MATRIX.md) and
[AFK-INST-14 Data Governance Framework](../institutional/AFK-INST-14-DATA-GOVERNANCE-FRAMEWORK.md). Retention figures follow AFK-INST-14 §3.  

## 1. Introduction
AFRIKOBA GLOBAL is committed to the highest standards of compliance with international Anti-Money Laundering (AML) and Counter-Terrorist Financing (CTF) regulations. This policy ensures our platform is not used for illicit activities.

## 2. KYC Tiers
We implement a risk-based approach with tiered KYC verification:

### Tier 1: Light (Basic)
*   **Requirements:** Phone number (verified via OTP).
*   **Limits:** Low daily transaction limits (e.g., < 100,000 TZS).
*   **Services:** Basic wallet, micro-savings.

### Tier 2: Standard (Verified)
*   **Requirements:** National ID (NIDA/National ID) number + Name verification.
*   **Limits:** Medium transaction limits.
*   **Services:** VICOBA participation, ROSCA pools, P2P lending.

### Tier 3: Enhanced (KYC L3)
*   **Requirements:** Physical ID upload + Selfie/Liveness check + Address verification.
*   **Limits:** High-value transfers, business loans.
*   **Services:** Full banking features, large disbursements.

## 3. Transaction Monitoring
*   **Real-time screening:** Every transaction is checked against blacklists and high-risk patterns.
*   **Velocity Checks:** Limits on frequency and volume of transfers within short timeframes.
*   **Anomaly Detection:** AI-driven detection of unusual spending or deposit behavior (via `aiRiskRecommendationService`).

## 4. Suspicious Activity Reporting (SAR)
*   All staff are trained to identify suspicious patterns and recognise the reporting thresholds.
*   Automated flags in the **Fraud Ops Dashboard** must be resolved within 48 hours.
*   **Formal filing (system-supported):** a case is raised in `aml_cases` (via Fraud Ops / AML admin);
    the Admin files the SAR with `POST /api/admin/aml/cases/:id/file-sar`, recording the FIU reference,
    agency, summary and filer. Every filing is written to the `sar_filings` trail (immutable), mirrored
    onto the case (`sar_reference`, `sar_agency`, `sar_filed_at`, disposition `REFERRED_TO_LRA`), and
    an `SAR_FILED` audit entry is appended. Multiple filings per case are supported for follow-ups.
*   Filing responsibility: Compliance Officer (MLRO-designate) confirms completeness before filing;
    the process is evidenced by `scripts/test-sar-filing.js` and surfaced in
    [AFK-INST-13](../institutional/AFK-INST-13-COMPLIANCE-MATRIX.md).

## 5. Record Keeping
*   All KYC documents are retained for the account-closure period + 1 year; financial/ledger/audit
    records for **7 years** (authoritative schedule: AFK-INST-14 §3; enforcement via partition DETACH
    archival, migration 088).
*   Audit trails are immutable and stored in the `audit_logs` table.

## 6. Prohibited Customers
AFRIKOBA does not provide services to:
*   Individuals on UN, EU, or local sanctions lists.
*   Shell banks.
*   Anonymous accounts or accounts with fake identities.
