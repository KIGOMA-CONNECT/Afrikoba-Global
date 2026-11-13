#!/usr/bin/env node
'use strict';
/* R37 (6): VICOBA addBonus is hard-locked in production. No ordinary configuration can switch it on when
 * NODE_ENV is anything other than an explicit 'test' / 'development' (production, unset, 'Production',
 * 'staging', ...): not VICOBA_ADD_BONUS_ENABLED='true', not PILOT_MODE='false', not AFRIKOBA_TIER_B_ENABLE.
 * The service and both HTTP prefixes refuse 403 PILOT_FEATURE_DISABLED before any read or write, and the
 * financial snapshot (group balance, vicoba_bonus, transactions, ledger, journal, users, outbox,
 * financial_operations) does not change. Control: explicit test env + the flag still enables it (unchanged),
 * so the refusals are not vacuous. DR/CR and account names are untouched (no posting code changed).
 * Flags are read at call time, so the environment is switched in-process (harness starts as NODE_ENV=test). */
const h = require('./r36-harness');
const { check, attempt, snap, diffSnap, call, group } = h;
const vicoba = require(h.path.join(h.ROOT, 'src/services/vicobaService'));
const pilot = require(h.path.join(h.ROOT, 'src/config/pilot'));

const ENV_KEYS = ['NODE_ENV', 'PILOT_MODE', 'VICOBA_ADD_BONUS_ENABLED', 'AFRIKOBA_TIER_B_ENABLE'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const setEnv = (o) => { for (const [k, v] of Object.entries(o)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
const restore = () => setEnv(saved);

(async () => {
  await h.listen(h.buildApp());
  const s = await group([['chair', 'MWENYEKITI'], ['member', 'MJUMBE']]);
  const off = (r) => !r.ok && r.status === 403 && r.code === 'PILOT_FEATURE_DISABLED';

  console.log('\n[1] production-like NODE_ENV: every ordinary switch combination stays OFF');
  const NE = [['production', 'production'], ['unset', undefined], ['Production', 'Production'], ['staging', 'staging'], ['empty', '']];
  const TIERB = [['none', undefined], ['all', 'all'], ['vicoba_bonus', 'vicoba_bonus']];
  for (const [nl, ne] of NE) {
    for (const [tl, tb] of TIERB) {
      setEnv({ NODE_ENV: ne, PILOT_MODE: 'false', VICOBA_ADD_BONUS_ENABLED: 'true', AFRIKOBA_TIER_B_ENABLE: tb });
      const enabled = pilot.isFeatureEnabled('vicobaAddBonus');
      const before = await snap();
      const r = await attempt(() => vicoba.addBonus(s.chair.id, s.g, { amount: 5000, purpose: 'r37-6' }));
      const d = diffSnap(before, await snap());
      check(`[1] NODE_ENV ${nl}, PILOT_MODE=false, flag=true, tier-B=${tl}: feature OFF, service 403, no DB change`, enabled === false && off(r) && d.length === 0, { enabled, r, d });
    }
  }

  console.log('\n[2] HTTP, both prefixes, production with every ordinary switch on');
  for (const prefix of ['/api/v1', '/api']) {
    setEnv({ NODE_ENV: 'production', PILOT_MODE: 'false', VICOBA_ADD_BONUS_ENABLED: 'true', AFRIKOBA_TIER_B_ENABLE: 'all' });
    const before = await snap();
    const r = await call('POST', `${prefix}/vicoba/groups/${s.g}/bonus`, s.chair, { amount: 5000, purpose: 'r37-6' });
    const d = diffSnap(before, await snap());
    check(`[2] ${prefix} leader POST bonus -> 403 PILOT_FEATURE_DISABLED, no DB change`, r.status === 403 && r.body && r.body.code === 'PILOT_FEATURE_DISABLED' && d.length === 0, { status: r.status, code: r.body && r.body.code, d });
  }

  console.log('\n[3] controls (unchanged behaviour)');
  {
    setEnv({ NODE_ENV: 'test', PILOT_MODE: undefined, VICOBA_ADD_BONUS_ENABLED: undefined, AFRIKOBA_TIER_B_ENABLE: undefined });
    check('[3] test env without the flag: OFF', pilot.isFeatureEnabled('vicobaAddBonus') === false);
    setEnv({ NODE_ENV: 'development', VICOBA_ADD_BONUS_ENABLED: 'true' });
    check('[3] development env with the flag: ON (feature check only)', pilot.isFeatureEnabled('vicobaAddBonus') === true);
    setEnv({ NODE_ENV: 'test', VICOBA_ADD_BONUS_ENABLED: 'true' });
    const before = await snap();
    const r = await attempt(() => vicoba.addBonus(s.chair.id, s.g, { amount: 5000, purpose: 'r37-6 control' }));
    const d = diffSnap(before, await snap());
    check('[3] test env with the flag: addBonus succeeds and the snapshot changes (refusals above are not vacuous)', r.ok && r.r.success === true && ['vicoba_groups', 'vicoba_bonus', 'journal_entries'].every((k) => d.includes(k)), { r, d });
    setEnv({ NODE_ENV: 'test', PILOT_MODE: 'true' });
    check('[3] test env with the flag but PILOT_MODE=true: OFF (pilot boundary wins)', pilot.isFeatureEnabled('vicobaAddBonus') === false);
  }

  restore();
  await h.finish('R37 (6) addBonus hard lock');
})().catch((e) => { restore(); h.fatal(e); });
