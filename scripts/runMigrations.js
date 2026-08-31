/**
 * Database Migration Runner
 * Applies any unapplied db/migrations/*.sql files in filename order.
 * Tracks applied versions in a schema_migrations table (idempotent).
 *
 * Automatically creates the database and runs base schema.sql if missing.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureDatabaseAndSchema() {
  const targetDb = process.env.DB_NAME || 'afrikoba_global';
  const user = process.env.DB_USER || 'afrikoba';
  const password = process.env.DB_PASSWORD || 'change_me_strong_password';
  const host = process.env.DB_HOST || 'db';
  const port = Number(process.env.DB_PORT || 5432);

  // 1. Connect to 'postgres' to create target db if missing
  const adminClient = new Client({ user, host, database: 'postgres', password, port });
  try {
    await adminClient.connect();
    const res = await adminClient.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [targetDb]);
    if (res.rows.length === 0) {
      console.log(`[MIGRATE] Database '${targetDb}' does not exist. Creating it now...`);
      await adminClient.query(`CREATE DATABASE ${targetDb}`);
      console.log(`[MIGRATE] Database '${targetDb}' created successfully.`);
    }
  } catch (e) {
    console.log(`[MIGRATE] Note: Could not auto-create database (${e.message}), assuming it exists.`);
  } finally {
    await adminClient.end().catch(() => {});
  }

  // 2. Connect to target db and check if base schema.sql needs to be run
  const client = new Client({ user, host, database: targetDb, password, port });
  try {
    await client.connect();
    const tableCheck = await client.query(`SELECT to_regclass('public.users')`);
    if (!tableCheck.rows[0].to_regclass) {
      console.log(`[MIGRATE] Base table 'users' not found. Executing db/schema.sql...`);
      const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
      if (fs.existsSync(schemaPath)) {
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');
        await client.query(schemaSql);
        console.log(`[MIGRATE] Base schema.sql executed successfully.`);
      }
    }
  } catch (err) {
    console.error(`[MIGRATE ERROR] Schema setup failed: ${err.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

async function getWorkingClient() {
  await ensureDatabaseAndSchema();

  const candidates = [
    {
      user: process.env.DB_USER || 'afrikoba',
      host: process.env.DB_HOST || 'db',
      database: process.env.DB_NAME || 'afrikoba_global',
      password: process.env.DB_PASSWORD || 'change_me_strong_password',
      port: Number(process.env.DB_PORT || 5432),
    },
    {
      user: 'afrikoba',
      host: process.env.DB_HOST || 'db',
      database: process.env.DB_NAME || 'afrikoba_global',
      password: 'change_me_strong_password',
      port: Number(process.env.DB_PORT || 5432),
    },
    {
      user: 'postgres',
      host: process.env.DB_HOST || 'db',
      database: process.env.DB_NAME || 'afrikoba_global',
      password: process.env.DB_PASSWORD || 'postgres',
      port: Number(process.env.DB_PORT || 5432),
    },
  ];

  for (let attempt = 1; attempt <= 15; attempt++) {
    for (const config of candidates) {
      const client = new Client(config);
      try {
        await client.connect();
        console.log(`[MIGRATE] Connected to database '${config.database}' using user '${config.user}' at host '${config.host}'.`);
        return client;
      } catch (err) {
        await client.end().catch(() => {});
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