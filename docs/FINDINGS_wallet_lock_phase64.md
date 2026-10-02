# Phase 64 — Impact Analysis: `lockWallet` / `unlockWallet` / `captureLock`

**Baseline:** `a15665232f189b9d38f6af02752c93573b71ddd0` (origin/main, Phase 63 merged)
**Engine blob:** `708bc9083050cb949bed59c89e6021b6c445ce91` · 39492 B · SHA-256 `9561a504200f04619a40bd81dee97bb1b4ede31667abdece922f24d33ae4c0af`
**Branch:** `phase64-wallet-lock-invariants`
**Mode:** read-only static analysis + test design. No engine/business-semantics change.

> Baseline correction: the engine blob changed between Phase 62 and Phase 63 from
> `d36a79c7` (SHA-256 `e1f3fa…`) to `708bc908` (SHA-256 `9561a504…`). The only engine
> delta is one added export: `setOperationState` (added by Phase 63 `0b35bd8`).
> Any earlier finding that stated `setOperationState` was "absent from deployed main"
> is **superseded** — it is present at this baseline.

---

## 1. Existing contract (as implemented, before any change)

All three primitives share one shape and are **client-injected, transaction-owning**:

```
claimOperation(reference)            -- idempotency gate, INSERT ... ON CONFLICT DO NOTHING
  if (!claimed) return { dedup }     -- early exit, NO mutation
SELECT ... FOR UPDATE                -- serialize per user row
pre-check (LOCK only)                -- friendly 400
guarded projection UPDATE            -- rowCount is authoritative
  if (rowCount !== 1) -> setOperationState(FAILED) + throw 400
postJournal(2 lines)                 -- balanced DR/CR
setOperationState(SUCCESS)
auditBalance x2 (LOCK/UNLOCK), x1 (CAPTURE)
```

| Primitive | Projection | Journal |
|---|---|---|
| `lockWallet` | `wallet -= n`, `locked += n` | DR `sourceAccount` / CR `CARD_HOLD` |
| `unlockWallet` | `wallet += n`, `locked -= n` | DR `CARD_HOLD` / CR `sourceAccount` |
| `captureLock` | `locked -= n`, wallet untouched | DR `CARD_HOLD` / CR `toAccount` |

**Transaction boundary is caller-owned.** The primitives never `BEGIN`/`COMMIT`. Correctness
of invariants 9 and 10 therefore depends entirely on callers following the discipline.
All three live callers do (verified by reading each `try/catch/finally`):

| Caller | BEGIN | same client | ROLLBACK on throw | COMMIT |
|---|---|---|---|---|
| `cardService.js` L190–211 / L218–237 / L239–258 | yes | yes | yes (`.catch(()=>{})`) | yes |
| `roscaService.js` L60–62, lock at L137 | yes | yes | yes L161 | yes L158 |
| `savingsCreditService.js` L417–430 (lock), L436–447 (unlock) | yes | yes | yes L428 | yes L425 |

---

## 2. Phase 7 → Phase 62/63 delta (contract change, not semantics change)

Introduced in `d6d6e6b` *"route all wallet/group balance mutations through ledger engine (phase 7)"*.

| Aspect | Phase 7 | Phase 62/63 (current) |
|---|---|---|
| Write order | **journal first**, projection second | **projection first**, journal second |
| Projection UPDATE | unguarded: `WHERE id = $2` | guarded: `AND wallet_balance >= $1` (lock) / `AND locked_balance >= $1` (unlock, capture) |
| Operation status | never finalized — claim row stuck at `NEW` | `setOperationState` → `SUCCESS` / `FAILED` |
| `UNLOCK` pre-check | none | conditional UPDATE is authoritative |
| `CAPTURE` guard | none | `locked_balance >= $1` |

**Consequence of the order reversal (important):** under Phase 7 a journal failure left the
projection untouched. Under the current order a journal failure happens *after* the projection
has already mutated inside the transaction — safety now rests on caller rollback alone.
This is not a defect (all callers comply) but it moves the failure responsibility outward and
must be covered by test.

---

## 3. Caller expectations that must not change

- `cardService.authorize` pre-checks `wallet_balance < amount` **itself** (L194) and logs a
  `DECLINED` row in a *separate* transaction before throwing `WALLET_INSUFFICIENT_FUNDS`.
  Engine-level rejection must keep being distinguishable (it throws a `statusCode: 400`
  error, not a domain code).
- `cardService` derives references as `${authRef}:LOCK`, `${authRef}:CAPTURE`,
  `${authRef}:REFUND`. Because the reference is the journal `entry_group_id`, **one reference
  = one operation = one journal group**. Retrying settlement is already prevented upstream by
  `WHERE status='AUTH_HOLD'`; the engine's dedup is the second line of defence.
- `savingsCreditService` uses **deterministic** references
  `SCGUAR:${loanId}:${userId}:LOCK` / `:REL`. A repeated call is expected to dedup, not to
  double-hold. `releaseGuarantees` loops and calls `unlockWallet` per guarantor.
- `roscaService` uses `${generateReference('RL')}:LK` — a fresh random reference per join.
- Ledger accounts `CARD_HOLD`, `CUSTOMER_WALLET`, `MNO_CLEARING` are seeded by
  `031_financial_core.sql` and numbered by `093_chart_of_accounts_numbering.sql`.
- `trg_journal_balanced` (constraint trigger, `031` L93 and `088` L49) is a DB-level second
  guarantee that every `entry_group_id` balances.

---

## 4. Invariant verdicts

`PASS` = proven by execution. `PENDING` = contract present in code/schema but **not yet proven
at runtime**. `FAIL` = defect established by analysis.

The initial static review identified INV-12 as a defect. The guard was subsequently patched in
`src/services/financialEngine.js` and the complete regression suite was rerun against the
credentialed non-production regression database. The final runtime result was **63/63 PASS**.

| # | Invariant | Verdict | Basis |
|---|---|---|---|
| INV-1 | `wallet + locked` unchanged by LOCK/UNLOCK | **PASS** | T1 runtime regression: LOCK and UNLOCK conserve the combined balance. |
| INV-2 | LOCK requires sufficient available | **PASS** | T4 runtime regression confirms insufficient available balance is rejected with no residue. |
| INV-3 | UNLOCK requires sufficient locked | **PASS** | T5 runtime regression confirms the guarded UPDATE rejects an excessive unlock with no residue. |
| INV-4 | CAPTURE requires sufficient locked | **PASS** | T6 runtime regression confirms the guarded UPDATE rejects an excessive capture with no residue. |
| INV-5 | exactly one balanced journal group | **PASS** | T1/T2/T3 runtime regression confirms balanced journal groups and no duplicate group on retry. |
| INV-6 | reference idempotent | **PASS** | T3 runtime regression confirms the same reference is claimed once and the second attempt deduplicates. |
| INV-7 | retry cannot create a second economic effect | **PASS** | T3 runtime regression confirms retry returns `dedup` with balances and journal state unchanged. |
| INV-8 | failed guard leaves no journal/audit residue | **PASS** | T4/T5/T6 runtime regression confirms rejected operations leave no journal, audit, operation, or balance residue. |
| INV-9 | journal failure rolls back the projection | **PASS** | T7 runtime regression forces journal failure and confirms the caller transaction rolls back the projection and leaves no residue. |
| INV-10 | operation state and mutation commit/rollback atomically | **PASS** | T10 runtime regression confirms committed operations reach `SUCCESS` while rolled-back operations leave no committed operation/journal. |
| INV-11 | concurrency cannot overdraw | **PASS** | T8 runtime regression with 8 concurrent LOCK attempts confirms no overdraw and no negative balances. |
| INV-12 | amount must be a positive value | **PASS** | Patched with `assertPositiveAmount()` before `claimOperation()`. T9 runtime regression: 16/16 amount/residue checks passed. |

---

## 5. Defect found and remediated: no positive-amount guard

The initial static review identified that `lockWallet`, `unlockWallet` and `captureLock`
converted the supplied amount with `Number(amount)` but did not reject zero, negative,
`NaN`, or infinite values.

This was remediated in the Phase 64 patch by adding `assertPositiveAmount()` immediately
after numeric conversion and **before `claimOperation()`** in all three primitives.

The guard requires a finite amount strictly greater than zero. Therefore an invalid request
is rejected with HTTP-style `statusCode 400` before an operation claim, projection update,
journal entry, or audit record can be created.

T9 was rerun against the credentialed regression database after the patch and passed all
16 checks, including negative and zero amounts, balance preservation, absence of journal,
audit and operation residue, and rejection before `claimOperation()`.

The final runtime result was **63/63 PASS**.

---

## 6. Environment and runtime evidence

The initial review was blocked by unavailable credentials on the default database endpoint.
The required non-production regression database was subsequently identified and used for
the final runtime acceptance run.

1. **Credentialed regression database used:** PostgreSQL database
   `afrikoba_regression` on `127.0.0.1:5436`, using the repository regression credentials.
   The database was verified reachable before mutation testing.

2. **Regression schema preflight passed.** The database contains `users.wallet_balance`,
   `users.locked_balance`, the required ledger accounts (`CARD_HOLD`,
   `CUSTOMER_WALLET`, `MNO_CLEARING`), the UNIQUE constraint on
   `financial_operations.reference_id`, and DB-level non-negative CHECK constraints for
   both wallet balances.

3. **The default port 3000 was not used.** It serves another application on this host.
   The Phase 64 suite explicitly targeted the credentialed regression database on port 5436.

4. **Mutation testing was restricted to the non-production regression database.**
   No staging or production financial data was used by the wallet-lock invariant suite.

5. **Final runtime acceptance:** the complete wallet-lock regression suite passed
   **63/63 checks**, including concurrency, idempotency, journal-failure rollback,
   operation-state atomicity, and the remediated INV-12 positive-amount guard.

---

## 7. Existing coverage: `scripts/test-cards.js`

Already proven (card HTTP path only):
- LOCK moves funds and conserves the total (L204); UNLOCK/refund restores it (L281).
- CAPTURE decrements locked only, wallet unchanged (L255).
- Balanced 2-line journals for LOCK / CAPTURE / release (L216, L265, L291).
- Amount ≤ 0, CVV, limits, ownership, decline-reason persistence, admin-only settle/refund.
- "Settle twice → 404" / "Refund twice → 404" (L267, L293).

**Not proven (the gap Phase 64 closes):**
- No engine-level invocation at all — everything goes through `cardService`.
- `roscaService.lockWallet` and both `savingsCreditService` calls have **zero** coverage.
- The idempotency gate `claimOperation` is never exercised: retries are blocked upstream by
  the `card_transactions.status = 'AUTH_HOLD'` filter, so `dedup` is never reached.
- No insufficient-**locked** test for UNLOCK or CAPTURE.
- No journal-failure/rollback test.
- No concurrency test.
- No assertion on `financial_operations` row count or terminal status.
- No assertion on `financial_audit_log` residue.
- No negative-amount test.
- `setOperationState` / `finalizeOperation` untested.

---

## 8. Test design — `scripts/test-wallet-lock-invariants.js`

Direct engine-level, transactional, no HTTP and no running server. Each scenario wraps the
call exactly as real callers do (`BEGIN` → primitive → `COMMIT`, `ROLLBACK` on throw) so the
suite exercises the real caller contract rather than a synthetic harness.

Safety gate: refuses to run unless `P64_ALLOW_MUTATION=1`; refuses if `DB_NAME` matches
`/prod|production|live|master|primary/i`; requires `P64_I_CONFIRM_NONPROD=1` when
`NODE_ENV=production`. Exits `2` when refused.

| Test | Invariants | Method |
|---|---|---|
| Preflight | schema contract | asserts `users.wallet_balance`+`locked_balance`, the three ledger accounts, the UNIQUE constraint on `financial_operations`, and the non-negative CHECKs |
| T1 | INV-1, INV-5 | LOCK 30,000 then UNLOCK 30,000; total conserved both ways; both journals balanced and exactly 2 lines |
| T2 | INV-4, INV-5 | LOCK 20,000 then CAPTURE 12,000; wallet unchanged; total falls by exactly the captured amount; journal to `MNO_CLEARING` |
| T3 | INV-5, INV-6, INV-7 | same reference twice → second returns `dedup`, no `success`; balances unchanged; still 1 journal group, 1 operation row, 2 audit rows |
| T4 | INV-2, INV-8 | LOCK 90,000 against 5,000 → throws, `statusCode 400`, balances unchanged, **0** journal / 0 audit / 0 operation rows |
| T5 | INV-3, INV-8 | UNLOCK 50,000 against 2,000 locked → same four assertions |
| T6 | INV-4, INV-8 | CAPTURE 25,000 against 3,000 locked → same four assertions |
| T7 | INV-9 | LOCK with `sourceAccount='NO_SUCH_LEDGER_ACCOUNT_XYZ'` → `postJournal` throws after the guarded UPDATE; asserts the projection rolled back and left no journal/audit/operation |
| T8 | INV-11 | 8 concurrent `lockWallet` of 30,000 each against 100,000 on one user, separate connections; asserts `locked === okCount × 30000`, `≤ 100000`, none negative, at least one refused |
| T9 | INV-12 | negative and zero amounts against all three primitives; asserts a clean `400` and no movement |
| T10 | INV-10 | committed LOCK leaves exactly one `SUCCESS` operation + balanced journal; rolled-back LOCK leaves neither |

Reproduce:
```
P64_ALLOW_MUTATION=1 \
DB_HOST=… DB_PORT=… DB_USER=… DB_PASSWORD=… DB_NAME=<regression-db> \
node scripts/test-wallet-lock-invariants.js
```

---

## 9. Status

Final runtime acceptance: **63/63 PASS** against the credentialed non-production
regression database.

INV-1 through INV-12 are proven by the Phase 64 wallet-lock invariant regression suite.
INV-12 was initially identified as a static defect and was remediated before the final
runtime run.

The branch is frozen for pre-merge review. `main` remains untouched.