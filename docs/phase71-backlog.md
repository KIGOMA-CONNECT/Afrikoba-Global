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

## 9. Step D guarantee: fewer duplicate SMS, NOT exactly-once

- **Origin:** Step D.
- `sendSMSIdempotent` + `sms_deliveries` **reduce** duplicate sends; they do **not**
  provide exactly-once delivery. When a provider call times out, resets, or returns 5xx,
  the SMS may or may not have reached the handset. Such outcomes are recorded as `UNKNOWN`
  and are never resent automatically, so the residual risk becomes a possibly *missing*
  SMS (to be reconciled), instead of a possible *duplicate*.
- Failover to another provider happens only after a **definite** failure (connection never
  established, HTTP 4xx, explicit provider rejection).

## 10. Rollback procedure for migration 148 (sms_deliveries)

- **Revert the Step D code first** (`sendSMSIdempotent`, the `PROJECT_SPLIT_SMS` handler);
  otherwise every `PROJECT_SPLIT_SMS` event fails on the missing table.
- **Export `UNKNOWN` and `PENDING` rows first**: they are the only record of SMS whose
  outcome still needs reconciliation.

  ```sql
  SELECT * FROM sms_deliveries WHERE status IN ('UNKNOWN', 'PENDING') ORDER BY updated_at;
  DROP TABLE IF EXISTS sms_deliveries;          -- also drops its indexes
  DELETE FROM schema_migrations WHERE version = '148_sms_deliveries.sql';
  ```

## 11. Production release order for Step D

1. Apply migration `148_sms_deliveries.sql` (new table only; harmless to the old code).
2. Deploy the Step D code **together**: `smsService.js`, `outboxService.js` and
   `src/outbox/handlers.js`.
- **`outboxService` must be released before or together with the new handler.** On the
  old `outboxService`, `NonRetryableError` is not recognised and is treated as an ordinary
  error: an `UNKNOWN` SMS event would be retried with backoff until `max_attempts` and then
  `DEAD`. No SMS would be resent (each retry finds `UNKNOWN`), but the event would take
  minutes instead of one attempt to reach `DEAD`, with misleading retry noise.
- Code before migration: every `PROJECT_SPLIT_SMS` event fails (missing table) and retries.

## 12. Reconcile `UNKNOWN` SMS with provider delivery reports

- **Find them (read-only):**

  ```sql
  SELECT d.idempotency_key, d.provider, d.phone_last4, d.last_error, d.updated_at,
         e.id AS outbox_event_id, e.status AS outbox_status
    FROM sms_deliveries d
    LEFT JOIN outbox_events e ON e.reference_id = d.idempotency_key
   WHERE d.status = 'UNKNOWN'
   ORDER BY d.updated_at;

  SELECT id, reference_id, last_error FROM outbox_events
   WHERE status = 'DEAD' AND last_error LIKE 'SMS_DELIVERY_UNKNOWN%';

  -- Stale PENDING: claimed, outcome never recorded (process stopped mid-send).
  -- Same threshold as smsService.STALE_PENDING_MS (10 minutes).
  SELECT d.idempotency_key, d.provider, d.phone_last4, d.attempts, d.updated_at,
         e.id AS outbox_event_id, e.status AS outbox_status, e.last_error
    FROM sms_deliveries d
    LEFT JOIN outbox_events e ON e.reference_id = d.idempotency_key
   WHERE d.status = 'PENDING'
     AND d.updated_at < NOW() - INTERVAL '10 minutes'
   ORDER BY d.updated_at;
  ```

- **DEAD outbox event with a PENDING `sms_deliveries` row:** if a sender stops after the
  claim (row `PENDING`), redeliveries of the event see a *fresh* `PENDING` and throw an
  ordinary error ("delivery in progress elsewhere"). The outbox backoff (5 s, 10 s, 20 s,
  40 s; `DEAD` after attempt 5, roughly 75 s plus dispatcher ticks) ends **before** the
  10-minute stale threshold, so the event goes `DEAD` while the row is still `PENDING`
  (not yet `UNKNOWN`). These rows appear in the stale-PENDING query above. A later
  `requeueDead` (after 10 minutes) turns the row into `UNKNOWN` and the event into
  `DEAD` with `SMS_DELIVERY_UNKNOWN`; in both cases nothing is resent automatically, and
  the row must be reconciled like any `UNKNOWN`.

- **Action:** match each `UNKNOWN` row against the provider's delivery reports / message
  logs (Beem, Africa's Talking, Twilio) by provider, time window and `phone_last4`; then
  record a decision (delivered -> mark `SENT`; not delivered -> explicit re-send) as a
  reviewed, audited operation. No automatic resend.
- **Also:** ingest provider delivery-report callbacks (DLR) so `provider_message_id` can
  be confirmed automatically.
- **RELEASE BLOCKER (first production release of Step D) — Africa's Talking codes:** the
  per-recipient `statusCode` mapping in `smsService.classifyProviderResponse`
  (accepted 100/101/102; rejected 401–407, 409, 502; UNKNOWN 500/501 and unrecognised)
  was written from memory of the AT documentation and must be verified against AT's
  **current** documentation before release. A wrong "rejected" code would allow a
  failover that can double-send.
- **RELEASE BLOCKER (first production release of Step D) — phone hash:** `phone_hash` is
  a plain SHA-256 of the normalised number; the phone-number space is small enough to
  brute-force, so it is effectively reversible. Decide before release whether to switch
  to an HMAC with a server-side secret (and how that secret is managed/rotated). The
  decision must be recorded before `sms_deliveries` holds production data.

## 13. Direct `sendSMS` callers are not migrated

- Only `PROJECT_SPLIT_SMS` uses `sendSMSIdempotent`. **36 direct `sendSMS` callers**
  (37 call sites including the old split handler before Step D; roughly the "~38" estimated)
  still use the original failover, which can double-send on a timeout.
- `sendSMS` stays as-is for OTP (short-lived, user can request again).
- Step C moves the `createNotification` SMS onto the outbox + `sendSMSIdempotent`; the
  remaining callers (vicoba, wallet, p2p, rosca, family, network, recurrence, events,
  reconciliation cron, pin reset, ...) need their own migration with stable keys.

## 14. Production release order for Steps A–D (+ C)

- **Migrations first:** apply `146_outbox_dispatch_leases.sql`, `147_notification_idempotency.sql`
  and `148_sms_deliveries.sql` (in that order) **before** deploying any Phase 71 code.
  The code of A, B, C and D reads/writes `lease_token`/`locked_until`,
  `notifications.source_event_reference` and `sms_deliveries`, and fails without them.
- **Then the code of A, B, C and D together, in one deploy.** Within it,
  `src/services/outboxService.js` (`NonRetryableError`, `referenceId`/`eventId` passed to
  handlers) must be released **before or together with** `src/outbox/handlers.js`; a
  handler throwing `NonRetryableError` against an old dispatcher would just be retried.
- Release blockers from item 12 (Africa's Talking codes, `phone_hash` HMAC decision) still
  apply.
- **Rolling back the code of Step C** (old `handlers.js` without `NOTIFICATION_SMS`): the
  dispatcher marks every due `NOTIFICATION_SMS` event `FAILED` with
  `No handler registered for NOTIFICATION_SMS`. `FAILED` is **terminal**: it is never
  claimed again, and `requeueDead` only touches `DEAD`. Those SMS are not sent until
  someone acts. Procedure:
  1. Count (SELECT only) before deciding anything:
     ```sql
     SELECT status, COUNT(*) AS events, MIN(created_at) AS oldest, MAX(created_at) AS newest
       FROM outbox_events
      WHERE event_type = 'NOTIFICATION_SMS'
      GROUP BY status;
     SELECT COUNT(*) AS failed_no_handler
       FROM outbox_events
      WHERE event_type = 'NOTIFICATION_SMS' AND status = 'FAILED'
        AND last_error = 'No handler registered for NOTIFICATION_SMS';
     ```
  2. Decide (a human decision, recorded) whether these SMS are still worth sending. Old
     ones may be stale; the in-app notification exists regardless.
  3. Only **after the handler is deployed again**, return the chosen events to the queue
     as a reviewed, audited operation, e.g. `UPDATE outbox_events SET status = 'PENDING',
     attempts = 0, next_attempt_at = NOW(), last_error = NULL, lease_token = NULL,
     locked_until = NULL, updated_at = NOW() WHERE event_type = 'NOTIFICATION_SMS' AND
     status = 'FAILED' AND last_error = 'No handler registered for NOTIFICATION_SMS'
     AND created_at >= <cut-off>;`. `sms_deliveries` keyed by `NOTIF_SMS:<id>` prevents
     a second send for any event that did get sent before the rollback.
- **Detect notifications that should have an SMS event but do not** (sms_enabled user
  with a phone, created since the Step C deploy). Causes: a failed enqueue, which is now
  logged as `NOTIFICATION_SMS enqueue failed for notificationId=...` and the notification
  is kept, or a release window. SELECT only:
  ```sql
  SELECT n.id AS notification_id, n.user_id, n.created_at
    FROM notifications n
    JOIN notification_preferences p ON p.user_id = n.user_id AND p.sms_enabled
    JOIN users u ON u.id = n.user_id AND btrim(COALESCE(u.phone_number, '')) <> ''
   WHERE n.created_at >= <step_c_deploy_time>
     AND NOT EXISTS (
       SELECT 1 FROM outbox_events e
        WHERE e.reference_id = 'NOTIF_SMS:' || n.id
          AND e.event_type = 'NOTIFICATION_SMS')
   ORDER BY n.created_at;
  ```
  The preference and phone are read **now**, not as they were at creation time, so the
  result is a candidate list to review, not proof of a lost SMS.

## 15. createNotification SMS goes through the outbox (Step C) — timing change

- All 19 `createNotification` callers (eventService ×4, projectFinanceService ×13,
  projectService ×1, referralService ×1; none changed) now get their SMS via a
  `NOTIFICATION_SMS` outbox event instead of an inline fire-and-forget `sendSMS`.
- **SMS timing changes:** the SMS is sent by the outbox dispatcher (cron every minute,
  `src/jobs/runAll.js`), so expect a delay of **up to about one minute** after the
  notification (longer on retries: backoff 5/10/20/40 s; `DEAD` after attempt 5).
  If the dispatcher cron is not running, notification SMS are **not sent** (they stay
  `PENDING` in `outbox_events`). Monitor the `NOTIFICATION_SMS` backlog.
- **How the dispatcher works today:** `cron.schedule('* * * * *')` calls
  `dispatchOutbox({ batchSize: 50 })` **once per tick**. It claims at most 50 due events
  (`ORDER BY attempts, id ... FOR UPDATE SKIP LOCKED`), handles them **one after another**,
  and returns. It does **not** loop until the queue is empty; anything above 50 waits for
  the next minute. The 50 are shared by **all** event types, not only SMS. Ticks are not
  serialised: a tick slower than 60 s overlaps the next one, which is safe (SKIP LOCKED,
  leases) but does not raise the per-tick limit.
- **Maximum throughput:** at most **50 events/minute = 3,000 events/hour** in total.
  This is also the hard upper bound for notification SMS, and lower in practice because
  other event types and retries take slots. Each SMS can take up to one provider timeout
  (15 s, no failover on UNKNOWN), so a few slow sends make one tick take minutes, and the
  real rate can fall far below 3,000/hour. A burst of N notifications (e.g. a project
  dividend to many investors) takes at least ceil(N/50) minutes to drain.
- **Measuring the `NOTIFICATION_SMS` queue** (SELECT only):
  ```sql
  SELECT COUNT(*) FILTER (WHERE status = 'PENDING')                         AS pending,
         COUNT(*) FILTER (WHERE status = 'PENDING' AND next_attempt_at <= NOW()) AS pending_due,
         COUNT(*) FILTER (WHERE status = 'PROCESSING')                      AS processing,
         MIN(created_at) FILTER (WHERE status = 'PENDING')                  AS oldest_pending,
         NOW() - MIN(created_at) FILTER (WHERE status = 'PENDING')          AS oldest_pending_age
    FROM outbox_events
   WHERE event_type = 'NOTIFICATION_SMS';
  ```
  Alert if `oldest_pending_age` grows past a few minutes or `pending` keeps rising.
- **RELEASE ITEM (decide before the first production release of Step C):** raise
  `batchSize`, or run the dispatcher in a loop within a tick until the queue is empty or a
  time budget is used up, e.g. "repeat while `claimed === batchSize` and elapsed < 50 s".
  Size it against the largest expected notification burst and the provider rate limits.
- **Enqueue failure is isolated (SAVEPOINT `notif_sms_enqueue`):** if the SMS enqueue
  fails, the notification is kept, its id is returned, the caller's transaction stays
  usable, and the error is logged with `notificationId`. That notification then has
  **no** SMS; use the detection SELECT in item 14 to find such notifications.
- **Error contract:** with `client`, other failures are logged and **re-thrown** to the
  transaction owner; without `client` (all 19 callers today), failures are logged and
  `null` is returned, as before Step C.
- `sms_enabled` and the phone number are checked when the notification is created (no
  event otherwise); the phone and text are re-read by the handler at send time, so a
  phone change in between sends to the new number.
- Callers without `client` (all 19 today) now write the notification and the event in
  their own short transaction (one `pool.connect()` per call). Callers inside a financial
  transaction (e.g. projectFinanceService refunds) still notify outside that transaction,
  as before Step C; moving them onto `client` / the handlers is Phase 72 (item 3).
- `UNKNOWN` outcomes make the event `DEAD` with `SMS_DELIVERY_UNKNOWN` and need the
  reconciliation in item 12; the DEAD-with-PENDING case from item 12 applies here too.

## 16. B2 (P1, fixed in E0): `payProjectDividends` could pay a dividend twice

- **Problem:** the `PENDING` payout rows were read without a lock, and the
  `PENDING -> PAID` update did not check its row count. `txnRef` is random per call
  (`generateReference('PROJECT_DIVIDEND_PAYOUT')`), so the per-investor credit reference
  never repeats and `creditWallet` cannot dedup. Two parallel calls both read the same
  `PENDING` rows and both credited the wallets. The second call's UPDATE changed 0 rows,
  went unnoticed, and the call committed.
- **Evidence (tests/project-dividend-concurrency.phase71.test.js, code at HEAD 6739401):**
  two parallel calls, investor A entitled to 1250.50 and B to 400.00. Wallets ended at
  A = 2501.00 and B = 800.00, with 2 CREDIT operations, 4 journal rows and 2 "paid"
  notifications per investor, and both calls reported `paid: 2`.
- **Fix (E0, `payProjectDividends` only):**
  1. `SELECT id FROM project_investor_payouts WHERE project_id = $1 AND status = 'PENDING'
     ORDER BY investor_user_id, id FOR UPDATE OF project_investor_payouts`. A parallel
     payout waits here and, after the first commits, finds nothing `PENDING` and returns
     `already_paid`.
  2. The investors' `users` rows are locked `ORDER BY id FOR UPDATE` before the first
     `creditWallet` (item 18).
  3. The `UPDATE ... SET status = 'PAID' ... WHERE status = 'PENDING'` must change exactly
     `row_count` rows (the rows summed for that investor). Otherwise it throws
     `ValidityError` 409 `DIVIDEND_STATE_CHANGED` and the whole payout, credits included,
     is rolled back.
  `txnRef`, all business references and the payout arithmetic are unchanged. After the
  fix: A = 1250.50 and B = 400.00, with 1 CREDIT, 1 journal pair and 1 notification each.
  The second call returns `already_paid`.
- **Limits of the fix, recorded on purpose:**
  - The aggregate `SELECT investor_user_id, SUM(entitlement) ... GROUP BY` after the lock
    takes **no lock of its own**. It is a separate statement with a fresh snapshot.
    `PENDING` rows inserted and committed by another transaction **between** the lock
    statement and the aggregate are not locked but are summed. Rows committed **after**
    the aggregate and before the UPDATE are not summed, but the UPDATE would flip them.
    The row-count check catches both mismatches: `rowCount !== row_count` gives 409
    `DIVIDEND_STATE_CHANGED`, the whole payout is rolled back, and the next call pays the
    complete set.
  - `if (res.dedup) continue;` skips the `PENDING -> PAID` update when `creditWallet`
    reports a duplicate reference. That would leave the payout `PENDING` with no credit
    in this run. It is **unreachable today**, because `txnRef` is random per call, so the
    per-investor reference `${txnRef}-u${id}` never repeats. If `txnRef` ever becomes
    deterministic, this branch must mark the rows `PAID` (the earlier credit is the
    payment) instead of skipping them.
  - The 409 for 55P03/40P01 covers any statement before `COMMIT`, not only the lock
    statements. To keep that from misleading, the message says only that the payout did
    not complete and nothing was paid ("Malipo hayakukamilika kwa sababu ya shughuli
    nyingine zinazoendelea. Hakuna kilicholipwa. Jaribu tena baadaye."). `logger.warn`
    records the step reached (`stage`: `payout-lock`, `users-lock`, `credit`,
    `mark-paid`) with `e.table` and `e.routine` when PostgreSQL provides them.
  - **Investors with zero entitlement are skipped without an UPDATE.** In the loop,
    `if (amt <= 0) continue;` runs before `creditWallet` and before the
    `PENDING -> PAID` UPDATE. An investor whose summed `PENDING` entitlement is 0 is
    neither credited nor marked: the rows stay `PENDING` after a successful payout and
    are summed (and skipped) again on every later run. This is unreachable in theory
    today: `entitlement` has `CHECK (entitlement >= 0)` (migration 132), and
    `processIncomingRevenue` does not insert rows with `entitlement <= 0`
    (`if (entitlement <= 0) continue;`, `src/services/projectFinanceService.js:401`). A
    future writer of zero rows would make it reachable. No code change in E0.
  - **`ROLLBACK` is swallowed silently.** The `catch` runs
    `await client.query('ROLLBACK').catch(() => {})`, so a failed rollback leaves no log
    and the original error is thrown, then `finally` returns the connection with
    `client.release()`. `src/config/db.js` limits the damage: `trackTransactionState`
    clears `__afrikobaInTx` only after a **successful** ROLLBACK/COMMIT, so `safeRelease`
    (db.js:216) sees the client still in a transaction and sends `ROLLBACK` again. If
    that also fails, it releases **with an error** (`doRelease(rbErr3)`), and pg destroys
    that connection instead of reusing it. A failed rollback is therefore not reused as a
    dirty connection, but it is still not logged. No code change in E0. Logging it is a
    small follow-up for all `ROLLBACK ... .catch(() => {})` sites.
- **The same pattern may exist on other money paths of projectFinanceService.** These
  are read-only notes, and none of these paths were changed. An earlier version of this
  item gave wrong line numbers for `forceCloseFunding` (2640/2646/2659); the corrected
  references and the plan are in **item 22**. `releaseCloseOutFund` (BEGIN `:3221`,
  `creditWallet` `:3224`) and `executeDisbursement` (BEGIN `:968`, `FOR UPDATE` `:979`,
  `creditWallet` `:1020`) each credit a single user. Their state transitions should be
  reviewed for the same "unlocked read + unchecked UPDATE" pattern.
- **Detecting past double payments (read-only, for production; NOT run by Claude Code).**
  Written from the migrations and the payout code, **not executed anywhere**. **The
  owner runs it by hand on production**, not Claude Code. It returns ids, amounts and
  references only (no names, phone numbers or message text).
  - The basis: since the payout was introduced (commit 079d185, 2026-09-14), each investor
    credit is a `financial_operations` row (migration 033). It has `operation_type =
    'CREDIT'`, `status = 'SUCCESS'` and `reference_id = '<txnRef>-u<investor_user_id>'`,
    where `txnRef = 'PROJECT_DIVIDEND_PAYOUT-<8 hex>-<project_id>'`
    (`generateReference` in `src/utils/helpers.js`). A successful run writes `txnRef` to
    `project_investor_payouts.payout_setting_reference` (migration 132) on the rows it
    flipped. In the B2 race, the losing call's UPDATE changed 0 rows, so **its `txnRef`
    appears in no payout row**.
  - Query A, the one requested: an investor with more than one dividend CREDIT for one
    project in one day, within a chosen period. A second legitimate payout on the same
    day (a new revenue paid out again) also shows here, so confirm with B or C.
    ```sql
    -- psql: \set from '2026-09-14'  \set to '2026-12-01'
    BEGIN READ ONLY;
    SET LOCAL statement_timeout = '60s';
    WITH div AS (
      SELECT fo.id, fo.user_id AS investor_user_id, fo.amount, fo.created_at, fo.reference_id,
             (regexp_match(fo.reference_id,
                '^PROJECT_DIVIDEND_PAYOUT-[0-9A-F]{8}-([0-9]+)-u[0-9]+$'))[1]::int AS project_id
        FROM financial_operations fo
       WHERE fo.operation_type = 'CREDIT'
         AND fo.status = 'SUCCESS'
         AND fo.reference_id LIKE 'PROJECT\_DIVIDEND\_PAYOUT-%'
         AND fo.created_at >= :'from' AND fo.created_at < :'to'
    )
    SELECT project_id, investor_user_id, created_at::date AS day,
           COUNT(*) AS credits, SUM(amount) AS credited_total,
           array_agg(id ORDER BY created_at) AS financial_operation_ids,
           array_agg(reference_id ORDER BY created_at) AS references
      FROM div
     GROUP BY project_id, investor_user_id, created_at::date
    HAVING COUNT(*) > 1
     ORDER BY day, project_id, investor_user_id;
    ROLLBACK;
    ```
  - Query B, confirmation by amount: credited total greater than the entitlement marked
    `PAID`, per project and investor. Any positive `excess` is money paid twice.
    ```sql
    BEGIN READ ONLY;
    SET LOCAL statement_timeout = '60s';
    WITH credited AS (
      SELECT (regexp_match(reference_id,
                '^PROJECT_DIVIDEND_PAYOUT-[0-9A-F]{8}-([0-9]+)-u[0-9]+$'))[1]::int AS project_id,
             user_id AS investor_user_id, COUNT(*) AS credits, SUM(amount) AS credited_total
        FROM financial_operations
       WHERE operation_type = 'CREDIT' AND status = 'SUCCESS'
         AND reference_id LIKE 'PROJECT\_DIVIDEND\_PAYOUT-%'
       GROUP BY 1, 2
    ), entitled AS (
      SELECT project_id, investor_user_id, SUM(entitlement) AS paid_entitlement
        FROM project_investor_payouts WHERE status = 'PAID'
       GROUP BY 1, 2
    )
    SELECT c.project_id, c.investor_user_id, c.credits, c.credited_total,
           COALESCE(e.paid_entitlement, 0) AS paid_entitlement,
           c.credited_total - COALESCE(e.paid_entitlement, 0) AS excess
      FROM credited c
      LEFT JOIN entitled e USING (project_id, investor_user_id)
     WHERE c.credited_total - COALESCE(e.paid_entitlement, 0) > 0.005
     ORDER BY excess DESC;
    ROLLBACK;
    ```
  - Query C, the losing call's credits: dividend credits whose batch `txnRef` was never
    written to a payout row of that investor (the B2 signature).
    ```sql
    BEGIN READ ONLY;
    SET LOCAL statement_timeout = '60s';
    SELECT fo.id AS financial_operation_id, fo.user_id AS investor_user_id,
           (regexp_match(fo.reference_id,
              '^PROJECT_DIVIDEND_PAYOUT-[0-9A-F]{8}-([0-9]+)-u[0-9]+$'))[1]::int AS project_id,
           fo.amount, fo.created_at, fo.reference_id
      FROM financial_operations fo
     WHERE fo.operation_type = 'CREDIT' AND fo.status = 'SUCCESS'
       AND fo.reference_id LIKE 'PROJECT\_DIVIDEND\_PAYOUT-%'
       AND NOT EXISTS (
             SELECT 1 FROM project_investor_payouts p
              WHERE p.investor_user_id = fo.user_id
                AND p.payout_setting_reference = regexp_replace(fo.reference_id, '-u[0-9]+$', ''))
     ORDER BY fo.created_at;
    ROLLBACK;
    ```
  - Any row found is a case for finance and reconciliation. It is not corrected
    automatically, and no correction script is part of E0.

## 17. Dividend payout: 409 on lock timeout or deadlock, and `lock_timeout`

- `src/config/db.js` keeps `lock_timeout: 3000` for production; **it is not changed**.
  The 409 path relies on it.
- **Contract:** before `COMMIT`, PostgreSQL `55P03` (lock wait over 3 s) or `40P01`
  (deadlock) is translated into `ValidityError` 409 code `DIVIDEND_PAYOUT_IN_PROGRESS`,
  message "Malipo hayakukamilika kwa sababu ya shughuli nyingine zinazoendelea. Hakuna
  kilicholipwa. Jaribu tena baadaye." It is logged with `logger.warn` together with the
  error code, `projectId`, `stage` (`payout-lock` / `users-lock` / `credit` /
  `mark-paid`), and `e.table` / `e.routine` when present.
  It is **not** `already_paid`: the payment state was not confirmed, the transaction was
  rolled back, and nothing was paid by that call.
- Every other database error propagates unchanged (tested with 40001). Errors after
  `COMMIT` are never mapped (`committed` flag).
- The route handler sends this as HTTP 409 via `errorHandler`. `localizeError` keeps the
  message, because the code has no i18n key. **Proven over HTTP** in test 6 (the real
  route, `authRequired`, `requireRoles`, the i18n middleware and `errorHandler`, driven by
  supertest). The `code` reaches the client in both cases:
  - `409 {"success":false,"code":"DIVIDEND_PAYOUT_IN_PROGRESS","message":"Malipo
    hayakukamilika kwa sababu ya shughuli nyingine zinazoendelea. Hakuna kilicholipwa.
    Jaribu tena baadaye."}`
  - `409 {"success":false,"code":"DIVIDEND_STATE_CHANGED","message":"Hali ya malipo ya
    mgawanyo imebadilika wakati wa kulipa; hakuna kilicholipwa, jaribu tena."}`
  - A retry after the first payout committed returns
    `200 {"success":true,"paid":[],"total":0,"already_paid":true}`, and the investor was
    paid once.
- Tests: lock held beyond 3 s gives 409 after about 3007 ms, and the next call returns
  `already_paid` (logged stage `payout-lock`); a forced `40P01` gives 409, a
  `logger.warn` entry with code, projectId and stage `mark-paid`, nothing paid, and the
  retry pays once; a forced `55P03` inside `creditWallet` gives the same 409, stage
  `credit` with `table`/`routine`, and nothing paid.

## 18. Deadlock in `financialEngine.creditWallet` (lock upgrade); local fix only

- **Cause:** `creditWallet` calls `claimOperation` first. Its `INSERT INTO
  financial_operations` FK check takes `FOR KEY SHARE` on the user row, and two
  transactions can hold that at the same time. Then each one asks for
  `SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE`, which waits for the other's
  KEY SHARE. The result is a deadlock (`40P01`). The server log shows both processes
  waiting at that statement on the same `users` tuple.
- **Evidence:** this predates E0. At HEAD, two payouts of different projects sharing
  investors deadlocked in the load test (2 deadlocks). A deterministic barrier test (3a)
  holds both at `creditWallet`'s `FOR UPDATE`. Without the users lock, both arrive holding
  KEY SHARE and deadlock every time (server `deadlock detected`, `pg_stat_database.deadlocks`
  0 -> 1). Money stays correct, because the deadlock victim is rolled back in full.
- **Current fix is local to `payProjectDividends`:** lock order is payouts first
  (`ORDER BY investor_user_id`), then `users` (`ORDER BY id`, `FOR UPDATE`), then
  `creditWallet`. With the users lock taken first, a second payout blocks before it takes
  any KEY SHARE, so there is no upgrade cycle.
- **The permanent fix is a separate step:** lock the user row `FOR UPDATE` inside
  `creditWallet` **before** `claimOperation` (and the same for `debitWallet` and the other
  engine operations that follow the claim-then-lock order). That touches about 56 call
  sites across `src` and every money path, so it needs its own tests and review.
- **Reverse lock order elsewhere (read-only report, not changed):** no other code in `src`
  locks `project_investor_payouts` (only `payProjectDividends` uses `FOR UPDATE` on it),
  and no code takes `users` and then the payout rows. The paths below can still deadlock
  with a dividend payout **on the `users` rows**, because they lock several investors in a
  different order:
  - `processIncomingRevenue`: `src/services/projectFinanceService.js:358` reads the
    `CONFIRMED` investors without `ORDER BY`. The `INSERT INTO project_investor_payouts`
    at `:404` takes FK `FOR KEY SHARE` on each investor in that unordered sequence.
    Against a payout holding `users FOR UPDATE` in id order, this can form a cycle. The
    payout side then returns 409 (item 17); the revenue side gets a raw 40P01.
  - `completeProject`: credits investors in `project_investments.id` order (`:1905`/`:1943`),
    not user id order.
  - `forceCloseFunding`: credits investors in unspecified order (`:2640`/`:2659`).
  These should adopt "lock users by id first" or the engine-level fix above.

## 19. Wait time grows with the number of investors

- The payout holds the `users` locks of all its investors (and the payout row locks)
  until `COMMIT`. Any other wallet operation on those users, or a second payout of the
  same project, waits that long. Beyond `lock_timeout` (3 s) it fails: a payout gets 409
  (item 17), other operations get their own 55P03.
- **What the earlier "N = 800: 3874 ms" was.** It was the wall time for **both calls
  together**, measured from starting call 1 until both returned. Because call 1 returns
  last, that is effectively **call 1's total time**, including the work after COMMIT
  (audit log, one notification per investor, outbox). It was **not** call 2's lock wait,
  and it is not compared with `lock_timeout`. `lock_timeout` (3000 ms) applies to
  **one statement's wait for a lock**. Call 2 waits at the payout-lock statement until
  call 1 COMMITs, so the number that matters is call 1's time in the locked section.
- **Measured again with per-statement timings** (test 5 now records, per connection, when
  the payout-lock statement is sent and returns, and when COMMIT returns; local
  container, `P71_SCALE_INVESTORS=N`, call 2 starts 50 ms after call 1):

  | N | call 1 locked section (lock granted → COMMIT done) | call 2 lock wait | call 1 total (incl. post-COMMIT) | call 2 result |
  |---|---|---|---|---|
  | 200 | 724 ms | 674 ms | 1122 ms | `already_paid` |
  | 400 | 1334 ms | 1289 ms | 2062 ms | `already_paid` |
  | 800 | 2646 ms | 2604 ms | 4010 ms | `already_paid` |
  | 1000 | 3040 ms | 2993 ms | 4907 ms | `already_paid` (7 ms under the limit) |
  | 1100 | 3319 ms | 3004 ms (cut off) | 5345 ms | **409 `DIVIDEND_PAYOUT_IN_PROGRESS`** |
  | 1200 | 3385 ms | 3005 ms (cut off) | 5488 ms | **409 `DIVIDEND_PAYOUT_IN_PROGRESS`** |

  The locked section costs about **3 ms per investor** (≈ 3.0–3.3 ms here). In every run,
  each investor was paid exactly once, including the 409 runs.
- **When call 2 starts getting 409:** when call 1's locked section, minus the delay before
  call 2 reaches the lock, exceeds 3000 ms. On this container that is **between N = 1000
  and N = 1100** (≈ 3000 / 3 ms ≈ 1000 investors). In production, the per-investor cost
  is higher (network round trips to the DB, real load), so the threshold is **lower**. If
  production costs 2× per investor, the threshold is about N ≈ 500. The same limit applies
  to **any other wallet operation** on those investors (deposit, withdrawal, transfer)
  while the payout runs: it waits on the `users` lock and gets its own 55P03 after 3 s.
- Production latency is higher than a local container. Before projects with several
  hundred investors pay out:
  - measure the locked section in production (logger or `pg_stat_statements`);
  - consider batching very large payouts (for example 300 investors per transaction).

## 20. Dividend route has no idempotency

- `POST /projects/:id/dividend/payout` (`src/routes/projectRoutes.js:257`) does not use
  the `idempotent` middleware. Even if it did, it would not help without an
  `Idempotency-Key` from the client: the middleware passes a request without the header
  straight through (`src/middleware/idempotent.js:201`), and the service generates a
  random `txnRef` per call, so there is no stable key to dedup on.
- Today's protection is the row locks plus the `PENDING` state (item 16). A retried
  request after success returns `already_paid`, not the original response.
- **To do:** require an `Idempotency-Key` on this route (wrap it in `idempotent(...)`),
  so a client retry gets the cached first response.

## 21. Production note for E0

- **E0 needs no migration** and changes only `payProjectDividends`
  (src/services/projectFinanceService.js). It fixes a money bug that exists in production
  today (item 16), so it **can be released early and on its own**, ahead of the rest of
  Phase 71 (items 11 and 14).
- Behaviour change for clients: a second payout request while one is running now waits,
  then returns `already_paid`; or, after 3 s, returns HTTP 409 `DIVIDEND_PAYOUT_IN_PROGRESS`
  ("try again later"). Before, it paid a second time. Admin tooling should treat 409 as
  "retry later", not as a failure that needs manual action.
- **The E0 commit sits on top of Steps A–D (and C)** on `phase71-outbox-hardening`
  (baseline HEAD 6739401). A release of E0 on its own **must not** take that branch as
  it is.
  - Before that release, E0 must be applied to the **production base**: cherry-pick the
    single E0 commit onto a branch cut from what production runs (its tag or commit), or
    build a separate branch from production.
  - Then run the E0 suite (`tests/project-dividend-concurrency.phase71.test.js`) again
    **on that base**, against a disposable `phase71_financial_audit_*` database, and
    record PASS/FAIL there. A pass on this branch does not prove a pass on the production
    base.
  - E0 itself touches only `payProjectDividends`. The cherry-pick should apply without
    conflict unless production's version of that function differs, and any conflict
    must be reviewed, not auto-resolved.
- **The release on its own needs no migration**: E0 uses only existing tables, columns and
  indexes.
- **After the release, check the logs** for `PROJECT_DIVIDEND_PAYOUT` warnings and their
  `stage`:
  - `payout-lock` means a second request while a payout was running: expected and
    harmless.
  - `users-lock` or `credit` means the payout waited on another wallet operation of the
    same investors. Watch how often it happens.
  - `mark-paid` is unexpected and should be investigated.
  - Repeated 409s for the same project suggest the payout is too large for 3 s (item 19).
- **409 is a "retry later" answer, not a system failure.** Both 409 codes
  (`DIVIDEND_PAYOUT_IN_PROGRESS` and `DIVIDEND_STATE_CHANGED`) mean the call was rolled
  back in full and nothing was paid. They must not page on-call or be counted as 5xx
  errors. The client retries later, and the retry either pays once or returns
  `already_paid`.

## 22. P1, NOT VERIFIED: other money paths that may refund or pay twice (E0b)

**Status: NOT VERIFIED. No test proves these yet.** This is a code reading of
`src/services/projectFinanceService.js` (line numbers from the working tree with E0). It
follows the same pattern as B2 (item 16): a read with no lock, a loop that moves money
with a **random** reference (so `creditWallet` cannot dedup), and a state UPDATE that
neither re-checks the old state nor checks its row count. **None of this code was changed
in E0, and no test for it is in the E0 commit.**

- **`forceCloseFunding` (REFUND), likely to refund twice.**
  - `:2594` reads the project with `pool.query`, outside any transaction, and `:2640`
    checks `status` in memory. Nothing locks the project.
  - `:2644` reads the `CONFIRMED` investments with `pool.query`, **before `BEGIN`**
    (`:2651`), with no `FOR UPDATE` and no `ORDER BY`.
  - In the loop, `:2654` makes a random reference (`generateReference('PREF')`).
    `:2656` runs `UPDATE project_investments SET ... status = 'REFUNDED' WHERE id = $2`,
    with **no `AND status = 'CONFIRMED'`** and no row-count check. `:2659`/`:2661`
    decrement the amount raised and the escrow balance (`GREATEST(..., 0)` hides
    over-decrement). `:2664` runs `creditWallet`.
  - `:2677` sets the project to `CANCELLED` with no status condition.
  - Two parallel REFUND calls both read the same list before either begins. The second
    waits on the first's `project_investments` row lock, then updates the row again,
    because there is no status condition, and credits each investor a second time with a
    new reference.
  - Side note: `createNotification(...)` at `:2670` runs inside the loop, before
    `COMMIT`. It uses its own connection, so an investor can be told "refunded" for a
    refund that is later rolled back.
- **`completeProject`, may return the escrow twice.**
  - `:1900` checks for an existing settlement with `pool.query`, outside the
    transaction, with no lock. `project_settlements` has **no UNIQUE on `project_id`**,
    only an index (migration 134). `:1898` checks `status = 'ACTIVE'` on a read made
    outside the transaction.
  - `:1910` reads investors inside the transaction with no lock (`ORDER BY id ASC`,
    investment id rather than user id). `:1920` reads `remaining_balance` with **no
    `FOR UPDATE`**.
  - The investors are credited at `:1948`, with reference
    `SETTLE-<projectId>-<Date.now()>-u<id>`, which is unique per call. The owner is
    credited at `:1972`.
  - Only then come the state UPDATEs: `:2010`
    `UPDATE controlled_project_accounts ... WHERE status <> 'CLOSED'`, with no row-count
    check; `:2017` `INSERT INTO project_settlements`, which does not fail on a duplicate;
    and `:2033` `UPDATE projects SET status = 'COMPLETED' WHERE id = $1`, with no status
    condition.
  - Two parallel calls both see no settlement and the same escrow. Both credit it. The
    second's escrow UPDATE changes 0 rows unnoticed, and it commits a second settlement.
- **`processIncomingRevenue`, may record entitlements twice (paid twice later) and may
  deadlock.**
  - Replay is protected **only when the caller sends `unique_reference`**: `claimOperation`
    (`:309`) turns a repeat into 409. Without it, `:304` generates a random reference, so a
    client retry records a **second revenue**. Its `project_investor_payouts` rows have
    new `payout_reference`s (`:402`), so `ON CONFLICT (payout_reference) DO NOTHING`
    (`:407`) does not stop them, and the next payout pays both.
  - `:358` reads the `CONFIRMED` investors with no lock and **no `ORDER BY`**. The
    `INSERT INTO project_investor_payouts` at `:404` takes FK `FOR KEY SHARE` on each
    investor in that unordered sequence, which is a deadlock path against a payout
    holding `users FOR UPDATE` in id order (item 18). An investment confirmed or refunded
    concurrently can also be included or left out.
- **Plan for E0b (same method as E0, its own step and commit):**
  1. For each path, a **parallel test that fails first** on the current code, using a
     real gate before `COMMIT`, a diagnostic connection and `pg_stat_activity` lock
     detection. It must show the double refund or payment with exact wallet, CREDIT,
     journal and state numbers, and for `processIncomingRevenue`, the retry without
     `unique_reference`. Disposable `phase71_financial_audit_*` DB, axios stubbed,
     127.0.0.1 only.
  2. Only after that failure is shown, apply the fix:
     - Lock the state row inside the transaction (`projects` / `controlled_project_accounts`
       / `project_investments` `FOR UPDATE`, in a fixed order).
     - Move the reads inside the transaction.
     - Re-check the old state in every UPDATE (`AND status = 'CONFIRMED'`,
       `AND status = 'ACTIVE'`), and check the row count, or a UNIQUE on
       `project_settlements(project_id)` through a migration.
     - Lock users `ORDER BY id` before crediting.
     - Map 55P03/40P01 to 409 as in item 17.
  3. Mutations that remove each guard, and the suites rerun, as in E0.
  4. Production check (read-only, run by the owner) for past double refunds or
     settlements, in the style of item 16.
