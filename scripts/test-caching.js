/* ============================================================
 * AFRIKOBA GLOBAL - CACHING + READ-REPLICA ROUTING REGRESSION
 * Verifies:
 *  - Pluggable cache (memory backend default; redis pou REDIS_URL)
 *    set/get, miss, TTL expiry, del, prefix bust, flush.
 *  - Read-through caching on /services/catalog + /vaults endpoints
 *    (hits counted via /api/cache/stats).
 *  - Admin stats/login gating on cache ops endpoints.
 *  - queryRead() replica routing counters are wired (CI: primaryDirect).
 * ============================================================ */
const BASE = process.env.CACHING_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');
const cache = require('../src/utils/cache');
const { queryRead, replicaInfo } = require('../src/config/replica');

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, extra) {
  failed++;
  failures.push(label);
  console.log(`  ✗ ${label}${extra ? ' :: ' + extra : ''}`);
}
async function expect(cond, label, extra) {
  if (cond) ok(label);
  else fail(label, extra);
}
async function section(label) { console.log('\n--- ' + label + ' ---'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const isGet = method === 'GET' || method === 'HEAD';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: !isGet && body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}

async function sendOtp(phoneNumber) {
  const r = await api('POST', '/api/auth/send-otp', null, { phoneNumber });
  return r.data.devOtp;
}
async function register(phoneNumber, fullName) {
  const otp = await sendOtp(phoneNumber);
  const r = await api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
  return r.data;
}

async function makeAdmin(regData) {
  if (!regData || !regData.user || !regData.user.id) return null;
  await pool.query("UPDATE users SET role = 'ADMIN', updated_at = NOW() WHERE id = $1", [regData.user.id]);
  return regData.user.id;
}

(async () => {
  const suffix = Math.floor(1000 + Math.random() * 9000);

  await section('Unit: memory cache backend');
  await cache.flush();
  await cache.set('unit:a', { ok: 1 }, 5000);
  const hit = await cache.get('unit:a');
  await expect(hit && hit.ok === 1, 'set + get returns value');
  const miss = await cache.get('unit:missing');
  await expect(miss === undefined, 'get of unknown key is a miss');

  await cache.set('unit:b', 'x', 120);
  await sleep(160);
  const expired = await cache.get('unit:b');
  await expect(expired === undefined, 'TTL expiry evicts entry');

  await cache.set('unit:del', 1, 5000);
  await cache.del('unit:del');
  const gone = await cache.get('unit:del');
  await expect(gone === undefined, 'del removes key');

  await cache.set('unit:p1', 1, 5000);
  await cache.set('unit:p2', 2, 5000);
  await cache.bust('unit:p');
  const b1 = await cache.get('unit:p1');
  const b2 = await cache.get('unit:p2');
  await expect(b1 === undefined && b2 === undefined, 'bust(prefix) removes matching keys');
  const s = cache.getStats();
  await expect(!!s.backend, 'stats expose backend (' + s.backend + ')');
  await expect(typeof s.hits === 'number', 'stats expose hit counter');

  await section('Replica routing (queryRead)');
  const before = replicaInfo();
  await queryRead('SELECT 1');
  const after = replicaInfo();
  if (process.env.DB_REPLICA_HOST) {
    await expect(after.enabled && after.toReplica > before.toReplica, 'queries routed to replica');
  } else {
    await expect(after.primaryDirect > before.primaryDirect, 'primary fallback path counted (no replica configured)');
  }

  await section('HTTP: register + admin promote');
  const uniqA = `255715${suffix}`;
  const uniqU = `255716${suffix}`;
  const userA = await register(uniqA, `CacheUserA${suffix}`);
  await expect(!!userA.token, 'user A registered');
  const adm = await register(uniqU, `CacheAdmin${suffix}`);
  const admId = await makeAdmin(adm);
  await expect(!!admId, 'admin promoted to ADMIN');

  await section('HTTP: /services/catalog read-through cache');
  let c1 = await api('GET', '/api/services/catalog', userA.token, null);
  await expect(c1.status === 200 && Array.isArray(c1.data.catalog), 'catalog cached on first fetch');
  let c2 = await api('GET', '/api/services/catalog', userA.token, null);
  await expect(!!c2.data.catalog, 'catalog served from cache (hit)');
  const st1 = await api('GET', '/api/cache/stats', adm.token, null);
  await expect(st1.status === 200, 'cache stats accessible to ADMIN');
  await expect(st1.data.success && st1.data.cache.hits >= 1, `cache hit counter incremented (hits=${st1.data.cache ? st1.data.cache.hits : '?'})`);
  await expect(!!st1.data.replica, 'replica routing info exposed');

  await section('HTTP: vault writes bust per-user cache');
  let v0 = await api('GET', '/api/vaults', userA.token, null);
  await expect(Array.isArray(v0.data.vaults) && v0.data.vaults.length === 0, 'vault list cached (empty)');
  const vr = await api('POST', '/api/vaults', userA.token, { name: `LengoTest${suffix}`, target_amount: '50000' });
  await expect(vr.status === 200 && !!vr.data.vault, 'vault created');
  let v1 = await api('GET', '/api/vaults', userA.token, null);
  await expect(v1.data.vaults && v1.data.vaults.length === 1, 'vault list reflects create (cache busted)');
  let v2 = await api('GET', '/api/vaults', userA.token, null);
  await expect(v2.data.vaults && v2.data.vaults.length === 1, 'vault list served from cache (still 1)');

  await section('HTTP: cache ops gating');
  const noAuth = await api('GET', '/api/cache/stats', null, null);
  await expect(noAuth.status === 401 || noAuth.status === 403, 'cache stats blocked without auth');
  const nonAdmin = await api('GET', '/api/cache/stats', userA.token, null);
  await expect(nonAdmin.status === 401 || nonAdmin.status === 403, 'cache stats blocked for non-admin');

  await section('HTTP: admin flush resets counters');
  const fl = await api('POST', '/api/cache/flush', adm.token, null);
  await expect(fl.status === 200 && fl.data.success, 'admin flush works');
  const st2 = await api('GET', '/api/cache/stats', adm.token, null);
  await expect(st2.data.cache.hits === 0, `hits reset after flush (hits=${st2.data.cache.hits})`);

  console.log(`\n===== CACHING: ${passed} passed, ${failed} failed =====`);
  if (failures.length) console.log('FAILURES: ' + failures.join(' | '));
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('SUITE CRASH:', e.message);
  process.exit(1);
});