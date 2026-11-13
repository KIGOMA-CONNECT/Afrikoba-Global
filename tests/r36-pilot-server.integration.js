#!/usr/bin/env node
'use strict';
/* R36 Task 4 — the REAL src/server.js started with PILOT_MODE=true (scratchpad runner r36int.sh with
 * R36_PILOT=1, disposable DB). Every disabled boundary answers 403 PILOT_FEATURE_DISABLED on /api/v1 and
 * /api, before authentication, rate state or body validation; enabled routes are not gated; public
 * registration creates no user row. R36 closure: excluded services -> 403 PILOT_SERVICE_EXCLUDED; with
 * R36_EXPECT_PROD=1 (runner R36_PROD=1) the process is NODE_ENV=production and no error body carries a stack. Needs TEST_BASE and the DB_* of the disposable database. */
const BASE = process.env.TEST_BASE;
if (!BASE || !/^phase71_financial_audit_r36_i[a-z0-9_]+$/.test(process.env.DB_NAME || '')) { console.error('REFUSING'); process.exit(2); }
const { Pool } = require('pg');
const pool = new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
async function call(method, p, body) {
  const r = await fetch(`${BASE}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) { /* */ }
  return { status: r.status, body: j };
}
(async () => {
  const users0 = Number((await pool.query('SELECT count(*) n FROM users')).rows[0].n);
  const DISABLED = [
    ['POST', '/auth/register', { fullName: 'R36 Pilot', phoneNumber: '0719000222', password: 'abcdefghij12' }],
    ['GET', '/p2p/requests'], ['GET', '/cards'], ['POST', '/recurrence/rules', {}], ['POST', '/network/scheduled', {}],
    ['POST', '/network/remittance/pickup', { pickupCode: 'X' }], ['POST', '/payments/azampay-callback', {}],
    ['POST', '/vicoba/groups/1/bonus', { amount: 5000 }], ['POST', '/vicoba/groups/1/profits/calculate', {}], ['POST', '/vicoba/profits/1/approve'],
    ['POST', '/vicoba/groups/1/topup/cross-network', {}], ['GET', '/saccos/groups'],
  ];
  for (const prefix of ['/api/v1', '/api']) {
    for (const [m, p, b] of DISABLED) {
      const r = await call(m, `${prefix}${p}`, b);
      check(`${m} ${prefix}${p} -> 403 PILOT_FEATURE_DISABLED`, r.status === 403 && r.body && r.body.code === 'PILOT_FEATURE_DISABLED', r);
    }
    for (const [m, p] of [['POST', '/auth/login'], ['GET', '/vicoba/groups'], ['POST', '/vicoba/groups/1/contribute'], ['POST', '/wallet/transfer']]) {
      const r = await call(m, `${prefix}${p}`, {});
      check(`${m} ${prefix}${p} -> not gated (${r.status})`, !(r.body && r.body.code === 'PILOT_FEATURE_DISABLED'), r);
    }
  }
  // R36 closure: services outside the pilot allow-list are refused server-side on both prefixes, for any method.
  const EXCLUDED = ['rosca', 'circles', 'business', 'credit', 'savings', 'vaults', 'family', 'events', 'marketplace', 'governance', 'disputes', 'ussd', 'currency', 'referrals', 'projects', 'investors'];
  for (const prefix of ['/api/v1', '/api']) {
    for (const seg of EXCLUDED) {
      for (const m of ['GET', 'POST']) {
        const r = await call(m, `${prefix}/${seg}/r36`, m === 'POST' ? {} : undefined);
        check(`${m} ${prefix}/${seg}/r36 -> 403 PILOT_SERVICE_EXCLUDED`, r.status === 403 && r.body && r.body.code === 'PILOT_SERVICE_EXCLUDED', r);
      }
    }
  }
  // Error bodies never carry a stack in the pilot process (it is NODE_ENV=production, see r36lpint R36_PROD=1).
  if (process.env.R36_EXPECT_PROD === '1') {
    check('server under test runs NODE_ENV=production', process.env.NODE_ENV === 'production', process.env.NODE_ENV);
    const probes = [await call('GET', '/api/v1/rosca/x'), await call('POST', '/api/v1/vicoba/groups/1/bonus', { amount: 5000 }), await call('GET', '/api/v1/vicoba/groups'),
      await call('GET', '/api/v1/r36-no-such-route'), await call('POST', '/api/v1/wallet/transfer', {})];
    const raw = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"broken json' });
    let rj = null; try { rj = await raw.json(); } catch (e) { /* */ }
    probes.push({ status: raw.status, body: rj });
    for (const pr of probes) check(`error ${pr.status} body has no stack / no file paths`, pr.status >= 400 && !JSON.stringify(pr.body || {}).match(/"stack"|\/src\/|node_modules/), pr);
  }
  const users1 = Number((await pool.query('SELECT count(*) n FROM users')).rows[0].n);
  check('registration attempts created no user row', users1 === users0, { users0, users1 });
  console.log(`\nR36 pilot server integration: ${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); await pool.end().catch(() => {}); process.exit(1); });
