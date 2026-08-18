# AFRIKOBA GLOBAL — Product & Scale Blueprint
### "Digital Banking & Upatu" — Unified Platform for Africa & the World

Target: 1B+ users, 200-year product vision. This document is the single source of truth for
feature direction, module ownership, and scale-first architecture decisions.

---

## 1. Dira (Vision)

> **AFRIKOBA = One platform where every community saves, borrows, invests, pays, and grows —
> combining the trust of African group-finance (VICOBA/ROSCA) with world-class digital banking.**

Everything we build must pass the "international standards" bar:
- **Compliance-first**: AML/KYC/CFT, GDPR + Data Protection Act (TZ), PCI-DSS, BaaS licensing path.
- **Money-safe**: escrow, multi-sig, audit trail on every shilling, idempotency, reconciliation.
- **Scale-ready**: event-driven, shardable data, cache-first reads, idempotent writes, regional DR.

---

## 2. Feature DNA — borrowed from world-class platforms

| Reference Platform | Proven Feature | AFRIKOBA Module | Status |
|---|---|---|---|
| **eRosca / Moneyfellows** | Automated ROSCA collections + payout cycles; credit score from contribution history | Upatu (ROSCA) Engine | ✅ Built (payout cron, queue allocation) → **next**: auto-contribution scheduling + trust_score from history |
| **ChamaPro / Mwanga** | Full chama accounting: contributions, loans, dividends/share-outs, member reports | VICOBA (Group Savings & Loans) | ✅ Built (multi-sig loans) → **next**: share-outs, dividend runs, group financial statements |
| **Tandem / Jamii** | Low-cost financial inclusion, microsavings, light KYC tiers | Light KYC onboarding + micro-vaults | 🔨 Onboarding (choose services) in progress |
| **Kiva** | Global P2P crowdfunded microloans, field partners, transparent repayment | P2P Investment + **Donor/Crowdfunding Loans** | P2P ✅ built → **next**: Kiva-style lending circles + field partner API |
| **Farmdrive / Complete Farmer** | Agri-financing tied to farm cycle; input financing; offtake-backed repayment | **Kilimo (Agri-Finance)** module | 🆕 Planned: input loans, harvest-cycle repayment, agronomist network |
| **LendingClub / Prosper** | Risk grades, fractional investing, automated matching, secondary market | P2P Investment | ✅ risk grading + fractional shares → **next**: secondary market, auto-invest |
| **Revolut / Monzo** | Multi-currency wallets, vaults/spaces, instant P2P, budgeting, cards | Digital Banking module | 🔨 wallet/wallet built → **next**: vaults, multi-currency, virtual cards |
| **Stripe Connect** | Platforms & connected accounts, split payments, escrow, KYC onboarding, dispute tools | **Malipo (Payments Platform)** + Split Engine | Split Engine ✅ built → **next**: connected merchant accounts, marketplace payouts |

### Feature cross-map → module ownership
```
┌──────────────────────────────────────────────────────────────────────────┐
│ AFRIKOBA GLOBAL (single login, choose-your-services)                     │
│                                                                          │
│  WALLET (base)      → Revolut/Monzo banking core                         │
│  VICOBA             → ChamaPro/Mwanga group accounting                   │
│  UPATU (ROSCA)      → eRosca/Moneyfellows automated cycles               │
│  P2P Investment     → LendingClub/Prosper + Kiva lending circles         │
│  KILIMO (Agri)      → Farmdrive/Complete Farmer                          │
│  MALIPO (Platform)  → Stripe Connect: connected accounts + splits        │
│  SMS/Payments infra → Beem, AzamPay (local rails), USSD-ready            │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Scale-First Architecture (1B users target)

### 3.1 North Star principles
1. **Idempotency everywhere** — every mutation carries `Idempotency-Key`; duplicate callbacks/retries are safe (already applied to webhook credit).
2. **Event-driven** — `events` table + outbox pattern → Kafka/nats queue → workers (SMS, payout, notifications, scoring). Current cron jobs migrate to event consumers.
3. **Read-model separation** — CQRS: transactional writes to PostgreSQL; analytical dashboards on replica/warehouse (e.g., ClickHouse/DuckDB).
4. **Sharding** — partition by `tenant/region` and `user_id`; `wallet_ledger`, `transactions` are append-only and partition-friendly.
5. **Caching** — Redis: session tokens, OTP attempts, wallet balances (with DB source-of-truth), group views.
6. **Multi-region DR** — active-standby per country; regulatory data residency.

### 3.2 Service boundaries (microservices at scale, monolith today)
| Domain | Service | Notes |
|---|---|---|
| Identity | auth-svc | OTP, JWT, KYC tiers, device mgmt |
| Ledger | ledger-svc | double-entry, wallet_ledger, escrow |
| Payments | payments-svc | AzamPay/MNO/SWIFT adapters, webhooks |
| Groups | group-svc | VICOBA + ROSCA + invitations |
| Marketplace | p2p-svc | projects, investors, secondary market |
| Agri | agri-svc | input financing, harvest cycles |
| Payments-Platform | connect-svc | Stripe-Connect-style connected accounts, splits |
| Comms | comms-svc | SMS (Beem), push, in-app, email |

### 3.3 Data model evolution
- `users` → profile + `kyc_docs`, `devices`, `addresses` (multi-currency later).
- `transactions` → append-only, hash-chained (tamper-evident ledger).
- `audit_logs` → all money events; immutable.
- Partition by month on `transactions`/`wallet_ledger` (Postgres declarative partitioning).
- Read replicas + materialized views for dashboards.

### 3.4 Trust & Credit
- **trust_score** (exists) feeds: contribution history (eRosca-style), repayment performance, KYC depth → generates **AFRIKOBA Credit Score (0–850)** used across P2P, VICOBA, Kilimo.

---

## 4. Phased Roadmap

### Phase 1 — Foundations (✅ mostly done)
- [x] Auth: OTP (Beem), PIN, password, KYC L1/L2
- [x] Wallet: deposit, transfer, withdraw, ledger, company revenue
- [x] VICOBA: groups, shares, multi-sig loans, maintenance fee
- [x] ROSCA: pools, join (KYC L2), schedules, automated payout (1% comm)
- [x] P2P: projects, 4-step audit, milestones, escrow, PDF contract, invest (KYC L2)
- [x] Split Engine (70/28/2), reconciliation, webhook security
- [x] Web dashboard (single-origin) + Admin panel

### Phase 2 — Access Control & Onboarding (🔄 in progress)
- [x] `user_service_subscriptions` (choose-your-services model)
- [ ] Service catalog + onboarding screen + lock/gating (backend ✅ frontend 🔨)
- [ ] VICOBA join codes + SMS invitations + accept flow
- [ ] Group invitations inbox (accept/reject)

### Phase 3 — Platform depth (world-class parity)
- [ ] VICOBA share-outs & dividend runs (ChamaPro)
- [ ] ROSCA auto-contribution scheduling + collections (eRosca)
- [ ] Trust → **AFRIKOBA Credit Score** dashboard
- [ ] Multi-currency wallets + FX (Revolut) — TZS, KES, UGX, USD
- [ ] Vaults/Spaces (targeted saving goals) (Monzo/Revolut)
- [ ] Budgeting & spending insights (Monzo)

### Phase 4 — Marketplace & Kiva-style
- [ ] P2P secondary market (LendingClub)
- [ ] Auto-invest rules (Prosper/LendingClub)
- [ ] Kiva-style lending circles & donor crowdfunding
- [ ] Connected merchant accounts + marketplace payouts (Stripe Connect)
- [ ] Disputes & chargeback toolkit (Stripe Connect)

### Phase 5 — Kilimo (Agri-Finance) (Farmdrive/Complete Farmer)
- [ ] Farm profiles, cycle-based repayment schedules
- [ ] Input financing (seeds/fertiliser) via supplier network
- [ ] Ofotake agreements backing loans
- [ ] Agronomist advisory + yield data

### Phase 6 — Scale engineering
- [ ] Event bus + outbox → queue workers
- [ ] Redis caching, read replicas, partition tables
- [ ] Multi-country deployment, regulatory licensing
- [ ] Mobile apps: Flutter (Android/iOS), USSD (MNO rails), feature-phone support

---

## 5. International-Standard Guardrails
- **Money movement**: every transfer = 1 transaction row + 2 ledger entries + audit row (done).
- **KYC gates**: ROSCA/P2P = L2; higher value / lending = L3 (documented identity) future.
- **Rate limiting & anti-fraud**: OTP attempt limits, per-IP limits, device binding (next phase).
- **Data protection**: encryption at rest (pgcrypto/TDE), secrets in env (not repo), least-privilege roles.
- **Audit**: `audit_logs` for privileged actions; immutable append-only.

---

## 6. Definition of "Done" for each feature
1. Backend endpoint with validation + RBAC/service gate.
2. Idempotent + transactional (rollback on failure).
3. SMS/notification where the user expects it.
4. Dashboard UI wired to it.
5. Test script proving the money math (fees, splits, ledgers).
6. Audit-log entry for money/privileged actions.
