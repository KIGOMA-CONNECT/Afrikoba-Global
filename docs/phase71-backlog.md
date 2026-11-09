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
