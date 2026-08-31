const { Pool } = require('pg');
const config = require('./index');
const logger = require('../utils/logger');

const pool = new Pool({
  ...config.db,
  max: 20,               // connection pooling for high concurrency
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000, // 10s query timeout
});

pool.on('error', (err) => {
  logger.error('DB_POOL', err.message);
});

// Periodic pool monitoring
setInterval(() => {
  logger.info('DB_POOL_STATS', 'Pool stats', {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  });
}, 60000); // Every minute

module.exports = pool;

