# Phase 68 — Deposit Atomicity & Callback Verification

**Status: BLOCKED (implementation complete, provider contract unverified).**
Phase 68 and finding **F-01** remain **OPEN**. D1 remains **BLOCKED** until the
official AzamPay transaction-status contract and provider acceptance tests exist.
Nothing in this work has been committed, pushed, merged, or deployed.

Branch: `phase68-deposit-atomicity-fix`
Worktree: `/tmp/afrikoba-phase68-deposit-fix`
Base commit: `29ee21e` (all changes below are uncommitted in that worktree)

---

## 1. Problem

Before this change the deposit path trusted the callback body:

- A forged `transactionstatus=success` callback credited the wallet without any
  gateway verification.
- A forged `transactionstatus=failed` callback cancelled a real deposit.
- A duplicate reference with a damaged journal was reported as a successful
  dedup because only a `financial_operations` row was checked.
- Callback and reconciliation could both settle the same deposit.

Baseline evidence on a HEAD-equivalent clone (`ef14927`, identical callback code)
is recorded in section 7.

---

## 2. Design

### 2.1 The callback body is a claim, the gateway answer is evidence

`processDepositCallback` no longer decides the outcome from the body. It queries
the gateway (`queryTransactionStatus`) and classifies the answer with
`classifyGatewayDeposit` (`src/services/depositVerification.js`).

| Classifier decision | Meaning | Effect |
|---|---|---|
| `SUCCESS` | gateway SUCCESS, reference matches, amount matches, contract verified | credit once |
| `FAILED` | gateway FAILED, reference matches, contract verified | mark `FAILED`, release hold |
| `CONFLICT` | gateway contradicts our record (reference/amount) | stay `PENDING`, record exception |
| `UNVERIFIED` | unavailable, not final, missing field, or contract unverified | stay `PENDING`, record exception |

A disagreement between body and gateway never moves money.

### 2.2 Provider-contract gate (default closed)

The `/azampay/payment/query` response schema is **not** documented by any checked
source. `docs/phase68/D1_PROVIDER_CONTRACT.md` §3 records this. Only the status
field (`transactionstatus`) is established by the existing integration code; the
reference and amount echo fields are *candidates*.

Therefore:

- `STATUS_CONTRACT.evidenceStatus = 'UNVERIFIED'` in code.
- `classifyGatewayDeposit(..., { contractVerified })` returns
  `UNVERIFIED / STATUS_CONTRACT_UNVERIFIED` for **every** input unless
  `contractVerified === true`.
- The flag comes from `config.azampay.statusContractVerified`
  (`AZAMPAY_STATUS_CONTRACT_VERIFIED`, default **false**), parallel to the payout
  gate added earlier.

While the flag is false, a deposit can never be auto-credited. The transaction
stays `PENDING` and an operator-visible exception is recorded. This is the
deliberate fail-closed posture until the provider contract is verified.

### 2.3 Atomic settlement

`postDeposit` now accepts the caller's client and `transactionId` and runs inside
the caller's transaction. A settlement is:

1. `pg_advisory_xact_lock(0, hashtext(reference))` — serialises callback vs
   reconciliation for the same reference.
2. guarded `PENDING → SUCCESS/FAILED` transition (only one winner).
3. `postDeposit` (journal + wallet + `financial_operations` + `company_revenue`).
4. `wallet_ledger` insert, then exact-row verification.
5. COMMIT.

Any failure rolls back **all** effects (wallet, journal, ledger, revenue,
operation state) and records `DEPOSIT_SETTLEMENT_FAILED`.

### 2.4 Idempotency contract

A duplicate reference is only accepted as a verified dedup when **all** hold:

- `financial_operations.operation_type = 'DEPOSIT'`, `status = 'SUCCESS'`
- matching user, amount and transaction id
- a complete, balanced deposit journal for that reference
  (`MNO_CLEARING DR = wallet + commission`, `CUSTOMER_WALLET CR = wallet`,
  `COMMISSION CR = commission`, no extra/duplicate lines, no transaction mismatch)

Otherwise `postDeposit` throws `DEPOSIT_IDEMPOTENCY_CONFLICT`. The mere existence
of a journal row or operation row is never sufficient.

### 2.5 Exception taxonomy

| Type | Raised by | Meaning |
|---|---|---|
| `CALLBACK_UNVERIFIED` | callback | gateway unavailable / not final / contract unverified |
| `CALLBACK_GATEWAY_CONFLICT` | callback | body and gateway disagree |
| `DEPOSIT_CONTRACT_UNVERIFIED` | reconciliation | gate closed |
| `DEPOSIT_GATEWAY_CONFLICT` | reconciliation | gateway contradicts our record |
| `DEPOSIT_SETTLEMENT_FAILED` | both | settlement threw; all effects rolled back |

---

## 3. Files changed

| File | Change |
|---|---|
| `src/services/depositVerification.js` | **new** — contract metadata, classifier gate, journal + ledger verifiers |
| `src/services/financialEngine.js` | hardened `postDeposit` dedup, caller client/transaction, guarded revenue + operation transitions |
| `src/services/walletService.js` | gateway-verified callback, atomic settlement, advisory lock, exceptions |
| `src/jobs/reconciliationCron.js` | `settleDeposit` exported, gate handling, parity with callback, exception dedupe |
| `src/config/index.js` | `azampay.statusContractVerified` |
| `.env.example` | `AZAMPAY_STATUS_CONTRACT_VERIFIED=false` |
| `src/middleware/webhookGuard.js` | constant-time secret comparison (`crypto.timingSafeEqual`) |
| `tests/deposit-verification.phase68.test.js` | **new** — 35 unit cases |
| `tests/deposit-atomicity.phase68.test.js` | **new** — 25 integration cases |
| `tests/webhook-guard.phase68.test.js` | **new** — 13 unit cases |

`git diff --check` exits 0 (no whitespace errors). All changed files pass
`node --check`.

---

## 4. Test evidence

All tests ran on the disposable database `phase68_amount_guard_d1verify`
(container `p68-ci-verify-db`, isolated: 69 users / 139 transactions at start).
The gateway, SMS and audit transport are stubbed: **no provider call, no SMS, no
production write**.

| Suite | Result | Command |
|---|---|---|
| `deposit-verification.phase68.test.js` | **35 / 35 PASS** | `bash /root/run_depositfix.sh tests/deposit-verification.phase68.test.js` |
| `deposit-atomicity.phase68.test.js` | **25 / 25 PASS** | `bash /root/run_depositfix.sh tests/deposit-atomicity.phase68.test.js` |
| `webhook-guard.phase68.test.js` | **13 / 13 PASS** | `bash /root/run_depositfix.sh tests/webhook-guard.phase68.test.js` |
| `financial-amount-guard.phase68.test.js` | **229 / 229 PASS** | `bash /root/run_depositfix.sh tests/financial-amount-guard.phase68.test.js` |
| `withdrawal-dispatch-d1.test.js` | **12 / 12 PASS** | `bash /root/run_depositfix.sh tests/withdrawal-dispatch-d1.test.js` |
| `regressionFinancialEnginePhase62.test.js` | **6 / 6 PASS** | `bash /root/run_depositfix.sh tests/regressionFinancialEnginePhase62.test.js` |
| `regressionFinancialEnginePhase68.test.js` | **5 / 5 PASS** | `bash /root/run_depositfix.sh tests/regressionFinancialEnginePhase68.test.js` |
| `azampay-payout-classification.test.js` | **7 / 7 PASS** | `bash /root/run_depositfix.sh tests/azampay-payout-classification.test.js` |

### Atomicity matrix (25 cases)

- **A1–A2** contract gate closed: neither callback nor reconciliation credits.
- **B1–B11** forged SUCCESS (no record / pending), verified success, replay,
  concurrency, amount mismatch, reference mismatch, timeout, forged FAILED,
  body SUCCESS vs gateway FAILED, unknown reference.
- **C1–C7** dedup: matching, conflicting commission/user/operation type,
  missing journal line, extra lines, non-SUCCESS operation.
- **D1–D2** rollback on ledger conflict; unbalanced journal rejected by engine
  and by the DB deferred trigger.
- **E1–E3** reconciliation parity and callback-then-reconciliation single credit.

---

## 5. Verified vs unverified

**Verified by deterministic tests (above):**

- Forged, replayed, concurrent, mismatched and timed-out callbacks cannot credit
  or cancel a deposit.
- A verified SUCCESS credits exactly once with a balanced 3-line journal, one
  `wallet_ledger` row and one `financial_operations` row.
- Settlement failure rolls back every effect.
- Dedup with a damaged/partial journal is rejected.
- Reconciliation and callback agree and cannot double-credit.
- Webhook secret comparison is constant-time and fails closed in production.

**Not verified (assumptions that remain open):**

- The real shape of the AzamPay `/azampay/payment/query` response
  (`externalId` / `externalReferenceId` / `reference`, `amount` /
  `transactionAmount`, status values). This is why the gate is closed.
- Behaviour against the live provider sandbox (no live call was made).
- Public request path and `trust proxy` topology (affects `req.ip` used by the
  IP allowlist).
- D1 payout contract remains unverified/BLOCKED.

---

## 6. Residual risks

1. **Deposits do not auto-credit until the gate is opened.** This is intentional
   fail-closed behaviour; it requires operational reconciliation until D1 is
   closed.
2. Opening the gate without verified field names would re-introduce the original
   vulnerability class (wrong/missing fields treated as success). Do not set
   `AZAMPAY_STATUS_CONTRACT_VERIFIED=true` before section 5 evidence is replaced
   with a provider-confirmed contract.
3. Callback/reconciliation exceptions are recorded in
   `reconciliation_exceptions` but alert transport is still a separate open item.
4. `idempotent.js` scoping/locking, four-eyes on withdrawals, CI DB password
   rotation, and the vite 8 / react-router-dom 7 migration remain open.
5. `tests/financial-amount-guard.test.js` in the worktree is corrupted and
   untracked; it was not modified or run. The valid tracked suite is
   `tests/financial-amount-guard.phase68.test.js`.

---

## 7. Baseline (pre-fix) evidence

HEAD-equivalent clone `/root/p68_audit_clone` at `ef14927` (identical callback
code to `29ee21e`):

- `tests/deposit-callback-verification.test.js`: **5 passed / 9 failed**
  - forged SUCCESS with no gateway record credited 10,000
  - forged SUCCESS while gateway PENDING credited 10,000
  - forged FAILED cancelled a real deposit
  - body SUCCESS while gateway FAILED became SUCCESS
  - amount and reference mismatches credited
- `tests/baseline-dedup-check.js`: **FAIL** — HEAD returns
  `{"dedup":true}` for a duplicate whose journal was damaged.

The same suites pass on the fixed worktree, which is the before/after evidence
for F-01.

---

## 8. Owner decisions required

1. Obtain the official AzamPay transaction-status contract (fields, statuses,
   error codes, sandbox acceptance test). Only then set
   `AZAMPAY_STATUS_CONTRACT_VERIFIED=true`.
2. Decide the operational process for `PENDING` deposits while the gate is closed.
3. Confirm the public request path / `trust proxy` so the IP allowlist sees the
   real client IP.
4. Approve alert transport for `reconciliation_exceptions`.
5. Authorise commit / PR / deploy separately. None has been done.

---

## 9. Reproduce

```bash
# from the host that owns the disposable DB
bash /root/run_depositfix.sh tests/deposit-verification.phase68.test.js
bash /root/run_depositfix.sh tests/deposit-atomicity.phase68.test.js
bash /root/run_depositfix.sh tests/webhook-guard.phase68.test.js
```

The runner sets `DB_NAME=PHASE68_TEST_DB=phase68_amount_guard_d1verify`,
`DB_HOST=127.0.0.1`, `DB_PORT=55457`, `NODE_ENV=test` and reads the DB password
from the container environment at runtime (never printed).
