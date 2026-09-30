# Phase 62 — Financial Engine Defect Specification

## Scope

Phase 62 addresses two newly identified defects in the frozen Financial Engine baseline.

Authoritative baseline:
- Phase 58 commit: `8f0647c3716e7261f6afaaab36efbeeaa4f0f470`
- Frozen financialEngine blob: `d671088bf4b1b4a52dbd078cc29bafe37cb81afe`
- Frozen engine SHA-256: `1c5e80cdb199e4275086f1c928d0fc3814c818542e8abb0c530abe66391593cc`

## Defect A — Audit failure must fail closed

### Current defect

`auditBalance()` catches an `INSERT INTO financial_audit_log` failure, logs the error, and returns normally.

This permits the surrounding financial transaction to continue toward `COMMIT` even though the projected-balance audit record was not written.

### Required behavior

An audit-log write failure MUST propagate to the transaction owner.

The transaction MUST then roll back.

A successful financial mutation MUST NOT commit without its corresponding audit record.

### Required regression assertions

1. Force the audit INSERT to fail.
2. The financial operation must fail.
3. The wallet mutation must roll back.
4. The journal mutation must roll back.
5. The operation claim/finalization must not survive as a successful committed operation.
6. No financial mutation may remain committed without its audit record.

## Defect B — postDeposit balance read must serialize on the wallet row

### Current defect

`postDeposit()` reads `wallet_balance` without `FOR UPDATE` before calculating the audit `balance_before` / `balance_after` values.

Concurrent deposits against the same wallet can therefore observe stale balance state.

### Required behavior

`postDeposit()` MUST lock the target user row before reading the balance used for the audit record.

Required SQL contract:

`SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE`

### Required regression assertions

1. The wallet row is locked before the balance snapshot is read.
2. Concurrent deposits against the same wallet serialize on that row.
3. Each committed audit record has a valid serialized before/after balance.
4. The final wallet balance equals the initial balance plus all successful deposits.
5. Each corresponding journal remains balanced.
6. No stale or overlapping audit balance interval is produced.

## Transaction-safety requirement

Both defects MUST preserve the existing transaction contract:

financial mutation
-> journal
-> audit
-> operation finalization
-> COMMIT

Any failure before COMMIT MUST cause rollback.

## Validation levels

### Structural validation

The regression test may verify source-level invariants such as:
- audit failure is not swallowed;
- `postDeposit()` contains `FOR UPDATE`;
- transaction boundaries remain intact.

Structural PASS does NOT constitute live acceptance.

### Live validation

A separate staging/regression database run is required to prove:
- forced audit failure rolls back all related mutations;
- concurrent deposits serialize correctly;
- final balances and audit before/after values reconcile.

Production test users and fabricated production balances MUST NOT be used.

## Status

Implementation: NOT STARTED

Structural validation: PENDING

Live validation: PENDING

Production validation: NOT STARTED

Acceptance: NOT CLAIMED
