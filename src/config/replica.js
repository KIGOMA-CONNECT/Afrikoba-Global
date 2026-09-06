/**
 * READ REPLICA ROUTING (optional)
 * Ikiwa DB_REPLICA_HOST iko, tunatengeneza pool ya replica kwa queries za
 * read-only. Pindi replica itakapofeli kimtandao, inarudi kwa primary
 * (read-after-write consistency + resilience). CI haina DB_REPLICA_* →
 * queryRead hutumia primary pool na kuhesabiwa kwenye stats.
 */
const { Pool } = require('pg');
const primary = require('./db');

const replicaConfig = (() => {
  const host = process.env.DB_REPLICA_HOST;
  if (!host) return null;
  return {
    host,
    port: parseInt(process.env.DB_REPLICA_PORT || process.env.DB_PORT || '5432', 10),
    user: process.env.DB_REPLICA_USER || process.env.DB_USER || 'postgres',
    password: process.env.DB_REPLICA_PASSWORD || process.env.DB_PASSWORD || '',
    database: process.env.DB_REPLICA_NAME || process.env.DB_NAME || 'afrikoba_global',
    max: parseFloat(process.env.DB_REPLICA_MAX || '10'),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 3000,
    statement_timeout: 10000,
  };
})();

const replicaPool = replicaConfig ? new Pool(replicaConfig) : null;
if (replicaPool) {
  replicaPool.on('error', () => {});
  // probe once; mark unhealthy on failure so reads fall back to primary
  replicaPool.query('SELECT 1').catch(() => {
    replicaHealthy = false;
  });
}

let replicaHealthy = replicaConfig ? true : false;
const counters = { toReplica: 0, primaryFallback: 0, primaryDirect: 0 };

/**
 * Run =gawa read-only query: replica ikiwa healthy, vinginevyo primary.
 * Daima hurejesha matokeo (never throws for topology reasons).
 */
async function queryRead(text, params) {
  if (replicaPool && replicaHealthy) {
    try {
      const res = await replicaPool.query(text, params);
      counters.toReplica += 1;
      return res;
    } catch (e) {
      replicaHealthy = false;
      counters.primaryFallback += 1;
    }
  } else {
    counters.primaryDirect += 1;
  }
  return primary.query(text, params);
}

function replicaInfo() {
  return {
    enabled: !!replicaPool,
    healthy: replicaHealthy,
    ...counters,
  };
}

// Pool-compatible alias: services call `query.query(text, params)`.
queryRead.query = queryRead;

module.exports = { queryRead, replicaInfo, replicaPool }; // eslint-disable-line no-underscore-dangle