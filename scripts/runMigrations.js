/**
 * Database Migration Runner
 * Applies any unapplied db/migrations/*.sql files in filename order.
 * Tracks applied versions in a schema_migrations table (idempotent).
 *
 * Identity controls (P1.1):
 *  - The maintenance connection may only use a permitted maintenance database and is
 *    identity-verified before any DDL.
 *  - The target name is validated (format, explicit PHASE68_TEST_DB match, denylist)
 *    before CREATE DATABASE, and is quoted in the DDL.
 *  - Every credential candidate must pass the same identity check on the connected
 *    database before any migration runs.
 *  - Identity refusals are never swallowed and never retried.
 *
 * MTC-28 / G1 — fail-closed authorization guard:
 *  - "Absent from schema_migrations" no longer means "safe to execute". It means
 *    "requires authorization/state evaluation".
 *  - Every unrecorded file must have an entry in db/migrations/authorization.json.
 *    Missing entry => UNKNOWN_MIGRATION => BLOCK (deny by default).
 *  - Migration 155 is hard-blocked in code while OD-10 is not APPROVED. This holds
 *    even if the manifest is edited or missing.
 *  - Applied-but-unrecorded migrations are BLOCKED, never silently recorded. Ledger
 *    reconciliation (G2) is a separate authorization gate.
 *  - The guard decision is made before any schema_migrations write or migration body
 *    execution. A blocked run opens no write transaction and executes no migration.
 *  - `--assess` is a genuinely non-mutating assessment: it does not create the
 *    database, does not create schema_migrations, does not bootstrap schema.sql, and
 *    issues SELECT/catalog reads only.
 *
 * Explicit non-goals for G1: executing migration 155, reconciling 152-154, or any
 * other ledger mutation. OD-10 remains OPEN.
 *
 * MTC-30 / G3 — governance controls:
 *  - SHA-256 content integrity: every migration file is verified against
 *    db/migrations/integrity.json before any connection/decision. Any modified,
 *    missing or unexpected .sql file is a fail-closed MIGRATION_INTEGRITY_VIOLATION.
 *  - Preview/dry-run: `--preview`, `--dry-run` and `--assess` are genuine
 *    read-only modes. They verify integrity, read ledger/catalog evidence, and
 *    print the plan. They never create the database, never create
 *    schema_migrations, never bootstrap schema.sql, and never execute SQL bodies.
 *  - Execution audit: authorized execution writes an append-only, hash-chained
 *    JSONL audit record per migration (sha256, decision id, authorization
 *    fingerprint, runner metadata, timings, outcome). Raw tokens are never stored.
 *    Audit initialisation failure blocks execution before any body runs.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { verifyIntegrity, formatViolations, IntegrityRefusal } = require('./migrationIntegrity');
const {
  createAuditWriter,
  DEFAULT_AUDIT_PATH,
  authorizationFingerprint,
  verifyAuditLog,
  formatAuditViolations,
} = require('./migrationAudit');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAINTENANCE_DBS = ['postgres'];
const DENYLIST = ['afrikoba_regression', 'afrikoba_global', 'afrikoba', 'afrikoba_staging', 'postgres', 'phase68_guard', 'phase68_remed_dryrun'];
const TARGET_PATTERN = /^phase68_amount_guard_[a-z0-9_]+$/i;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/i;
const DUPLICATE_DATABASE = '42P04';
const CONNECTIVITY_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH'];

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const AUTHORIZATION_PATH = path.join(MIGRATIONS_DIR, 'authorization.json');
const INTEGRITY_PATH = path.join(MIGRATIONS_DIR, 'integrity.json');

const DEFAULT_AUTHORIZATION = Object.freeze({
  version: 1,
  defaultState: 'PENDING_UNAUTHORIZED',
  decisions: Object.freeze({}),
  migrations: Object.freeze({}),
});

// Defense in depth. A migration listed here cannot execute unless its governing
// owner decision is APPROVED, regardless of what the JSON manifest says.
const HARD_BLOCKED = Object.freeze({
  '155_social_fund_institution_binding.sql': Object.freeze({
    decision: 'OD-10',
    reason: 'institution model not authorized',
    blockedEffects: Object.freeze([
      Object.freeze({ type: 'column', table: 'social_fund_cases', column: 'institution_id' }),
      Object.freeze({ type: 'column', table: 'social_fund_case_permissions', column: 'institution_id' }),
      Object.freeze({ type: 'index', name: 'idx_sf_case_perms_institution' }),
    ]),
  }),
});

const EXPECTED_INTEGRITY_ROOT_HASH = '4e9ccd35906bd33236218fd7badff009a36cc3f0d1515fa3d0053950606dc3a0';
const EXPECTED_AUTHORIZATION_SHA256 = 'f5e50ffb982f2962a226253c49225abb4f6b56b86009c4688ee8c63ef38ee102';
const DECISION_EXECUTE = 'EXECUTE';
const DECISION_BLOCK = 'BLOCK';
const DECISION_SKIP = 'SKIP';

class IdentityRefusal extends Error {}

/**
 * A governed, fail-closed refusal. `code` is a stable machine-readable string and
 * `plan` carries the full classification for reporting/audit.
 */
class GuardRefusal extends Error {
  constructor(code, message, plan = []) {
    super(message);
    this.name = 'GuardRefusal';
    this.code = code;
    this.plan = plan;
  }
}

function refuse(message) {
  return new IdentityRefusal('REFUSING: ' + message);
}

// Validates the configured target before any connection or DDL.
function validatedTarget(env = process.env) {
  const expected = env.PHASE68_TEST_DB;
  const targetDb = env.DB_NAME;
  if (!expected || !targetDb || targetDb !== expected || !TARGET_PATTERN.test(expected)) {
    throw refuse('DB_NAME and PHASE68_TEST_DB must match an explicit phase68_amount_guard_<unique_suffix> disposable database name.');
  }
  if (!IDENTIFIER_PATTERN.test(targetDb)) {
    throw refuse('invalid database identifier.');
  }
  if (DENYLIST.includes(targetDb) || MAINTENANCE_DBS.includes(targetDb)) {
    throw refuse(`database '${targetDb}' is denylisted.`);
  }
  return targetDb;
}

// Credential candidates, tried in order. Each candidate passes the same identity checks.
function credentialCandidates(env = process.env) {
  const host = env.DB_HOST || 'db';
  const port = Number(env.DB_PORT || 5432);
  return [
    { label: 'primary', host, port, user: env.DB_USER || 'afrikoba', password: env.DB_PASSWORD || 'change_me_strong_password' },
    { label: 'fallback-app', host, port, user: 'afrikoba', password: 'change_me_strong_password' },
    { label: 'fallback-superuser', host, port, user: 'postgres', password: env.DB_PASSWORD || 'postgres' },
  ];
}

function clientFor(database, candidate) {
  return new Client({ host: candidate.host, port: candidate.port, user: candidate.user, password: candidate.password, database });
}

// Confirms the connected database is exactly the expected one. Throws IdentityRefusal on mismatch.
async function verifyIdentity(client, expectedDb, role) {
  const res = await client.query('SELECT current_database() AS db');
  const actual = res.rows[0].db;
  if (actual !== expectedDb) {
    throw refuse(`${role} connection reports database '${actual}', expected '${expectedDb}'.`);
  }
  if (role === 'target' && DENYLIST.includes(actual)) {
    throw refuse(`database '${actual}' is denylisted.`);
  }
  if (role === 'maintenance' && !MAINTENANCE_DBS.includes(actual)) {
    throw refuse(`maintenance connection must use a permitted maintenance database, not '${actual}'.`);
  }
  return actual;
}

function isConnectivityError(err) {
  return CONNECTIVITY_CODES.includes(err && err.code) || /connect|terminated|timeout/i.test(String(err && err.message));
}

// Creates the target database if it is missing. Runs only over a verified maintenance connection.
async function ensureTargetDatabase(targetDb, env = process.env) {
  let lastErr = null;
  for (const candidate of credentialCandidates(env)) {
    const admin = clientFor('postgres', candidate);
    try {
      await admin.connect();
      await verifyIdentity(admin, 'postgres', 'maintenance');
      const res = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetDb]);
      if (res.rows.length === 0) {
        console.log(`[MIGRATE] Database '${targetDb}' does not exist. Creating it now (maintenance credential '${candidate.label}')...`);
        await admin.query(`CREATE DATABASE "${targetDb.replace(/"/g, '""')}"`);
        console.log(`[MIGRATE] Database '${targetDb}' created successfully.`);
      }
      return;
    } catch (err) {
      if (err instanceof IdentityRefusal) throw err;
      if (err && err.code === DUPLICATE_DATABASE) return;
      if (!isConnectivityError(err)) throw err;
      lastErr = err;
    } finally {
      await admin.end().catch(() => {});
    }
  }
  console.log(`[MIGRATE] Note: maintenance connection unavailable (${lastErr && lastErr.message}); continuing with target connection checks.`);
}

// Connects to the target with each credential candidate in turn. Identity is verified before migrations.
// NOTE: implicit db/schema.sql bootstrap was removed in MTC-28. It was a mutation that could
// occur before any authorization decision. Fresh-database bootstrap requires a separate,
// explicitly authorized procedure.
async function getWorkingClient({ createDatabase = true, env = process.env } = {}) {
  const targetDb = validatedTarget(env);
  if (createDatabase) await ensureTargetDatabase(targetDb, env);

  let lastErr = null;
  for (let attempt = 1; attempt <= 15; attempt++) {
    for (const candidate of credentialCandidates(env)) {
      const client = clientFor(targetDb, candidate);
      try {
        await client.connect();
        await verifyIdentity(client, targetDb, 'target');
        console.log(`[MIGRATE] Connected to database '${targetDb}' using credential '${candidate.label}' (user '${candidate.user}'). Identity verified: ${targetDb}`);
        return client;
      } catch (err) {
        await client.end().catch(() => {});
        if (err instanceof IdentityRefusal) throw err;
        if (!isConnectivityError(err) && err && err.code !== '28P01' && err.code !== '28000') throw err;
        lastErr = err;
        console.log(`[MIGRATE] Credential '${candidate.label}' not usable (${err.code || err.message}); trying next candidate.`);
      }
    }
    console.log(`[MIGRATE] Waiting for database connection (attempt ${attempt}/15)...`);
    await sleep(2000);
  }
  throw new Error(`Could not connect to database after 15 attempts.${lastErr ? ' last error: ' + lastErr.message : ''}`);
}

// ---------------------------------------------------------------------------
// Authorization manifest
// ---------------------------------------------------------------------------

function consumeAuthorization(storePath, token, { fsImpl = fs, lockRetries = 50, lockDelayMs = 10 } = {}) {
  if (!token) return { consumed: false, alreadyConsumed: false };
  const fp = crypto.createHash('sha256').update(String(token)).digest('hex');
  const lockPath = storePath + '.lock';
  const deadline = Date.now() + lockRetries * lockDelayMs;
  let fd = null;
  // acquire lock
  while (true) {
    try { fd = fsImpl.openSync(lockPath, 'wx'); break; }
    catch (err) {
      if (Date.now() >= deadline) throw err;
      const waitUntil = Date.now() + lockDelayMs;
      while (Date.now() < waitUntil) { /* busy wait */ }
    }
  }
  try {
    let list = [];
    if (fsImpl.existsSync(storePath)) {
      try { list = JSON.parse(fsImpl.readFileSync(storePath, 'utf8')); } catch (_) { list = []; }
      if (!Array.isArray(list)) list = [];
    }
    if (list.includes(token) || list.includes(fp)) {
      return { consumed: false, alreadyConsumed: true };
    }
    list.push(fp);
    fsImpl.mkdirSync(path.dirname(storePath), { recursive: true });
    const tmp = storePath + '.tmp-' + process.pid;
    fsImpl.writeFileSync(tmp, JSON.stringify(list));
    fsImpl.renameSync(tmp, storePath);
    return { consumed: true, alreadyConsumed: false };
  } finally {
    try { fsImpl.closeSync(fd); } catch (_) {}
    try { fsImpl.unlinkSync(lockPath); } catch (_) {}
  }
}
function loadAuthorization(file = AUTHORIZATION_PATH, { expectedSha256 = EXPECTED_AUTHORIZATION_SHA256 } = {}) {
  if (!fs.existsSync(file)) {
    return {
      version: DEFAULT_AUTHORIZATION.version,
      defaultState: DEFAULT_AUTHORIZATION.defaultState,
      decisions: {},
      migrations: {},
    };
  }
  const buffer = fs.readFileSync(file);
  if (expectedSha256) {
    const actual = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actual !== expectedSha256) {
      throw new GuardRefusal(
        'AUTHORIZATION_TAMPERED',
        `authorization manifest '${file}' hash ${actual} does not match the trusted anchor ${expectedSha256}`
      );
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch (err) {
    throw new GuardRefusal('MIGRATION_AUTHORIZATION_INVALID', `cannot parse authorization manifest '${file}': ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new GuardRefusal('MIGRATION_AUTHORIZATION_INVALID', `authorization manifest '${file}' must be a JSON object`);
  }
  return {
    version: parsed.version || 1,
    defaultState: parsed.defaultState || 'PENDING_UNAUTHORIZED',
    decisions: parsed.decisions && typeof parsed.decisions === 'object' ? parsed.decisions : {},
    migrations: parsed.migrations && typeof parsed.migrations === 'object' ? parsed.migrations : {},
  };
}

function resolveAuthorization(argv = process.argv.slice(2), env = process.env) {
  const flag = argv.find((a) => typeof a === 'string' && a.startsWith('--authorize='));
  const raw = flag ? flag.slice('--authorize='.length) : env.MIGRATION_AUTHORIZATION || '';
  const id = String(raw || '').trim();
  return { id: id || null };
}

// ---------------------------------------------------------------------------
// Migration state detection
// ---------------------------------------------------------------------------

function listMigrationFiles(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

async function readRecorded(client) {
  const exists = await client.query(`SELECT to_regclass('public.schema_migrations') AS o`);
  if (!exists.rows[0] || !exists.rows[0].o) {
    return { exists: false, versions: [] };
  }
  const res = await client.query('SELECT version FROM schema_migrations');
  return { exists: true, versions: res.rows.map((r) => r.version) };
}

function assertIdentifier(name, context) {
  if (typeof name !== 'string' || !IDENTIFIER_PATTERN.test(name)) {
    throw new GuardRefusal('MIGRATION_AUTHORIZATION_INVALID', `invalid identifier in authorization manifest (${context}): ${name}`);
  }
  return `"${name}"`;
}

// Evaluates one declared migration effect. All probes are catalog/SELECT reads.
async function effectPresent(client, effect) {
  if (!effect || typeof effect !== 'object') return false;
  switch (effect.type) {
    case 'table':
    case 'view': {
      const res = await client.query('SELECT to_regclass($1) AS o', [`public.${effect.name}`]);
      return Boolean(res.rows[0] && res.rows[0].o);
    }
    case 'column': {
      const res = await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 LIMIT 1`,
        [effect.table, effect.column]
      );
      return res.rows.length > 0;
    }
    case 'index': {
      const res = await client.query(
        `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1 LIMIT 1`,
        [effect.name]
      );
      return res.rows.length > 0;
    }
    case 'function': {
      const res = await client.query('SELECT to_regprocedure($1) AS o', [`public.${effect.name}`]);
      return Boolean(res.rows[0] && res.rows[0].o);
    }
    case 'row': {
      const table = assertIdentifier(effect.table, 'row.table');
      const column = assertIdentifier(effect.column, 'row.column');
      const res = await client.query(`SELECT 1 FROM ${table} WHERE ${column} = $1 LIMIT 1`, [effect.value]);
      return res.rows.length > 0;
    }
    default:
      throw new GuardRefusal('MIGRATION_AUTHORIZATION_INVALID', `unknown effect type in authorization manifest: ${effect.type}`);
  }
}

async function probeEffects(client, files, manifest = DEFAULT_AUTHORIZATION, hardBlocked = HARD_BLOCKED) {
  const out = {};
  for (const file of files) {
    const entry = (manifest.migrations && manifest.migrations[file]) || {};
    const effects = entry.expectedEffects || (hardBlocked[file] && hardBlocked[file].blockedEffects) || [];
    if (!Array.isArray(effects) || effects.length === 0) continue;
    const checked = [];
    for (const effect of effects) {
      checked.push({ ...effect, present: await effectPresent(client, effect) });
    }
    out[file] = checked;
  }
  return out;
}

function allPresent(checked) {
  return Array.isArray(checked) && checked.length > 0 && checked.every((e) => e.present === true);
}

function anyPresent(checked) {
  return Array.isArray(checked) && checked.some((e) => e.present === true);
}

/**
 * Pure, deterministic classification. No database access.
 *
 * Decision precedence:
 *   1. Recorded in schema_migrations            -> SKIP
 *   2. Hard-blocked migration (OD-10 not APPROVED) -> BLOCK
 *   3. Missing manifest entry                  -> BLOCK (deny by default)
 *   4. Manifest state evaluation               -> SKIP/BLOCK/EXECUTE
 */
function classifyMigrations({
  files,
  recorded = [],
  manifest = DEFAULT_AUTHORIZATION,
  effects = {},
  authorization = null,
  hardBlocked = HARD_BLOCKED,
  now = () => new Date(),
  consumed = [],
  requireControls = true,
} = {}) {
  if (!Array.isArray(files)) throw new TypeError('files must be an array');
  const recordedSet = recorded instanceof Set ? recorded : new Set(recorded);
  const migrations = (manifest && manifest.migrations) || {};
  const decisions = (manifest && manifest.decisions) || {};
  const token = authorization && authorization.id ? authorization.id : null;

  const block = (file, code, reason, decisionId = null, classification = 'BLOCKED') => ({
    version: file,
    decision: DECISION_BLOCK,
    classification,
    code,
    decisionId,
    reason,
  });

  return files.map((file) => {
    // 1. Already recorded: preserve existing behavior, never re-execute.
    if (recordedSet.has(file)) {
      return {
        version: file,
        decision: DECISION_SKIP,
        classification: 'RECORDED',
        code: 'APPLIED_TRACKED',
        decisionId: null,
        reason: 'recorded in schema_migrations',
      };
    }

    const hard = hardBlocked[file];
    const entry = migrations[file];
    const state = entry ? entry.state : (manifest && manifest.defaultState) || 'PENDING_UNAUTHORIZED';

    // 2. Hard block: while OD-10 is not owner-approved, the migration is
    //    unconditionally blocked. The decision cannot be manufactured by
    //    editing authorization.json (F-02/F-09).
    if (hard) {
      const decisionStatus = decisions[hard.decision];
      const drift = anyPresent(effects[file]);
      return block(
        file,
        drift ? 'BLOCKED_MIGRATION_EFFECT_PRESENT' : 'MIGRATION_BLOCKED',
        drift
          ? `${hard.decision} not approved but blocked migration effects are present — drift incident`
          : `${hard.decision} ${decisionStatus || 'OPEN'} — ${hard.reason}`,
        hard.decision,
        drift ? 'BLOCKED_DRIFT' : 'BLOCKED'
      );
    }

    // 3. Deny by default for any unrecorded file without an authorization entry.
    if (!entry) {
      return block(file, 'UNKNOWN_MIGRATION', 'no authorization entry (deny by default)', null, 'UNKNOWN');
    }

    // 4. Manifest state evaluation.
    switch (state) {
      case 'APPLIED_UNRECORDED': {
        const checked = effects[file] || [];
        if (allPresent(checked)) {
          return block(
            file,
            'APPLIED_UNRECORDED',
            'declared effects present but no ledger row; G2 reconciliation required (never auto-recorded)',
            null,
            'APPLIED_UNRECORDED'
          );
        }
        return block(
          file,
          'APPLIED_EVIDENCE_MISSING',
          checked.length === 0
            ? 'declared applied but has no verifiable effects'
            : 'declared applied but one or more effects are absent — ambiguous state',
          null,
          'AMBIGUOUS'
        );
      }
      case 'RECONCILED':
        // MTC-29: a reconciled entry is only valid while its ledger row exists.
        // If the row disappears the state is ambiguous and must block (never re-execute).
        return block(
          file,
          'RECONCILIATION_LEDGER_MISSING',
          'manifest records this migration as reconciled but no schema_migrations row exists — ambiguous state',
          entry.decision || null,
          'AMBIGUOUS'
        );
      case 'BLOCKED':
        return block(
          file,
          'MIGRATION_BLOCKED',
          entry.reason || 'blocked by authorization manifest',
          entry.decision || null,
          'BLOCKED'
        );
      case 'PENDING_AUTHORIZED': {
        if (!token) {
          return block(file, 'MIGRATION_NOT_AUTHORIZED', 'pending but no execution authorization token was supplied', entry.decision || null, 'PENDING_UNAUTHORIZED');
        }
        if (!entry.executionAuthorization) {
          return block(file, 'MIGRATION_NOT_AUTHORIZED', 'pending with no executionAuthorization defined in the manifest', entry.decision || null, 'PENDING_UNAUTHORIZED');
        }
        if (token !== entry.executionAuthorization) {
          return block(file, 'MIGRATION_NOT_AUTHORIZED', 'execution authorization token does not match the manifest', entry.decision || null, 'PENDING_UNAUTHORIZED');
        }
        // F-07: optional expiry + nonce binding. If declared, enforce.
        if (entry.expiresAt) {
          const expiry = Date.parse(entry.expiresAt);
          if (!Number.isFinite(expiry) || now().getTime() >= expiry) {
            return block(file, 'MIGRATION_AUTHORIZATION_EXPIRED', 'execution authorization has expired or has an invalid expiry', entry.decision || null, 'PENDING_UNAUTHORIZED');
          }
        }
        if (entry.nonce) {
          if (!authorization || authorization.nonce !== entry.nonce) {
            return block(file, 'MIGRATION_AUTHORIZATION_NONCE_MISMATCH', 'execution authorization nonce does not match', entry.decision || null, 'PENDING_UNAUTHORIZED');
          }
        }
        // F-07: optional controls; mandatory when requireControls is set.
        if (requireControls) {
          if (!entry.nonce) {
            return block(file, 'MIGRATION_AUTHORIZATION_NONCE_MISSING', 'execution authorization requires a nonce under the strict control policy', entry.decision || null, 'PENDING_UNAUTHORIZED');
          }
          if (!entry.expiresAt) {
            return block(file, 'MIGRATION_AUTHORIZATION_EXPIRY_MISSING', 'execution authorization requires an expiry under the strict control policy', entry.decision || null, 'PENDING_UNAUTHORIZED');
          }
        }
        const consumedSet = consumed instanceof Set ? consumed : new Set(consumed);
        if (consumedSet.has(token) || consumedSet.has(crypto.createHash('sha256').update(String(token)).digest('hex'))) {
          return block(file, 'MIGRATION_AUTHORIZATION_REPLAYED', 'execution authorization token has already been consumed', entry.decision || null, 'PENDING_UNAUTHORIZED');
        }
        return {
          version: file,
          decision: DECISION_EXECUTE,
          classification: 'PENDING_AUTHORIZED',
          code: 'AUTHORIZED',
          decisionId: entry.decision || null,
          reason: 'authorized by manifest entry',
        };
      }
      case 'PENDING_UNAUTHORIZED':
      case 'PENDING':
        return block(file, 'MIGRATION_NOT_AUTHORIZED', 'pending and not authorized', entry.decision || null, 'PENDING_UNAUTHORIZED');
      default:
        return block(file, 'UNKNOWN_MIGRATION_STATE', `unknown authorization manifest state '${state}'`, entry.decision || null, 'AMBIGUOUS');
    }
  });
}

function formatPlan(plan) {
  const lines = ['[MIGRATE] Migration guard assessment:'];
  for (const item of plan) {
    const id = item.decisionId ? ` (${item.decisionId})` : '';
    lines.push(
      `  ${item.version.padEnd(56)} ${String(item.classification).padEnd(20)} ${item.decision.padEnd(7)} ${item.code}${id} — ${item.reason}`
    );
  }
  const executable = plan.filter((p) => p.decision === DECISION_EXECUTE).length;
  const blocked = plan.filter((p) => p.decision === DECISION_BLOCK).length;
  const skipped = plan.filter((p) => p.decision === DECISION_SKIP).length;
  lines.push(`[MIGRATE] Summary: executable=${executable} blocked=${blocked} skipped=${skipped} total=${plan.length}`);
  return lines.join('\n');
}

function formatBlockMessage(blocked) {
  return [
    'Migration execution refused (fail-closed):',
    ...blocked.map((b) => `  - ${b.version}: ${b.code} — ${b.reason}`),
  ].join('\n');
}

function authorizationSource(argv = [], env = process.env) {
  if (argv.some((a) => typeof a === 'string' && a.startsWith('--authorize='))) return 'argv';
  if (env.MIGRATION_AUTHORIZATION) return 'env';
  return 'none';
}

function hashPlan(plan) {
  const canonical = plan.map((p) => [p.version, p.decision, p.code, p.decisionId || null]);
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function formatPreview(plan, { integrity = null, recorded = null } = {}) {
  const lines = [
    '[MIGRATE] PREVIEW / DRY RUN — READ-ONLY.',
    '  No migration body is executed. No ledger write. No database creation or schema bootstrap.',
  ];
  if (integrity) {
    lines.push(`  Integrity: ${integrity.checked} files verified, ${integrity.fileCount} manifest entries, rootHash=${integrity.rootHash}`);
  }
  if (recorded) lines.push(`  Ledger rows read: ${recorded.versions.length}`);
  lines.push(formatPlan(plan));

  const files = (integrity && integrity.manifest && integrity.manifest.files) || {};
  const executable = plan.filter((p) => p.decision === DECISION_EXECUTE);
  for (const item of executable) {
    const sha = files[item.version] && files[item.version].sha256;
    lines.push(`  would execute ${item.version} sha256=${sha || 'unverified'} decision=${item.decisionId || 'none'}`);
  }
  const blocked = plan.filter((p) => p.decision === DECISION_BLOCK).length;
  const skipped = plan.filter((p) => p.decision === DECISION_SKIP).length;
  lines.push(
    `[MIGRATE] Preview complete: would_execute=${executable.length} blocked=${blocked} skipped=${skipped}. No changes were made.`
  );
  return lines.join('\n');
}

/**
 * Executes only EXECUTE-classified migrations. Refuses before any write if any
 * BLOCK classification is present. The ledger table is created only after the
 * guard has passed and only when there is executable work.
 *
 * MTC-30: if an audit writer is supplied, `run.started`, `migration.started`,
 * `migration.applied|failed` and `run.completed` records are appended around
 * execution. When `auditRequired` is true, execution refuses without a writer.
 */
async function executePlan({
  client,
  plan,
  baseDir = MIGRATIONS_DIR,
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  log = console.log,
  audit = null,
  auditRequired = false,
  integrity = null,
} = {}) {
  const blocked = plan.filter((p) => p.decision === DECISION_BLOCK);
  if (blocked.length > 0) {
    throw new GuardRefusal(blocked[0].code, formatBlockMessage(blocked), plan);
  }

  // F-09: never trust a caller-supplied plan for a hard-blocked migration.
  const hardBlockedInPlan = plan.filter((p) => Object.prototype.hasOwnProperty.call(HARD_BLOCKED, p.version));
  if (hardBlockedInPlan.length > 0) {
    throw new GuardRefusal(
      'MIGRATION_BLOCKED',
      formatBlockMessage(hardBlockedInPlan.map((p) => ({ ...p, decision: DECISION_BLOCK, code: 'MIGRATION_BLOCKED' }))),
      plan
    );
  }

  const executable = plan.filter((p) => p.decision === DECISION_EXECUTE);
  if (executable.length === 0) {
    return { applied: 0, plan };
  }

  if (auditRequired && !audit) {
    throw new GuardRefusal(
      'MIGRATION_AUDIT_UNAVAILABLE',
      'migration execution requires an audit writer; refusing to run without execution audit metadata'
    );
  }

  const integrityFiles =
    (integrity && (integrity.files || (integrity.manifest && integrity.manifest.files))) || {};
  const shaFor = (item) =>
    (integrityFiles[item.version] && integrityFiles[item.version].sha256) || item.sha256 || null;
  const planSha256 = hashPlan(plan);

  // Audit must exist before the first mutation (ledger table creation).
  if (audit) {
    audit.write('run.started', {
      mode: 'apply',
      planSha256,
      executable: executable.map((e) => e.version),
      total: plan.length,
    });
  }

  // Ledger infrastructure is created only after the authorization decision.
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version VARCHAR(255) PRIMARY KEY,
       applied_at TIMESTAMPTZ DEFAULT NOW()
     )`
  );

  let applied = 0;
  for (const item of executable) {
    const sha256 = shaFor(item);
    const decisionId = item.decisionId || null;
    const startedAt = Date.now();
    if (audit) audit.write('migration.started', { version: item.version, sha256, decisionId });
    const sql = readFile(path.join(baseDir, item.version));
    let committed = false;
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [item.version]);
      await client.query('COMMIT');
      committed = true;
      if (audit) {
        audit.write('migration.applied', {
          version: item.version,
          sha256,
          decisionId,
          ledgerRecorded: true,
          durationMs: Date.now() - startedAt,
        });
      }
      log(`[MIGRATE] Applied ${item.version}`);
      applied++;
    } catch (err) {
      if (!committed) {
        await client.query('ROLLBACK').catch(() => {});
      }
      if (audit) {
        try {
          audit.write('migration.failed', {
            version: item.version,
            sha256,
            decisionId,
            errorCode: (err && err.code) || 'MIGRATION_FAILED',
            durationMs: Date.now() - startedAt,
          });
        } catch (_) {
          // Preserve the original migration failure.
        }
      }
      throw err;
    }
  }
  if (audit) audit.write('run.completed', { applied, failed: 0, planSha256 });
  if (audit) {
    const auditCheck = verifyAuditLog(audit.file);
    if (!auditCheck.ok) {
      throw new GuardRefusal('MIGRATION_AUDIT_CHAIN_INVALID', formatAuditViolations(auditCheck), auditCheck.violations);
    }
  }
  return { applied, plan };
}

/**
 * Core guarded run. Injectable for deterministic tests.
 * Returns the plan without writing when `assess` is true.
 *
 * MTC-30: an already-computed `integrity` result may be supplied so callers can
 * enforce the same content verification as the CLI. Audit injection is optional
 * here; `auditRequired` enforces that execution cannot proceed un-audited.
 */
async function runGuardedMigrations({
  client,
  files = listMigrationFiles(),
  manifest = loadAuthorization(),
  authorization = { id: null },
  effects = null,
  assess = false,
  baseDir = MIGRATIONS_DIR,
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  log = console.log,
  hardBlocked = HARD_BLOCKED,
  integrity = null,
  audit = null,
  auditRequired = false,
  consumed = [],
  requireControls = true,
} = {}) {
  if (!client) throw new TypeError('client is required');
  const recorded = await readRecorded(client);
  const resolvedEffects = effects || (await probeEffects(client, files, manifest, hardBlocked));
  const plan = classifyMigrations({
    files,
    recorded: recorded.versions,
    manifest,
    effects: resolvedEffects,
    authorization,
    hardBlocked,
    consumed,
    requireControls,
  });

  if (assess) {
    return { plan, applied: 0, assess: true, recorded, integrity };
  }

  const result = await executePlan({ client, plan, baseDir, readFile, log, audit, auditRequired, integrity });
  return { ...result, assess: false, recorded, integrity };
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  clientFactory = null,
  files = null,
  manifest = null,
  effects = null,
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  log = console.log,
  integrity = null,
  integrityPath = INTEGRITY_PATH,
  auditPath = null,
  auditFactory = null,
  now = () => new Date(),
} = {}) {
  // `--preview`, `--dry-run` and `--assess` are aliases for a genuinely
  // read-only planning mode.
  const previewMode = argv.some((a) => a === '--preview' || a === '--dry-run' || a === '--assess');
  const authorization = resolveAuthorization(argv, env);
  const authSource = authorizationSource(argv, env);
  let client = null;

  // F-01: integrity trust anchor (external, not defeated by coordinated rewrite).
  const anchorFlag = argv.find((a) => typeof a === 'string' && a.startsWith('--integrity-anchor='));
  const expectedRootHash =
    (anchorFlag ? anchorFlag.slice('--integrity-anchor='.length) : null) ||
    env.MIGRATION_INTEGRITY_ANCHOR ||
    (integrityPath === INTEGRITY_PATH ? EXPECTED_INTEGRITY_ROOT_HASH : null);

  // Integrity gate: verified against local files BEFORE any DB connection.
  const resolvedIntegrity = integrity || verifyIntegrity({ manifestPath: integrityPath, expectedRootHash });
  if (!resolvedIntegrity.ok) {
    throw new GuardRefusal(
      'MIGRATION_INTEGRITY_VIOLATION',
      formatViolations(resolvedIntegrity),
      resolvedIntegrity.violations
    );
  }

  try {
    client = clientFactory
      ? await clientFactory({ assess: previewMode, argv, env })
      : await getWorkingClient({ createDatabase: !previewMode, env });

    const resolvedFiles = files || listMigrationFiles();
    const resolvedManifest = manifest || loadAuthorization();

    const recorded = await readRecorded(client);
    const resolvedEffects = effects || (await probeEffects(client, resolvedFiles, resolvedManifest));
    const authorizationStorePath =
      env.MIGRATION_AUTHORIZATION_STORE ||
      path.join(path.dirname(DEFAULT_AUDIT_PATH), 'used-authorizations.json');
    // F-07: atomic one-time consumption before execution.
    if (authorization && authorization.id) {
      let consumeResult;
      try {
        consumeResult = consumeAuthorization(authorizationStorePath, authorization.id);
      } catch (err) {
        throw new GuardRefusal('MIGRATION_AUTHORIZATION_STORE_UNAVAILABLE', `could not access authorization consumption store: ${err.message}`);
      }
      if (!consumeResult.consumed) {
        throw new GuardRefusal('MIGRATION_AUTHORIZATION_REPLAYED', 'execution authorization has already been consumed');
      }
    }
    let consumed = [];
    try {
      if (fs.existsSync(authorizationStorePath)) {
        consumed = JSON.parse(fs.readFileSync(authorizationStorePath, 'utf8'));
        if (!Array.isArray(consumed)) consumed = [];
      }
    } catch (_) {
      consumed = [];
    }
    const requireControls = !argv.includes('--allow-legacy-authorization') && env.MIGRATION_AUTHORIZATION_REQUIRE_CONTROLS !== '0';
    const plan = classifyMigrations({
      files: resolvedFiles,
      recorded: recorded.versions,
      manifest: resolvedManifest,
      effects: resolvedEffects,
      authorization,
      consumed,
      requireControls,
    });

    if (previewMode) {
      log(formatPreview(plan, { integrity: resolvedIntegrity, recorded }));
      const executable = plan.filter((p) => p.decision === DECISION_EXECUTE).length;
      const blocked = plan.filter((p) => p.decision === DECISION_BLOCK).length;
      log(`[MIGRATE] Preview complete (non-mutating). would_execute=${executable} blocked=${blocked}.`);
      return { plan, applied: 0, assess: true, preview: true, recorded, integrity: resolvedIntegrity };
    }

    log(formatPlan(plan));

    // Audit writer is created only when there is actual, unblocked execution
    // work, so blocked, preview and no-op runs never touch the audit log.
    const executable = plan.filter((p) => p.decision === DECISION_EXECUTE).length;
    const blockedCount = plan.filter((p) => p.decision === DECISION_BLOCK).length;
    const auditFlag = argv.find((a) => typeof a === 'string' && a.startsWith('--audit-log='));
    const resolvedAuditPath =
      auditPath || (auditFlag ? auditFlag.slice('--audit-log='.length) : null) || DEFAULT_AUDIT_PATH; // F-05: ignore MIGRATION_AUDIT_LOG env by default
    let audit = null;
    if (executable > 0 && blockedCount === 0) {
      audit = auditFactory
        ? await auditFactory({ argv, env, authorization, source: authSource, integrity: resolvedIntegrity })
        : createAuditWriter({
            file: resolvedAuditPath,
            authorization: {
              fingerprint: authorizationFingerprint(authorization && authorization.id),
              source: authSource,
            },
            now,
          });
    }

    const result = await executePlan({
      client,
      plan,
      baseDir: MIGRATIONS_DIR,
      readFile,
      log,
      audit,
      auditRequired: executable > 0,
      integrity: resolvedIntegrity,
    });
    log(`[MIGRATE] ${result.applied} pending migration(s) applied. ${recorded.versions.length} already recorded of ${resolvedFiles.length}.`);
    return { ...result, assess: false, preview: false, recorded, integrity: resolvedIntegrity };
  } finally {
    if (client && typeof client.end === 'function') {
      await client.end().catch(() => {});
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    if (err instanceof GuardRefusal) {
      console.error('[MIGRATE BLOCKED] ' + err.message);
      process.exitCode = 3;
    } else if (err instanceof IntegrityRefusal) {
      console.error('[MIGRATE INTEGRITY VIOLATION] ' + err.message);
      process.exitCode = 3;
    } else if (err instanceof IdentityRefusal) {
      console.error(err.message);
      process.exitCode = 1;
    } else {
      console.error('[MIGRATE ERROR]', err && (err.stack || err.message));
      process.exitCode = 1;
    }
  });
}

module.exports = {
  // constants / config
  MIGRATIONS_DIR,
  AUTHORIZATION_PATH,
  INTEGRITY_PATH,
  DEFAULT_AUTHORIZATION,
  DEFAULT_AUDIT_PATH,
  HARD_BLOCKED,
  DECISION_EXECUTE,
  DECISION_BLOCK,
  DECISION_SKIP,
  // errors
  IdentityRefusal,
  GuardRefusal,
  // manifest
  loadAuthorization,
  resolveAuthorization,
  // connection (identity-verified; shared with MTC-29 reconciliation)
  getWorkingClient,
  // state detection / classification
  listMigrationFiles,
  readRecorded,
  probeEffects,
  effectPresent,
  classifyMigrations,
  // authorization consumption
  consumeAuthorization,
  // execution
  executePlan,
  runGuardedMigrations,
  main,
  // reporting
  formatPlan,
  formatBlockMessage,
  formatPreview,
  hashPlan,
  authorizationSource,
};
