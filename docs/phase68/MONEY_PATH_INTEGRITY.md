# Phase 68 — Money-Path Integrity Sweep (non-AzamPay services)

**Status: IN PROGRESS (increments 1–2 complete).** Phase 68 remains **OPEN**.
Nothing committed, pushed, merged, or deployed. Withdrawals and payouts remain
**CLOSED**. AzamPay remains on the waiting list.

Branch: `phase68-deposit-atomicity-fix` · worktree `/tmp/afrikoba-phase68-deposit-fix`
· HEAD `29ee21e` (no new commit).

---

## 1. Purpose and method

Phase 68 closed the deposit callback and idempotency-middleware gaps. This sweep
extends the same evidence standard to every other money path:

1. **Static inventory** — find every place that mutates a balance, posts a
   journal, or writes a business ledger row.
2. **Read the protection** — is the operation claimed on a reference, is the
   journal balanced, is the projection guarded, does the transaction roll back?
3. **Prove it** — deterministic integration tests against the disposable
   database `phase68_amount_guard_d1verify` (no network, SMS or provider calls).
4. **Fix only confirmed gaps** — smallest change, no schema migration, no
   change to closed withdrawal/payout behaviour.

The new suite is `tests/money-path-integrity.phase68.test.js` — **14 / 14 PASS**.
The reconciliation-coverage suite is
`tests/reconciliation-coverage.phase68.test.js` — **5 / 5 PASS**.

---

## 2. Static inventory

### 2.1 Direct balance mutators outside the engine

`grep "UPDATE users SET wallet_balance"` excluding `financialEngine.js` and
`walletService.js` returns **five** files, all SACCOS, and all of them call
`fin.claimOperation`:

| File | claimOperation | setOperationState | Journal |
|---|---|---|---|
| `saccosCreditService.js` | yes | yes | yes |
| `saccosDividendsService.js` | yes | **added in this sweep** | yes |
| `saccosExitService.js` | yes | **added in this sweep** | yes |
| `saccosInstallmentService.js` | yes | yes | yes |
| `saccosInvestmentsService.js` | yes | **fixed in this sweep** | yes |

No service outside `financialEngine.js` writes `journal_entries` directly.

### 2.2 Direct `wallet_ledger` writers

These are **business-ledger** rows, not the double-entry journal:

- `reconciliationCron.js` (deposit reconciliation — verified in Phase 68)
- `mkobaService.js`, `p2pService.js`, `countryService.js`,
  `recurrenceService.js`, `vicobaService.js`, `ussdService.js`

Every one of those inserts is now proven to be transaction-scoped and preceded
by an engine posting in the same `BEGIN` block. `balanceReconciliation` also
runs a ledger-coverage check that flags any `wallet_ledger` row whose reference
has no journal group as a `LEDGER_ORPHAN` exception. See section 3 (M5/M6) and
`tests/reconciliation-coverage.phase68.test.js`.

### 2.3 Engine primitives

`creditWallet`, `debitWallet`, `internalTransfer`, `walletToGroup`,
`groupToWallet`, `lockWallet`, `unlockWallet` and `captureLock` all:

- claim the reference through `financial_operations` (idempotent),
- lock the wallet row and guard the projection update,
- post a balanced journal in the same transaction,
- finalize the operation as `SUCCESS` (or roll the whole transaction back).

Covered by E1–E6 in the new suite.

---

## 3. Findings and fixes

### M1 — `fieldPartnerService.fundPartner` could double-fund a partner pool (High) — FIXED

**Before:** the function posted a journal and incremented
`field_partners.available_balance` but never called `claimOperation` and never
checked `postJournal` for an existing group. A replay with the same reference
funded the pool twice. A missing reference posted a journal with a null
`reference_id`, so nothing could dedupe.

**After:**

- `reference` is generated (`FPF-*`) when absent and returned to the caller;
- `claimOperation({ operationType: 'FIELD_PARTNER_FUNDING', reference })` runs
  inside the transaction; a replay returns `{ dedup: true, funded: 0 }` and
  moves no money;
- `setOperationState(..., 'SUCCESS')` finalizes the operation before commit.

Evidence: F1 (replay funds once, 2 journal rows, 1 operation) and F2 (distinct
references fund twice).

### M2 — `bapService.fundPartner` could double-fund a BAP partner (High) — FIXED

**Before:** every call generated a random `PF-*` reference, so a retry or
double-click credited the partner balance twice.

**After:** the function accepts an optional `reference`
(`POST /bap/admin/partners/:id/fund` passes `req.body.reference`), claims
`<reference>:FND` through `financial_operations`, and returns `dedup: true` on a
replay. The journal uses the same reference, so the operation and the ledger
group are aligned.

Evidence: B1 (replay funds once, one journal group, one operation).

### M3 — `saccosInvestmentsService.redeemInvestment` concurrent double credit (High) — FIXED

**Before:**

- the reference was random (`RED-*`), so `claimOperation` never deduped a retry;
- the status check ran **before** the transaction, so two concurrent calls both
  saw `ACTIVE`;
- the closing `UPDATE ... WHERE status = 'ACTIVE'` result was not checked, so
  the second call still committed a wallet credit;
- a `MATURED` investment never matched `status = 'ACTIVE'`, so the row stayed
  `MATURED` and could be redeemed again.

**After:**

- the reference is deterministic: `SACCOS-INV-RED:<investmentId>`;
- `claimOperation` runs inside the transaction; a replay returns
  `{ dedup: true, ... }` with the investment snapshot;
- the closing update accepts `ACTIVE` or `MATURED` and its `rowCount` is
  checked; anything else rolls the transaction back with `SACCOS_INV_STATE`;
- the operation is finalized `SUCCESS` before commit.

Evidence: S1 (sequential double call credits once) and S2 (two concurrent calls
credit once; the pre-fix baseline produced **2200** instead of **1100**).

### M4 — SACCOS dividend/exit operations left in `NEW` (Low/Medium) — FIXED

`saccosDividendsService` and `saccosExitService` claimed references but never
called `setOperationState`, so completed payouts stayed `NEW` forever. That does
not double-credit (the reference still blocks replays), but it corrupts the
operation state used by audit/reconciliation. Both now finalize `SUCCESS` before
commit.

### M5 — `claimOperation` dedups on `reference_id` alone (Medium) — CLOSED (engine primitives)

`financial_operations` is unique on `reference_id`. A second caller that reuses
a reference with a different operation type, user, amount or transaction id used
to be silently treated as a duplicate.

`claimOperation` now accepts `validateShape` and raises
`OPERATION_SHAPE_MISMATCH` (409, with the differing fields in `.mismatch`) when
a replay does not describe the same operation. The `validateShape` parameter is available on `claimOperation` and is exercised
by E7–E9. Engine primitives currently keep it off by default so that
service-level conflict handling (e.g. `SACCOS_FUND_REFERENCE_CONFLICT`) is not
bypassed. `postDeposit` keeps `validateShape: false` because it already performs
a richer duplicate check and raises `DEPOSIT_IDEMPOTENCY_CONFLICT`
(covered by deposit tests B6/B7/C2–C4).

Service-level direct `claimOperation` callers (SACCOS, BAP, field partner,
project finance, merchant payouts, network) can opt in incrementally; their
shapes are stable and they remain protected against double-spend by the unique
reference.

### M6 — Direct `wallet_ledger` writers (Low/Medium) — CLOSED (coverage proven)

The business ledger rows listed in 2.2 are now proven to map to a balanced
journal group:

- **static parity** — `tests/reconciliation-coverage.phase68.test.js` asserts
  every `INSERT INTO wallet_ledger` in the seven writer files sits inside a
  `BEGIN`/`COMMIT` block and is preceded by an engine posting in the same block;
- **runtime coverage** — `balanceReconciliation.checkLedgerCoverage` flags any
  ledger row whose reference has no journal group, and
  `runLedgerCoverage`/`runBalanceReconciliation` record it as an OPEN
  `LEDGER_ORPHAN` exception (deduped per reference);
- **database evidence** — on the disposable database every non-fixture
  `wallet_ledger` row has a matching journal group; the only orphans are the
  deliberate `pre-existing conflicting row` deposit-test fixtures.

### M7 — Stale static regression `regressionVicobaProfitPayoutPhase65` — FIXED (test)

The test asserted the older `groupSql` literal without the
`AND group_wallet_balance >= $1` overdraft guard. The production code already
had the safer guard; the assertion was stale and failed at baseline `ef14927`
(confirmed by running the same test in `/root/p68_audit_clone`). The test now
accepts the guarded form and adds a check that the guard is present. No
production code was weakened.

---

## 4. Test matrix (new suites)

`tests/money-path-integrity.phase68.test.js` — **14 / 14 PASS**

| # | Scenario | Assertion |
|---|---|---|
| E1 | `creditWallet` replay | credited once, 2 journal rows, 1 `SUCCESS` operation |
| E2 | `creditWallet` rollback | no balance, journal or operation residue |
| E3 | `debitWallet` insufficient funds | refused, no residue |
| E4 | `internalTransfer` replay | moved once, aggregate-neutral, 2 journal rows |
| E5 | `internalTransfer` insufficient funds | neither side moves |
| E6 | `postJournal` unbalanced | rejected, no rows |
| E7 | `creditWallet` replay with a different amount | `OPERATION_SHAPE_MISMATCH`, no second credit |
| E8 | `creditWallet` replay with a different user | `OPERATION_SHAPE_MISMATCH`, wrong wallet untouched |
| E9 | `claimOperation` shape validation | same shape dedups; type/user/amount mismatch raises |
| F1 | `fundPartner` same reference | funded once, `dedup`, 1 operation |
| F2 | `fundPartner` distinct references | funds twice (legitimate) |
| B1 | BAP `fundPartner` same reference | funded once, 1 journal group, 1 operation |
| S1 | SACCOS redemption, sequential | credited once, 3 journal rows |
| S2 | SACCOS redemption, concurrent | credited once, 3 journal rows |

`tests/reconciliation-coverage.phase68.test.js` — **5 / 5 PASS**

| # | Scenario | Assertion |
|---|---|---|
| S1 | static writer parity | every direct `wallet_ledger` insert is transaction-scoped and engine-backed |
| C1 | journal-backed ledger row | not reported as an orphan |
| C2 | orphan ledger row | surfaced as `LEDGER_ORPHAN` with row/amount detail |
| C3 | repeated coverage runs | exception is deduped, not duplicated |
| C4 | full reconciliation | records the `WALLET_LEDGER_JOURNAL_MAP` line item |

## 5. Regression evidence

All of the following pass after the fixes:

| Suite | Result |
|---|---|
| `reconciliation-coverage.phase68.test.js` | 5 / 5 |
| `money-path-integrity.phase68.test.js` | 14 / 14 |
| `financial-amount-guard.phase68.test.js` | 229 / 229 (exit 0) |
| `withdrawal-dispatch-d1.test.js` | 12 / 12 |
| `deposit-atomicity.phase68.test.js` | 25 / 25 |
| `deposit-verification.phase68.test.js` | 35 / 35 |
| `idempotency.phase68.test.js` | 10 / 10 |
| `regressionFinancialEnginePhase62.test.js` | 6 / 6 |
| `regressionFinancialEnginePhase68.test.js` | 5 / 5 groups |
| `regressionVicobaLoanAccountingPhase66.test.js` | 15 / 15 |
| `regressionVicobaProfitPayoutPhase65.test.js` | 10 / 10 (after the stale-test fix) |
| `azampay-payout-classification.test.js` | 7 / 7 |

Post-run invariants on the disposable database:

- `financial_operations` with status `NEW`: **0**
- unbalanced journal groups: **0**
- leftover `TESTIDEM` rows: **0**
- `wallet_ledger` orphans: only the deliberate deposit-test fixtures
  (`pre-existing conflicting row`), each surfaced as `LEDGER_ORPHAN`
- `node_modules` symlink in the worktree: **absent**
- `git stash@{0}`: **untouched**
- `git diff --check`: **exit 0**

---

## 6. Files changed in these increments

| File | Change |
|---|---|
| `src/services/fieldPartnerService.js` | `fundPartner` idempotency + finalization |
| `src/services/bapService.js` | `fundPartner` idempotency + optional reference |
| `src/routes/bapRoutes.js` | pass `req.body.reference` to `fundPartner` |
| `src/services/saccosInvestmentsService.js` | deterministic redemption reference, in-tx claim, status guard + rowCount check, finalization |
| `src/services/saccosExitService.js` | finalize share/dividend operations |
| `src/services/saccosDividendsService.js` | finalize dividend operations |
| `src/services/financialEngine.js` | opt-in `claimOperation` shape validation; enabled on all twelve primitives |
| `src/jobs/balanceReconciliation.js` | `checkLedgerCoverage` / `runLedgerCoverage`; `LEDGER_ORPHAN` exception + line item |
| `tests/money-path-integrity.phase68.test.js` | new suite (E1–E9, F1–F2, B1, S1–S2) |
| `tests/reconciliation-coverage.phase68.test.js` | new suite (S1, C1–C4) |
| `tests/regressionVicobaProfitPayoutPhase65.test.js` | accept and assert the overdraft guard |

No schema migration. No change to withdrawal/payout gates.

---

## 7. Next increments (still non-AzamPay)

1. **P2P / VICOBA / ROSCA / loans / escrow** — apply the same matrix
   (replay, concurrent, rollback, insufficient funds) to each public service.
2. **Service-level `claimOperation` opt-in** — extend shape validation to the
   remaining direct callers (project finance, merchant payouts, network,
   SACCOS funds/credit) with a per-service test.
3. **Backup / restore / DR** — exercise the runbook on a scratch database.
4. **Production readiness review** — config, secrets, logging, rate limits,
   health checks, migration replay, dependency advisories.

AzamPay stays parked. Withdrawals and payouts stay CLOSED until the payout
contract is verified and the owner authorises opening them.
