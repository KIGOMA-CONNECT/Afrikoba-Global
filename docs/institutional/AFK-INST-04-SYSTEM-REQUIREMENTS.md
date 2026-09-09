---
Document ID: AFK-INST-04
Title: System Requirements Specification
Purpose: Traceable system-level functional and non-functional requirements (FR/NFR) mapped to Afrikoba's modules and evidence.
Owner: Solutions Architect
Status: DRAFT
Version: 0.9
Effective Date: 2026-09-07
Last Review Date: 2026-09-08
Related Systems/Modules: All modules; see FR traceability matrix
Related Regulatory Requirements: AFK-INST-13 (compliance), AFK-INST-14 (data)
Approval Authority: Solutions Architect + CAB
---

# System Requirements Specification (AFK-INST-04)

## 1. Traceability model

Every FR links to: (1) Business capability (AFK-INST-02), (2) implementation evidence (route/service/CI suite on Blueprint status), (3) test in CI (AFK-INST-21).

## 2. Functional requirements (representative, traceable)

| ID | FR | Capability | Evidence (module/test) |
|----|----|------------|------------------------|
| FR-1 | OTP-verified phone registration; roles; JWT | Auth | authRoutes; test-all |
| FR-2 | KYC tiers L1–L3 with expiry sweep + downgrade | Identity/KYC | kycDocumentService; test-kyc (30) |
| FR-3 | Wallet balance, deposit, transfer, withdraw, statements, holdings | Wallet | walletService/engine; test-all |
| FR-4 | VICOBA/M-Koba shares, loans, social fund, penalties | Cooperatives | vicoba/mkoba; test-vicoba, test-vicoba-inbox |
| FR-5 | ROSCA pools, contributions, rotations, payouts | ROSCA | roscaService; test-rosca |
| FR-6 | P2P projects, investment, escrow milestones, revenue splits | P2P | p2pService; test-p2p |
| FR-7 | Cards (virtual/physical model) admin settle/refund | Cards | cardService; four-eyes launchers |
| FR-8 | Savings goals/challenges/vaults + micro/business/agri loans | Savings/lending | savings*Service; test-vault, test-lending-gates, kilimo |
| FR-9 | Merchant QR + payment links + invoices + payouts | Payments/merchant | merchantService; test-merchant-payouts |
| FR-10 | Payroll runs, budget control | Business | payrollService, budgetService |
| FR-11 | RFQ/bids/supplier financing | Procurement | procurementService |
| FR-12 | AI insights (spend, cashflow, budget, credit, loan relief, invoice/payroll/procurement) | AI | aiInsightService; test-ai-insights (13) |
| FR-13 | Chart of accounts numbered/typed; ops grouped view | Ops/ledger | chartOfAccountsService; test-chart-of-accounts (21) |
| FR-14 | Trace-levem spans/tree + ops tracing endpoint | Observability | trace util/telemetry; test-tracing (19) |
| FR-15 | Partitions ensure/list/archive | Ops/scale | partitionService; test-partitions |
| FR-16 | Multi-country config: caps, WHT, KYC types, licenses; /api/countries | Cross-border | countryService; test-multi-country (31) |
| FR-17 | Device binding + device_policy + fraud alerts | Security | deviceService; test-device-binding |
| FR-18 | Field partners onboarding + credit decisioning | Inclusion | fieldPartnerService; test-field-partners |
| FR-19 | Social/event funds (Upatu, bereavement, fundraising, event savings) | Social | eventService, socialFundService; test-events-stage4/5 |
| FR-20 | Digital meetings, group chat, AI secretary, resolutions | Governance | governanceService; governance suites |
| FR-21 | Project intelligence + automated project mgmt + HITL approval | Projects | projectIntelligenceService, aiDocumentIntelligence |
| FR-22 | Outbox event bus with backoff/dead-letter | Async | outboxService; test-outbox |
| FR-23 | USSD (HMAC) menu/balance/portfolio/transfer | Inclusion | ussdService; test-ussd |
| FR-24 | Reconciliation cron + exceptions | Finance | reconciliation jobs; spec AFK-INST-17 |

## 3. Non-functional requirements

| NFR | Requirement | Evidence |
|-----|-------------|----------|
| NFR-1 Reliability | ≥99.5% core API availability; graceful shutdown; health probes | /health, /health/db; deploy docs |
| NFR-2 Performance | p95 sub-second on core money ops; 47 indexes | standards audit; k6 |
| NFR-3 Security | OWASP top-10 mitigated; secrets env-only; HMAC rails | Global Standards Audit PASS |
| NFR-4 Data safety | Backups 30d verified; ledger/audit partitioned; DR RTO<30m / RPO<24h | DR runbook; partitionService |
| NFR-5 Auditability | append-only audit_logs; model register; traces retained | AFK-INST-16/20 |
| NFR-6 Portability/inclusion | Sw/en i18n; USSD parity; mobile secure storage | mobile Flutter suite; dashboard i18n |
| NFR-7 Scalability | Stateless auth; read replica; partitioning; async outbox | DEPLOYMENT.md; ADR-003 |
| NFR-8 Compliance | WHT/caps per market; KYC; breach 72h | test-multi-country; AFK-INST-13 |

## 4. Environment matrix

| Env | DB | Flags | Tests |
|-----|----|-------|-------|
| CI | fresh seeded Postgres | RATE_LIMIT_DISABLED, DISABLE_CRON | 43 suites |
| Staging | mirrored prod subset | most flags | k6 load/security |
| Prod | managed Postgres + replicas | flag-controlled rollout | smoke + monitoring |

## 5. Configuration requirements

- `validateConfig()` fail-fast in production (missing JWT/DB/WEBHOOK/Beem/AzamPay/CORS → refuse boot).
- Env-driven: `NODE_ENV, PORT, DB_*, JWT_*, CORS_ORIGINS, WEBHOOK_SECRET, USSD_SECRET, BEEM_*, AZAMPAY_*, SENTRY_DSN, REDIS_URL, TRUST_PROXY, APP_PORT` (DEPLOYMENT.md §1).
- Money thresholds config-driven (`config_settings` for four-eyes, lending gates 052).

## Change History

| Version | Date | Author | Reason | Approval |
|---------|------|--------|--------|----------|
| 0.1 | 2026-09-07 | AI code review | Baseline SRS from module/route/service inventory + suites + deployment env | Solutions Architect (pending) |
| 0.2 | 2026-09-07 | AI code review | CI suite count 30→31 with test-procurement | Solutions Architect (pending) |
| 0.3 | 2026-09-07 | AI code review | CI suite count 31→32 with test-tcra-ussd (097 shortcode registry) | Solutions Architect (pending) |
| 0.4 | 2026-09-08 | AI code review | CI suite count 32→33 with test-restore-verify (AFK-INST-18 DR restore) | Solutions Architect (pending) |