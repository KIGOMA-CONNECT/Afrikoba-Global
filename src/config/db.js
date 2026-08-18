const { Pool } = require('pg');
const config = require('./index');

const pool = new Pool({
  ...config.db,
  max: 20,               // connection pooling for high concurrency
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[PG POOL ERROR]', err.message);
});

module.exports = pool;
