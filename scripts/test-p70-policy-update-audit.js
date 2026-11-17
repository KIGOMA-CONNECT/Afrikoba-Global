'use strict';

const assert = require('assert');
const express = require('express');
const request = require('supertest');

if (process.env.P70_2_POLICY_AUDIT_OVERRIDE !== '1') {
  throw new Error('ABORT: set P70_2_POLICY_AUDIT_OVERRIDE=1 for this isolated acceptance test.');
}

const EXPECTED_DB = process.env.DB_NAME || 'phase70_2_policy_audit_20261108';
const EXPECTED_HOST = '/var/run/postgresql';
const EXPECTED_PORT = '5432';
const EXPECTED_USER = 'postgres';
const TEST_CODE = 'P70_2_POLICY_AUDIT_TEST';

process.env.DB_HOST = EXPECTED_HOST;
process.env.DB_PORT = EXPECTED_PORT;
process.env.DB_NAME = EXPECTED_DB;
process.env.DB_USER = EXPECTED_USER;
process.env.DB_PASSWORD = '';
process.env.DISABLE_CRON = 'true';

const pool = require('../src/config/db');
const { signToken } = require('../src/middleware/auth');
const fourEyesRoutes = require('../src/routes/fourEyesRoutes');

const app = express();
app.use(express.json());
app.use('/api/admin/four-eyes', fourEyesRoutes);
app.use((err, req, res, next) => {
  const status = err.statusCode || err.status || 500;
  res.status(status).json({
    success: false,
    code: err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR'),
    message: err.message || 'Internal error',
  });
});

const ADMIN_ID = 4;
const NON_ADMIN_ID = 1;

const FINANCIAL_TABLES = [
  'financial_operations',
  'journal_entries',
  'event_withdrawals',
  'merchant_payouts',
  'project_investor_payouts',
  'crowdfund_lender_payouts',
  'remittance_payouts',
  'saccos_dividend_payouts',
  'saccos_savings_withdrawals',
  'social_fund_payouts',
  'vicoba_profit_payouts',
  'vicoba_withdrawals',
  'yield_payout_logs',
];

async function db(sql, params = []) {
  return pool.query(sql, params);
}

async function scalar(sql, params = []) {
  const r = await db(sql, params);
  return r.rows[0];
}

async function assertDbIdentity() {
  const r = await db(`
    SELECT current_database() AS database_name,
           current_user AS database_user,
           current_setting('port') AS server_port,
           current_setting('transaction_read_only') AS transaction_read_only
  `);
  const row = r.rows[0];
  assert.strictEqual(row.database_name, EXPECTED_DB, 'wrong database');
  assert.strictEqual(row.database_user, EXPECTED_USER, 'wrong database user');
  assert.strictEqual(String(row.server_port), EXPECTED_PORT, 'wrong PostgreSQL port');
  assert.strictEqual(row.transaction_read_only, 'off', 'database is read-only');
}

async function assertFixture() {
  const admin = await scalar(
    `SELECT id, role, is_active, auth_version
       FROM users
      WHERE id = $1`,
    [ADMIN_ID]
  );
  assert(admin, 'fixture ADMIN user missing');
  assert.strictEqual(admin.role, 'ADMIN');
  assert.strictEqual(admin.is_active, true);

  const nonAdmin = await scalar(
    `SELECT id, role, is_active, auth_version
       FROM users
      WHERE id = $1`,
    [NON_ADMIN_ID]
  );
  assert(nonAdmin, 'fixture non-admin user missing');
  assert.notStrictEqual(nonAdmin.role, 'ADMIN');
  assert.strictEqual(nonAdmin.is_active, true);

  const flag = await scalar(
    `SELECT flag_key, enabled, rollout_percent, audience
       FROM feature_flags
      WHERE flag_key = 'FOUR_EYES'`
  );
  assert(flag, 'FOUR_EYES feature flag missing');
  assert.strictEqual(flag.enabled, true);
  assert.strictEqual(Number(flag.rollout_percent), 100);
  assert.deepStrictEqual(flag.audience, []);
}

async function financialSnapshot() {
  const snapshot = {};

  const users = await scalar(`
    SELECT COUNT(*)::bigint AS rows,
           COALESCE(SUM(wallet_balance), 0)::text AS wallet_balance_total,
           COALESCE(SUM(locked_balance), 0)::text AS locked_balance_total
      FROM users
  `);
  snapshot.users = users;

  for (const table of FINANCIAL_TABLES) {
    const row = await scalar(`SELECT COUNT(*)::bigint AS rows FROM ${table}`);
    snapshot[table] = row.rows;
  }

  return snapshot;
}

async function auditRows() {
  const r = await db(
    `SELECT id, user_id, action, entity_type, entity_id, meta, ip_address, user_agent
       FROM audit_logs
      WHERE action = 'FOUR_EYES_POLICY_UPDATE'
        AND entity_type = 'FOUR_EYES_POLICY'
        AND meta->>'action_code' = $1
      ORDER BY id`,
    [TEST_CODE]
  );
  return r.rows;
}

async function policy() {
  const r = await db(
    `SELECT id, action_code, description, required_approvers,
            approver_roles, enabled, allow_self_approve
       FROM four_eyes_policies
      WHERE action_code = $1`,
    [TEST_CODE]
  );
  return r.rows[0] || null;
}

async function createAuditFailureTrigger() {
  const functionName = 'p70_2_fail_policy_audit_insert';
  const triggerName = 'p70_2_fail_policy_audit_insert_trigger';

  const existingFunction = await scalar(`
    SELECT to_regprocedure('public.${functionName}()') IS NOT NULL AS exists
  `);
  const existingTrigger = await scalar(`
    SELECT EXISTS (
      SELECT 1
        FROM pg_trigger
       WHERE tgrelid = 'public.audit_logs'::regclass
         AND tgname = '${triggerName}'
    ) AS exists
  `);

  assert.strictEqual(existingFunction.exists, false, 'test trigger function already exists');
  assert.strictEqual(existingTrigger.exists, false, 'test audit trigger already exists');

  await db(`
    CREATE FUNCTION public.${functionName}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.action = 'FOUR_EYES_POLICY_UPDATE'
         AND NEW.entity_type = 'FOUR_EYES_POLICY' THEN
        RAISE EXCEPTION 'P70_2_INTENTIONAL_AUDIT_FAILURE';
      END IF;
      RETURN NEW;
    END;
    $$;
  `);

  await db(`
    CREATE TRIGGER ${triggerName}
    BEFORE INSERT ON public.audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION public.${functionName}();
  `);

  return { functionName, triggerName };
}

async function dropAuditFailureTrigger(names) {
  if (!names) return;
  await db(`DROP TRIGGER IF EXISTS ${names.triggerName} ON public.audit_logs`);
  await db(`DROP FUNCTION IF EXISTS public.${names.functionName}()`);
}

async function run() {
  let triggerNames = null;

  try {
    console.log('P70.2 POLICY UPDATE / AUDIT ACCEPTANCE');
    await assertDbIdentity();
    await assertFixture();

    const initialFinancial = await financialSnapshot();

    const admin = await scalar(
      `SELECT id, role, phone_number, auth_version
         FROM users
        WHERE id = $1`,
      [ADMIN_ID]
    );
    const nonAdmin = await scalar(
      `SELECT id, role, phone_number, auth_version
         FROM users
        WHERE id = $1`,
      [NON_ADMIN_ID]
    );

    const adminToken = signToken(admin, '10m');
    const nonAdminToken = signToken(nonAdmin, '10m');

    const unauthenticated = await request(app)
      .put(`/api/admin/four-eyes/policies/${TEST_CODE}`)
      .send({ description: 'unauthenticated' });
    assert.strictEqual(unauthenticated.status, 401, 'unauthenticated request must remain 401');

    const nonAdminResponse = await request(app)
      .put(`/api/admin/four-eyes/policies/${TEST_CODE}`)
      .set('Authorization', `Bearer ${nonAdminToken}`)
      .send({ description: 'non-admin' });
    assert.strictEqual(nonAdminResponse.status, 403, 'non-admin request must remain 403');

    const createResponse = await request(app)
      .put(`/api/admin/four-eyes/policies/${TEST_CODE}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('User-Agent', 'P70.2-Acceptance')
      .send({
        description: 'P70.2 baseline policy',
        requiredApprovers: 2,
        approverRoles: ['ADMIN', 'COMPLIANCE'],
        enabled: true,
        allowSelfApprove: false,
      });

    assert.strictEqual(createResponse.status, 200, `policy create failed: ${JSON.stringify(createResponse.body)}`);
    assert(createResponse.body.policy, 'create response missing policy');
    assert.strictEqual(createResponse.body.policy.action_code, TEST_CODE);
    assert.strictEqual(createResponse.body.policy.required_approvers, 2);
    assert.deepStrictEqual(createResponse.body.policy.approver_roles, ['ADMIN', 'COMPLIANCE']);

    let current = await policy();
    assert(current, 'created policy missing from database');

    let audits = await auditRows();
    assert.strictEqual(audits.length, 1, 'create must produce exactly one policy-update audit');
    assert.strictEqual(audits[0].user_id, ADMIN_ID);
    assert.strictEqual(String(audits[0].entity_id), String(current.id));
    assert.strictEqual(audits[0].meta.action_code, TEST_CODE);
    assert.strictEqual(audits[0].meta.before, null);
    assert.deepStrictEqual(audits[0].meta.after, {
      action_code: TEST_CODE,
      description: 'P70.2 baseline policy',
      required_approvers: 2,
      approver_roles: ['ADMIN', 'COMPLIANCE'],
      enabled: true,
      allow_self_approve: false,
    });
    assert(audits[0].ip_address !== undefined, 'audit IP field missing');
    assert(audits[0].user_agent !== undefined, 'audit user-agent field missing');

    const partialResponse = await request(app)
      .put(`/api/admin/four-eyes/policies/${TEST_CODE}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('User-Agent', 'P70.2-Partial-Update')
      .send({ description: 'P70.2 partial update' });

    assert.strictEqual(partialResponse.status, 200, `partial update failed: ${JSON.stringify(partialResponse.body)}`);
    assert.strictEqual(partialResponse.body.policy.description, 'P70.2 partial update');
    assert.strictEqual(partialResponse.body.policy.required_approvers, 2);
    assert.deepStrictEqual(partialResponse.body.policy.approver_roles, ['ADMIN', 'COMPLIANCE']);
    assert.strictEqual(partialResponse.body.policy.enabled, true);
    assert.strictEqual(partialResponse.body.policy.allow_self_approve, false);

    audits = await auditRows();
    assert.strictEqual(audits.length, 2, 'partial update must add one audit');
    assert.deepStrictEqual(audits[1].meta.before, {
      action_code: TEST_CODE,
      description: 'P70.2 baseline policy',
      required_approvers: 2,
      approver_roles: ['ADMIN', 'COMPLIANCE'],
      enabled: true,
      allow_self_approve: false,
    });
    assert.deepStrictEqual(audits[1].meta.after, {
      action_code: TEST_CODE,
      description: 'P70.2 partial update',
      required_approvers: 2,
      approver_roles: ['ADMIN', 'COMPLIANCE'],
      enabled: true,
      allow_self_approve: false,
    });

    const beforeAuditFailurePolicy = await policy();
    const beforeAuditFailureCount = audits.length;

    triggerNames = await createAuditFailureTrigger();

    const auditFailureResponse = await request(app)
      .put(`/api/admin/four-eyes/policies/${TEST_CODE}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ description: 'P70.2 MUST ROLLBACK' });

    assert.strictEqual(
      auditFailureResponse.status,
      500,
      `audit failure must surface as 500, got ${auditFailureResponse.status}`
    );

    const afterAuditFailurePolicy = await policy();
    assert.deepStrictEqual(
      afterAuditFailurePolicy,
      beforeAuditFailurePolicy,
      'policy update must roll back when audit insertion fails'
    );

    const afterAuditFailureCount = (await auditRows()).length;
    assert.strictEqual(
      afterAuditFailureCount,
      beforeAuditFailureCount,
      'failed audit transaction must not leave an audit row'
    );

    await dropAuditFailureTrigger(triggerNames);
    triggerNames = null;

    const concurrentA = request(app)
      .put(`/api/admin/four-eyes/policies/${TEST_CODE}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('User-Agent', 'P70.2-Concurrency-A')
      .send({ description: 'P70.2 concurrent description' });

    const concurrentB = request(app)
      .put(`/api/admin/four-eyes/policies/${TEST_CODE}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('User-Agent', 'P70.2-Concurrency-B')
      .send({ allowSelfApprove: true });

    const [responseA, responseB] = await Promise.all([concurrentA, concurrentB]);

    assert.strictEqual(responseA.status, 200, `concurrent A failed: ${JSON.stringify(responseA.body)}`);
    assert.strictEqual(responseB.status, 200, `concurrent B failed: ${JSON.stringify(responseB.body)}`);

    current = await policy();
    assert.strictEqual(current.description, 'P70.2 concurrent description');
    assert.strictEqual(current.allow_self_approve, true);
    assert.strictEqual(current.required_approvers, 2);
    assert.deepStrictEqual(current.approver_roles, ['ADMIN', 'COMPLIANCE']);
    assert.strictEqual(current.enabled, true);

    audits = await auditRows();
    assert.strictEqual(audits.length, 4, 'two concurrent successful updates must add two audits');

    const lastTwo = audits.slice(-2);
    const descriptions = lastTwo.map((a) => a.meta.after.description);
    const selfApproveValues = lastTwo.map((a) => a.meta.after.allow_self_approve);

    assert(descriptions.includes('P70.2 concurrent description'), 'concurrent description update missing from audit');
    assert(selfApproveValues.includes(true), 'concurrent allow_self_approve update missing from audit');

    const auditAfterSnapshots = lastTwo.map((a) => a.meta.after);
    for (const after of auditAfterSnapshots) {
      assert.strictEqual(after.required_approvers, 2);
      assert.deepStrictEqual(after.approver_roles, ['ADMIN', 'COMPLIANCE']);
      assert.strictEqual(after.enabled, true);
    }

    const finalFinancial = await financialSnapshot();
    assert.deepStrictEqual(
      finalFinancial,
      initialFinancial,
      'policy/audit endpoint changed financial state'
    );

    const finalFlag = await scalar(
      `SELECT flag_key, enabled, rollout_percent, audience
         FROM feature_flags
        WHERE flag_key = 'FOUR_EYES'`
    );
    assert.strictEqual(finalFlag.enabled, true);
    assert.strictEqual(Number(finalFlag.rollout_percent), 100);

    console.log('PASS 1: isolated database identity and fixture authorization');
    console.log('PASS 2: unauthenticated/non-admin authorization behavior unchanged');
    console.log('PASS 3: policy create returns compatible { policy } response');
    console.log('PASS 4: partial update preserves unspecified policy fields');
    console.log('PASS 5: audit contains actor/entity/IP/user-agent and complete before/after evidence');
    console.log('PASS 6: audit insertion failure atomically rolls back policy update');
    console.log('PASS 7: concurrent partial updates preserve independent field changes');
    console.log('PASS 8: successful updates produce corresponding audit evidence');
    console.log('PASS 9: financial tables and user wallet balances remain unchanged');
    console.log('P70.2 POLICY UPDATE / AUDIT ACCEPTANCE: PASS');
    console.log(JSON.stringify({
      database: EXPECTED_DB,
      policy: TEST_CODE,
      audit_rows: audits.length,
      financial_state_unchanged: true,
    }));

  } finally {
    if (triggerNames) {
      await dropAuditFailureTrigger(triggerNames).catch(() => {});
    }
    await pool.end().catch(() => {});
  }
}

run().catch((error) => {
  console.error('P70.2 POLICY UPDATE / AUDIT ACCEPTANCE: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
