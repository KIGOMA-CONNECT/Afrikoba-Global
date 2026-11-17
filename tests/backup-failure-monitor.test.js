'use strict';
// Phase 68 E: backup failure detection, retry exhaustion and alert generation.
// Pure logic. Alert sender is a test double; nothing is sent and no I/O is done.

const path = require('path');
const assert = require('assert');
const m = require(path.join(__dirname, '..', 'src', 'jobs', 'backupFailureMonitor'));

const MAX = 3;
const t = (n) => `2026-10-29T02:0${n}:00Z`;
const fail = (n, error = 'pg_dump exit 1') => ({ ok: false, error, at: t(n) });
const ok = (n) => ({ ok: true, at: t(n) });

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

function recorder(behaviour = 'ok') {
  const calls = [];
  const fn = async (alert) => {
    calls.push(alert);
    if (behaviour === 'throw') throw new Error('smtp/sms endpoint unreachable');
  };
  fn.calls = calls;
  return fn;
}

async function runAttempts(attempts, opts) {
  let state = m.initialState();
  const actions = [];
  for (const a of attempts) {
    const r = await m.handleAttempt({ state, attempt: a, maxAttempts: MAX, ...opts });
    state = r.state;
    actions.push(r.action);
  }
  return { state, actions };
}

scenario('B1 success on first attempt: OK, no alert, no retry state', async () => {
  const send = recorder();
  const { state, actions } = await runAttempts([ok(0)], { alertingEnabled: true, sendAlert: send });
  assert.strictEqual(state.status, m.STATES.OK);
  assert.strictEqual(state.consecutiveFailures, 0);
  assert.strictEqual(state.lastSuccessAt, t(0));
  assert.deepStrictEqual(actions, ['NONE']);
  assert.strictEqual(send.calls.length, 0);
});

scenario('B2 single failure: RETRYING, no alert yet', async () => {
  const send = recorder();
  const { state, actions } = await runAttempts([fail(0)], { alertingEnabled: true, sendAlert: send });
  assert.strictEqual(state.status, m.STATES.RETRYING);
  assert.strictEqual(state.consecutiveFailures, 1);
  assert.strictEqual(state.lastError, 'pg_dump exit 1');
  assert.deepStrictEqual(actions, ['NONE']);
  assert.strictEqual(send.calls.length, 0);
});

scenario('B3 retry exhaustion with alerting OFF (default): EXHAUSTED, nothing sent', async () => {
  const send = recorder();
  const { state, actions } = await runAttempts([fail(0), fail(1), fail(2)], { sendAlert: send });
  assert.strictEqual(state.status, m.STATES.EXHAUSTED);
  assert.strictEqual(state.consecutiveFailures, MAX);
  assert.deepStrictEqual(actions, ['NONE', 'NONE', 'ALERT_SUPPRESSED']);
  assert.strictEqual(send.calls.length, 0, 'alert sent while alerting disabled');
  assert.strictEqual(state.alertedForEpisode, false, 'suppressed alert must stay pending for later');
});

scenario('B4 alerting ON: exhaustion alerts exactly once; further failures do not re-alert', async () => {
  const send = recorder();
  const { state, actions } = await runAttempts(
    [fail(0), fail(1), fail(2), fail(3), fail(4)],
    { alertingEnabled: true, sendAlert: send }
  );
  assert.strictEqual(state.status, m.STATES.EXHAUSTED);
  assert.deepStrictEqual(actions, ['NONE', 'NONE', 'ALERT_SENT', 'NONE', 'NONE']);
  assert.strictEqual(send.calls.length, 1);
  assert.strictEqual(send.calls[0].type, 'BACKUP_RETRY_EXHAUSTED');
  assert.strictEqual(send.calls[0].consecutiveFailures, MAX);
});

scenario('B5 alert generation/delivery failure is recorded, not swallowed; retried next run', async () => {
  const send = recorder('throw');
  const { state, actions } = await runAttempts([fail(0), fail(1), fail(2)], { alertingEnabled: true, sendAlert: send });
  assert.strictEqual(state.status, m.STATES.EXHAUSTED);
  assert.strictEqual(state.alertFailures, 1);
  assert.strictEqual(state.alertedForEpisode, false);
  assert.match(state.lastError, /alert failed: smtp\/sms endpoint unreachable/);
  assert.strictEqual(actions[2], 'ALERT_FAILED');

  const next = await m.handleAttempt({ state, attempt: fail(3), maxAttempts: MAX, alertingEnabled: true, sendAlert: recorder() });
  assert.strictEqual(next.action, 'ALERT_SENT', 'failed alert not retried on next failure');
});

scenario('B6 recovery re-arms the episode: a later exhaustion alerts again', async () => {
  const send = recorder();
  const { state, actions } = await runAttempts(
    [fail(0), fail(1), fail(2), ok(3), fail(4), fail(5), fail(6)],
    { alertingEnabled: true, sendAlert: send }
  );
  assert.strictEqual(state.status, m.STATES.EXHAUSTED);
  assert.strictEqual(state.lastSuccessAt, t(3));
  assert.deepStrictEqual(actions, ['NONE', 'NONE', 'ALERT_SENT', 'NONE', 'NONE', 'NONE', 'ALERT_SENT']);
  assert.strictEqual(send.calls.length, 2);
});

scenario('B7 alerting disabled but sender present: guard prevents any send', async () => {
  const send = recorder();
  const { actions } = await runAttempts([fail(0), fail(1), fail(2)], { alertingEnabled: false, sendAlert: send });
  assert.strictEqual(actions[2], 'ALERT_SUPPRESSED');
  assert.strictEqual(send.calls.length, 0);
});

scenario('B8 archive classification: gzip failure, wrong magic and valid archive', async () => {
  assert.deepStrictEqual(m.classifyArchive({ gzipOk: false, dumpMagic: 'PGDMP' }), { ok: false, reason: 'GZIP_INTEGRITY_FAILED' });
  assert.deepStrictEqual(m.classifyArchive({ gzipOk: true, dumpMagic: 'SQL -' }), { ok: false, reason: 'NOT_PG_CUSTOM_ARCHIVE' });
  assert.deepStrictEqual(m.classifyArchive({ gzipOk: true, dumpMagic: 'PGDMP' }), { ok: true, reason: null });
});

scenario('B9 long error text is truncated; attempt state is not mutated in place', async () => {
  const s0 = m.initialState();
  const s1 = m.recordAttempt(s0, { ok: false, error: 'x'.repeat(1000), at: t(0) }, { maxAttempts: MAX });
  assert.strictEqual(s1.lastError.length, 300);
  assert.strictEqual(s0.consecutiveFailures, 0);
});

(async () => {
  let failed = 0;
  for (const s of scenarios) {
    try {
      await s.fn();
      console.log(`PASS ${s.name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${s.name}\n     ${(e.stack || e.message).split('\n').slice(0, 3).join('\n     ')}`);
    }
  }
  console.log(`RESULT: ${scenarios.length - failed} passed, ${failed} failed of ${scenarios.length}`);
  process.exit(failed ? 1 : 0);
})();
