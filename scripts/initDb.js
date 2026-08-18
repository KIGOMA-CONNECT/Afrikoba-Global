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
    port: process.env.DB_PORT || 5432,
  });

  try {
    await client.connect();
    const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await client.query(schema);
    console.log('[DB] Schema imewekwa kikamilifu.');
  } catch (err) {
    console.error('[DB ERROR]', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
