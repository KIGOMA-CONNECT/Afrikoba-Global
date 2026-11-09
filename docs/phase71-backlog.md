# Phase 71 Backlog

Items raised during the Phase 71 (outbox hardening) review gates that are not yet done.

## 1. Static check: literal `ROLLBACK` in `splitPaymentService`

- **Origin:** Step 0 review (commit `71ca584`).
- **Problem:** Case 10 of `tests/outbox-lease-dispatcher.phase71.test.js` verifies the
  rollback/release **path** only. The `safeRelease()` wrapper in `src/config/db.js`
  can issue `ROLLBACK` itself when a client is released mid-transaction, so the test
  does not prove that `runSplitPayment` explicitly rolls back on the duplicate-period
  early return.
- **Action:** Add a static assertion (source scan of `src/services/splitPaymentService.js`)
  that the duplicate-period branch contains `await client.query('ROLLBACK')` before
  `return`, or add a direct assertion on the transaction-control call that does not
  depend on the wrapper.

## 2. `test:phase71` npm script

- **Action:** Add a `test:phase71` script to `package.json` that runs the Phase 71 test
  files.
- **Requirement (must be in the script's documentation):** it needs a **disposable
  database** named `phase71_financial_audit_<suffix>`, supplied through
  `DB_NAME`/`DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`. The tests refuse any other
  database name and TRUNCATE tables, so they must never be pointed at a real database.
  Do not add it to the default `npm test` script, which runs without a database.

## 3. Direct notifications in `projectFinanceService` → Phase 72

- **Decision:** Deferred to **Phase 72** (out of Phase 71 scope).
- **Scope:** Direct `createNotification` / `notifyProjectInvestors` calls made after
  `COMMIT` in `src/services/projectFinanceService.js` (e.g. the dividend payout loop and
  close-out / liquidation notifications) should move into outbox handlers so they become
  transactional and retry-safe.
- **Note:** Phase 71 step E only moves `enqueueOutbox` and the dividend `logAudit` inside
  the transaction; it does not change these direct notifications.
