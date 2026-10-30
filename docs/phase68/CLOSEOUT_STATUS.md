# Phase 68 — Closeout Status

Date: 2026-10-30
Branch: `phase68-deposit-atomicity-fix` (worktree `/tmp/afrikoba-phase68-deposit-fix`, HEAD `29ee21e`)
Status: **Phase 68 OPEN** — deposit atomicity and idempotency gaps are closed;
provider-dependent and owner-dependent items remain. Nothing committed, pushed,
merged, or deployed. Withdrawals/payouts remain **CLOSED**.

---

## 1. Finding register

| # | Finding | Severity | Status | Evidence / owner |
|---|---|---|---|---|
| S1 | Deposit callback trusted body status | High | **CLOSED (mitigated)** | `DEPOSIT_ATOMICITY.md`; 25/25 + 35/35 tests; auto-credit gated by `AZAMPAY_STATUS_CONTRACT_VERIFIED=false` |
| S2 | AzamPay status-query contract unverified | High | **BLOCKED (provider)** | `D1_PROVIDER_CONTRACT.md`; needs official contract + sandbox acceptance |
| S3 | Idempotency middleware race + cross-user cache | Medium | **CLOSED (fixed)** | `IDEMPOTENCY_HARDENING.md`; 10/10 tests |
| S4 | Webhook replay cache in-memory / optional header | Low | OPEN (accepted for now) | State machine already prevents double credit; multi-replica hardening pending |
| S5 | Public client IP / `trust proxy` topology unmapped | Medium | OPEN (owner/ops) | Needs host request-path mapping; no code change safe without topology |
| S6 | proxy-addr CVE-2026-90711 | Critical advisory | **CLOSED** | Not reachable with `trust proxy = 1`; installed tree 2.0.8 |
| S7 | web-dashboard dependency advisories (4) | Medium | OPEN (migration) | vite 8 / react-router-dom 7 major bumps need a migration review |
| S8 | CI DB credential exposed; production-derived data | High | OPEN (authorization) | Rotation/re-seed plan written, not executed |
| S9 | No four-eyes on self-service withdrawal | Owner decision | OPEN (owner) | Withdrawal stays closed; product/risk decision |
| S10 | Withdrawal authorization/controls | — | Present | `authRequired`, device trust, KYC, limits, freeze, fraud, idempotency |
| S11 | Audit logging on withdrawal/reconciliation | — | Present | `logAudit` + `reconciliation_exceptions` dedupe |
| S12 | Non-AzamPay money-path integrity sweep (increments 1–2) | High | **PARTIAL (increments 1–2 fixed)** | `MONEY_PATH_INTEGRITY.md`; 14/14 + 5/5 new tests; funding, SACCOS redemption, ledger coverage and `claimOperation` shape gaps closed |

---

## 2. What is safe to say now

- A forged, replayed, concurrent, mismatched or timed-out deposit callback
  cannot credit or cancel a deposit.
- A verified deposit credits exactly once with a balanced journal, one
  `wallet_ledger` row and one `financial_operations` row.
- Settlement failure rolls back every effect.
- Duplicate deposits with a damaged journal are rejected.
- Idempotency keys are user-scoped and concurrent duplicates execute once.
- The webhook secret comparison is constant-time and fails closed in production.
- Engine primitives credit/debit/transfer exactly once on a reference, roll
  back completely, and refuse insufficient funds without residue.
- Field-partner pool funding and BAP partner funding cannot double-fund on a
  replayed reference.
- SACCOS investment redemption cannot double-credit, including two concurrent
  redemptions and a `MATURED` investment.
- Every direct `wallet_ledger` writer is transaction-scoped and engine-backed,
  and a ledger row without a journal group is surfaced as `LEDGER_ORPHAN`.
- Reusing a reference with a different operation type, user or amount is
  rejected with `OPERATION_SHAPE_MISMATCH` by every engine primitive; the
  deposit path keeps its richer `DEPOSIT_IDEMPOTENCY_CONFLICT` handling.

## 3. What is not established

- The real AzamPay transaction-status response schema and live sandbox
  behaviour. This is why deposit auto-credit remains gated closed.
- The public request path and `trust proxy` topology.
- Production processing approval for payments whose verification is unverified.
- Four-eyes policy for self-service withdrawals (owner decision).

---

## 4. Phase 68 exit criteria still open

1. Official AzamPay transaction-status contract + sandbox acceptance test
   (S2 / D1). Until then `AZAMPAY_STATUS_CONTRACT_VERIFIED` stays `false`.
2. Topology confirmation for `req.ip` (S5).
3. Owner decision on four-eyes for withdrawals (S9) — withdrawal remains closed.
4. Authorization to rotate the CI DB credential and replace production-derived
   test data (S8).
5. Dependency migration plan for the dashboard (S7).

---

## 5. Next work that does not depend on AzamPay

Recommended order, each with its own deterministic tests:

1. **Money-path integrity sweep (S12)** — increments 1–2 are done
   (`MONEY_PATH_INTEGRITY.md`). Continue with:
   - service-level `claimOperation` shape validation opt-in (project finance,
     merchant payouts, network, SACCOS funds/credit);
   - P2P, VICOBA/ROSCA, loans/BNPL, escrow and project finance using the same
     replay / concurrent / rollback / insufficient-funds matrix.
2. **Reconciliation coverage** — prove every money path has a reconciler and an
   exception type; alert transport remains a separate owner item.
3. **Backup / restore / disaster recovery** — exercise the runbook on a scratch
   database and record exit codes.
4. **Production readiness review** — config, secrets, logging, rate limits,
   health checks, migration replay, dependency advisories.
5. **Webhook replay hardening (S4)** — only if multi-replica deployment is
   confirmed; otherwise keep the state-machine protection documented.

AzamPay stays on the waiting list. Withdrawals and payouts stay CLOSED until the
payout contract is verified and the owner authorises opening them.
