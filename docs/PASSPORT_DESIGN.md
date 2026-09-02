# AFRIKOBA Financial Passport — Design

## 1. Vision

AFRIKOBA is moving from a financial *transaction platform* into a financial
*operating system* for individuals, families, groups, businesses and
communities. The anchor is a persistent, governed, portable financial identity —
the **AFRIKOBA Financial Passport** — built on top of the hardened double-entry
ledger (Phases 1–11).

The passport is **not** another opaque credit score. It is an explainable
financial profile and decisioning layer exposing:

```
                    FINANCIAL PASSPORT
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
     IDENTITY           BEHAVIOUR          CAPACITY
        │                  │                  │
      KYC/NIDA          Savings            Income
      Phone             Repayment          Cashflow
      Account           Contributions      Assets
      Verification      Consistency        Obligations
        │                  │                  │
        └──────────────────┼──────────────────┘
                           │
                    AFRIKOBA SCORE
                           │
              ┌────────────┼────────────┐
              │            │            │
             Credit       Risk        Trust
```

Example of the richness: a customer with TZS 150,000 in their wallet may carry
a passport that reads *"consistent savings for 18 months, TZS 50,000 monthly
VICOBA contributions, three on-time obligations, regular income, low risk, and
TZS 30,000 in committed obligations."*

## 2. Governance principles

We do **not** allow an opaque model to simply say "Score = 742, approve loan."
Instead every passport maintains:

| Dimension | Example value |
|---|---|
| Identity confidence | 98% |
| Repayment reliability | 91% |
| Savings consistency | 84% |
| Cash-flow stability | 79% |
| Group participation | 93% |
| Transaction risk | LOW |
| Current obligations | TZS X |
| Disposable capacity | TZS X |

Requirements met by the implementation:
- **Explainable** — every dimension carries a named band + human-readable reason.
- **Versioned / append-only** — each calculation inserts a new snapshot (migration
  036) preserving how and why a score changed (`triggers` column).
- **Ledger-consistent** — read-only; never mutates a balance or the journal, so it
  cannot disturb the reconciliation invariants (0-diff).
- **Deterministic** — the score is a pure function of stored data, not opaque ML.

## 3. Current implementation (Phase 12)

### Migration `036_financial_passport.sql`
Creates `financial_passports` (append-only, versioned per user, `is_current`
flag, a `BEFORE INSERT` trigger that demotes the previous current row and
promotes the new one). No ledger account is added, so the reconciliation matrix
is unchanged.

### `financialPassportService.js`
Computes and persists an explained passport:

- **Identity** (0–100): KYC level, phone verified, NIDA present, account age.
- **Behaviour** (0–100): savings consistency, repayment reliability, contribution
  consistency, group participation, transaction regularity, transaction risk
  (LOW/MEDIUM/HIGH from disputes, unresolved fraud alerts, reversals).
- **Capacity** (TZS): estimated monthly income, cash-flow, committed obligations
  (active micro-loans + debts + guarantees + VICOBA dues), disposable capacity.
- **AFRIKOBA Score** (0–850): weighted identity 30% / behaviour 45% / capacity
  25%, with a risk guardrail. Exposed as `calculatePassport()` and `getPassport()`.

### `financialAutopilotService.js`
Advisory planning layer: financial position (STABLE / WATCHING / AT_RISK),
recommended emergency reserve (N months of essentials, default 3), recommended
monthly savings (a target = % of disposable capacity), growth allocation,
obligations, discretionary capacity, and a target-achievement horizon.

Since Phase 13 the same service also **auto-executes** saving behind explicit
opt-in (`activatePlan` / `runAutopilotPayouts`), journaled through the engine —
see §4.1 below.

### `creditScoreService.js`
- **Bug fix:** the legacy `calculateScore` queried a non-existent `vicoba_loans`
  table (latent runtime failure). Rewritten against the real repayment sources
  (`micro_loans` + `vicoba_loan_schedules`).
- **Governed eligibility:** `checkEligibility` now uses the passport's explainable
  score + capacity. A product is eligible only when (a) score meets the product
  threshold AND (b) the estimated monthly repayment is `<= 50%` of disposable
  capacity. Rejection reasons are surfaced explicitly.

### `passportRoutes.js`
- `GET /passport` — current passport snapshot.
- `POST /passport/recalculate` — force a version bump / recalculation.
- `GET /passport/autopilot?target_amount=&emergency_months=` — financial plan.
- `POST /passport/autopilot/plans` — activate an auto-executed savings plan.
- `GET /passport/autopilot/plans` — list the user's plans.
- `PATCH /passport/autopilot/plans/:id` — set status (ACTIVE/PAUSED/COMPLETED).
- `DELETE /passport/autopilot/plans/:id` — remove a plan.

## 4. Follow-on roadmap

### 4.1 Financial Autopilot (auto-execution) — IMPLEMENTED (Phase 13)

The advisory plan is now **actionable behind explicit opt-in**, preserving ledger
invariants:

- **Migration `037_financial_autopilot.sql`** — `autopilot_plans` table storing the
  objective (`target_amount`), the **snapshotted monthly allocation** decided at
  activation (governance: it never silently changes), frequency, status, totals
  (`total_saved`, `skip_count`) and last-execution time.
- **`activatePlan()`** — derives the recommended monthly allocation from the
  current passport capacity and persists the opt-in. Returns the snapshot + the
  passport version it was based on.
- **`runAutopilotPayouts()`** (cron, daily in `runAll.js`) — for each `ACTIVE`
  monthly plan that is due:
  - **Affordability guard:** skips (never fails) if current passport disposable
    capacity has dropped below the allocation, or the wallet lacks funds.
  - **Idempotency:** journals `DR CUSTOMER_WALLET → CR SUSPENSE` through the
    engine with a **per-period** reference `AUTOPILOT:<plan>:<YYYYMM>`. A cron
    retry for the same month returns `dedup` and never double-moves money.
  - **Goal credit:** the allocation is added to the attached savings goal
    (completing it when it reaches target), `total_saved` is updated.
- Safety: every execution is a normal engine journaling, so the reconciliation
  matrix stays at 0-diff (verified run #12, 10/10).

### 4.1b Known limitation
`auditService.logAction()` writes to `audit_logs` which currently lacks the
`changes` column it references — the write fails safely (caught + logged as
`AUDIT_LOG_FAILURE`), so autopilot still runs, but audit rows are not persisted.
A dedicated hardening step should sync `auditService` to the real `audit_logs`
schema (Phase 8+ regression, pre-existing, affects many services that import the
non-existent `logAudit`).

### 4.2 AFRIKOBA Marketplace
Converge wallet / procurement / groups / finance around goods & services:
```
Need → discover → compare → finance → purchase → pay → insure → save → review
```
- Verified suppliers, AI-assisted price comparison, affordability checks via the
  passport, cash / credit / group financing, escrow-payment, delivery confirm,
  settlement, warranty/insurance.
- AFRIKOBA should not wait for suppliers to manually populate prices before
  helping the buyer establish a reasonable market price.

### 4.3 Long-term product shape
```
                         AFRIKOBA
       MONEY LAYER     INTELLIGENCE     MARKETPLACE
       Wallet          AI Passport      Goods / Services
       Payments        Risk             Procurement
       Settlement      Credit           Commerce
       Ledger          Forecasting
                            │
                     FINANCIAL OS
                            │
                 Individual / Family / Business
                            │
                       AFRIKOBA ID (Trust + Data + Governance)
```

## 5. Safety & correctness notes

- The **passport** is read-only over app projections; it never touches balances or
  the double-entry journal.
- The **autopilot plan-building** is read-only too; only the **opt-in auto-execution**
  (Phase 13) moves money, and it does so exclusively through `financialEngine`
  (`debitWallet`) with per-period idempotent references plus affordability/funds
  guards, keeping the ledger at 0-diff.
- Scoring is defensive: empty source tables yield valid explained passports
  (zero/neutral dims) rather than exceptions.
- Eligibility now carries reasons, giving AFRIKOBA a stronger governance stance.
- Autopilot auto-execution is **opt-in only** and **snapshots** the allocation at
  activation; it cannot silently change the amount or bypass affordability.
