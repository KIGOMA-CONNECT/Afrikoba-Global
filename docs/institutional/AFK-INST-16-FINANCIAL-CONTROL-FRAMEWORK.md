---
Document ID: AFK-INST-16
Title: Financial Control Framework
Purpose: Financial controls, segregation of duties, fee/ledger rules and posting discipline that guarantee every money movement is accounted for and balanced.
Owner: Head of Finance
Status: DRAFT
Version: 0.2
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: financialEngine (ADR-001), ledger_accounts + chart numbering (093), four-eyes (081/082), reconciliation, GOVERNMENT_WHT/REMITTANCE accounts, partitions (088)
Related Regulatory Requirements: FATF; regional banking/payments oversight; AFK-INST-13 mapping
Approval Authority: Board / Finance Committee
---

# Financial Control Framework (AFK-INST-16)

## 1. Principles

1. **Every money movement** = 1 transaction row + ≥2 balanced ledger entries + audit entry.
2. **Ledger is the sole source of truth**: `postJournal` enforces DR == CR via DB trigger;
   service-level direct `users.wallet_balance` writes are prohibited (audit: all 26 writes live
   in financialEngine).
3. **Idempotency**: financial mutations require unique references; retries cannot double-post.
4. **Separation of duties**: maker-checker via four-eyes for admin money actions
   (disburse/refund/settle) and high-value transfers; no self-approval.
5. **Chart-of-accounts discipline**: every account has a formal `account_type` + `chart_number`
   in the correct 1000–5999 range (migration 093); new accounts must be approved and numbered
   before use.

## 2. Control activities

| Control | Implementation | Frequency |
|---------|----------------|-----------|
| Balancing-group trigger | Journal DR=CR enforced at DB | Real-time |
| Reconciliation | Cron reconciles pending/settled; exceptions in `reconciliation_exceptions` | Daily |
| Daily transfer cap | Per-country daily totals (089) | Real-time |
| WHT / remittance posts | Cross-border transfers post to GOVERNMENT_WHT + REMITTANCE_CLEARING | Real-time |
| Fee split verification | Platform fees / commissions / referral paid to dedicated accounts | Tested in suites (test-all, test multisplit) |
| Ledger integrity tests | `test-ledger-integrity.js`, card/loan disburse tests in CI | CI |
| Chart-of-accounts audit | `test-chart-of-accounts.js` (26 accounts numbered/in-range) | CI |

## 3. Segregation of duties (SoD) matrix

| Action | Maker | Checker | Restriction |
|--------|-------|---------|-------------|
| Large refund | Admin | Admin (four-eyes) | no-self-approval |
| Loan/VICOBA/card disbursement | Admin/agent | Admin (four-eyes) | actor fallback recorded |
| High-value wallet transfer | User | Four-eyes on threshold | config-driven threshold |
| Chart/account changes | Finance | Governance | ADR + AFK-INST-26 |

## 4. Reporting & reconciliation

- Ops chart-of-accounts grouped view with journal balances + totals (`/api/ops/chart-of-accounts`).
- Price/FX quotes via countryService; reconciliation of cross-border nets vs MNO/payment rails weekly.

## 5. Escrow funds governance

- Project escrow milestones, deliver-evidence release, admin-ruled disputes (marketplace) —
  funds never commingle with platform income; complex/distressed cases go to four-eyes.

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline from financial-core audit + postJournal trigger | Finance Committee (pending) |
| 0.2 | 2026-09-07 | AI code review | Added chart-numbering control (093) referencing new CI suite | Finance Committee (pending) |