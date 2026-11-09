#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / Step A: close-out handler behaviour
 *
 *  - PROJECT_COMPLETED, PROJECT_LIQUIDATED, PROJECT_RESERVE_RELEASED and
 *    PROJECT_RESIDUAL_RELEASED handlers are VERIFY-ONLY: they confirm, by the
 *    event's payload.reference, that the financial record exists, and throw
 *    when it does not. Every statement they issue must be a SELECT.
 *  - Moved notifying handlers still throw when createNotification returns null.
 *
 * Requires a DISPOSABLE database named phase71_financial_audit_<suffix> with
 * the full schema (db/schema.sql + db/migrations/*.sql) applied.
 * Usage:
 *   DB_NAME=phase71_financial_audit_<suffix> DB_USER=... DB_PASSWORD=... \
 *     node tests/outbox-closeout-handlers.phase71.test.js
 * ==========================================================================*/

const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
const targetDb = process.env.DB_NAME || '';
if (!DB_GUARD.test(targetDb)) {
  console.error(`REFUSING: DB_NAME must match ${DB_GUARD} (got '${targetDb || '<unset>'}').`);
  process.exit(2);
}

const crypto = require('crypto');
const pool = require('../src/config/db');
const { registerAll } = require('../src/outbox/handlers');

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

function collect(deps) {
  const map = new Map();
  registerAll({ registerHandler: (name, fn) => map.set(name, fn) }, deps);
  return map;
}

// Pool wrapper that records every statement text the handlers issue.
const recorded = [];
const recordingPool = {
  query: (sql, params) => {
    recorded.push(typeof sql === 'string' ? sql : sql.text);
    return pool.query(sql, params);
  },
};

async function rejects(fn, re) {
  try { await fn(); return { threw: false }; } catch (e) {
    return { threw: true, matched: re ? re.test(e.message) : true, message: e.message };
  }
}

const tag = crypto.randomBytes(4).toString('hex');
async function fixtures() {
  const u = await pool.query(
    `INSERT INTO users (full_name, phone_number) VALUES ($1, $2) RETURNING id`,
    [`P71 Owner ${tag}`, `2557${String(Date.now()).slice(-8)}`]
  );
  const ownerId = u.rows[0].id;
  const p = await pool.query(
    `INSERT INTO projects (owner_user_id, name) VALUES ($1, $2) RETURNING id`,
    [ownerId, `P71 Project ${tag}`]
  );
  const projectId = p.rows[0].id;
  const settleRef = `SETTLE-${projectId}-${tag}`;
  const s = await pool.query(
    `INSERT INTO project_settlements (project_id, summary) VALUES ($1, $2::jsonb) RETURNING id`,
    [projectId, JSON.stringify({ reference: settleRef })]
  );
  const liqRef = `LIQD-${projectId}-${tag}`;
  await pool.query(
    `INSERT INTO project_liquidations (project_id, settlement_id, reference) VALUES ($1, $2, $3)`,
    [projectId, s.rows[0].id, liqRef]
  );
  const resRef = `RESVA-${projectId}-${tag}`;
  const residRef = `RESID-${projectId}-${tag}`;
  await pool.query(
    `INSERT INTO project_reserve_releases (project_id, settlement_id, reserve_type, amount, released_to, reference)
     VALUES ($1, $2, 'DISTRIBUTION_RESERVE', 100, $3, $4),
            ($1, $2, 'OWNER_RESIDUAL',       50,  $3, $5)`,
    [projectId, s.rows[0].id, ownerId, resRef, residRef]
  );
  return { ownerId, projectId, settleRef, liqRef, resRef, residRef };
}

async function main() {
  try {
    const r = await pool.query(
      `SELECT current_database() AS db, current_user AS usr,
              inet_server_addr()::text AS addr, inet_server_port() AS port`
    );
    const { db, usr, addr, port } = r.rows[0];
    console.log(`DB identity: database=${db} user=${usr} server_addr=${addr} server_port=${port}`);
    if (db !== targetDb || !DB_GUARD.test(db)) throw new Error(`REFUSING: connected to '${db}'`);

    const f = await fixtures();
    const h = collect({
      pool: recordingPool,
      createNotification: async () => { throw new Error('verify-only handler must not notify'); },
    });

    const cases = [
      { type: 'PROJECT_COMPLETED', good: f.settleRef, key: 'settlementId' },
      { type: 'PROJECT_LIQUIDATED', good: f.liqRef, key: 'liquidationId' },
      { type: 'PROJECT_RESERVE_RELEASED', good: f.resRef, key: 'releaseId', wrongType: f.residRef },
      { type: 'PROJECT_RESIDUAL_RELEASED', good: f.residRef, key: 'releaseId', wrongType: f.resRef },
    ];

    for (const c of cases) {
      section(c.type);
      const handler = h.get(c.type);
      expect(typeof handler === 'function', 'handler registered');
      if (typeof handler !== 'function') continue;

      // Row exists
      let res;
      try { res = await handler({ eventType: c.type, payload: { projectId: f.projectId, reference: c.good } }); }
      catch (e) { res = { error: e.message }; }
      expect(res && res.verified === true && Number.isInteger(res[c.key]),
        'row exists -> verified', JSON.stringify(res));

      // Row missing (unknown reference)
      const missing = await rejects(
        () => handler({ eventType: c.type, payload: { projectId: f.projectId, reference: `NOPE-${tag}` } }),
        new RegExp(`^${c.type}: no project_`)
      );
      expect(missing.threw && missing.matched, 'row missing -> throws', missing.message);

      // Same reference, different project -> throws (reference AND project must match)
      const otherProject = await rejects(
        () => handler({ eventType: c.type, payload: { projectId: f.projectId + 999999, reference: c.good } }),
        new RegExp(`^${c.type}: no project_`)
      );
      expect(otherProject.threw && otherProject.matched, 'right reference, wrong project -> throws', otherProject.message);

      if (c.wrongType) {
        const wrongType = await rejects(
          () => handler({ eventType: c.type, payload: { projectId: f.projectId, reference: c.wrongType } }),
          new RegExp(`^${c.type}: no project_reserve_releases`)
        );
        expect(wrongType.threw && wrongType.matched, 'reference of the other reserve_type -> throws', wrongType.message);
      }

      const noRef = await rejects(
        () => handler({ eventType: c.type, payload: { projectId: f.projectId } }),
        /payload\.reference is required/
      );
      expect(noRef.threw && noRef.matched, 'missing payload.reference -> throws', noRef.message);
    }

    section('Verify-only handlers issue SELECT statements only');
    const nonSelect = recorded.filter((sql) => !/^\s*SELECT\b/i.test(sql));
    expect(recorded.length > 0, `statements recorded (${recorded.length})`);
    expect(nonSelect.length === 0, 'every statement is a SELECT (no INSERT/UPDATE/DELETE)', nonSelect.join(' | '));

    section('Notifying handlers still throw when the notification is not persisted');
    const stubPool = {
      query: async () => ({ rows: [{ id: 1, user_id: 1, owner_user_id: 1, name: 'X' }], rowCount: 1 }),
    };
    const hn = collect({ pool: stubPool, createNotification: async () => null });
    const notifying = {
      MERCHANT_PAYOUT_EXECUTED: { merchantId: 1, reference: 'R' },
      VICOBA_LOAN_APPROVED: { applicantUserId: 1, amount: 10 },
      OUTBOX_TEST: { userId: 1 },
      PROJECT_REVENUE_PROCESSED: { projectId: 1, amount: 10, reference: 'R', allocations: [] },
      PROJECT_DIVIDEND_PAID: { projectId: 1, name: 'X', reference: 'R', paid: [] },
    };
    for (const [type, payload] of Object.entries(notifying)) {
      const out = await rejects(() => hn.get(type)({ eventType: type, payload }),
        new RegExp(`^Notification persistence failed for ${type}$`));
      expect(out.threw && out.matched, `${type}: null notification -> throws`, out.message);
    }
    const hOk = collect({ pool: stubPool, createNotification: async () => 42 });
    for (const [type, payload] of Object.entries(notifying)) {
      const out = await rejects(() => hOk.get(type)({ eventType: type, payload }));
      expect(!out.threw, `${type}: persisted notification -> resolves`, out.message);
    }
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
}

main();
