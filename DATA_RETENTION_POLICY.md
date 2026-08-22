# Data Retention Policy — Afrikoba Global
Effective Date: August 22, 2026

## 1. Purpose
This policy defines how long Afrikoba Global retains different types of data and how data is securely deleted when no longer needed.

## 2. Retention Schedule

| Data Type | Retention Period | Deletion Method | Legal Basis |
|-----------|-----------------|-----------------|-------------|
| **User Accounts** | Until deletion request + 30 days | Hard delete from DB | Contract performance |
| **KYC Documents** | Until account deletion + 1 year | Secure file deletion | AML regulations |
| **Transaction Records** | 7 years from transaction date | Archive then delete | Financial regulations |
| **Wallet Ledger** | 7 years | Archive then delete | Financial regulations |
| **Audit Logs** | 7 years | Archive then delete | Regulatory compliance |
| **OTP Codes** | 1 hour | Auto-cleanup cron | Security |
| **Idempotency Keys** | 24 hours | Auto-cleanup cron | Security |
| **Session Data** | 24 hours | Auto-cleanup cron | Security |
| **Analytics Events** | 2 years | Batch delete | Service improvement |
| **Notification History** | 90 days | Auto-cleanup | Storage management |
| **Referral Records** | 3 years | Archive then delete | Contract performance |
| **Exchange Rates** | 5 years | Archive then delete | Financial records |
| **System Settings** | Indefinite | Manual review | Operational |

## 3. Data Deletion Process

### 3.1 Account Deletion Request
1. User submits deletion request via app or email
2. Account status changes to `PENDING_DELETION`
3. 30-day grace period (user can cancel)
4. After 30 days: hard delete personal data
5. Transaction records retained per legal requirements

### 3.2 Automated Cleanup
- OTP codes: cleaned every hour
- Idempotency keys: cleaned every 6 hours
- Notifications: cleaned after 90 days
- Analytics events: cleaned after 2 years

### 3.3 What Gets Deleted
- Full name, email, phone number
- Password hash, PIN hash
- TOTP secret
- KYC documents and verification data
- Notification content
- Session data

### 3.4 What Gets Retained (Anonymized)
- Transaction amounts (for financial reporting)
- VICOBA group statistics (aggregated)
- Audit log entries (anonymized user_id)

## 4. Data Backup Retention
- Daily backups: retained 30 days
- Weekly backups: retained 12 months
- Monthly backups: retained 7 years
- Backup deletion: secure overwrite

## 5. Third-Party Data Retention
- Beem Africa: SMS delivery logs per their policy
- AzamPay: Transaction records per their policy
- Sentry: Error logs per their policy (90 days default)

## 6. Compliance
This policy complies with:
- Tanzania Data Protection Act, 2022
- East African Community data protection frameworks
- GDPR Article 17 (Right to Erasure) where applicable

## 7. Review
This policy is reviewed annually or when regulations change.

## 8. Contact
For data retention inquiries: privacy@afrikoba.com
