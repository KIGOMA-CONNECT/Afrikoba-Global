# AFRIKOBA GLOBAL — Data Protection & Privacy Policy

**Version:** 1.1  
**Status:** Formal  
**Last Updated:** September 2026  
**Derivative of:** [AFK-INST-14 Data Governance Framework](../institutional/AFK-INST-14-DATA-GOVERNANCE-FRAMEWORK.md) (single source of truth for data governance, retention and DPIA triggers). This document is a controlled derivative and must not diverge from the framework.  

## 1. Overview
AFRIKOBA GLOBAL respects user privacy and complies with the **Tanzania Personal Data Protection Act (2022)**, **GDPR**, and other regional data protection laws.

## 2. Data Collection Principles
*   **Lawfulness & Transparency:** Data is collected for specific, legitimate purposes disclosed to the user.
*   **Data Minimization:** We only collect data necessary for providing financial services.
*   **Accuracy:** Users can update their profile and KYC information via the dashboard.

## 3. Categories of Data Processed
*   **Identity Data:** Name, ID number, DOB.
*   **Contact Data:** Phone number, email, address.
*   **Financial Data:** Wallet balances, transaction history, credit score.
*   **Technical Data:** IP address, device ID, trace IDs (telemetry).
*   **Social Data:** VICOBA/ROSCA group membership and contribution history.

## 4. Security Measures
*   **Encryption at Rest:** Sensitive columns (NIDA, secrets) are encrypted.
*   **Encryption in Transit:** All traffic is served over HTTPS/TLS 1.3.
*   **Access Control:** Least-privilege access for employees. Only authorized officers can view KYC documents.
*   **Anonymization:** Data used for AI training or analytics is anonymized or aggregated.

## 5. User Rights
Users have the right to:
1.  **Access:** Request a copy of their data.
2.  **Rectification:** Correct inaccurate data.
3.  **Erasure:** Request deletion (subject to the **7-year** financial record retention requirement per AFK-INST-14 §3).
4.  **Portability:** Export their transaction history.

## 6. Third-party Sharing
Data is shared only with:
*   Regulators (as required by law).
*   Identity verification providers (e.g., NIDA API).
*   Payment processors (e.g., AzamPay, Beem).
*   *We NEVER sell user data to third parties.*

## 7. Data Breach Notification
In the event of a significant data breach, AFRIKOBA will notify the relevant regulator and affected users within 72 hours.

## 8. Retention Schedule
See the authoritative retention schedule in AFK-INST-14 §3 (derivatives: `DATA_RETENTION_POLICY.md`,
`PRIVACY_POLICY.md` §6). Key figures: financial/audit records 7 years; OTP 1 hour; idempotency keys
24 hours; sessions/refresh tokens 24 hours; notifications 90 days; analytics events 2 years;
telemetry traces 90 days; backups 30 days; KYC docs account-closure + 1 year.
