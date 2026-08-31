const { Pool } = require('pg');
const config = require('./index');
const logger = require('../utils/logger');

let currentPool;
let currentConfig = {
  ...config.db,
  host: process.env.DB_HOST || 'db',
  user: process.env.DB_USER || 'afrikoba',
  password: process.env.DB_PASSWORD || 'change_me_strong_password',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
};

currentPool = new Pool(currentConfig);

currentPool.on('error', (err) => {
  logger.error('DB_POOL_ERROR', err.message);
});

async function autoDetectWorkingDbConfig() {
  const candidates = [
    currentConfig,
    { ...currentConfig, user: 'afrikoba', password: 'change_me_strong_password' },
    { ...currentConfig, user: 'postgres', password: process.env.DB_PASSWORD || 'postgres' },
    { ...currentConfig, user: 'postgres', password: 'postgres' },
    { ...currentConfig, user: 'postgres', password: 'change_me_strong_password' },
  ];

  for (const cand of candidates) {
    const testPool = new Pool({ ...cand, max: 1, connectionTimeoutMillis: 2000 });
    try {
      const res = await testPool.query('SELECT 1');
      if (res) {
        await testPool.end().catch(() => {});
        if (cand.user !== currentConfig.user || cand.password !== currentConfig.password || cand.host !== currentConfig.host) {
          logger.warn('DB_POOL', `Self-healing active: switched DB user to '${cand.user}' at '${cand.host}'`);
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

autoDetectWorkingDbConfig().catch((err) => logger.error('DB_SELF_HEAL_CRASH', err.message));

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

module.exports = new Proxy({}, {
  get(target, prop) {
    const value = currentPool[prop];
    if (typeof value === 'function') {
      return value.bind(currentPool);
    }
    return value;
  }
});
