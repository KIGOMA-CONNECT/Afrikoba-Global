const { Pool } = require('pg');
const pg = require('pg');
const config = require('./index');
const logger = require('../utils/logger');

const POOL_MAX = Number(process.env.DB_POOL_MAX) || 20;

let currentPool;
let currentConfig = {
  ...config.db,
  host: process.env.DB_HOST || 'db',
  user: process.env.DB_USER || 'afrikoba',
  password: process.env.DB_PASSWORD || 'change_me_strong_password',
  max: POOL_MAX,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
  lock_timeout: 3000,
  idle_in_transaction_session_timeout: 8000,
};

currentPool = new Pool(currentConfig);

currentPool.on('error', (err) => {
  logger.error('DB_POOL_ERROR', err.message);
});

// 55P03 (lock timeout) / 40P01 (deadlock) diagnostics: dump which backend holds
// the contested locks so the phantom long-lived lock holder finally gets caught.
let lastLockDiag = 0;
async function diagnoseLockBlockers(sqlState) {
  const nowTs = Date.now();
  if (nowTs - lastLockDiag < 1500) return;
  lastLockDiag = nowTs;
  try {
    const res = await currentPool.query(
      `SELECT blocked_locks.pid AS blocked_pid,
              blocked_activity.state AS blocked_state,
              left(blocked_activity.query, 80) AS blocked_query,
              blocking_locks.pid AS blocking_pid,
              blocking_activity.state AS blocking_state,
              left(blocking_activity.query, 120) AS blocking_query,
              (now() - blocking_activity.xact_start)::text AS blocking_xact_age
         FROM pg_locks blocked_locks
         JOIN pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
         JOIN pg_locks blocking_locks
           ON blocking_locks.locktype = blocked_locks.locktype
          AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
          AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
          AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
          AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
          AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
          AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
          AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
          AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
          AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
         JOIN pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
        WHERE NOT blocked_locks.granted AND blocking_locks.granted`
    );
    if (res.rows.length) {
      res.rows.forEach((row) => {
        logger.warn('DB-LOCK-DIAG', `SQLState ${sqlState}: blocked=${row.blocked_pid}(${row.blocked_state}) "${row.blocked_query}" <- blocker=${row.blocking_pid}(${row.blocking_state}, xact_age=${row.blocking_xact_age}) "${row.blocking_query}"`);
      });
    }
  } catch (e) {
    logger.warn('DB-LOCK-DIAG', `diag query failed: ${e.message}`);
  }
  try {
    const holders = await currentPool.query(
      `SELECT l.pid, a.state, (now() - a.xact_start)::text AS xact_age,
              left(a.query, 140) AS q, COUNT(*) AS locks_held
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.granted
          AND a.pid <> pg_backend_pid()
          AND a.xact_start IS NOT NULL
          AND now() - a.xact_start > interval '0.5 seconds'
        GROUP BY l.pid, a.state, a.xact_start, left(a.query, 140)
        ORDER BY xact_age DESC`
    );
    if (holders.rows.length) {
      holders.rows.forEach((row) => {
        logger.warn('DB-LOCK-DIAG', `SQLState ${sqlState} persistent-holder: pid=${row.pid} state=${row.state} xact_age=${row.xact_age} locks=${row.locks_held} "${row.q}"`);
      });
    }
  } catch (e) {
    logger.warn('DB-LOCK-DIAG', `holder query failed: ${e.message}`);
  }
  try {
    const txs = await currentPool.query(
      `SELECT pid, state, (now() - xact_start)::text AS xact_age, left(query, 140) AS q
         FROM pg_stat_activity
        WHERE xact_start IS NOT NULL AND pid <> pg_backend_pid()
        ORDER BY xact_start`
    );
    if (txs.rows.length) {
      txs.rows.forEach((row) => {
        logger.warn('DB-LOCK-DIAG', `SQLState ${sqlState} in-tx: pid=${row.pid} state=${row.state} xact_age=${row.xact_age} "${row.q}"`);
      });
    }
  } catch (e) {
    logger.warn('DB-LOCK-DIAG', `in-tx query failed: ${e.message}`);
  }
}

async function terminateStaleLockHolders(graceSeconds = 2) {
  // CI suite is strictly sequential — backends holding granted locks for
  // >graceSeconds are by definition rogue/leaked and safe to terminate there.
  if (process.env.CI !== 'true') {
    logger.info('DB-LOCK-DIAG', 'terminateStaleLockHolders skipped (CI=false)');
    return 0;
  }
  try {
    const res = await currentPool.query(
      `SELECT l.pid AS terminated, pg_terminate_backend(l.pid) AS ok
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.granted
          AND l.pid <> pg_backend_pid()
          AND a.xact_start IS NOT NULL
          AND a.xact_start < now() - ($1::int || ' seconds')::interval`,
      [graceSeconds]
    );
    logger.info('DB-LOCK-DIAG', `terminate(${graceSeconds}s) -> ${res.rows.length} stale holder(s) terminated`);
    return res.rows.length;
  } catch (e) {
    logger.warn('DB-LOCK-DIAG', `terminate query failed: ${e.message}`);
    return 0;
  }
}

const origPgQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function q(...args) {
  const p = origPgQuery.apply(this, args);
  if (p && typeof p.then === 'function') {
    p.then(null, (e) => {
      if (e && (e.code === '55P03' || e.code === '40P01')) diagnoseLockBlockers(e.code);
    });
  }
  return p;
};

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
            max: POOL_MAX,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
            statement_timeout: 30000,
            lock_timeout: 3000,
            idle_in_transaction_session_timeout: 8000,
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

function safeRelease(client, origRelease, err) {
  if (!err) {
    client.query('ROLLBACK').then(() => origRelease()).catch(() => origRelease());
    return;
  }
  origRelease(err);
}

function safeConnect() {
  return currentPool.connect().then((client) => {
    if (!client || client.__afrikobaSafeRelease) return client;
    const origRelease = client.release.bind(client);
    let released = false;
    client.release = (err) => {
      if (released) return;
      released = true;
      safeRelease(client, origRelease, err);
    };
    client.__afrikobaSafeRelease = true;
    return client;
  });
}

module.exports = new Proxy({}, {
  get(target, prop) {
    if (prop === 'connect') {
      return safeConnect;
    }
    if (prop === 'terminateStaleLockHolders') {
      return terminateStaleLockHolders;
    }
    const value = currentPool[prop];
    if (typeof value === 'function') {
      return value.bind(currentPool);
    }
    return value;
  }
});
