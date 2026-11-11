#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / Remediation OBS-7c: FROZEN waterfall rules are immutable
 *   approveWaterfallRule / freezeWaterfallRule / unfreezeWaterfallRule /
 *   processIncomingRevenue (src/services/projectFinanceService.js)
 *
 * Owner decision (2026-11-10):
 *   - A FROZEN rule is immutable; expert approval alone cannot modify it.
 *   - An approved change creates a NEW version with an effective date, an approval
 *     record and a complete audit trail.
 *   - Existing funded investments keep their original allocation terms.
 *
 *  1. unfreeze of a FROZEN rule -> 409, row byte-identical (service and HTTP).
 *  2. freeze of a FROZEN / PROPOSED / DRAFT rule -> 409, row unchanged.
 *  3. approve called on a FROZEN rule id -> refused, row unchanged.
 *  4. Owner proposes v2, expert approves with an effective date -> v2 ACTIVE with
 *     approved_by / approved_at / effective_date / supersedes_rule_id; v1 FROZEN
 *     row byte-identical.
 *  5. Audit row: actor (proposer), approver, timestamp, previous version, new
 *     version, effective date.
 *  6. Revenue after the amendment is allocated with the FROZEN v1 terms.
 *  7. A further amendment v3 supersedes v2 (not v1); revenue still uses v1.
 *  8. Before any funding (rule ACTIVE, not FROZEN) amendments behave as before.
 *  9. Static: every UPDATE of waterfall_allocation_rules excludes FROZEN rows.
 *
 * axios and SMS are stubbed. Requires a DISPOSABLE database named
 * phase71_financial_audit_<suffix>.
 * ==========================================================================*/

const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
const targetDb = process.env.DB_NAME || '';
if (!DB_GUARD.test(targetDb)) {
  console.error(`REFUSING: DB_NAME must match ${DB_GUARD} (got '${targetDb || '<unset>'}').`);
  process.exit(2);
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

setTimeout(() => {
  console.log('\nWATCHDOG: test process exceeded 90 s; exiting with failure.');
  process.exit(1);
}, 90000).unref();

require('axios');
const axiosPath = require.resolve('axios');
const httpCalls = [];
require.cache[axiosPath].exports = {
  post: async (url) => { httpCalls.push(url); throw new Error('TEST: axios.post not expected'); },
  get: async (url) => { httpCalls.push(url); throw new Error('TEST: axios.get not expected'); },
};
const smsService = require('../src/services/smsService');
smsService.sendSMS = async () => ({ success: true, simulated: true });

const pool = require('../src/config/db');
const projectService = require('../src/services/projectService');
const pf = require('../src/services/projectFinanceService');

const FINANCE_FILE = path.join(__dirname, '..', 'src', 'services', 'projectFinanceService.js');
const tag = crypto.randomBytes(4).toString('hex');
let seq = 0;

let passed = 0;
let failed = 0;
const failures = [];
function ok(label) { passed++; console.log('  ✓ ' + label); }
function bad(label, extra) {
  failed++;
  failures.push(label);
  console.log('  ✗ ' + label + (extra !== undefined ? ' :: ' + extra : ''));
}
function expect(cond, label, extra) { if (cond) ok(label); else bad(label, extra); }
function section(label) { console.log('\n--- ' + label + ' ---'); }
async function safe(fn) {
  try { return { value: await fn() }; } catch (e) { return { error: e.message || String(e), err: e }; }
}
const show = (o) => JSON.stringify(o);

async function makeUser(label, role, wallet = 0) {
  seq += 1;
  const phone = `2555${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
  const id = (await pool.query(
    'INSERT INTO users (full_name, phone_number) VALUES ($1, $2) RETURNING id',
    [`P71WF ${label} ${tag} ${seq}`, phone])).rows[0].id;
  if (role) await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
  if (wallet) await pool.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [wallet, id]);
  return id;
}
const RULE = (inv, own) => ({ investor_dividend_percentage: inv, owner_residual_percentage: own });
async function ruleRow(id) { return (await pool.query('SELECT * FROM waterfall_allocation_rules WHERE id = $1', [id])).rows[0]; }
const rowKey = (r) => show(r);

// Project with v1 (60/40) created by the owner and approved by an admin.
// funded=true: one investment of 1000 freezes v1.
async function setup({ funded = true } = {}) {
  const owner = await makeUser('owner');
  const approver = await makeUser('approver', 'ADMIN');
  const investor = await makeUser('investor', null, 5000);
  const projectId = (await pool.query(
    `INSERT INTO projects (owner_user_id, name, status, capital_required, amount_raised)
     VALUES ($1, $2, 'FUNDING', 10000, 0) RETURNING id`, [owner, `P71WF project ${tag} ${++seq}`])).rows[0].id;
  const v1 = await pf.createInitialRules(owner, projectId, RULE(60, 40));
  await pf.approveWaterfallRule(approver, v1.id, {});
  if (funded) {
    await projectService.invest(investor, projectId, { amount: 1000, unique_reference: `P71WF-${tag}-${projectId}-inv` });
  }
  return { owner, approver, investor, projectId, v1Id: v1.id };
}
async function amend(s, inv, own, effective) {
  const p = await pf.proposeWaterfallRules(s.owner, s.projectId, { ...RULE(inv, own), change_reason: `P71WF ${inv}/${own}` });
  await pf.approveWaterfallRule(s.approver, p.id, { effective_date: effective });
  return p.id;
}
async function revenue(s, amount, sfx) {
  return pf.processIncomingRevenue(s.owner, s.projectId,
    { amount, revenue_type: 'SALES', unique_reference: `P71WF-${tag}-${s.projectId}-rev-${sfx}` }, null);
}
async function allocRule(s, sfx) {
  return (await pool.query(
    `SELECT DISTINCT rule_id, rule_version FROM waterfall_allocation_records
      WHERE project_id = $1 AND revenue_reference = $2`,
    [s.projectId, `P71WF-${tag}-${s.projectId}-rev-${sfx}`])).rows;
}

// HTTP harness (real projectRoutes + i18n + errorHandler)
let app;
function httpApp() {
  if (app) return app;
  const express = require('express');
  const { i18n } = require('../src/i18n/middleware');
  const projectRoutes = require('../src/routes/projectRoutes');
  const { errorHandler } = require('../src/middleware/errorHandler');
  app = express();
  app.use(express.json());
  app.use(i18n);
  app.use('/api/v1', projectRoutes);
  app.use(errorHandler);
  return app;
}
async function tokenFor(id) {
  const u = (await pool.query('SELECT id, role, phone_number, auth_version FROM users WHERE id = $1', [id])).rows[0];
  return require('../src/middleware/auth').signToken(u);
}

// ---------------------------------------------------------------------------
async function testFrozenAfterFunding() {
  section('0. Funding freezes the approved rule');
  const s = await setup();
  const v1 = await ruleRow(s.v1Id);
  expect(v1.status === 'FROZEN' && Number(v1.approved_by) === s.approver, 'v1 FROZEN after the first investment, approved_by recorded', show({ status: v1.status, approved_by: v1.approved_by }));
}

async function testUnfreezeAndFreezeRejected() {
  section('1/2/3. In-place changes of a FROZEN rule are refused');
  const s = await setup();
  const before = rowKey(await ruleRow(s.v1Id));
  const u = await safe(() => pf.unfreezeWaterfallRule(s.approver, s.v1Id));
  expect(!!u.error && u.err.statusCode === 409, 'service unfreeze of FROZEN -> 409', u.error || show(u.value));
  expect(rowKey(await ruleRow(s.v1Id)) === before, 'row byte-identical after unfreeze attempt', '');

  const request = require('supertest');
  const res = await request(httpApp())
    .post(`/api/v1/projects/${s.projectId}/waterfall-rules/${s.v1Id}/unfreeze`)
    .set('Authorization', `Bearer ${await tokenFor(s.approver)}`).send({});
  expect(res.status === 409, 'HTTP unfreeze (ADMIN) of FROZEN -> 409', `${res.status} ${show(res.body)}`);
  expect(rowKey(await ruleRow(s.v1Id)) === before, 'row byte-identical after HTTP unfreeze attempt', '');

  const f = await safe(() => pf.freezeWaterfallRule(s.approver, s.v1Id));
  expect(!!f.error && f.err.statusCode === 409, 're-freeze of FROZEN -> 409 (no in-place write)', f.error || show(f.value));
  expect(rowKey(await ruleRow(s.v1Id)) === before, 'row byte-identical after re-freeze attempt', '');

  const ap = await safe(() => pf.approveWaterfallRule(s.approver, s.v1Id, { effective_date: '2026-12-01' }));
  expect(!!ap.error, 'approve called on the FROZEN rule id -> refused', ap.error || show(ap.value));
  expect(rowKey(await ruleRow(s.v1Id)) === before, 'row byte-identical after approve attempt', '');

  const p = await pf.proposeWaterfallRules(s.owner, s.projectId, { ...RULE(55, 45), change_reason: 'P71WF proposal' });
  const fp = await safe(() => pf.freezeWaterfallRule(s.approver, p.id));
  expect(!!fp.error && fp.err.statusCode === 409 && (await ruleRow(p.id)).status === 'PROPOSED',
    'freeze of a PROPOSED rule -> 409 (no activation without approval)', fp.error || show(fp.value));
  const up = await safe(() => pf.unfreezeWaterfallRule(s.approver, p.id));
  expect(!!up.error && (await ruleRow(p.id)).status === 'PROPOSED', 'unfreeze of a PROPOSED rule -> refused (no activation without approval)', up.error || show(up.value));
}

async function testAmendmentVersioning() {
  section('4/5/6/7. Amendment = new version; FROZEN v1 untouched; revenue keeps v1 terms');
  const s = await setup();
  const v1Before = rowKey(await ruleRow(s.v1Id));
  const r0 = await revenue(s, 1000, 'r0');
  const d0 = (r0.allocations || []).find((a) => a.step === 'DIVIDEND');
  expect(d0 && d0.amount === 600, 'revenue before amendment: DIVIDEND 600 (v1 60 %)', show(r0.allocations));

  const t0 = Date.now();
  const v2Id = await amend(s, 50, 50, '2026-12-01');
  const v2 = await ruleRow(v2Id);
  expect(v2.status === 'ACTIVE' && v2.version === 2 && Number(v2.supersedes_rule_id) === s.v1Id,
    'v2 ACTIVE, version 2, supersedes_rule_id = v1', show({ status: v2.status, version: v2.version, supersedes: v2.supersedes_rule_id }));
  expect(Number(v2.proposed_by) === s.owner && Number(v2.approved_by) === s.approver && v2.approved_at
    && new Date(v2.effective_date).toISOString().slice(0, 10) === '2026-12-01',
    'v2 records proposer, approver, approved_at and effective_date 2026-12-01', show({ p: v2.proposed_by, a: v2.approved_by, at: v2.approved_at, eff: v2.effective_date }));
  expect(rowKey(await ruleRow(s.v1Id)) === v1Before, 'v1 FROZEN row byte-identical after the amendment', (await ruleRow(s.v1Id)).status);

  const audit = (await pool.query(
    `SELECT user_id, meta, created_at FROM audit_logs WHERE action = 'WATERFALL_RULES_APPROVED' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [v2Id])).rows[0];
  const ad = audit && audit.meta && (typeof audit.meta === 'string' ? JSON.parse(audit.meta) : audit.meta).afterData;
  expect(!!audit && Number(audit.user_id) === s.approver && new Date(audit.created_at).getTime() >= t0 - 5000,
    'audit row: approver as user, timestamped', show(audit && { user: audit.user_id, at: audit.created_at }));
  expect(ad && Number(ad.previous_rule_id) === s.v1Id && Number(ad.previous_version) === 1 && Number(ad.new_version) === 2
    && ad.effective_date === '2026-12-01' && Number(ad.proposed_by) === s.owner && Number(ad.approved_by) === s.approver,
    'audit afterData: previous rule/version, new version, effective date, proposer, approver', show(ad));

  const r1 = await revenue(s, 1000, 'r1');
  const d1 = (r1.allocations || []).find((a) => a.step === 'DIVIDEND');
  const used1 = await allocRule(s, 'r1');
  expect(d1 && d1.amount === 600 && used1.length === 1 && Number(used1[0].rule_id) === s.v1Id && Number(used1[0].rule_version) === 1,
    'revenue after amendment: allocated with FROZEN v1 (DIVIDEND 600, rule v1)', `${show(r1.allocations)} ${show(used1)}`);

  const v3Id = await amend(s, 45, 55, '2027-01-01');
  expect((await ruleRow(v2Id)).status === 'SUPERSEDED' && (await ruleRow(v3Id)).status === 'ACTIVE',
    'v3 approved: v2 SUPERSEDED, v3 ACTIVE', show({ v2: (await ruleRow(v2Id)).status, v3: (await ruleRow(v3Id)).status }));
  expect(rowKey(await ruleRow(s.v1Id)) === v1Before, 'v1 still byte-identical after v3', '');
  const r2 = await revenue(s, 1000, 'r2');
  const used2 = await allocRule(s, 'r2');
  expect(used2.length === 1 && Number(used2[0].rule_id) === s.v1Id, 'revenue after v3: still FROZEN v1', show(used2));
}

async function testBeforeFunding() {
  section('8. Before funding (ACTIVE, not FROZEN): amendment supersedes as before');
  const s = await setup({ funded: false });
  expect((await ruleRow(s.v1Id)).status === 'ACTIVE', 'v1 ACTIVE (no funding yet)', (await ruleRow(s.v1Id)).status);
  const v2Id = await amend(s, 50, 50, '2026-12-01');
  expect((await ruleRow(s.v1Id)).status === 'SUPERSEDED' && (await ruleRow(v2Id)).status === 'ACTIVE', 'v1 SUPERSEDED, v2 ACTIVE (unchanged behaviour)', '');
  await projectService.invest(s.investor, s.projectId, { amount: 1000, unique_reference: `P71WF-${tag}-${s.projectId}-late` });
  expect((await ruleRow(v2Id)).status === 'FROZEN', 'first funding freezes the then-approved v2', (await ruleRow(v2Id)).status);
  const r = await revenue(s, 1000, 'b');
  const used = await allocRule(s, 'b');
  expect(used.length === 1 && Number(used[0].rule_id) === v2Id, 'revenue uses v2', show(used));
}

async function testStatic() {
  section('9. Static: every UPDATE of waterfall_allocation_rules excludes FROZEN rows');
  const src = fs.readFileSync(FINANCE_FILE, 'utf8');
  const updates = src.match(/UPDATE waterfall_allocation_rules[\s\S]*?WHERE[^`"]*/g) || [];
  const unsafe = updates.filter((u) => !(/status\s*=\s*'ACTIVE'/.test(u.split('WHERE')[1]) || /NOT IN \([^)]*'FROZEN'/.test(u) || /status IN \('DRAFT',\s*'PROPOSED'\)/.test(u)));
  expect(updates.length >= 3 && unsafe.length === 0, `all ${updates.length} UPDATEs are guarded against FROZEN`, unsafe.map((u) => u.replace(/\s+/g, ' ').slice(0, 140)).join(' | '));
}

// ---------------------------------------------------------------------------
(async () => {
  try {
    const r = await pool.query(
      `SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS addr, inet_server_port() AS port`);
    const { db, usr, addr, port } = r.rows[0];
    console.log(`DB identity: database=${db} user=${usr} server_addr=${addr} server_port=${port}`);
    if (db !== targetDb || !DB_GUARD.test(db)) throw new Error(`REFUSING: connected to '${db}'`);
    const silenced = console.error;
    console.error = () => {};
    const logger = require('../src/utils/logger');
    const realError = logger.error; logger.error = () => {};
    try {
      for (const t of [testFrozenAfterFunding, testUnfreezeAndFreezeRejected, testAmendmentVersioning, testBeforeFunding, testStatic]) {
        const res = await safe(t);
        if (res.error) bad(`${t.name} aborted`, res.error);
      }
    } finally {
      console.error = silenced; logger.error = realError;
    }
    expect(httpCalls.length === 0, 'no real provider HTTP call', httpCalls.length);
  } catch (e) {
    bad('unexpected error', e && e.stack || e);
  } finally {
    await pool.end().catch(() => {});
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('Failures:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
})();
