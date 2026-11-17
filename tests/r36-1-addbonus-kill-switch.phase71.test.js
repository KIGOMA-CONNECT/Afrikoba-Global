#!/usr/bin/env node
'use strict';
/* R36 Task 1 — VICOBA addBonus kill switch (src/config/pilot.js, feature 'vicobaAddBonus').
 *  [1] default (VICOBA_ADD_BONUS_ENABLED unset, PILOT_MODE unset): service addBonus refuses 403
 *      PILOT_FEATURE_DISABLED; no change to group balance, vicoba_bonus, transactions, wallet_ledger,
 *      journal_entries, users, outbox, financial_operations.
 *  [2] HTTP POST /vicoba/groups/:g/bonus by a leader: 403 PILOT_FEATURE_DISABLED on /api/v1 and /api,
 *      also with an invalid body (the gate runs before validation); no DB change.
 *  [3] only the exact string 'true' switches it on: 'false', 'TRUE', '1', 'yes', ' true' stay OFF.
 *  [4] VICOBA_ADD_BONUS_ENABLED='true' but PILOT_MODE='true' -> still OFF (pilot boundary wins).
 *  [5] positive control: VICOBA_ADD_BONUS_ENABLED='true', PILOT_MODE unset -> the call succeeds and the
 *      snapshot DOES change (proves [1]-[4] are not vacuous).
 *  [6] static: the kill switch is the first statement of addBonus, before any query.
 */
const h = require('./r36-harness');
const fs = require('fs');
const { check, attempt, snap, diffSnap, call, group } = h;
const vicoba = require(h.path.join(h.ROOT, 'src/services/vicobaService'));

(async () => {
  await h.listen(h.buildApp());
  const s = await group([['chair', 'MWENYEKITI'], ['member', 'MJUMBE']]);
  const off = (r) => !r.ok && r.status === 403 && r.code === 'PILOT_FEATURE_DISABLED';

  console.log('\n[1] default OFF (service)');
  {
    const before = await snap();
    const r = await attempt(() => vicoba.addBonus(s.chair.id, s.g, { amount: 5000, purpose: 'r36' }));
    const after = await snap();
    check('[1] addBonus refused 403 PILOT_FEATURE_DISABLED with no env set', off(r), r);
    check('[1] no balance / bonus / transaction / ledger / journal change', diffSnap(before, after).length === 0, diffSnap(before, after));
  }

  console.log('\n[2] HTTP route, both prefixes, gate before validation');
  for (const prefix of ['/api/v1', '/api']) {
    for (const body of [{ amount: 5000, purpose: 'r36' }, { amount: 'not-a-number' }]) {
      const before = await snap();
      const r = await call('POST', `${prefix}/vicoba/groups/${s.g}/bonus`, s.chair, body);
      const after = await snap();
      check(`[2] ${prefix} body=${JSON.stringify(body)} -> 403 PILOT_FEATURE_DISABLED`, r.status === 403 && r.body && r.body.code === 'PILOT_FEATURE_DISABLED', r);
      check(`[2] ${prefix} no DB change`, diffSnap(before, after).length === 0, diffSnap(before, after));
    }
  }

  console.log('\n[3] only the exact value "true" enables');
  for (const v of ['false', 'TRUE', '1', 'yes', ' true', '']) {
    process.env.VICOBA_ADD_BONUS_ENABLED = v;
    const before = await snap();
    const r = await attempt(() => vicoba.addBonus(s.chair.id, s.g, { amount: 5000 }));
    check(`[3] VICOBA_ADD_BONUS_ENABLED=${JSON.stringify(v)} -> OFF, no DB change`, off(r) && diffSnap(before, await snap()).length === 0, r);
  }

  console.log('\n[4] pilot boundary wins over the feature flag');
  {
    process.env.VICOBA_ADD_BONUS_ENABLED = 'true'; process.env.PILOT_MODE = 'true';
    const before = await snap();
    const r = await attempt(() => vicoba.addBonus(s.chair.id, s.g, { amount: 5000 }));
    const http = await call('POST', `/api/v1/vicoba/groups/${s.g}/bonus`, s.chair, { amount: 5000 });
    check('[4] service refused under PILOT_MODE=true', off(r), r);
    check('[4] HTTP refused under PILOT_MODE=true', http.status === 403 && http.body.code === 'PILOT_FEATURE_DISABLED', http);
    check('[4] no DB change', diffSnap(before, await snap()).length === 0);
  }

  console.log('\n[5] positive control (explicit ON, not pilot)');
  {
    process.env.VICOBA_ADD_BONUS_ENABLED = 'true'; delete process.env.PILOT_MODE;
    const before = await snap();
    const r = await attempt(() => vicoba.addBonus(s.chair.id, s.g, { amount: 5000, purpose: 'control' }));
    const d = diffSnap(before, await snap());
    check('[5] explicit ON succeeds', r.ok && r.r.success === true, r);
    check('[5] snapshot detects the change (group balance, vicoba_bonus, journal)', ['vicoba_groups', 'vicoba_bonus', 'journal_entries'].every((k) => d.includes(k)), d);
    delete process.env.VICOBA_ADD_BONUS_ENABLED;
  }

  console.log('\n[6] static');
  {
    const src = fs.readFileSync(h.path.join(h.ROOT, 'src/services/vicobaService.js'), 'utf8');
    const start = src.indexOf('async function addBonus(');
    const body = src.slice(start, src.indexOf('\nasync function ', start + 10));
    const iGate = body.indexOf("assertFeatureEnabled('vicobaAddBonus')");
    const firstQuery = Math.min(...['pool.', 'client.', 'fin.'].map((t) => { const i = body.indexOf(t); return i < 0 ? Infinity : i; }));
    check('[6] kill switch precedes every query in addBonus', iGate > 0 && iGate < firstQuery, { iGate, firstQuery });
    const routes = fs.readFileSync(h.path.join(h.ROOT, 'src/routes/vicobaRoutes.js'), 'utf8');
    check('[6] route gate precedes validate() on /groups/:groupId/bonus', /'\/groups\/:groupId\/bonus', require\('\.\.\/config\/pilot'\)\.requireFeature\('vicobaAddBonus'\), validate\(/.test(routes));
  }

  await h.finish('R36 (1) addBonus kill switch');
})().catch(h.fatal);
