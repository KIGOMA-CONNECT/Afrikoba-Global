# Backup monitor — integration design and wiring plan

Status: **NOT WIRED.** The host cron, `/usr/local/sbin/afrikoba-backup`, and the alert transport are unchanged. Alerting, SMS, and offsite upload stay disabled. Wiring needs separate authorization.

## 1. What exists

| Component | Location | State |
|---|---|---|
| Host backup script | `/usr/local/sbin/afrikoba-backup` | Production, unchanged. Uses `set -eo pipefail`. Dumps to a temp file, runs `gzip -t`, checks for the `PGDMP` magic, then atomically moves the file into place. Exits non-zero on dump, gzip, or magic failure. |
| Retention | same script | `find ... -delete` is commented out with the note `TEMP DISABLED (retention safeguard 2026-10-13)`. Backups accumulate until the owner re-enables retention. |
| Cron | host crontab, `0 2 * * *`, output to `/opt/afrikoba/backups/backup.log` | Unchanged. |
| State machine | `src/jobs/backupFailureMonitor.js` | New. Pure logic: retry count, EXHAUSTED at `maxAttempts`, one alert per episode, reset on success, archive classification. |
| Runner | `src/jobs/backupMonitorRunner.js` | New. Runs a command as a child process (no shell), verifies the newest archive (gzip + `PGDMP`), writes state atomically to a JSON file, and calls the state machine. |
| Unit tests | `tests/backup-failure-monitor.test.js` | 9/9 pass. |
| Integration tests | `tests/backup-monitor-integration.test.js` | 11/11 pass. Real child processes and real files in a temp directory. |

## 2. Test coverage (integration)

| ID | Scenario | Result |
|---|---|---|
| I1 | exit 0, valid PGDMP archive | OK, state written |
| I2 | non-zero exit | RETRYING, exit code kept in `lastError` |
| I3 | exit 0, no archive | `MISSING_ARCHIVE` |
| I4 | exit 0, corrupt archive | `GZIP_INTEGRITY_FAILED` |
| I5 | exit 0, gzip but not PGDMP | `NOT_PG_CUSTOM_ARCHIVE` |
| I6 | repeated failures to exhaustion, alerting on | Exactly one alert |
| I7 | exhaustion, alerting off | Suppressed, nothing sent, EXHAUSTED persisted |
| I8 | success after exhaustion, then exhaustion again | State reset; second alert sent |
| I9 | alert transport fails | `ALERT_FAILED` persisted; next failed run retries |
| I10 | command does not exist | Recorded as failure, no crash |
| I11 | older corrupt archive plus newer valid one | Newest archive is verified |

## 3. Exit-code mapping (host script to monitor)

| Host script outcome | Exit code from host script | Monitor attempt |
|---|---|---|
| Success, archive published | 0 | ok, if the newest archive passes gzip and magic checks |
| Dump or gzip failure | non-zero (pipefail) | failure, `exit N` |
| Gzip integrity or magic failure | 1 | failure, `exit 1` |
| Success with no archive written | 0 | failure, `MISSING_ARCHIVE` (defensive) |
| Disk full during dump | non-zero | failure, `exit N` |

Note: the host script's own checks are the first line of defence. The monitor repeats the archive check on the published file so that a later corruption or a deleted file is also caught.

## 4. Wiring options

Option A (recommended): a wrapper that runs the host script through the runner.

```
0 2 * * * cd /var/www/afrikoba && node -e "require('./src/jobs/backupMonitorRunner').runMonitoredBackup({command:'/usr/local/sbin/afrikoba-backup',archiveDir:'/opt/afrikoba/backups',archivePattern:/^afrikoba_global_.*\.sql\.gz$/,stateFile:'/opt/afrikoba/backups/.monitor_state.json',maxAttempts:3,alertingEnabled:false}).then(r=>console.log(JSON.stringify({action:r.action,status:r.state.status})))" >> /opt/afrikoba/backups/backup.log 2>&1
```

- Retry: the wrapper calls the runner in a loop of up to 3 attempts, 10 minutes apart, stopping at the first success. The loop is not in this file yet.
- Alerts: `alertingEnabled: false`. Nothing is sent. The alert transport must be chosen by the owner and injected.
- The line above is a plan, not applied. Quoting and the `require` path must be tested in the isolated clone before any cron change.

Option B: a systemd timer that runs the same command. Equivalent behaviour, easier to log. Requires the same authorization.

## 5. Alert transport (owner decision)

No transport is configured. Choices, none enabled:

1. Email to a named operator distribution list.
2. Existing Beem SMS, which the owner currently keeps disabled.
3. Messaging to an internal channel.

Requirements for any transport: no secret values in the message body; a rate limit that matches "one per episode"; failures are recorded as `ALERT_FAILED` (already implemented).

## 6. Rollback

- Remove the cron line. The host script is untouched, so the previous behaviour returns.
- Delete `.monitor_state.json`. Nothing else depends on it.
- The runner writes only to the state file and to whatever `archiveDir` it is given. It does not delete archives.

## 7. Not in scope

- Re-enabling retention (`find ... -delete`). That is a separate owner decision, because it deletes evidence and backups.
- Offsite upload. Remains disabled.
- Changing `/usr/local/sbin/afrikoba-backup`.
