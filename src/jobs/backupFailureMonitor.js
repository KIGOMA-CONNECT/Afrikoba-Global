'use strict';
// Backup failure monitor (Phase 68 E). Pure state machine: no I/O, no network.
// Alert delivery is injected. Alerting is OFF unless the caller enables it, so
// nothing is sent (no SMS, no external notification) by default.

const STATES = Object.freeze({ OK: 'OK', RETRYING: 'RETRYING', EXHAUSTED: 'EXHAUSTED' });

function initialState() {
  return {
    status: STATES.OK,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    alertedForEpisode: false,
    alertFailures: 0,
  };
}

// A dump archive is valid only if gzip integrity passes and the decompressed
// stream starts with the PostgreSQL custom-format magic "PGDMP".
function classifyArchive({ gzipOk, dumpMagic }) {
  if (!gzipOk) return { ok: false, reason: 'GZIP_INTEGRITY_FAILED' };
  if (dumpMagic !== 'PGDMP') return { ok: false, reason: 'NOT_PG_CUSTOM_ARCHIVE' };
  return { ok: true, reason: null };
}

function recordAttempt(state, attempt, { maxAttempts }) {
  if (attempt.ok) {
    return { ...initialState(), lastSuccessAt: attempt.at };
  }
  const consecutiveFailures = state.consecutiveFailures + 1;
  return {
    ...state,
    status: consecutiveFailures >= maxAttempts ? STATES.EXHAUSTED : STATES.RETRYING,
    consecutiveFailures,
    lastFailureAt: attempt.at,
    lastError: String(attempt.error || 'unknown').slice(0, 300),
  };
}

// Processes one backup attempt. Returns { state, action, alert }.
// action: NONE | ALERT_SENT | ALERT_SUPPRESSED | ALERT_FAILED
async function handleAttempt({ state, attempt, maxAttempts, alertingEnabled = false, sendAlert = null }) {
  const next = recordAttempt(state, attempt, { maxAttempts });

  if (next.status !== STATES.EXHAUSTED || next.alertedForEpisode) {
    return { state: next, action: 'NONE', alert: null };
  }

  const alert = {
    type: 'BACKUP_RETRY_EXHAUSTED',
    consecutiveFailures: next.consecutiveFailures,
    lastError: next.lastError,
    lastSuccessAt: next.lastSuccessAt,
    at: attempt.at,
  };

  if (!alertingEnabled || typeof sendAlert !== 'function') {
    return { state: next, action: 'ALERT_SUPPRESSED', alert };
  }

  try {
    await sendAlert(alert);
    return { state: { ...next, alertedForEpisode: true }, action: 'ALERT_SENT', alert };
  } catch (error) {
    return {
      state: { ...next, alertFailures: next.alertFailures + 1, lastError: `${next.lastError} | alert failed: ${String(error.message).slice(0, 120)}` },
      action: 'ALERT_FAILED',
      alert,
    };
  }
}

module.exports = { STATES, initialState, classifyArchive, recordAttempt, handleAttempt };
