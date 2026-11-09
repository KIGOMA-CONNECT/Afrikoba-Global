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

## 4. Close-out outbox handlers are verify-only → notifications move in Phase 72

- **Origin:** Step A decision.
- **Current state:** The handlers for `PROJECT_COMPLETED`, `PROJECT_LIQUIDATED`,
  `PROJECT_RESERVE_RELEASED` and `PROJECT_RESIDUAL_RELEASED` in `src/outbox/handlers.js`
  are **verify-only**: SELECT only, they confirm by `payload.reference` that the
  settlement / liquidation / reserve-release row exists, and throw if it does not. They
  send no notifications, because `projectFinanceService` already notifies owner and
  investors directly after `COMMIT` (a notifying handler would duplicate them).
- **Phase 72:** Move those owner/investor notifications into these handlers and remove the
  direct calls, **after Step B** (notification idempotency via `source_event_reference`)
  **and Step D** (`sms_deliveries`, no failover on timeout) are in place, so handler
  retries cannot duplicate notifications or SMS.

## 5. Legacy `FAILED` outbox events for the four close-out event types

- **Origin:** Step A review.
- **Problem:** Before Step A, `PROJECT_COMPLETED`, `PROJECT_LIQUIDATED`,
  `PROJECT_RESERVE_RELEASED` and `PROJECT_RESIDUAL_RELEASED` had no registered handler, so
  the dispatcher marked any such event `FAILED` with `last_error = 'No handler registered
  for <type>'`. Registering handlers does **not** reprocess them: `requeueDead` only
  touches `DEAD` rows, and the dispatcher only claims `PENDING` (and expired `PROCESSING`).
- **Procedure — count first, decide later (read-only, no UPDATE):**

  ```sql
  SELECT event_type,
         COUNT(*)        AS failed_events,
         MIN(created_at) AS oldest,
         MAX(created_at) AS newest
    FROM outbox_events
   WHERE status = 'FAILED'
     AND event_type IN ('PROJECT_COMPLETED', 'PROJECT_LIQUIDATED',
                        'PROJECT_RESERVE_RELEASED', 'PROJECT_RESIDUAL_RELEASED')
     AND last_error LIKE 'No handler registered for %'
   GROUP BY event_type
   ORDER BY event_type;
  ```

  Also list `FAILED` rows for these types whose `last_error` is **not** the
  "No handler registered" message, separately; they need individual review.
- **Decision (after counting, with approval):** whether to requeue these rows to `PENDING`
  so the verify-only handlers confirm each reference, or to close them out with a recorded
  disposition. Any requeue must be a separate, reviewed, audited change. It is not part of
  Step A.
