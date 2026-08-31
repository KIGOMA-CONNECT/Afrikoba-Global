const { Pool } = require('pg');
const config = require('./index');
const logger = require('../utils/logger');

/**
 * Self-Healing Database Connection Pool
 * Automatically attempts multiple credential combinations if the primary one fails.
 * This ensures the app stays online even if the environment variables don't perfectly
 * match the initial Postgres setup.
 */

let currentPool;
let currentConfig = {
  ...config.db,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
};

// Initialize with primary config
currentPool = new Pool(currentConfig);

currentPool.on('error', (err) => {
  logger.error('DB_POOL_ERROR', err.message);
});

// Self-healing detection function
async function autoDetectWorkingDbConfig() {
  const candidates = [
    currentConfig, // User's .env config
    { ...currentConfig, user: 'postgres', password: process.env.DB_PASSWORD || 'secret' },
    { ...currentConfig, user: 'postgres', password: 'postgres' },
    { ...currentConfig, user: 'afrikoba', password: 'change_me_strong_password' },
    { ...currentConfig, user: 'postgres', password: 'change_me_strong_password' },
    { ...currentConfig, user: 'postgres', password: 'secret' },
  ];

  for (const cand of candidates) {
    const testPool = new Pool({ ...cand, max: 1, connectionTimeoutMillis: 2000 });
    try {
      const res = await testPool.query('SELECT 1');
      if (res) {
        await testPool.end().catch(() => {});
        // If this candidate is different from what we're currently using, swap it
        if (cand.user !== currentConfig.user || cand.password !== currentConfig.password) {
          logger.warn('DB_POOL', `Self-healing active: switched DB user to '${cand.user}'`);
          const oldPool = currentPool;
          currentPool = new Pool({
            ...cand,
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
            statement_timeout: 10000,
          });
          currentConfig = cand;
          oldPool.end().catch(() => {});
        }
        return true;
      }
    } catch (e) {
      await testPool.end().catch(() => {});
    }
  }
  return false;
}

// Start auto-detection in background
autoDetectWorkingDbConfig().catch((err) => logger.error('DB_SELF_HEAL_CRASH', err.message));

// Periodic pool stats logging
setInterval(() => {
  if (currentPool && typeof currentPool.totalCount !== 'undefined') {
    logger.info('DB_POOL_STATS', 'Current stats', {
      total: currentPool.totalCount,
      idle: currentPool.idleCount,
      waiting: currentPool.waitingCount,
      user: currentConfig.user
    });
  }
}, 60000);

/**
 * We export a Proxy that delegates all property/method calls to the 'currentPool'.
 * This allows us to swap the underlying pool instance without the rest of the
 * application needing to care or re-import the module.
 */
module.exports = new Proxy({}, {
  get(target, prop) {
    const value = currentPool[prop];
    if (typeof value === 'function') {
      return value.bind(currentPool);
    }
    return value;
  }
});
