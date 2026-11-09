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

## 6. Rollback procedure for migration 147 (notification idempotency)

- **Origin:** Step B.
- **Order matters:** drop the index first, then the column.

  ```sql
  DROP INDEX IF EXISTS uq_notifications_user_source_event_ref;
  ALTER TABLE notifications DROP COLUMN IF EXISTS source_event_reference;
  DELETE FROM schema_migrations WHERE version = '147_notification_idempotency.sql';
  ```

- **Before rolling back:** revert the Step B code first (`createNotification` writes
  `source_event_reference`, and the five notifying outbox handlers pass it); otherwise every
  handler notification will fail on the missing column. After rollback, outbox redeliveries
  can create duplicate notifications again.
- **Operational note:** `CREATE UNIQUE INDEX` (non-concurrent, because the runner wraps each
  migration in a transaction) takes a lock that blocks writes to `notifications` while the
  index is built. Existing rows are all `NULL` for the new column, but the table is still
  scanned. Schedule the production run accordingly.

## 7. Register `OUTBOX_TEST` and `OUTBOX_RETRY` only in test environments

- **Origin:** Step B review.
- **Problem:** `src/outbox/handlers.js` registers the diagnostic handlers `OUTBOX_TEST`
  (creates a notification for `payload.userId`) and `OUTBOX_RETRY` (fails twice out of three)
  in every environment, including production.
- **Action:** Register them only when `NODE_ENV` is `test`/`development` (or behind an
  explicit flag), and update `tests/fixtures/phase71-outbox-handlers.before.json` and the
  contract test's expected set accordingly, so production cannot process these event types.

## 8. Production release order for Step B: migration 147 first, then code

- **Origin:** Step B review.
- **Order:** apply migration `147_notification_idempotency.sql` **before** deploying the
  Step B code.
- **Why:** the Step B code makes the five notifying outbox handlers
  (`MERCHANT_PAYOUT_EXECUTED`, `VICOBA_LOAN_APPROVED`, `OUTBOX_TEST`,
  `PROJECT_REVENUE_PROCESSED`, `PROJECT_DIVIDEND_PAID`) always pass `sourceEventReference`,
  so `createNotification` writes `notifications.source_event_reference` with
  `ON CONFLICT (user_id, source_event_reference)`. Without the column and the partial unique
  index, that INSERT fails, `createNotification` returns `null`, and **all five handlers
  throw** and retry until `DEAD`. Direct callers (no reference) are unaffected.
  The migration is backward-compatible with the old code (nullable column, partial index),
  so migration-first is safe.
- **Before building the index, size the table (read-only):**

  ```sql
  SELECT COUNT(*) AS notification_rows,
         pg_size_pretty(pg_total_relation_size('notifications')) AS total_size
    FROM notifications;
  ```

  The index is built non-concurrently inside the runner's transaction and blocks writes to
  `notifications` while it builds (see item 6); choose a low-traffic window based on this
  size. If the table is large, decide separately whether to build the index
  `CONCURRENTLY` outside the runner before applying 147 (the `IF NOT EXISTS` makes 147 a
  no-op for an index that already exists).
