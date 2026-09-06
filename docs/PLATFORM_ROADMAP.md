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
| **eRosca / Moneyfellows** | Automated ROSCA collections + payout cycles; credit score from contribution history | Upatu (ROSCA) Engine | ✅ Auto-contribution + **trust_score from history** done (migration 042): on-time +/- missed scoring, per-member reliability, member trust history |
| **ChamaPro / Mwanga** | Full chama accounting: contributions, loans, dividends/share-outs, member reports | VICOBA (Group Savings & Loans) | ✅ Built (multi-sig loans) + **share-outs/dividend runs** (calculate → approve → disburse per-share dividends, member payouts) |
| **Tandem / Jamii** | Low-cost financial inclusion, microsavings, light KYC tiers | Light KYC onboarding + micro-vaults | 🔨 Onboarding (choose services) in progress |
| **Kiva** | Global P2P crowdfunded microloans, field partners, transparent repayment | P2P Investment + **Donor/Crowdfunding Loans** | P2P ✅ built → **next**: Kiva-style lending circles + field partner API |
| **Farmdrive / Complete Farmer** | Agri-financing tied to farm cycle; input financing; offtake-backed repayment | **Kilimo (Agri-Finance)** module | 🆕 Planned: input loans, harvest-cycle repayment, agronomist network |
| **LendingClub / Prosper** | Risk grades, fractional investing, automated matching, secondary market | P2P Investment | ✅ risk grading + fractional shares → **next**: secondary market, auto-invest |
| **Revolut / Monzo** | Multi-currency wallets, vaults/spaces, instant P2P, budgeting, cards | Digital Banking module | ✅ Multi-currency wallets + FX done (TZS + KES/UGX/USD/EUR/GBP/RWF/GHS/NGN ...): live rates (direct/inverse/triangulated), ledgered conversions, display currency |
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
- [x] VICOBA join codes + SMS invitations + accept flow — done: `vicoba_groups.join_code`, join-by-code, `inviteMembers` SMS, `/invitations/:id/accept|reject`, mobile invite inbox
- [x] Group invitations inbox (accept/reject) — done: `VicobaScreen.dart` invite inbox + CI stage

### Phase 3 — Platform depth (world-class parity)
- [x] VICOBA share-outs & dividend runs (ChamaPro) — done: calculate → approve per-share dividends, member payouts
- [x] ROSCA auto-contribution scheduling + trust_score from history (eRosca) — done: migration 042, on-time/missed scoring
- [x] Trust → **AFRIKOBA Credit Score** dashboard — done: 0-850 gauge, pillars, capacity, explained dimensions
- [x] Multi-currency wallets + FX (Revolut) — TZS, KES, UGX, USD, EUR, GBP ... — done: dynamic currencies, live FX, holdings portfolio
- [x] Vaults/Spaces (targeted saving goals) (Monzo/Revolut) — done: `/api/vaults` (goals + deposits/withdraws + fixed deposits + summary), `scripts/test-vault.js` wired into CI, mobile `VaultScreen.dart`
- [x] Budgeting & spending insights (Monzo) — done: per-category monthly budgets, spend vs budget progress, over-budget alerts, savings-rate (migration 043, /api/budget)

### Phase 4 — Marketplace & Kiva-style
- [x] P2P secondary market (LendingClub) — done: `p2p_secondary_listings` + buy flow + auto-invest rules
- [x] Auto-invest rules (Prosper/LendingClub) — done: `/api/secondary/auto-invest`
- [x] Kiva-style lending circles & donor crowdfunding — done: `lending_circles` + `crowdfund_campaigns`
- [x] Connected merchant accounts + marketplace payouts (Stripe Connect) — done: migration 085, `/api/merchant/connected` + `/payouts` + admin execute, dashboard + mobile parity
- [x] Disputes & chargeback toolkit (Stripe Connect) — done: `disputeService.js`

### Phase 5 — Kilimo (Agri-Finance) (Farmdrive/Complete Farmer)
- [x] Farm profiles, cycle-based repayment schedules — done: `farm_profiles`, `agri_loans`
- [x] Input financing (seeds/fertiliser) via supplier network — done: `agri_input_suppliers` + `applyAgriLoan`
- [x] Ofotake agreements backing loans — done: `agri_offtake_agreements`
- [x] Farm seasons + harvest/yield tracking — done: migration 086 `farm_seasons`, `completeHarvest` yield roll-up
- [x] Agronomist advisory + yield data — done: migration 086 `agri_advisories`, issue/action lifecycle

### Phase 6 — Scale engineering
- [x] Event bus + outbox → queue workers — done: migration 087 transaction-aware outbox, SKIP LOCKED dispatcher, backoff + dead-letter, `/api/outbox`
- [x] Redis caching, read replicas, partition tables — done: caching + replicas as above; **partition tables** done (migration 088): `journal_entries` + `audit_logs` → monthly declarative RANGE partitions, `partitionService.js` (ensure/create/list/archive DETACH), boot + cron provisioning, `GET /api/ops/partitions`, `scripts/test-partitions.js` in CI; remaining scale: multi-country deployment, regulatory licensing
- [ ] Multi-country deployment, regulatory licensing
- [x] Mobile apps: Flutter (Android/iOS) — done: `mobile/` merchant parity added on home drawer; USSD (MNO rails) + feature-phone support still next

---

## 5. International-Standard Guardrails
- **Money movement**: every transfer = 1 transaction row + 2 ledger entries + audit row (done).
- **KYC gates**: ROSCA/P2P = L2; higher value / lending = L3 (documented identity) — done: `enforceHighValueKyc` on all borrow paths (≥ 1,000,000 TZS → L3, env-configurable).
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
