'use strict';
/* R37 (5) / Letters L-1, K-18: GET /rosca/pools/:poolId must enforce pool membership for req.user.
 *  - a member gets 200 with the member list (names, queue numbers, phone numbers of fellow members);
 *  - a logged-in NON-member gets 403 and the body carries no member data and no phone number;
 *  - the pool creator who has not joined is a non-member (403);
 *  - a non-existent pool id answers exactly like a pool you are not in (403, no existence oracle);
 *  - malformed ids are refused without reaching the data;
 *  - refused requests change nothing in the database (business-table fingerprint before == after).
 * Real server (integration runner). No secret value is printed. */
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const jwt = require(path.join(ROOT, 'node_modules/jsonwebtoken'));
const { Client } = require(path.join(ROOT, 'node_modules/pg'));

const BASE = process.env.TEST_BASE;
if (!BASE || !/^phase71_financial_audit_[a-z0-9_]+$/.test(process.env.DB_NAME || '') || process.env.DB_PORT !== '55481' || !process.env.JWT_SECRET) {
  console.error('REFUSING: run via the integration runner (disposable DB on 127.0.0.1:55481)'); process.exit(2);
}
let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
async function get(p, token) {
  const r = await fetch(`${BASE}${p}`, { headers: { authorization: `Bearer ${token}` } });
  let text = ''; try { text = await r.text(); } catch (e) { /* */ }
  let body = null; try { body = JSON.parse(text); } catch (e) { /* */ }
  return { status: r.status, body, text };
}
const tokenFor = (u) => jwt.sign({ id: u.id, role: u.role, phone: u.phone_number, av: u.auth_version || 0, jti: crypto.randomUUID() }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '10m' });

(async () => {
  const db = new Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  await db.connect();
  const mk = async (name) => (await db.query(
    `INSERT INTO users (full_name, phone_number, password_hash, kyc_level) VALUES ($1, $2, 'x', 2) RETURNING id, role, phone_number, auth_version`,
    [name, `2557${crypto.randomInt(10000000, 99999999)}`])).rows[0];
  const creator = await mk('R37-5 creator (not joined)');
  const m1 = await mk('R37-5 member one'); const m2 = await mk('R37-5 member two');
  const outsider = await mk('R37-5 outsider');
  const poolId = (await db.query(
    `INSERT INTO rosca_pools (pool_name, contribution_amount, cycle_frequency, total_members, pool_type, created_by_user_id)
     VALUES ('R37-5 pool', 10000, 'WEEKLY', 3, 'PRIVATE_KIKOBA', $1) RETURNING id`, [creator.id])).rows[0].id;
  await db.query('INSERT INTO rosca_members (pool_id, user_id, assigned_queue_number) VALUES ($1, $2, 1), ($1, $3, 2)', [poolId, m1.id, m2.id]);
  const otherPool = (await db.query(
    `INSERT INTO rosca_pools (pool_name, contribution_amount, cycle_frequency, total_members, pool_type, created_by_user_id)
     VALUES ('R37-5 other pool', 5000, 'WEEKLY', 3, 'PUBLIC', $1) RETURNING id`, [outsider.id])).rows[0].id;
  await db.query('INSERT INTO rosca_members (pool_id, user_id, assigned_queue_number) VALUES ($1, $2, 1)', [otherPool, outsider.id]);
  const maxId = (await db.query('SELECT COALESCE(MAX(id),0)+1000 AS m FROM rosca_pools')).rows[0].m;

  // Business-table fingerprint (users' money/trust fields, every rosca_* table).
  const fingerprint = async () => (await db.query(`SELECT md5(concat_ws('|',
      (SELECT string_agg(id||':'||coalesce(wallet_balance::text,'')||':'||coalesce(locked_balance::text,'')||':'||coalesce(trust_score::text,'')||':'||coalesce(auth_version::text,''), ',' ORDER BY id) FROM users),
      (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM rosca_pools t),
      (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM rosca_members t),
      (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM rosca_schedules t),
      (SELECT count(*)::text FROM rosca_trust_history),
      (SELECT count(*)::text FROM rosca_constitutions),
      (SELECT count(*)::text FROM rosca_constitution_acceptance))) AS h`)).rows[0].h;

  console.log('\n[1] positive: a member sees the pool and fellow members');
  for (const [label, u] of [['member one', m1], ['member two', m2]]) {
    const r = await get(`/api/v1/rosca/pools/${poolId}`, tokenFor(u));
    const members = (r.body && r.body.pool && r.body.pool.members) || [];
    check(`[1] ${label} -> 200 with 2 members`, r.status === 200 && members.length === 2, { status: r.status, n: members.length });
    check(`[1] ${label} sees fellow members' phone numbers (members only)`, members.some((m) => m.phone_number === m1.phone_number) && members.some((m) => m.phone_number === m2.phone_number));
  }
  const legacy = await get(`/api/rosca/pools/${poolId}`, tokenFor(m1));
  check('[1] legacy /api/rosca path behaves the same for a member (200)', legacy.status === 200, { status: legacy.status });

  console.log('\n[2] negative: non-members get 403 and no member data');
  const before = await fingerprint();
  const phones = [m1.phone_number, m2.phone_number];
  const local = (p) => p.slice(-9);
  for (const [label, u, p] of [['outsider (member of another pool)', outsider, `/api/v1/rosca/pools/${poolId}`],
    ['outsider via legacy /api/rosca', outsider, `/api/rosca/pools/${poolId}`],
    ['creator who has not joined', creator, `/api/v1/rosca/pools/${poolId}`],
    ['member one asking for a pool they are not in', m1, `/api/v1/rosca/pools/${otherPool}`],
    ['outsider asking for a non-existent pool', outsider, `/api/v1/rosca/pools/${maxId}`]]) {
    const r = await get(p, tokenFor(u));
    check(`[2] ${label} -> 403`, r.status === 403, { status: r.status });
    check(`[2] ${label}: body has no member list and no phone number`, !/members|phone_number|full_name/.test(r.text) && !phones.some((ph) => r.text.includes(local(ph))), { status: r.status });
  }
  for (const bad of ['abc', '1;DROP', '-1', '0', '1.5', '01', '9999999999', '99999999999999999999']) {
    const r = await get(`/api/v1/rosca/pools/${encodeURIComponent(bad)}`, tokenFor(outsider));
    check(`[2] malformed pool id ${JSON.stringify(bad)} -> 4xx, no member data`, r.status >= 400 && r.status < 500 && !/phone_number|members/.test(r.text), { status: r.status });
  }
  const after = await fingerprint();
  check('[2] refused requests left every business table unchanged (fingerprint before == after)', before === after);

  console.log('\n[3] the pool list does not expose phone numbers');
  const list = await get('/api/v1/rosca/pools', tokenFor(outsider));
  check('[3] GET /rosca/pools (any logged-in user) carries no phone number', list.status === 200 && !/phone_number/.test(list.text) && !phones.some((ph) => list.text.includes(local(ph))), { status: list.status });

  await db.end();
  console.log(`\nR37 (5) ROSCA pool membership: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e && e.message); process.exit(1); });
