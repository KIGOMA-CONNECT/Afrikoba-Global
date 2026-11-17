/**
 * MTC-30 / G3 — Migration content integrity (SHA-256) and tamper detection.
 *
 * Builds and verifies a deterministic manifest over db/migrations/*.sql.
 *
 * Canonicalization: UTF-8 text, BOM stripped, CRLF/CR normalized to LF. This
 * makes the hash stable across checkouts while still detecting any substantive
 * content change. The canonical byte length is recorded alongside the hash.
 *
 * The manifest itself carries a rootHash over the sorted entries, so editing the
 * manifest without regenerating the root is detectable.
 *
 * This module never executes SQL. It only reads migration files and the JSON
 * manifest. Regenerating the manifest requires the explicit G3 token.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'db', 'migrations');
const DEFAULT_MANIFEST = path.join(DEFAULT_DIR, 'integrity.json');
const INTEGRITY_AUTHORIZATION = 'MTC-30-G3';
const SCHEMA_VERSION = 1;
const ALGORITHM = 'sha256';
const CANONICALIZATION = 'utf8-lf-no-bom';

class IntegrityRefusal extends Error {
  constructor(code, message, violations = []) {
    super(message);
    this.name = 'IntegrityRefusal';
    this.code = code;
    this.violations = violations;
  }
}

function canonicalize(value) {
  let text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n?/g, '\n');
}

function canonicalBytes(value) {
  return Buffer.byteLength(canonicalize(value), 'utf8');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashContent(value) {
  return sha256(canonicalize(value));
}

function listMigrationFiles(dir = DEFAULT_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function rootHashFor(files) {
  const entries = Object.keys(files)
    .sort()
    .map((name) => `${name}\u0000${files[name].sha256}\u0000${files[name].bytes}`)
    .join('\n');
  return sha256(entries);
}

function buildManifest({ dir = DEFAULT_DIR, generatedBy = null, now = () => new Date() } = {}) {
  const files = {};
  for (const name of listMigrationFiles(dir)) {
    const buffer = fs.readFileSync(path.join(dir, name));
    files[name] = {
      sha256: hashContent(buffer),
      bytes: canonicalBytes(buffer),
    };
  }
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    algorithm: ALGORITHM,
    canonicalization: CANONICALIZATION,
    generatedAt: now().toISOString(),
    generatedBy,
    fileCount: Object.keys(files).length,
    rootHash: rootHashFor(files),
    files,
  };
  const authPath = path.join(dir, 'authorization.json');
  if (fs.existsSync(authPath)) {
    const buffer = fs.readFileSync(authPath);
    manifest.authorization = {
      file: 'authorization.json',
      sha256: hashContent(buffer),
      bytes: canonicalBytes(buffer),
    };
  }
  return manifest;
}

function validateManifestShape(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    return ['manifest must be a JSON object'];
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) errors.push(`unsupported schemaVersion: ${manifest.schemaVersion}`);
  if (manifest.algorithm !== ALGORITHM) errors.push(`unsupported algorithm: ${manifest.algorithm}`);
  if (manifest.canonicalization !== CANONICALIZATION) {
    errors.push(`unsupported canonicalization: ${manifest.canonicalization}`);
  }
  if (!manifest.files || typeof manifest.files !== 'object') {
    errors.push('files map is missing');
    return errors;
  }
  for (const [name, entry] of Object.entries(manifest.files)) {
    if (!entry || !/^[a-f0-9]{64}$/.test(String(entry.sha256))) errors.push(`${name}: invalid sha256`);
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) errors.push(`${name}: invalid bytes`);
  }
  if (manifest.authorization !== undefined) {
    const a = manifest.authorization;
    if (!a || typeof a !== 'object') errors.push('authorization entry must be an object');
    else {
      if (a.file !== 'authorization.json') errors.push('authorization.file must be authorization.json');
      if (!/^[a-f0-9]{64}$/.test(String(a.sha256))) errors.push('authorization.sha256 invalid');
      if (!Number.isInteger(a.bytes) || a.bytes < 0) errors.push('authorization.bytes invalid');
    }
  }
  return errors;
}

function parseManifest(text, source) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new IntegrityRefusal('INTEGRITY_MANIFEST_INVALID', `cannot parse integrity manifest '${source}': ${err.message}`);
  }
  const shapeErrors = validateManifestShape(parsed);
  if (shapeErrors.length > 0) {
    throw new IntegrityRefusal(
      'INTEGRITY_MANIFEST_INVALID',
      `integrity manifest '${source}' is invalid: ${shapeErrors.join('; ')}`
    );
  }
  return parsed;
}

function loadManifest(manifestPath = DEFAULT_MANIFEST) {
  if (!fs.existsSync(manifestPath)) {
    throw new IntegrityRefusal('INTEGRITY_MANIFEST_MISSING', `integrity manifest not found: ${manifestPath}`);
  }
  return parseManifest(fs.readFileSync(manifestPath, 'utf8'), manifestPath);
}

/**
 * Verifies all migration files against a manifest.
 * Returns { ok, violations, checked, fileCount, rootHash, manifestPath, manifest }.
 * Never throws for content drift; only malformed/missing manifests throw.
 */
function verifyIntegrity({ dir = DEFAULT_DIR, manifestPath = DEFAULT_MANIFEST, manifest = null, expectedRootHash = null } = {}) {
  const resolved = manifest || loadManifest(manifestPath);
  const violations = [];
  const expected = resolved.files;
  const actualFiles = listMigrationFiles(dir);
  const actualSet = new Set(actualFiles);
  const expectedNames = Object.keys(expected).sort();

  for (const name of expectedNames) {
    if (!actualSet.has(name)) {
      violations.push({ code: 'MISSING', file: name, detail: 'file present in manifest but absent on disk' });
      continue;
    }
    const buffer = fs.readFileSync(path.join(dir, name));
    const actualHash = hashContent(buffer);
    const actualBytes = canonicalBytes(buffer);
    if (actualHash !== expected[name].sha256 || actualBytes !== expected[name].bytes) {
      violations.push({
        code: 'MODIFIED',
        file: name,
        detail: `expected sha256=${expected[name].sha256} bytes=${expected[name].bytes}, ` +
          `actual sha256=${actualHash} bytes=${actualBytes}`,
      });
    }
  }
  for (const name of actualFiles) {
    if (!Object.prototype.hasOwnProperty.call(expected, name)) {
      violations.push({ code: 'UNEXPECTED', file: name, detail: 'file on disk is not covered by the manifest' });
    }
  }

  const computedRoot = rootHashFor(expected);
  if (computedRoot !== resolved.rootHash) {
    violations.push({
      code: 'MANIFEST_TAMPERED',
      file: 'integrity.json',
      detail: `declared rootHash=${resolved.rootHash} does not match entries=${computedRoot}`,
    });
  }
  if (resolved.fileCount !== expectedNames.length) {
    violations.push({
      code: 'MANIFEST_TAMPERED',
      file: 'integrity.json',
      detail: `declared fileCount=${resolved.fileCount} does not match entries=${expectedNames.length}`,
    });
  }
  if (expectedRootHash && computedRoot !== expectedRootHash) {
    violations.push({
      code: 'INTEGRITY_ANCHOR_MISMATCH',
      file: 'integrity.json',
      detail: `computed rootHash=${computedRoot} does not match trusted anchor=${expectedRootHash}`,
    });
  }

  // F-02: authorization.json trust boundary.
  if (resolved.authorization) {
    const authFile = path.join(dir, resolved.authorization.file || 'authorization.json');
    if (!fs.existsSync(authFile)) {
      violations.push({ code: 'AUTHORIZATION_MISSING', file: 'authorization.json', detail: 'authorization manifest declared but absent on disk' });
    } else {
      const buffer = fs.readFileSync(authFile);
      const actualHash = hashContent(buffer);
      const actualBytes = canonicalBytes(buffer);
      if (actualHash !== resolved.authorization.sha256 || actualBytes !== resolved.authorization.bytes) {
        violations.push({ code: 'AUTHORIZATION_TAMPERED', file: 'authorization.json', detail: 'authorization manifest does not match integrity manifest' });
      }
    }
  }

  const ok = violations.length === 0;
  return {
    ok,
    violations,
    checked: actualFiles.length,
    fileCount: expectedNames.length,
    rootHash: computedRoot,
    manifestPath,
    manifest: resolved,
  };
}

function verifyManifestText({ dir = DEFAULT_DIR, manifestText, manifestPath = '(inline)' } = {}) {
  const manifest = parseManifest(manifestText, manifestPath);
  return verifyIntegrity({ dir, manifest, manifestPath });
}

function formatViolations(result) {
  const lines = [
    `Migration integrity verification failed (${result.violations.length} violation(s)):`,
    ...result.violations.map((v) => `  - [${v.code}] ${v.file}: ${v.detail}`),
  ];
  return lines.join('\n');
}

function writeManifest({ dir = DEFAULT_DIR, manifestPath = DEFAULT_MANIFEST, authorization = null, generatedBy = 'MTC-30-G3', now = () => new Date() } = {}) {
  if (!authorization || authorization !== INTEGRITY_AUTHORIZATION) {
    throw new IntegrityRefusal(
      'INTEGRITY_UPDATE_NOT_AUTHORIZED',
      `writing the integrity manifest requires the explicit G3 authorization token '${INTEGRITY_AUTHORIZATION}'`
    );
  }
  const manifest = buildManifest({ dir, generatedBy, now });
  const tmp = `${manifestPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, manifestPath);
  return manifest;
}

function main({
  argv = process.argv.slice(2),
  dir = DEFAULT_DIR,
  manifestPath = DEFAULT_MANIFEST,
  log = console.log,
} = {}) {
  const write = argv.includes('--init') || argv.includes('--update');
  const json = argv.includes('--json');
  const authFlag = argv.find((a) => typeof a === 'string' && a.startsWith('--authorization='));
  const authorization = authFlag ? authFlag.slice('--authorization='.length) : process.env.MTC30_AUTHORIZATION || null;
  const anchorFlag = argv.find((a) => typeof a === 'string' && a.startsWith('--anchor='));
  const expectedRootHash = anchorFlag ? anchorFlag.slice('--anchor='.length) : process.env.MIGRATION_INTEGRITY_ANCHOR || null;

  if (write) {
    const manifest = writeManifest({ dir, manifestPath, authorization, generatedBy: authorization });
    log(`[INTEGRITY] Wrote ${manifestPath}: files=${manifest.fileCount} rootHash=${manifest.rootHash}`);
    return { manifest, written: true };
  }

  const result = verifyIntegrity({ dir, manifestPath, expectedRootHash });
  if (json) {
    log(JSON.stringify({ ok: result.ok, fileCount: result.fileCount, rootHash: result.rootHash, violations: result.violations }, null, 2));
  } else if (result.ok) {
    log(`[INTEGRITY] OK: ${result.checked} migration files match ${manifestPath} (rootHash=${result.rootHash}).`);
  } else {
    log(formatViolations(result));
  }
  return result;
}

if (require.main === module) {
  try {
    const result = main();
    if (result && result.ok === false) process.exitCode = 3;
  } catch (err) {
    if (err instanceof IntegrityRefusal) {
      console.error('[INTEGRITY REFUSED] ' + err.message);
      process.exitCode = 3;
    } else {
      console.error('[INTEGRITY ERROR]', err && (err.stack || err.message));
      process.exitCode = 1;
    }
  }
}

module.exports = {
  DEFAULT_DIR,
  DEFAULT_MANIFEST,
  INTEGRITY_AUTHORIZATION,
  SCHEMA_VERSION,
  ALGORITHM,
  CANONICALIZATION,
  IntegrityRefusal,
  canonicalize,
  canonicalBytes,
  sha256,
  hashContent,
  listMigrationFiles,
  rootHashFor,
  buildManifest,
  validateManifestShape,
  parseManifest,
  loadManifest,
  verifyIntegrity,
  verifyManifestText,
  formatViolations,
  writeManifest,
  main,
};
