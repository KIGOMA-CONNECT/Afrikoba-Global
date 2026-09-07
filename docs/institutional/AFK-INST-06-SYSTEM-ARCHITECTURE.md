---
Document ID: AFK-INST-06
Title: System Architecture Document
Purpose: End-to-end system architecture: services, data flow, integration and deployment topology.
Owner: Enterprise Architect
Status: DRAFT
Version: 0.1
Effective Date: 2026-09-07
Last Review Date: 2026-09-07
Related Systems/Modules: All; deployment per DEPLOYMENT.md
Related Regulatory Requirements: AFK-INST-13; deploy/co-tenancy isolation per DEPLOYMENT.md §3
Approval Authority: Enterprise Architect / CAB
---

# System Architecture Document (AFK-INST-06)

## 1. Logical architecture

- **API runtime** (Node/Express): ~56 route modules + ~100 service modules; stateless JWT auth.
- **Data store** — PostgreSQL 16 (single source of truth; ledger + wallet + all domains).
- **Caching** — Redis (rate-limit + idempotency) with in-memory fallback.
- **Async** — transaction-aware outbox + SKIP LOCKED dispatcher with backoff/dead-letter (087).
- **Mobile** — Flutter (secure storage; biometrics; parity). **USSD** — HMAC rails for feature phones.
- **Observability** — Winston JSON logs + Sentry; request_telemetry columns + trace_spans (094).

## 2. Money flow (core invariant)

```
Client → route → service → financialEngine
  ├─ postJournal (DR == CR, DB trigger enforced)
  ├─ wallet ledger write (single mutator — ADR-001)
  ├─ audit_logs entry (append-only, partitioned 088)
  └─ outbox event → queue workers
```
Business groups (VICOBA/ROSCA/family) mirror through `walletToGroup`/`groupToWallet`; external
money (AzamPay) and SMS (Beem) via provider abstraction; cross-border WHT routed to GOVT accounts.

## 3. Data flow

- Ingestion: REST/HTTPS, USSD (HMAC), webhooks (signed, IP-locked), payment-link public pages.
- Compute: services compute fees/splits/WHT deterministically; IDs gameable → transaction rows.
- Persistence: migrations 001–094 idempotent; ledger/audit partitioned monthly (088).
- Reporting: `observabilityService` + analytics warehouse for BI; ops chart-of-accounts.

## 4. Deployment topology

Per `DEPLOYMENT.md`:
- Option A: Docker Compose (VPS): multi-stage app image (dashboard bundled), non-root,
  healthcheck, auto-restart; DB volume + nightly backup (retention 30d).
- Option B: PaaS (Render/Railway/Fly): managed Postgres + webservice.
- Option C: Kubernetes: same image, Secret for env, `/health` + `/health/db` probes.
- Co-tenancy isolation: Afrikoba stack bound to `127.0.0.1:${APP_PORT}`; additive reverse-proxy
  vhost only (Caddy/Nginx) so other domains are untouched (DEPLOYMENT.md §3).

## 5. Trust boundaries

- Edge TLS + CORS allowlist + rate limiting + `X-Request-Id`.
- RBAC + device binding on transfer/withdraw; four-eyes on admin money; webhook/USSD HMAC.
- DB access via pooled `pg` with parameterized queries; least-privilege roles.

## 6. Scalability & reliability

- Stateless JWT; read-replica ready; partitions for growth; outbox for durability/backoff.
- Health: `/health` (liveness), `/health/db` (readiness); backup verification + restore test (DR FY18).

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline from codebase structure + DEPLOYMENT.md | Enterprise Architect (pending) |