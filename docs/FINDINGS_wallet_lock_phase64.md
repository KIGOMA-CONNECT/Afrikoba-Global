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
at runtime** (no credentialed regression DB available — see §6). `FAIL` = defect established
by analysis.

| # | Invariant | Verdict | Basis |
|---|---|---|---|
| INV-1 | `wallet + locked` unchanged by LOCK/UNLOCK | **PENDING** | Arithmetic holds in all three UPDATEs; `test-cards.js` L204/L281 asserts it for the card path only. `scripts/test-wallet-lock-invariants.js` T1 proves it at engine level. |
| INV-2 | LOCK requires sufficient available | **PENDING** | Pre-check L784 **and** guard L791 + rowCount. Note: exercised by `test-cards.js` only through the *caller's* pre-check, not the engine guard. T4/T9. |
| INV-3 | UNLOCK requires sufficient locked | **PENDING** | Guard L831 + rowCount. **Untested today.** T5. |
| INV-4 | CAPTURE requires sufficient locked | **PENDING** | Guard L870 + rowCount. **Untested today.** T6. |
| INV-5 | exactly one balanced journal group | **PENDING** | `postJournal` rejects DR≠CR (L128); `entry_group_id = referenceId` (L122). `test-cards.js` asserts balance for the card path; does not assert *group count* under retry. T1/T2/T3. |
| INV-6 | reference idempotent | **PENDING** | `uq_financial_operation_ref UNIQUE (reference_id)` **verified present** in DDL, so `ON CONFLICT (reference_id)` is effective. T3. |
| INV-7 | retry cannot create a second economic effect | **PENDING** | Dedup returns before any mutation. `test-cards.js` "settle twice → 404" tests the *card_transactions state machine*, **not** `claimOperation`. T3. |
| INV-8 | failed guard leaves no journal/audit residue | **PENDING** | Guard precedes journal, so no journal can exist; `setOperationState(FAILED)` + throw relies on caller rollback. T4/T5/T6. |
| INV-9 | journal failure rolls back the projection | **PENDING** | Ordering means the projection *is* mutated when `postJournal` throws; safety is caller-rollback-dependent. All 3 callers comply. T7 forces failure via an unknown account code. |
| INV-10 | operation state and mutation commit/rollback atomically | **PENDING** | `setOperationState` runs on the same client (L808/L849/L887) with `AND status='NEW'`. Never exercised by any existing test. T10. |
| INV-11 | concurrency cannot overdraw | **PENDING** | `SELECT … FOR UPDATE` (L780/L823/L864) **plus** conditional UPDATE. Structurally sound but unproven. T8 (8 × 30,000 against 100,000). |
| INV-12 | amount must be a positive value | **FAIL (by analysis)** | See §5 — no guard exists. T9 probes it. |

---

## 5. Defect found: no positive-amount guard

`lockWallet`, `unlockWallet` and `captureLock` all do `const amountN = Number(amount)` and
**never validate the sign**.

For `lockWallet({ amount: -1000 })`:
1. pre-check `availBefore < -1000` → false, passes;
2. guard `wallet_balance >= -1000` → true, so `rowCount === 1`;
3. projection becomes `wallet = wallet + 1000`, `locked = locked - 1000` — **money created**;
4. journal posts `DR CUSTOMER_WALLET -1000 / CR CARD_HOLD -1000`; `postJournal`'s balance check
   computes `abs(-1000 - -1000) = 0` → **passes**, so negative journal lines are accepted.

`unlockWallet` with a negative amount degenerates into an unintended LOCK; `captureLock` with a
negative amount increases `locked_balance`.

`NaN` fails closed (`wallet_balance >= NaN` → NULL → `rowCount 0`), so only the sign case matters.

**Mitigation that exists but is not sufficient:** `db/schema.sql` L21–22 declares
`CHECK (wallet_balance >= 0)` and `CHECK (locked_balance >= 0)`. That converts the exploit into
a raw `23514` constraint violation rather than a clean domain `400`, and it is **absent if the
`users` table was created by any migration rather than `schema.sql`** (see §6, schema risk).

Reachability: all three current callers validate amount before calling
(`cardService` rejects `amount ≤ 0` with `CARD_AMOUNT_INVALID`; ROSCA and savings compute
`collateral`/`blocked` with `round2` from stored non-negative columns). So this is a
**defence-in-depth gap in the engine**, not a live exploitable path today.

Fix is **out of scope for Phase 64** per the "no redesign without contract agreement" rule —
recorded here for a decision.

### Secondary observations (not defects)
- `setOperationState` does **not** validate `status` against `['SUCCESS','FAILED']`, whereas
  `finalizeOperation` does (L80–81). A caller could write an arbitrary terminal status.
- The three lock primitives call `setOperationState`, never `finalizeOperation`, so
  `financial_operations.attempts` is never incremented for LOCK/UNLOCK/CAPTURE — these
  operations are invisible to attempt-count diagnostics.
- `finalizeOperation` is exported and defined but **no caller** uses it at this baseline.

---

## 6. Blocking environment facts (read this before running anything)

1. **No credentialed Afrikoba database is reachable from this machine.**
   Port 5432 accepts TCP but every credential set in `.env.example`
   (`afrikoba` / `change_me_strong_password`) and the obvious `postgres` variants is rejected
   with `password authentication failed`. No `.env` file exists in the tree — only
   `.env.example`.
2. **Port 3000 is not Afrikoba.** `scripts/test-cards.js` defaults to
   `CARDS_TEST_BASE || 'http://127.0.0.1:3000'`. That port is currently served by
   **`afriMarket API`** (image `twenzetu-sokoni-api`), confirmed via `/api/health`
   (`{"service":"afriMarket API","version":"1.0.0"}`). Running `test-cards.js` unmodified on
   this host would target the wrong application. Any run must set `CARDS_TEST_BASE`
   explicitly.
3. **Other local databases are out of scope.** Docker exposes `afri-market-postgres` (5434)
   and `abms-postgres` (5435) — different applications. They must not be used for Afrikoba
   financial-mutation tests.
4. **Schema risk — `users.locked_balance` is `schema.sql`-only.** No migration creates the
   `users` table and none adds `locked_balance`; `031_financial_core.sql` L128 adds it only to
   `transactions`. `scripts/runMigrations.js` runs `schema.sql` only when the database is
   absent. A database created by migration-only means would therefore have **no
   `locked_balance` column and no non-negative CHECK**, making all three primitives fail with
   a raw SQL error. Must be confirmed against the real regression/production schema before
   any invariant is called PASS.
5. Preflight in the new suite asserts items 4 and the CHECK constraints explicitly, so a
   misconfigured database fails loudly instead of producing a misleading result.

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

No invariant is claimed PASS. Twelve of thirteen are PENDING solely for lack of a credentialed
non-production database. INV-12 is FAIL by static analysis. `main` is untouched.