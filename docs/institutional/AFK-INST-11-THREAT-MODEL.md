---
Document ID: AFK-INST-11
Title: Threat Model
Purpose: Asset inventory, attack surfaces, STRIDE-based threats, mitigations and residual risk for Afrikoba Global.
Owner: Security Lead
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: wallet/engine, KYC (083), devices (092), four-eyes (081), webhooks/USSD, AI (046), telemetry (094)
Related Regulatory Requirements: AFK-INST-10 (controls), AFK-INST-12 (risk register linkage)
Approval Authority: Security Lead / CAB
---

# Threat Model (AFK-INST-11)

## 1. Assets

| Asset | Classification | Criticality |
|-------|----------------|-------------|
| User wallet balances & ledger | Restricted | HIGH |
| KYC docs / NIDA / secrets / TOTP | Restricted | HIGH |
| financialEngine / ledger integrity | Internal | HIGH |
| Webhook/USSD HMAC secrets | Restricted | HIGH |
| AI signals & model register | Internal | MEDIUM |
| Telemetry traces (may contain IP/device) | Internal/Confidential | MEDIUM |
| Admin ops surfaces | Internal | HIGH |

## 2. Attack surfaces

- Public API (auth, wallet, transfers, withdraw).
- Web dashboard + public `/pay/:code` pages.
- Flutter mobile + USSD (HMAC).
- Webhooks (AzamPay/Beem callbacks, providers).
- Admin/ops routes (four-eyes gated) + fraud/AML surfaces.
- DB (pooled access, replicas), backups, queues (outbox).

## 3. STRIDE analysis (representative)

| Threat | Target | Risk | Mitigations | Residual |
|--------|--------|------|-------------|----------|
| Spoofing (fake user) | Auth | M | OTP, device binding, TOTP | Account takeover on device loss — mitigated by binding alerts |
| Tampering (alter ledger) | Ledger/engine | H | engine single-mutator, DR=CR trigger, idempotency, immutable audit | Accepted (mitigated) |
| Repudiation (deny txn) | Audit | M | append-only audit_logs (partitioned), traces | None substantive |
| Information disclosure (KYC/PII) | KYC/telemetry | H | encryption, RBAC, masking, least-protect rows | DPK access review required |
| DoS (rate abuse) | Auth/wallet | M | rate limits, IP/device limits | Small line-rate residual |
| Elevation of privilege (admin) | Admin ops | H | RBAC + four-eyes executors, no self-approval | Residual if executor creds leak — mitigated by 2 executors + audit |
| Model/GIGO (AI wrongness) | AI insights/credit | M | deterministic heuristics, model register, dismiss/user-review, HITL (AFK-INST-15) | Residual drift reviewed quarterly |

## 4. Trust boundaries

Edge (TLS/CORS/rate) → API (auth/RBAC/validation) → Services (engine invariants) → DB (pooled, least-priv).
Webhooks/USSD cross the edge via HMAC; admin ops cross into four-eyes/quorum zone.

## 5. Residual risks & review

Residual risks rolled into Risk Register (AFK-INST-12): R-003 (account takeover), R-004 (ML/TF),
R-005 (breach), R-010 (AI drift). Review annually or on material change; IRP (AFK-INST-20) governs response.

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline STRIDE model tying into controls + risk register | Security Lead (pending) |