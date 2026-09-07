---
Document ID: AFK-INST-10
Title: Security Architecture
Purpose: Security controls across layers — identity, transport, data, network and application — with a control catalogue mapped to implementation.
Owner: Security Lead
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: auth, wallet, devices (092), four-eyes (081/082), AML/fraud, telemetry (094)
Related Regulatory Requirements: AFK-INST-13 (AML/KYC, PDPA), OWASP Top 10 (audit PASS)
Approval Authority: Security Lead / CAB
---

# Security Architecture (AFK-INST-10)

## 1. Identity & access

- OTP phone verify (L1) → KYC tiers (L2 NIDA, L3 ID+selfie+address); optional password + PIN; TOTP 2FA for privileged ops.
- JWT (stateless, signed, TTL 7d); RBAC roles (ADMIN/MJUMBE/roles in claims); admin four-eyes executors.
- Trusted-device binding (092): device fingerprint registry, per-user device_policy
  (PERMISSIVE/TRUSTED_ONLY), per-device sliding-window limiter, first-seen fraud_alert.

## 2. Transport & boundaries

- TLS 1.2+; CORS allowlist (no `*` in prod); trust proxy for TLS-terminating edge; `X-Request-Id`.
- Webhook (WEBHOOK_SECRET) + USSD (USSD_SECRET) HMAC signature + IP allowlist.

## 3. Application

- Zod input validation on all routes; parameterized SQL (injection); rate limits (OTP 20/Auth 40/API 1000 per 15m).
- Security middleware: XSS, SQLi, CSRF, input-length guards; fail-fast config validation (`validateConfig`).
- Money invariants: engine single-mutator; journal DR=CR trigger; idempotency; balancing checked by tests.

## 4. Data protection

- Encryption at rest (sensitive columns via pgcrypto; app-level for secrets); encryption in transit (TLS).
- Least-privilege DB roles; secrets in env (never repo); PII masking in admin surfaces.
- KYC docs restricted-class per AFK-INST-14; access requires authorization; audit on privileged access.

## 5. Monitoring & response

- Sentry + JSON logs; telemetry traces (094) for correlation; fraud/alarm feed.
- IRP (AFK-INST-20) for containment/notification; audit_logs append-only partition(088) for evidence.

## 6. Security testing

- Global Standards Audit (OWASP Top 10 PASS), `npm audit` 0 vulns, k6 load/security scripts,
  CI security step + suites (device binding, legacy integrity, etc.).

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline from standards audit + auth/device/fraud implementation | Security Lead (pending) |