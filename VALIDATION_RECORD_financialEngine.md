# Validation Record — `src/services/financialEngine.js` transaction safety

**Status: ACCEPTED (engine validation scope only)**
**Freeze: ACTIVE — no further functional changes without a new, separately documented defect test.**

## 1. Frozen artifact

| Field | Value |
|---|---|
| File | `src/services/financialEngine.js` |
| Size | `39448` bytes |
| Modified (UTC) | `2026-09-27T07:48:58.2154978Z` |
| SHA-256 | `1c5e80cdb199e4275086f1c928d0fc3814c818542e8abb0c530abe66391593cc` |

Hash was re-verified after all live runs and was identical to the pre-live gate value, i.e. the engine was frozen for the entire validation window. Machine-checkable manifest: `tests/zz_engine_freeze.sha256`.

## 2. Acceptance

```text
IMPLEMENTATION     = DONE
STRUCTURAL         = 9/9 PASS
LIVE               = 9/9 PASS
RECONCILIATION     = PASS
TX224              = UNTOUCHED
ACCEPTANCE         = APPROVED
```

This acceptance covers the `financialEngine.js` transaction-safety validation scope only.

## 3. Generic transaction-safety contract (retained)

The fix is a single generic contract, not a collection of special-case patches. Every covered function follows the same ordered pipeline:

```text
conditional financial mutation
  -> rowCount / guard validation
  -> journal only after successful mutation
  -> operation terminal state
  -> atomic commit/rollback
  -> idempotency where applicable
  -> projection <-> ledger reconciliation
```

Functions under this contract (retained by explicit decision):

```text
releaseHold
unlockWallet
holdFunds
captureLock
lockWallet
captureHold
postDeposit
transfer
creditWallet
debitWallet
internalTransfer
walletToGroup
groupToWallet
```

Only consistency guarantees were added. Business semantics of operations that did not require change were not altered.

## 4. Validation evidence

| Gate | Result | Evidence |
|---|---|---|
| `node --check src/services/financialEngine.js` | PASS | syntax clean |
| Structural `tests/regressionFinancialEngine.test.js` | 9 passed, 0 failed | `tests/zz_struct_out.txt` |
| Pre-live static / identity / TX224 gate | PASS | `tests/zz_out_prelive.txt` |
| Live #2–#8 (actual DB) | 7/7 PASS | `tests/zz_out_live_after_fix.txt` |
| Live #1, #9 (corrected re-run, actual DB) | 2/2 PASS | `tests/zz_out_live_after_fix2.txt` |
| Combined live | 9/9 PASS | both live files above |

All live evidence was produced against the isolated regression database `afrikoba_regression` on host port `5436`. No production system, no migration, and no schema mutation was involved.

### 4.1 Live matrix

| # | Invariant | Verdict |
|---|---|---|
| 1 | HOLD conditional-atomic; race yields exactly one winner; loser leaves zero residue | PASS |
| 2 | RELEASE restores available balance and is idempotent on reference | PASS |
| 3 | Duplicate RELEASE repeated 4x produces no double financial effect | PASS |
| 4 | No orphan journal, no false success, DB CHECK refuses negative balances | PASS |
| 5 | Terminal state only — every operation of the run finalized to `SUCCESS`, no `NEW` | PASS |
| 6 | Retry produces no double effect; 3rd call of a settled reference returns `dedup` | PASS |
| 7 | Single-transaction atomicity — forced error rolls back mutation + journal + audit | PASS |
| 8 | Double-entry holds: per-group DR = CR, whole-DB difference 0 | PASS |
| 9 | Projection ↔ ledger identities hold; no orphan ledger groups; no false audit rows | PASS |

### 4.2 Defects closed

| # | Pre-fix defect | Post-fix result |
|---|---|---|
| 4 | `releaseHold` returned success and posted journal/audit although the guarded update matched no row | rejection with `op=null, journal=0, audit=0` |
| 4 | `unlockWallet` posted journal before validating the guard, leaving an orphan journal group on failure | rejection with zero residue |
| 5 | `holdFunds` / `captureLock` left operations in non-terminal `NEW` state | all run operations finalized to `SUCCESS` |
| 9 | Pre-fix run left 3 ledger groups without a matching balance movement | 0 orphans in post-fix run |

### 4.3 Reconciliation identities (post-fix)

| Identity | Ledger | Projection | Gap |
|---|---|---|---|
| `CARD_HOLD` net (`CR - DR`) = `SUM(locked_balance)` | 205000.0000 | 205000.00 | **0** |
| `CUSTOMER_WALLET` net (`CR - DR`) = `SUM(wallet) - SUM(seed)` | -235000.0000 | -235000 | **0** |
| Ledger groups without balance movement | — | — | **0** |
| Audit rows without a ledger group | — | — | **0** |
| Double-entry, this scenario | DR 475000.0000 / CR 475000.0000 | 20 rows | **0** |
| Users with negative wallet or locked, whole database | — | — | **0** |

### 4.4 Test-harness corrections (harness only, engine untouched)

Two defects in the first post-fix live harness were found and corrected. Neither was an engine defect, and the engine hash was identical across both runs.

1. Reference tags were deterministic, so the `holdFunds` concurrency race reused the `lockWallet` reference and received `dedup: true`. It was then miscounted as a second winner. Corrected by giving each race mode its own unique reference pair.
2. The reconciliation query labelled a value "net credit" but summed `CR` only, omitting `- DR`, producing a spurious gap. A second query referenced `je.operation_type`, which does not exist; the column lives on `financial_operations`. Both queries were corrected and re-run.

## 5. Historical residue — DELIBERATELY PRESERVED

```text
pre-fix historical residue = 2,254,998 across 9 references
```

This figure is **pre-fix historical residue that was deliberately preserved**. It is not output of the post-fix engine and must not be read as a post-fix reconciliation result.

Rules in force for this residue:

- Must not be deleted.
- Must not be corrected.
- Must not be re-posted.
- Must not be reconciled by manual adjustment.
- No data migration may be performed for its sake.

Post-fix runs re-asserted the residue as `2254998.0000 across 9 refs` after every run, confirming the baseline was neither altered nor repaired. All post-fix reconciliation verdicts are scoped to newly created users and references, and all post-fix references are unique and within the 15-character limit.

**Consequently, this historical regression database is intentionally NOT clean.** Acceptance in section 2 does not assert that it is.

## 6. TX224

```text
WD-3EC32D6D
TX224 operations     = 0
TX224 rows           = 0
TX224 source literals = 0
```

The fix is generic; no TX224 special-casing exists in the engine path. No test, cleanup step, or migration is permitted to touch TX224.

## 7. Evidence preservation

All evidence files are immutable. Original pre-fix evidence was never overwritten — its timestamps (`07:29`–`07:37` UTC) all predate the engine edit at `07:48:58` UTC.

| File | Role | SHA-256 |
|---|---|---|
| `tests/zz_out_prelive.txt` | pre-live identity / inventory / TX224 gate | `5abb02854ae23e4d1eaed600e3bb0fc9e40a17c5df511d0714bc51b795f6d005` |
| `tests/zz_struct_out.txt` | structural 9/9 | `582529a5287be0b1bf07c4b1042a8245407184ab20521d60f279a3fc16a33d01` |
| `tests/zz_out_live_after_fix.txt` | live #2–#8 | `c1b4dbc0758166eac0815b80074ac7011529d9fba64750ede6398fd9022842e0` |
| `tests/zz_out_live_after_fix2.txt` | live #1, #9 (corrected) | `2112f3109da03fbc1d7764a9169a31f8376cf555c18d3d64cb778b85e3af46d3` |
| `tests/zz_out_preflight.txt` | pre-fix schema preflight | `a45b0c2aa814de6773f0c662929a52d5f8c98056010c724de7f8adc75c6b10f1` |
| `tests/zz_out_preflight2.txt` | pre-fix constraints / partitions | `238e0cb6d11cee6b4fa14bc39ad7af5e99828888241cc74f7fb0e7006cb2c91f` |
| `tests/zz_out_live.txt` | pre-fix live run (defect evidence) | `5ff3a9ac598d83ed217342c1ced0a30631356cef6e1f7de7da1ad8bc833dc3f0` |
| `tests/zz_out_t1r.txt` | pre-fix focused re-test of #1 | `ada92f8396b7bc7adb36fa708b9db6bf21044146ea7daffee4cfdea2a2206343` |
| `tests/zz_out_confirm.txt` | pre-fix reconciliation confirmation | `3658d6feb5c4b578fe74918b4833eb151f36991f784d4897849da9d5ebb51495` |
| `tests/zz_out_confirm2.txt` | pre-fix TX224 confirmation | `d090c0785050e1474e87d41271cb5aba57bc548468753f91765c32b1322fae10` |

## 8. Change-freeze rule

`src/services/financialEngine.js` is frozen at the hash in section 1. No functional change is permitted unless a new defect is discovered through a separately documented test, in which case the new test, its evidence, and a new record revision are required before the freeze is lifted.
