const Redis = require('ioredis');
const config = require('../config');
const logger = require('../utils/logger');

let redis = null;

function getRedis() {
  if (redis) return redis;
  if (!config.redis?.url) return null;

  redis = new Redis(config.redis.url, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 3) {
        logger.warn('REDIS', `Connection failed after ${times} retries. Falling back to in-memory.`);
        return null;
      }
      return Math.min(times * 200, 2000);
    },
    lazyConnect: true,
  });

  redis.on('error', (err) => {
    logger.warn('REDIS', `Error: ${err.message}`);
  });

  redis.on('connect', () => {
    logger.info('REDIS', 'Connected.');
  });

  redis.connect().catch(() => {
    logger.warn('REDIS', 'Failed to connect. Falling back to in-memory.');
    redis = null;
  });

  return redis;
}

module.exports = { getRedis };
