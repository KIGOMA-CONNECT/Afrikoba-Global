# AFRIKOBA GLOBAL — Anti-Money Laundering (AML) & Know Your Customer (KYC) Policy

**Version:** 1.0  
**Status:** Formal  
**Last Updated:** September 2026  

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
*   All staff are trained to identify suspicious patterns.
*   Automated flags in the **Fraud Ops Dashboard** must be resolved within 48 hours.
*   Suspicious activities are reported to the Financial Intelligence Unit (FIU) as per regional laws.

## 5. Record Keeping
*   All KYC documents and transaction records are maintained for a minimum of 10 years after the account is closed.
*   Audit trails are immutable and stored in the `audit_logs` table.

## 6. Prohibited Customers
AFRIKOBA does not provide services to:
*   Individuals on UN, EU, or local sanctions lists.
*   Shell banks.
*   Anonymous accounts or accounts with fake identities.
