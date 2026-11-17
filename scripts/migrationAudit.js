/**
 * MTC-30 / G3 — Migration execution audit metadata and authorization traceability.
 *
 * Append-only JSONL audit log with a SHA-256 hash chain. Every record carries:
 *   schemaVersion, seq, event, at, runId, prev, hash,
 *   authorization {fingerprint, source}, runner {name, version, node},
 *   plus event-specific metadata (version, sha256, decisionId, outcome, durationMs).
 *
 * Raw authorization tokens are NEVER stored: only sha256(token) is recorded.
 *
 * The log is local to the runner host (default logs/migration-audit.jsonl) and is
 * only written on an authorized execution path. Preview/dry-run and blocked runs
 * write nothing.
 *
 * This module performs no SQL and no network access.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUDIT_SCHEMA_VERSION = 1;
const DEFAULT_AUDIT_PATH = path.join(__dirname, '..', 'logs', 'migration-audit.jsonl');
const DEFAULT_RUNNER = Object.freeze({ name: 'runMigrations', version: 'MTC-30', node: process.version });

class AuditError extends Error {
  constructor(code, message, violations = []) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    this.violations = violations;
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    const parts = Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]));
    return '{' + parts.join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function authorizationFingerprint(token) {
  return token ? sha256(String(token)) : null;
}

function hashRecord(record) {
  const copy = { ...record };
  delete copy.hash;
  return sha256(stableStringify(copy));
}

/**
 * Verifies every line's record hash and the prev-hash chain.
 * Returns { ok, count, lastHash, violations }.
 */
function verifyAuditLog(file = DEFAULT_AUDIT_PATH, { fsImpl = fs, expectedCount = null, expectedLastHash = null } = {}) {
  if (!fsImpl.existsSync(file)) {
    const violations = [];
    if (expectedCount !== null && expectedCount > 0) violations.push({ code: 'AUDIT_TRUNCATED', seq: 0, detail: `expected ${expectedCount} records, found 0` });
    return { ok: violations.length === 0, count: 0, lastHash: null, violations };
  }
  const text = fsImpl.readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const violations = [];
  let prev = null;
  let seq = 0;
  lines.forEach((line, index) => {
    seq++;
    let record;
    try {
      record = JSON.parse(line);
    } catch (err) {
      violations.push({ code: 'AUDIT_RECORD_INVALID', seq, detail: `line ${index + 1}: ${err.message}` });
      return;
    }
    if (record.schemaVersion !== AUDIT_SCHEMA_VERSION) {
      violations.push({ code: 'AUDIT_SCHEMA_UNSUPPORTED', seq, detail: `schemaVersion=${record.schemaVersion}` });
    }
    if (record.seq !== seq) {
      violations.push({ code: 'AUDIT_SEQUENCE_BROKEN', seq, detail: `seq=${record.seq}, expected ${seq}` });
    }
    if (record.prev !== prev) {
      violations.push({ code: 'AUDIT_CHAIN_BROKEN', seq, detail: `prev=${record.prev}, expected ${prev}` });
    }
    const expected = hashRecord(record);
    if (record.hash !== expected) {
      violations.push({ code: 'AUDIT_HASH_MISMATCH', seq, detail: `line ${index + 1} hash mismatch` });
    }
    prev = record.hash;
  });
  if (expectedCount !== null && lines.length !== expectedCount) {
    violations.push({ code: 'AUDIT_TRUNCATED', seq: lines.length, detail: `expected ${expectedCount} records, found ${lines.length}` });
  }
  if (expectedLastHash !== null && prev !== expectedLastHash) {
    violations.push({ code: 'AUDIT_TAIL_MISMATCH', seq: lines.length, detail: `expected lastHash=${expectedLastHash}, found ${prev}` });
  }
  return { ok: violations.length === 0, count: lines.length, lastHash: prev, violations };
}

function formatAuditViolations(result) {
  return [
    `Audit log verification failed (${result.violations.length} violation(s)):`,
    ...result.violations.map((v) => `  - [${v.code}] seq ${v.seq}: ${v.detail}`),
  ].join('\n');
}

/**
 * Creates an append-only writer. The parent directory is created lazily on the
 * first write, so blocked/preview runs never touch the filesystem.
 *
 * Creation verifies any existing chain; a corrupted log refuses new writes.
 */
function createAuditWriter({
  file = DEFAULT_AUDIT_PATH,
  authorization = { fingerprint: null, source: 'none' },
  runner = DEFAULT_RUNNER,
  runId = crypto.randomUUID(),
  now = () => new Date(),
  fsImpl = fs,
  lockRetries = 50,
  lockDelayMs = 10,
} = {}) {
  const existing = verifyAuditLog(file, { fsImpl });
  if (!existing.ok) {
    throw new AuditError('AUDIT_CHAIN_INVALID', formatAuditViolations(existing), existing.violations);
  }
  let lastHash = existing.lastHash;
  let count = existing.count;
  let dirReady = false;
  const lockPath = file + '.lock';

  function acquireLock() {
    const deadline = Date.now() + lockRetries * lockDelayMs;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const fd = fsImpl.openSync(lockPath, 'wx');
        return fd;
      } catch (err) {
        if (Date.now() >= deadline) throw err;
        const waitUntil = Date.now() + lockDelayMs;
        while (Date.now() < waitUntil) { /* busy wait */ }
      }
    }
  }

  function releaseLock(fd) {
    try { fsImpl.closeSync(fd); } catch (_) {}
    try { fsImpl.unlinkSync(lockPath); } catch (_) {}
  }

  function write(event, payload = {}) {
    if (!event || typeof event !== 'string') throw new AuditError('AUDIT_EVENT_INVALID', 'audit event name is required');
    if (!dirReady) {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      dirReady = true;
    }
    const fd = acquireLock();
    try {
      // Re-read tail under lock to avoid forking by concurrent writers (F-04).
      const current = verifyAuditLog(file, { fsImpl });
      if (!current.ok) {
        throw new AuditError('AUDIT_CHAIN_INVALID', formatAuditViolations(current), current.violations);
      }
      lastHash = current.lastHash;
      count = current.count;
      const record = {
        schemaVersion: AUDIT_SCHEMA_VERSION,
        seq: count + 1,
        event,
        at: now().toISOString(),
        runId,
        prev: lastHash,
        authorization,
        runner,
        ...payload,
      };
      record.hash = hashRecord(record);
      const fd = fsImpl.openSync(file, 'a');
      try {
        fsImpl.writeSync(fd, JSON.stringify(record) + '\n', null, 'utf8');
        try { fsImpl.fsyncSync(fd); } catch (_) {}
      } finally {
        fsImpl.closeSync(fd);
      }
      lastHash = record.hash;
      count++;
      return record;
    } finally {
      releaseLock(fd);
    }
  }

  return {
    file,
    runId,
    write,
    get lastHash() {
      return lastHash;
    },
    get count() {
      return count;
    },
  };
}

function recoverAuditLog(file = DEFAULT_AUDIT_PATH, { fsImpl = fs, now = () => new Date(), runner = DEFAULT_RUNNER } = {}) {
  const existing = verifyAuditLog(file, { fsImpl });
  if (!fsImpl.existsSync(file)) return { recovered: false, reason: 'absent', count: 0 };
  if (!existing.ok) {
    throw new AuditError('AUDIT_CHAIN_INVALID', formatAuditViolations(existing), existing.violations);
  }
  const lines = fsImpl.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { recovered: false, reason: 'empty', count: 0 };
  const last = JSON.parse(lines[lines.length - 1]);
  if (last.event === 'run.completed' || last.event === 'run.recovered' || last.event === 'run.interrupted') {
    return { recovered: false, reason: 'already-terminal', count: lines.length, lastEvent: last.event };
  }
  // Append a recovery record to close the interrupted run.
  const fd = fsImpl.openSync(file, 'a');
  try {
    const record = {
      schemaVersion: AUDIT_SCHEMA_VERSION,
      seq: lines.length + 1,
      event: 'run.recovered',
      at: now().toISOString(),
      runId: last.runId || crypto.randomUUID(),
      prev: last.hash,
      authorization: last.authorization || { fingerprint: null, source: 'none' },
      runner,
      recovered: true,
      recoveredFrom: last.event,
    };
    record.hash = hashRecord(record);
    fsImpl.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    try { fsImpl.fsyncSync(fd); } catch (_) {}
    return { recovered: true, reason: 'interrupted-run-closed', count: lines.length + 1, lastEvent: 'run.recovered' };
  } finally {
    try { fsImpl.closeSync(fd); } catch (_) {}
  }
}
function readAuditLog(file = DEFAULT_AUDIT_PATH, { fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(file)) return [];
  return fsImpl
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

module.exports = {
  AUDIT_SCHEMA_VERSION,
  DEFAULT_AUDIT_PATH,
  DEFAULT_RUNNER,
  AuditError,
  stableStringify,
  sha256,
  authorizationFingerprint,
  hashRecord,
  verifyAuditLog,
  formatAuditViolations,
  createAuditWriter,
  readAuditLog,
  recoverAuditLog,
};
