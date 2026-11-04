const { Pool } = require('pg');
const pg = require('pg');
const config = require('./index');
const logger = require('../utils/logger');

const POOL_MAX = Number(process.env.DB_POOL_MAX) || 20;

let currentPool;
let currentConfig = {
  ...config.db,
  host: process.env.DB_HOST || config.db.host,
  user: process.env.DB_USER || config.db.user,
  password: process.env.DB_PASSWORD || '',
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

let lastLockDiag = 0;
async function diagnoseLockBlockers(sqlState) {
  const nowTs = Date.now();
  if (nowTs - lastLockDiag < 1500) return;
  lastLockDiag = nowTs;
  try {
    const res = await currentPool.query(
      "SELECT blocked_locks.pid AS blocked_pid, blocked_activity.state AS blocked_state, left(blocked_activity.query, 80) AS blocked_query, blocking_locks.pid AS blocking_pid, blocking_activity.state AS blocking_state, left(blocking_activity.query, 120) AS blocking_query, (now() - blocking_activity.xact_start)::text AS blocking_xact_age FROM pg_locks blocked_locks JOIN pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid JOIN pg_locks blocking_locks ON blocking_locks.locktype = blocked_locks.locktype AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid JOIN pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid WHERE NOT blocked_locks.granted AND blocking_locks.granted"
    );
    if (res.rows.length) {
      res.rows.forEach((row) => {
        logger.warn('DB-LOCK-DIAG', 'SQLState ' + sqlState + ': blocked=' + row.blocked_pid + '(' + row.blocked_state + ') <- blocker=' + row.blocking_pid + '(' + row.blocking_state + ', xact_age=' + row.blocking_xact_age + ')');
      });
    }
  } catch (e) {
    logger.warn('DB-LOCK-DIAG', 'diag query failed: ' + e.message);
  }
}

async function terminateStaleLockHolders(graceSeconds) {
  if (graceSeconds === undefined) graceSeconds = 2;
  if (process.env.CI !== 'true') {
    logger.info('DB-LOCK-DIAG', 'terminateStaleLockHolders skipped (CI=false)');
    return 0;
  }
  try {
    const res = await currentPool.query(
      "SELECT l.pid AS terminated, pg_terminate_backend(l.pid) AS ok FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.granted AND l.pid <> pg_backend_pid() AND a.xact_start IS NOT NULL AND a.xact_start < now() - ($1::int || ' seconds')::interval",
      [graceSeconds]
    );
    logger.info('DB-LOCK-DIAG', 'terminate(' + graceSeconds + 's) -> ' + res.rows.length + ' stale holder(s) terminated');
    return res.rows.length;
  } catch (e) {
    logger.warn('DB-LOCK-DIAG', 'terminate query failed: ' + e.message);
    return 0;
  }
}

const origPgQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function q() {
  var args = Array.prototype.slice.call(arguments);
  const p = origPgQuery.apply(this, args);
  if (p && typeof p.then === 'function') {
    p.then(null, function(e) {
      if (e && (e.code === '55P03' || e.code === '40P01')) diagnoseLockBlockers(e.code);
    });
  }
  return p;
};

const dbPoolStatsInterval = setInterval(function() {
  if (currentPool && typeof currentPool.totalCount !== 'undefined') {
    logger.info('DB_POOL_STATS', 'Current stats', {
      total: currentPool.totalCount,
      idle: currentPool.idleCount,
      waiting: currentPool.waitingCount,
      user: currentConfig.user
    });
  }
}, 60000);
if (typeof dbPoolStatsInterval.unref === 'function') {
  dbPoolStatsInterval.unref();
}

function isBeginQuery(text) {
  if (!text) return false;
  var t = String(text).trim().toLowerCase();
  return t === 'begin' || t.indexOf('begin ') === 0 || t.indexOf('start transaction') === 0;
}

function isCommitQuery(text) {
  if (!text) return false;
  var t = String(text).trim().toLowerCase();
  return t === 'commit' || t.indexOf('commit ') === 0 || t === 'end' || t.indexOf('end ') === 0;
}

function isRollbackQuery(text) {
  if (!text) return false;
  var t = String(text).trim().toLowerCase();
  return t === 'rollback' || t.indexOf('rollback ') === 0;
}

function extractSql(args) {
  if (!args || args.length === 0) return null;
  var sql = args[0];
  if (typeof sql === 'object' && sql !== null && sql.text) {
    sql = sql.text;
  }
  if (typeof sql === 'string') return sql;
  return null;
}

function trackTransactionState(client) {
  if (client.__afrikobaTxTracked) return;
  client.__afrikobaTxTracked = true;
  var origQuery = client.query.bind(client);
  client.query = function() {
    var args = Array.prototype.slice.call(arguments);
    var sql = extractSql(args);
    var cmdBegin = sql && isBeginQuery(sql);
    var cmdCommit = sql && isCommitQuery(sql);
    var cmdRollback = sql && isRollbackQuery(sql);

    if (typeof args[args.length - 1] === 'function') {
      var cb = args[args.length - 1];
      args[args.length - 1] = function(err, result) {
        if (!err) {
          if (cmdBegin) client.__afrikobaInTx = true;
          else if (cmdCommit || cmdRollback) client.__afrikobaInTx = false;
        }
        return cb(err, result);
      };
      try {
        return origQuery.apply(this, args);
      } catch (e) {
        throw e;
      }
    }

    var p;
    try {
      p = origQuery.apply(this, args);
    } catch (e) {
      throw e;
    }
    if (p && typeof p.then === 'function') {
      return p.then(function(res) {
        if (cmdBegin) client.__afrikobaInTx = true;
        else if (cmdCommit || cmdRollback) client.__afrikobaInTx = false;
        return res;
      }, function(err) {
        throw err;
      });
    }
    return p;
  };
}

function safeRelease(client, origRelease, err) {
  var released = false;
  function doRelease(e) {
    if (released) return;
    released = true;
    try {
      origRelease(e);
    } catch (releaseEx) {
      // Preserve original caller error; do not let release exception mask it
      if (err) {
        throw err;
      }
      throw releaseEx;
    }
  }

  if (err) {
    if (client.__afrikobaInTx) {
      try {
        var p = client.query('ROLLBACK');
        if (p && typeof p.then === 'function') {
          p.then(function() {
            try {
              doRelease(err);
            } catch (e) {
              // caller error is primary; suppress release exception
            }
          }).catch(function(rbE) {
            var rbErr = rbE || new Error('rollback_failed');
            try {
              doRelease(rbErr);
            } catch (e) {
              // caller error is primary; suppress release exception
            }
          });
          return;
        }
      } catch (e) {
        var rbErr2 = e || new Error('rollback_failed');
        doRelease(rbErr2);
        return;
      }
      // sync path with no promise
      doRelease(err);
      return;
    }
    doRelease(err);
    return;
  }

  if (client.__afrikobaInTx) {
    try {
      var p2 = client.query('ROLLBACK');
      if (p2 && typeof p2.then === 'function') {
        p2.then(function() {
          client.__afrikobaInTx = false;
          try {
            doRelease();
          } catch (e) {
            // suppress release exception to avoid unhandled rejection
          }
        }).catch(function(rbE) {
          var rbErr3 = rbE || new Error('rollback_failed');
          try {
            doRelease(rbErr3);
          } catch (e) {
            // suppress release exception to avoid unhandled rejection
          }
        });
        return;
      }
    } catch (e) {
      var rbErr4 = e || new Error('rollback_failed');
      doRelease(rbErr4);
      return;
    }
    client.__afrikobaInTx = false;
    doRelease();
    return;
  }
  doRelease();
}

function safeConnect() {
  return currentPool.connect().then(function(client) {
    if (!client || client.__afrikobaSafeRelease) return client;
    trackTransactionState(client);
    var origRelease = client.release.bind(client);
    var released = false;
    client.release = function(err) {
      if (released) return;
      released = true;
      safeRelease(client, origRelease, err);
    };
    client.__afrikobaSafeRelease = true;
    return client;
  });
}

const proxy = new Proxy({}, {
  get: function(target, prop) {
    if (prop === 'connect') {
      return safeConnect;
    }
    if (prop === 'terminateStaleLockHolders') {
      return terminateStaleLockHolders;
    }
    if (prop === '_setPool') {
      return function(pool) { currentPool = pool; };
    }
    if (prop === '_getPool') {
      return function() { return currentPool; };
    }
    var value = currentPool[prop];
    if (typeof value === 'function') {
      return value.bind(currentPool);
    }
    return value;
  }
});
module.exports = proxy;
