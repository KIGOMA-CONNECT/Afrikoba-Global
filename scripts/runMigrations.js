/**
 * Database Migration Runner
 * Applies any unapplied db/migrations/*.sql files in filename order.
 * Tracks applied versions in a schema_migrations table (idempotent).
 *
 * Automatically creates the database and runs base schema.sql if missing.
 *
 * Identity controls (P1.1):
 *  - The maintenance connection may only use a permitted maintenance database and is
 *    identity-verified before any DDL.
 *  - The target name is validated (format, explicit PHASE68_TEST_DB match, denylist)
 *    before CREATE DATABASE, and is quoted in the DDL.
 *  - Every credential candidate must pass the same identity check on the connected
 *    database before schema.sql or any migration runs.
 *  - Identity refusals are never swallowed and never retried.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAINTENANCE_DBS = ['postgres'];
const DENYLIST = ['afrikoba_regression', 'afrikoba_global', 'afrikoba', 'afrikoba_staging', 'postgres', 'phase68_guard', 'phase68_remed_dryrun'];
const TARGET_PATTERN = /^phase68_amount_guard_[a-z0-9_]+$/i;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/i;
const DUPLICATE_DATABASE = '42P04';
const CONNECTIVITY_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH'];

class IdentityRefusal extends Error {}

function refuse(message) {
  return new IdentityRefusal('REFUSING: ' + message);
}

// Validates the configured target before any connection or DDL.
function validatedTarget() {
  const expected = process.env.PHASE68_TEST_DB;
  const targetDb = process.env.DB_NAME;
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
function credentialCandidates() {
  const host = process.env.DB_HOST || 'db';
  const port = Number(process.env.DB_PORT || 5432);
  return [
    { label: 'primary', host, port, user: process.env.DB_USER || 'afrikoba', password: process.env.DB_PASSWORD || 'change_me_strong_password' },
    { label: 'fallback-app', host, port, user: 'afrikoba', password: 'change_me_strong_password' },
    { label: 'fallback-superuser', host, port, user: 'postgres', password: process.env.DB_PASSWORD || 'postgres' },
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
async function ensureTargetDatabase(targetDb) {
  let lastErr = null;
  for (const candidate of credentialCandidates()) {
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

// Connects to the target with each credential candidate in turn. Identity is verified before schema or migrations.
async function getWorkingClient() {
  const targetDb = validatedTarget();
  await ensureTargetDatabase(targetDb);

  let schemaChecked = false;
  for (let attempt = 1; attempt <= 15; attempt++) {
    for (const candidate of credentialCandidates()) {
      const client = clientFor(targetDb, candidate);
      try {
        await client.connect();
        await verifyIdentity(client, targetDb, 'target');
        console.log(`[MIGRATE] Connected to database '${targetDb}' using credential '${candidate.label}' (user '${candidate.user}'). Identity verified: ${targetDb}`);
        if (!schemaChecked) {
          schemaChecked = true;
          const tableCheck = await client.query(`SELECT to_regclass('public.users')`);
          if (!tableCheck.rows[0].to_regclass) {
            console.log(`[MIGRATE] Base table 'users' not found. Executing db/schema.sql...`);
            const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
            if (fs.existsSync(schemaPath)) {
              await client.query(fs.readFileSync(schemaPath, 'utf8'));
              console.log(`[MIGRATE] Base schema.sql executed successfully.`);
            }
          }
        }
        return client;
      } catch (err) {
        await client.end().catch(() => {});
        if (err instanceof IdentityRefusal) throw err;
        if (!isConnectivityError(err) && err && err.code !== '28P01' && err.code !== '28000') throw err;
        console.log(`[MIGRATE] Credential '${candidate.label}' not usable (${err.code || err.message}); trying next candidate.`);
      }
    }
    console.log(`[MIGRATE] Waiting for database connection (attempt ${attempt}/15)...`);
    await sleep(2000);
  }

  throw new Error('Could not connect to database after 15 attempts.');
}

async function main() {
  let client;
  try {
    client = await getWorkingClient();

    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version VARCHAR(255) PRIMARY KEY,
         applied_at TIMESTAMPTZ DEFAULT NOW()
       )`
    );

    const dir = path.join(__dirname, '..', 'db', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

    const used = await client.query('SELECT version FROM schema_migrations');
    const done = new Set(used.rows.map((r) => r.version));

    let applied = 0;
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[MIGRATE] Applied ${file}`);
        applied++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[MIGRATE ERROR] ${file}: ${err.message}`);
        process.exitCode = 1;
        break;
      }
    }

    console.log(`[MIGRATE] ${applied} pending migration(s) applied. ${done.size} already applied of ${files.length}.`);
  } catch (err) {
    console.error('[MIGRATE ERROR]', err.message);
    process.exitCode = 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

main();
