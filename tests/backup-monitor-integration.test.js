'use strict';
// Phase 68 E: integration tests for the backup monitor runner.
// Real child processes and real files in a temp dir. Alert sender is a test double.
// No host script, no cron, no SMS, no upload.

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const runner = require(path.join(__dirname, '..', 'src', 'jobs', 'backupMonitorRunner'));

const NODE = process.execPath;
const WRITE_GOOD = `require('fs').writeFileSync(process.argv[1], require('zlib').gzipSync(Buffer.from('PGDMP-test-archive')))`;
const WRITE_CORRUPT = `require('fs').writeFileSync(process.argv[1], Buffer.from('this is not gzip'))`;
const WRITE_NOT_PG = `require('fs').writeFileSync(process.argv[1], require('zlib').gzipSync(Buffer.from('-- plain SQL dump')))`;

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p68-bmon-'));
  const archiveDir = path.join(dir, 'backups');
  fs.mkdirSync(archiveDir);
  return { dir, archiveDir, stateFile: path.join(dir, 'state.json') };
}

let tick = 0;
const now = () => `2026-10-29T02:${String(tick++ % 60).padStart(2, '0')}:00Z`;

function opts(ws, cmd, extra = {}) {
  const archivePath = path.join(ws.archiveDir, `afrikoba_global_${Date.now()}_${tick}.sql.gz`);
  const { script } = cmd;
  return {
    command: NODE,
    args: script.body !== undefined
      ? ['-e', script.body, archivePath]
      : ['-e', `process.exit(${script.exit})`],
    archiveDir: ws.archiveDir,
    archivePattern: /^afrikoba_global_.*\.sql\.gz$/,
    stateFile: ws.stateFile,
    maxAttempts: 3,
    now,
    ...extra,
  };
}

const exitCmd = (code) => ({ script: { exit: code } });
const goodCmd = () => ({ script: { body: WRITE_GOOD } });
const corruptCmd = () => ({ script: { body: WRITE_CORRUPT } });
const notPgCmd = () => ({ script: { body: WRITE_NOT_PG } });
const noArchiveCmd = () => ({ script: { exit: 0 } });

const readStateFile = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const recorder = (fail = false) => {
  const calls = [];
  const fn = async (alert) => {
    calls.push(alert);
    if (fail) throw new Error('alert transport unavailable');
  };
  fn.calls = calls;
  return fn;
};

scenario('I1 exit 0 with valid PGDMP archive: OK, state persisted', async () => {
  const ws = workspace();
  const r = await runner.runMonitoredBackup(opts(ws, goodCmd()));
  assert.strictEqual(r.attempt.ok, true);
  assert.strictEqual(r.state.status, 'OK');
  assert.strictEqual(readStateFile(ws.stateFile).status, 'OK');
});

scenario('I2 non-zero exit: RETRYING with exit code recorded', async () => {
  const ws = workspace();
  const r = await runner.runMonitoredBackup(opts(ws, exitCmd(3)));
  assert.strictEqual(r.state.status, 'RETRYING');
  assert.strictEqual(r.state.consecutiveFailures, 1);
  assert.match(r.state.lastError, /exit 3/);
});

scenario('I3 exit 0 but no archive produced: MISSING_ARCHIVE', async () => {
  const ws = workspace();
  const r = await runner.runMonitoredBackup(opts(ws, noArchiveCmd()));
  assert.strictEqual(r.attempt.ok, false);
  assert.strictEqual(r.attempt.error, 'MISSING_ARCHIVE');
  assert.strictEqual(r.state.status, 'RETRYING');
});

scenario('I4 corrupt archive (not gzip): GZIP_INTEGRITY_FAILED', async () => {
  const ws = workspace();
  const r = await runner.runMonitoredBackup(opts(ws, corruptCmd()));
  assert.strictEqual(r.attempt.error, 'GZIP_INTEGRITY_FAILED');
  assert.strictEqual(r.state.status, 'RETRYING');
});

scenario('I5 gzip but not a PostgreSQL custom archive: NOT_PG_CUSTOM_ARCHIVE', async () => {
  const ws = workspace();
  const r = await runner.runMonitoredBackup(opts(ws, notPgCmd()));
  assert.strictEqual(r.attempt.error, 'NOT_PG_CUSTOM_ARCHIVE');
});

scenario('I6 repeated failures to exhaustion with alerting ON: exactly one alert', async () => {
  const ws = workspace();
  const send = recorder();
  const o = { alertingEnabled: true, sendAlert: send };
  for (let i = 0; i < 4; i++) await runner.runMonitoredBackup(opts(ws, exitCmd(1), o));
  const s = readStateFile(ws.stateFile);
  assert.strictEqual(s.status, 'EXHAUSTED');
  assert.strictEqual(s.consecutiveFailures, 4);
  assert.strictEqual(send.calls.length, 1);
  assert.strictEqual(send.calls[0].type, 'BACKUP_RETRY_EXHAUSTED');
});

scenario('I7 exhaustion with alerting OFF: suppressed, nothing sent, EXHAUSTED persisted', async () => {
  const ws = workspace();
  const send = recorder();
  let last;
  for (let i = 0; i < 3; i++) last = await runner.runMonitoredBackup(opts(ws, exitCmd(1), { sendAlert: send }));
  assert.strictEqual(last.action, 'ALERT_SUPPRESSED');
  assert.strictEqual(send.calls.length, 0);
  assert.strictEqual(readStateFile(ws.stateFile).status, 'EXHAUSTED');
});

scenario('I8 success after exhaustion resets state; a later exhaustion alerts again', async () => {
  const ws = workspace();
  const send = recorder();
  const o = { alertingEnabled: true, sendAlert: send };
  for (let i = 0; i < 3; i++) await runner.runMonitoredBackup(opts(ws, exitCmd(1), o));
  const ok = await runner.runMonitoredBackup(opts(ws, goodCmd(), o));
  assert.strictEqual(ok.state.status, 'OK');
  assert.strictEqual(readStateFile(ws.stateFile).consecutiveFailures, 0);
  for (let i = 0; i < 3; i++) await runner.runMonitoredBackup(opts(ws, exitCmd(1), o));
  assert.strictEqual(send.calls.length, 2);
});

scenario('I9 alert transport failure: recorded in state, retried on next failed run', async () => {
  const ws = workspace();
  const send = recorder(true);
  const o = { alertingEnabled: true, sendAlert: send };
  let r;
  for (let i = 0; i < 3; i++) r = await runner.runMonitoredBackup(opts(ws, exitCmd(1), o));
  assert.strictEqual(r.action, 'ALERT_FAILED');
  const persisted = readStateFile(ws.stateFile);
  assert.strictEqual(persisted.alertFailures, 1);
  assert.strictEqual(persisted.alertedForEpisode, false);

  const recover = recorder();
  const next = await runner.runMonitoredBackup(opts(ws, exitCmd(1), { alertingEnabled: true, sendAlert: recover }));
  assert.strictEqual(next.action, 'ALERT_SENT');
  assert.strictEqual(recover.calls.length, 1);
});

scenario('I10 backup command missing entirely: failure recorded, no crash', async () => {
  const ws = workspace();
  const r = await runner.runMonitoredBackup(opts(ws, exitCmd(0), {
    command: path.join(ws.dir, 'no-such-binary-xyz'), args: [],
  }));
  assert.strictEqual(r.state.status, 'RETRYING');
  assert.strictEqual(r.attempt.ok, false);
});

scenario('I11 newest archive is the one verified (older corrupt file is ignored)', async () => {
  const ws = workspace();
  fs.writeFileSync(path.join(ws.archiveDir, 'afrikoba_global_old.sql.gz'), 'garbage');
  const old = Date.now() - 60_000;
  fs.utimesSync(path.join(ws.archiveDir, 'afrikoba_global_old.sql.gz'), old / 1000, old / 1000);
  const r = await runner.runMonitoredBackup(opts(ws, goodCmd()));
  assert.strictEqual(r.attempt.ok, true);
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
