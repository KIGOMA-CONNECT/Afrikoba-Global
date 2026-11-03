'use strict';
// Integration wrapper for backup attempts (Phase 68 E). Runs the backup command
// as a child process (no shell), verifies the newest archive, persists monitor
// state to a file, and delegates alerting to backupFailureMonitor.
// Not wired into host cron. /usr/local/sbin/afrikoba-backup is not called by this module.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');
const monitor = require('./backupFailureMonitor');

function newestArchive(dir, pattern) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const matches = entries.filter((f) => pattern.test(f)).map((f) => {
    const full = path.join(dir, f);
    return { full, mtime: fs.statSync(full).mtimeMs };
  });
  if (!matches.length) return null;
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches[0].full;
}

function verifyArchive(file) {
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return monitor.classifyArchive({ gzipOk: false, dumpMagic: null });
  }
  let inflated;
  try {
    inflated = zlib.gunzipSync(raw);
  } catch {
    return monitor.classifyArchive({ gzipOk: false, dumpMagic: null });
  }
  return monitor.classifyArchive({ gzipOk: true, dumpMagic: inflated.subarray(0, 5).toString('latin1') });
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve({ exitCode: 0, stderr: '' });
      const code = typeof error.code === 'number' ? error.code : null;
      resolve({ exitCode: code, stderr: String(stderr || error.message || '').slice(-300) });
    });
  });
}

function readState(stateFile) {
  try {
    return { ...monitor.initialState(), ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
  } catch {
    return monitor.initialState();
  }
}

function writeStateAtomic(stateFile, state) {
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile);
}

// One monitored attempt. Returns { state, action, alert, attempt }.
async function runMonitoredBackup({
  command, args = [], archiveDir, archivePattern, stateFile,
  maxAttempts = 3, alertingEnabled = false, sendAlert = null,
  timeoutMs = 10 * 60 * 1000, now = () => new Date().toISOString(),
}) {
  const at = now();
  const run = await runCommand(command, args, timeoutMs);
  let attempt;
  if (run.exitCode !== 0) {
    attempt = { ok: false, at, error: `exit ${run.exitCode}: ${run.stderr}`.trim() };
  } else {
    const file = newestArchive(archiveDir, archivePattern);
    if (!file) {
      attempt = { ok: false, at, error: 'MISSING_ARCHIVE' };
    } else {
      const v = verifyArchive(file);
      attempt = v.ok ? { ok: true, at } : { ok: false, at, error: v.reason };
    }
  }
  const prev = readState(stateFile);
  const result = await monitor.handleAttempt({ state: prev, attempt, maxAttempts, alertingEnabled, sendAlert });
  writeStateAtomic(stateFile, result.state);
  return { ...result, attempt };
}

module.exports = { runMonitoredBackup, newestArchive, verifyArchive, readState };
