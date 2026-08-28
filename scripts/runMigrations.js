/**
 * Database Migration Runner
 * Applies any unapplied db/migrations/*.sql files in filename order.
 * Tracks applied versions in a schema_migrations table (idempotent).
 *
 * Usage:
 *   node scripts/runMigrations.js
 *
 * Runs automatically on container start (Docker) so a fresh production
 * database gets every migration (base schema + 001..NNN).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function main() {
  const client = new Client({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'afrikoba_global',
    password: process.env.DB_PASSWORD || 'secret',
    port: Number(process.env.DB_PORT || 5432),
  });

  try {
    await client.connect();
    console.log('[MIGRATE] Connected to database.');

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
    await client.end();
  }
}

main();