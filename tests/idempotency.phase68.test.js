'use strict';
/**
 * Phase 68 — idempotency middleware (finding S3).
 *
 * Verifies, against the disposable Postgres database:
 *   - keys are scoped per user in memory, Redis and the database;
 *   - concurrent duplicates execute the mutation once (the second gets 409);
 *   - a completed response is replayed without re-execution;
 *   - refusals and aborted requests release the claim so retries work;
 *   - an unauthenticated request cannot use a key.
 *
 * No Express/supertest dependency: the middleware is exercised with request /
 * response doubles. No network, no Redis (REDIS_URL unset in the test env).
 */

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const DB_NAME = process.env.DB_NAME || '';
if (!/^phase68_amount_guard_[a-z0-9_]+$/.test(DB_NAME) || process.env.PHASE68_TEST_DB !== DB_NAME) {
  console.error('SUITE ERROR: DB_NAME and PHASE68_TEST_DB must match an explicit phase68_amount_guard_<unique_suffix> disposable database name.');
  process.exit(2);
}

const pool = require(path.join(ROOT, 'src/config/db'));
const { idempotent } = require(path.join(ROOT, 'src/middleware/idempotent'));

const RUN = `TESTIDEM-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRes() {
  const listeners = new Map();
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    locals: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
    json(body) { this.body = body; this.emit('finish'); return this; },
    on(ev, cb) {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(cb);
      return this;
    },
    emit(ev) {
      for (const cb of listeners.get(ev) || []) cb();
    },
  };
}

/**
 * Run one middleware-wrapped handler.
 * @param {object} opts
 * @param {number|null} opts.userId
 * @param {string|null} opts.key
 * @param {function} opts.handler (req, res) => any
 */
async function invoke({ userId, key, handler }) {
  const req = {
    headers: key ? { 'idempotency-key': key } : {},
    user: userId ? { id: userId } : undefined,
  };
  const res = makeRes();
  let nextError = null;
  await idempotent(handler)(req, res, (err) => { nextError = err || new Error('next called'); });
  if (res.locals.idempotencyFinalize) await res.locals.idempotencyFinalize();
  return { res, nextError };
}

function countingHandler({ status = 200, body = { ok: true }, delay = 0 } = {}) {
  const state = { executions: 0 };
  const handler = async (req, res) => {
    state.executions++;
    if (delay) await sleep(delay);
    return res.status(status).json(typeof body === 'function' ? body(state.executions) : body);
  };
  return { state, handler };
}

async function rowsFor(rawKey) {
  const { rows } = await pool.query(
    `SELECT key_value, user_id, status_code, response_body, expires_at
       FROM idempotency_keys WHERE key_value LIKE $1 ORDER BY key_value`,
    [`%${rawKey}`]
  );
  return rows;
}

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

let userA;
let userB;

/* ------------------------------------------------------------------ */

scenario('no Idempotency-Key passes straight through', async () => {
  const raw = `${RUN}-nokey`;
  const { state, handler } = countingHandler();
  const { res } = await invoke({ userId: userA, key: null, handler });
  assert.strictEqual(state.executions, 1, 'handler did not run');
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { ok: true });
  assert.strictEqual((await rowsFor(raw)).length, 0, 'row written without a key');
});

scenario('missing authenticated user is rejected fail-closed', async () => {
  const raw = `${RUN}-noauth`;
  const { state, handler } = countingHandler();
  const { res } = await invoke({ userId: null, key: raw, handler });
  assert.strictEqual(state.executions, 0, 'handler ran without a user');
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.code, 'IDEMPOTENCY_REQUIRES_AUTH');
  assert.strictEqual((await rowsFor(raw)).length, 0, 'row written for unauthenticated request');
});

scenario('replay returns the cached response without re-executing', async () => {
  const raw = `${RUN}-replay`;
  const { state, handler } = countingHandler({ body: { value: 'first' } });
  const first = await invoke({ userId: userA, key: raw, handler });
  assert.strictEqual(state.executions, 1);
  assert.strictEqual(first.res.statusCode, 200);

  const second = await invoke({ userId: userA, key: raw, handler });
  assert.strictEqual(state.executions, 1, 'handler re-executed on replay');
  assert.deepStrictEqual(second.res.body, { value: 'first' });
  assert.strictEqual(second.res.statusCode, 200);

  const rows = await rowsFor(raw);
  assert.strictEqual(rows.length, 1, 'expected one scoped row');
  assert.strictEqual(rows[0].key_value, `u${userA}:${raw}`, 'key not scoped to user');
  assert.strictEqual(Number(rows[0].status_code), 200);
});

scenario('the same key from another user is isolated', async () => {
  const raw = `${RUN}-cross`;
  const { state, handler } = countingHandler({
    body: (n) => ({ executed: n }),
  });

  const a1 = await invoke({ userId: userA, key: raw, handler });
  assert.strictEqual(state.executions, 1);
  assert.deepStrictEqual(a1.res.body, { executed: 1 });

  const b1 = await invoke({ userId: userB, key: raw, handler });
  assert.strictEqual(state.executions, 2, 'user B read user A cached response');
  assert.deepStrictEqual(b1.res.body, { executed: 2 }, 'user B got user A body');

  const a2 = await invoke({ userId: userA, key: raw, handler });
  assert.strictEqual(state.executions, 2, 'user A replay re-executed');
  assert.deepStrictEqual(a2.res.body, { executed: 1 });

  const rows = await rowsFor(raw);
  assert.strictEqual(rows.length, 2, 'expected one row per user');
  assert.deepStrictEqual(
    rows.map((r) => r.key_value).sort(),
    [`u${userA}:${raw}`, `u${userB}:${raw}`].sort()
  );
});

scenario('concurrent duplicates execute once; the loser gets 409', async () => {
  const raw = `${RUN}-concurrent`;
  const { state, handler } = countingHandler({ delay: 200, body: { done: true } });

  const [r1, r2] = await Promise.all([
    invoke({ userId: userA, key: raw, handler }),
    invoke({ userId: userA, key: raw, handler }),
  ]);

  assert.strictEqual(state.executions, 1, `handler executed ${state.executions} times`);
  const statuses = [r1.res.statusCode, r2.res.statusCode].sort();
  assert.deepStrictEqual(statuses, [200, 409], `unexpected statuses ${statuses}`);

  const loser = r1.res.statusCode === 409 ? r1.res : r2.res;
  assert.strictEqual(loser.body.code, 'IDEMPOTENCY_IN_PROGRESS');
  assert.ok(Number(loser.headers['retry-after']) >= 1, 'missing Retry-After');

  const replay = await invoke({ userId: userA, key: raw, handler });
  assert.strictEqual(state.executions, 1, 'replay after concurrency re-executed');
  assert.strictEqual(replay.res.statusCode, 200);
  assert.deepStrictEqual(replay.res.body, { done: true });
});

scenario('a refusal releases the claim so the client can retry', async () => {
  const raw = `${RUN}-refusal`;
  const { state, handler } = countingHandler({ status: 429, body: { code: 'LIMIT_EXCEEDED' } });

  const first = await invoke({ userId: userA, key: raw, handler });
  assert.strictEqual(first.res.statusCode, 429);
  assert.strictEqual(state.executions, 1);
  assert.strictEqual((await rowsFor(raw)).length, 0, 'refusal was cached');

  const second = await invoke({ userId: userA, key: raw, handler });
  assert.strictEqual(second.res.statusCode, 429);
  assert.strictEqual(state.executions, 2, 'retry did not re-execute');
});

scenario('an aborted request releases the claim', async () => {
  const raw = `${RUN}-aborted`;
  const state = { executions: 0 };
  const handler = async () => { state.executions++; };

  const req = { headers: { 'idempotency-key': raw }, user: { id: userA } };
  const res = makeRes();
  await idempotent(handler)(req, res, () => {});
  // Simulate the connection closing before a response was written.
  res.emit('close');
  await res.locals.idempotencyFinalize();
  assert.strictEqual(state.executions, 1);
  assert.strictEqual((await rowsFor(raw)).length, 0, 'aborted claim was not released');

  const retry = await invoke({ userId: userA, key: raw, handler: async (rq, rs) => rs.json({ ok: 'retry' }) });
  assert.strictEqual(retry.res.statusCode, 200);
  assert.deepStrictEqual(retry.res.body, { ok: 'retry' });
});

scenario('a completed DB row is replayed without touching the handler', async () => {
  const raw = `${RUN}-dbreplay`;
  const key = `u${userA}:${raw}`;
  await pool.query(
    `INSERT INTO idempotency_keys (key_value, user_id, status_code, response_body, expires_at)
     VALUES ($1, $2, 201, $3::jsonb, NOW() + INTERVAL '1 hour')`,
    [key, userA, JSON.stringify({ from: 'db' })]
  );
  const { state, handler } = countingHandler();
  const { res } = await invoke({ userId: userA, key: raw, handler });
  assert.strictEqual(state.executions, 0, 'handler ran despite a completed row');
  assert.strictEqual(res.statusCode, 201);
  assert.deepStrictEqual(res.body, { from: 'db' });
});

scenario('a completed row belonging to another user is ignored', async () => {
  const raw = `${RUN}-otherrow`;
  await pool.query(
    `INSERT INTO idempotency_keys (key_value, user_id, status_code, response_body, expires_at)
     VALUES ($1, $2, 200, $3::jsonb, NOW() + INTERVAL '1 hour')`,
    [`u${userB}:${raw}`, userB, JSON.stringify({ secret: 'user-b-only' })]
  );
  const { state, handler } = countingHandler({ body: { mine: true } });
  const { res } = await invoke({ userId: userA, key: raw, handler });
  assert.strictEqual(state.executions, 1, 'user A was served user B row');
  assert.deepStrictEqual(res.body, { mine: true });
});

scenario('different keys execute independently', async () => {
  const { state, handler } = countingHandler();
  await invoke({ userId: userA, key: `${RUN}-k1`, handler });
  await invoke({ userId: userA, key: `${RUN}-k2`, handler });
  assert.strictEqual(state.executions, 2);
});

/* ------------------------------------------------------------------ */

(async () => {
  const { rows } = await pool.query('SELECT id FROM users ORDER BY id LIMIT 2');
  assert.ok(rows.length >= 2, 'need at least two users in the disposable database');
  userA = rows[0].id;
  userB = rows[1].id;

  let failed = 0;
  for (const s of scenarios) {
    try {
      await s.fn();
      console.log(`PASS ${s.name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${s.name}\n     ${(e.stack || e.message).split('\n').slice(0, 5).join('\n     ')}`);
    }
  }

  await pool.query(`DELETE FROM idempotency_keys WHERE key_value LIKE $1`, [`%${RUN}%`]).catch(() => {});
  console.log(`RESULT: ${scenarios.length - failed} passed, ${failed} failed of ${scenarios.length}`);
  await pool.end().catch(() => {});
  process.exit(failed ? 1 : 0);
})();
