'use strict';

const assert = require('node:assert/strict');

const TARGET = {
  host: '127.0.0.1',
  port: '5436',
  database: 'phase68_amount_guard_p70_agent_20261107',
  user: 'afrikoba_r',
  password: 'afrikoba_ro_strong'
};

if (process.env.P70_POLICY_AUDIT_OVERRIDE !== '1') {
  throw new Error('Refusing to run without P70_POLICY_AUDIT_OVERRIDE=1');
}

for (const [key, value] of Object.entries({
  DB_HOST: TARGET.host,
  DB_PORT: TARGET.port,
  DB_NAME: TARGET.database,
  DB_USER: TARGET.user,
  DB_PASSWORD: TARGET.password
})) {
  process.env[key] = value;
}

if (
  process.env.DB_HOST !== TARGET.host ||
  process.env.DB_PORT !== TARGET.port ||
  process.env.DB_NAME !== TARGET.database ||
  process.env.DB_USER !== TARGET.user
) {
  throw new Error('Database target guard failed');
}

let pool;
let fourEyes;
let network;
let triggerInstalled = false;
let originalPolicyEnabled = true;

const TRIGGER_NAME = 'p70_reject_agent_settlement_audit_trigger';
const FUNCTION_NAME = 'p70_reject_agent_settlement_audit_20261107';

function pass(message) {
  console.log(`[PASS] ${message}`);
}

function equal(actual, expected, message) {
  assert.equal(actual, expected, `${message}: expected ${expected}, got ${actual}`);
}

async function setPolicyEnabled(enabled) {
  const result = await pool.query(
    `UPDATE four_eyes_policies
        SET enabled = $1, updated_at = NOW()
      WHERE action_code = 'AGENT_SETTLEMENT'
      RETURNING enabled`,
    [enabled]
  );
  equal(result.rows.length, 1, 'AGENT_SETTLEMENT policy update');
  equal(result.rows[0].enabled, enabled, 'Policy enabled state');
}

async function createAgent(label) {
  const stamp = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const code = `P70-${stamp}`.slice(0, 20);
  const phone = `P70${String(Date.now()).slice(-9)}${String(process.pid).slice(-2)}`.slice(0, 15);

  const result = await pool.query(
    `INSERT INTO agents
       (user_id, agent_code, business_name, owner_name, phone, status, tier, balance)
     VALUES (1, $1, $2, $3, $4, 'ACTIVE', 'BRONZE', 0)
     RETURNING id, balance`,
    [code, `P70 policy audit ${label}`, 'P70 Isolated Test', phone]
  );

  equal(Number(result.rows[0].balance), 0, `${label} initial balance`);
  return Number(result.rows[0].id);
}

async function initiateDeposit(agentId, amount) {
  const result = await network.agentSettlement(agentId, amount, 'DEPOSIT', 1);
  equal(result.success, true, 'Settlement initiation');
  equal(result.status, 'PENDING', 'Initial settlement state');

  const requestId = Number(result.fourEyesRequestId);
  const settlement = await pool.query(
    `SELECT id, status, amount, agent_id, type, reference
       FROM agent_settlements
      WHERE reference = $1`,
    [result.reference]
  );

  equal(settlement.rows.length, 1, 'Settlement row count');
  equal(settlement.rows[0].status, 'PENDING', 'Settlement begins pending');

  return {
    requestId,
    settlementId: Number(settlement.rows[0].id),
    reference: result.reference,
    operationReference: `${result.reference}:STL`,
    amount: Number(settlement.rows[0].amount)
  };
}

async function getFinancialState(agentId, requestId, reference) {
  const result = await pool.query(
    `SELECT a.balance,
       s.status AS settlement_status,
       r.status AS request_status,
       r.execution_result,
       (SELECT COUNT(*)::int FROM journal_entries
         WHERE reference_id = $1) AS journal_count,
       (SELECT COUNT(*)::int FROM financial_operations
         WHERE reference_id = $1) AS operation_count,
       (SELECT COUNT(*)::int FROM four_eyes_approvals
         WHERE request_id = r.id) AS approval_count
     FROM four_eyes_requests r
     JOIN agent_settlements s
       ON s.id = (r.payload->>'settlementId')::bigint
     JOIN agents a ON a.id = s.agent_id
     WHERE r.id = $2 AND a.id = $3`,
    [reference, requestId, agentId]
  );
  return result.rows[0];
}

async function testDisabledPolicyRecovery() {
  const agentId = await createAgent('disabled recovery');
  const item = await initiateDeposit(agentId, '17.00');

  const approval = await fourEyes.approve(
    item.requestId, 5, 'ADMIN', 'P70 initial settlement before policy disable'
  );
  equal(approval.request.status, 'EXECUTED', 'Initial settlement execution');

  const before = await getFinancialState(agentId, item.requestId, item.operationReference);
  equal(before.settlement_status, 'SETTLED', 'Settlement before simulated recovery');
  equal(Number(before.balance), 17, 'Balance before simulated recovery');
  equal(Number(before.journal_count), 2, 'Journal count before simulated recovery');
  equal(Number(before.operation_count), 1, 'Operation count before simulated recovery');

  const simulatedSplitCommit = await pool.query(
    `UPDATE four_eyes_requests
        SET status = 'APPROVED',
            executed_by = NULL,
            execution_result = NULL,
            error = NULL,
            updated_at = NOW()
      WHERE id = $1 AND status = 'EXECUTED'
      RETURNING id`,
    [item.requestId]
  );
  equal(simulatedSplitCommit.rows.length, 1, 'Simulated split-commit request state');

  await setPolicyEnabled(false);

  await fourEyes.retry(item.requestId, 5);

  const after = await getFinancialState(agentId, item.requestId, item.operationReference);
  equal(after.request_status, 'EXECUTED', 'Recovered request state');
  equal(after.settlement_status, 'SETTLED', 'Recovered settlement state');
  equal(Number(after.balance), 17, 'Balance after recovery');
  equal(Number(after.journal_count), 2, 'Journal count after recovery');
  equal(Number(after.operation_count), 1, 'Operation count after recovery');

  const executionResult = typeof after.execution_result === 'string'
    ? JSON.parse(after.execution_result)
    : after.execution_result;

  equal(executionResult.recovered, true, 'Record-only recovery marker');
  equal(executionResult.duplicate, true, 'Record-only duplicate marker');

  pass('Disabled-policy recovery marks an already SETTLED request EXECUTED without duplicate financial effects');
}

async function testRetryBlockedWhenPolicyDisabled() {
  await setPolicyEnabled(true);

  const agentId = await createAgent('disabled retry');
  const item = await initiateDeposit(agentId, '19.00');

  const failedFixture = await pool.query(
    `UPDATE four_eyes_requests
        SET status = 'FAILED',
            error = 'P70 disabled-policy retry fixture',
            updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING'
      RETURNING id`,
    [item.requestId]
  );
  equal(failedFixture.rows.length, 1, 'FAILED request fixture');

  await setPolicyEnabled(false);

  let blocked = false;
  try {
    await fourEyes.retry(item.requestId, 5);
  } catch (error) {
    blocked = Number(error.statusCode || error.status) === 403;
    if (!blocked) throw error;
  }
  equal(blocked, true, 'Retry must return 403 while policy is disabled');

  const state = await getFinancialState(agentId, item.requestId, item.operationReference);
  equal(state.request_status, 'FAILED', 'Request remains FAILED');
  equal(state.settlement_status, 'PENDING', 'Settlement remains PENDING');
  equal(Number(state.balance), 0, 'Agent balance remains unchanged');
  equal(Number(state.journal_count), 0, 'No journal entries created');
  equal(Number(state.operation_count), 0, 'No financial operation created');

  pass('Retry is blocked with HTTP-style 403 while policy is disabled; no financial side effects occur');
}

async function installAuditFailureTrigger() {
  const collision = await pool.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgname = $1 AND NOT tgisinternal
       ) AS trigger_exists,
       to_regprocedure($2) IS NOT NULL AS function_exists`,
    [TRIGGER_NAME, `${FUNCTION_NAME}()`]
  );

  if (collision.rows[0].trigger_exists || collision.rows[0].function_exists) {
    throw new Error('P70 audit failure trigger/function already exists; refusing to overwrite');
  }

  await pool.query(`
    CREATE FUNCTION ${FUNCTION_NAME}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.action = 'AGENT_SETTLEMENT_SETTLED'
         AND NEW.entity_type = 'AGENT_SETTLEMENT' THEN
        RAISE EXCEPTION 'P70 deliberate audit insertion failure';
      END IF;
      RETURN NEW;
    END;
    $$;
  `);

  // Track the function before trigger creation so cleanup also covers trigger failure.
  triggerInstalled = true;

  await pool.query(`
    CREATE TRIGGER ${TRIGGER_NAME}
    BEFORE INSERT ON audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION ${FUNCTION_NAME}();
  `);
}

async function testAuditFailureRollsBackSettlement() {
  await setPolicyEnabled(true);

  const agentId = await createAgent('audit rollback');
  const item = await initiateDeposit(agentId, '23.00');

  await installAuditFailureTrigger();

  await fourEyes.approve(
    item.requestId, 5, 'ADMIN', 'P70 deliberate audit rollback test'
  );

  const state = await getFinancialState(agentId, item.requestId, item.operationReference);

  equal(state.request_status, 'FAILED', 'Request state after audit failure');
  equal(state.settlement_status, 'PENDING', 'Settlement rolled back to PENDING');
  equal(Number(state.balance), 0, 'Agent balance rolled back');
  equal(Number(state.journal_count), 0, 'Journal entries rolled back');
  equal(Number(state.operation_count), 0, 'Financial operation rolled back');
  equal(Number(state.approval_count), 1, 'Approval decision remains recorded');

  const audit = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM audit_logs
      WHERE action = 'AGENT_SETTLEMENT_SETTLED'
        AND entity_type = 'AGENT_SETTLEMENT'
        AND entity_id::text = $1`,
    [String(item.settlementId)]
  );
  equal(Number(audit.rows[0].count), 0, 'Failed audit event must not be persisted');

  pass('Audit insertion failure rolls back settlement, balance, journal and financial operation atomically');
}

async function main() {
  if (global.setInterval) {
    const originalSetInterval = global.setInterval;
    global.setInterval = (fn, ms, ...args) => {
      const timer = originalSetInterval(fn, ms, ...args);
      if (timer && typeof timer.unref === 'function') timer.unref();
      return timer;
    };

    try {
      pool = require('../src/config/db');
    } finally {
      global.setInterval = originalSetInterval;
    }
  }

  const identity = await pool.query(`
    SELECT current_database() AS db,
           current_user AS db_user,
           inet_server_port() AS server_port,
           current_setting('transaction_read_only') AS read_only
  `);

  const actual = identity.rows[0];
  equal(actual.db, TARGET.database, 'Connected database');
  equal(actual.db_user, TARGET.user, 'Connected database role');
  equal(actual.read_only, 'off', 'Database write access');
  if (Number(actual.server_port) !== Number(TARGET.port)) {
    console.log(`[info] PostgreSQL server reports port ${actual.server_port}; client endpoint is ${TARGET.port}`);
  }
  pass(`Connected to isolated database ${actual.db} as ${actual.db_user}`);

  const users = await pool.query(
    `SELECT id, role, is_active
       FROM users
      WHERE id = ANY($1::int[])`,
    [[1, 5]]
  );
  const userMap = new Map(users.rows.map(row => [Number(row.id), row]));
  assert(userMap.has(1), 'Requester fixture user 1 missing');
  assert(userMap.has(5), 'ADMIN fixture user 5 missing');
  equal(userMap.get(1).role, 'MJUMBE', 'Requester role');
  equal(userMap.get(1).is_active, true, 'Requester active state');
  equal(userMap.get(5).role, 'ADMIN', 'Approver role');
  equal(userMap.get(5).is_active, true, 'Approver active state');

  const policy = await pool.query(
    `SELECT enabled
       FROM four_eyes_policies
      WHERE action_code = 'AGENT_SETTLEMENT'`
  );
  equal(policy.rows.length, 1, 'AGENT_SETTLEMENT policy exists');
  originalPolicyEnabled = policy.rows[0].enabled;
  equal(originalPolicyEnabled, true, 'Initial AGENT_SETTLEMENT policy state');
  pass('Requester and ADMIN fixtures are active; settlement policy starts enabled');

  fourEyes = require('../src/services/fourEyesService');
  network = require('../src/services/networkService');

  fourEyes.registerExecutor('AGENT_SETTLEMENT', async (payload, approverId) =>
    network.executeAgentSettlement(payload, approverId)
  );

  try {
    await testDisabledPolicyRecovery();
    await testRetryBlockedWhenPolicyDisabled();
    await testAuditFailureRollsBackSettlement();
    console.log('P70 POLICY/AUDIT ACCEPTANCE: PASS');
    console.log(`Database: ${TARGET.database} @ ${TARGET.host}:${TARGET.port}`);
    console.log('Test records intentionally retained for inspection.');
  } finally {
    let cleanupError = null;

    if (triggerInstalled) {
      try {
        await pool.query(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON audit_logs`);
      } catch (error) {
        cleanupError = error;
      }

      try {
        await pool.query(`DROP FUNCTION IF EXISTS ${FUNCTION_NAME}()`);
      } catch (error) {
        cleanupError = cleanupError || error;
      }

      triggerInstalled = false;
    }

    try {
      if (originalPolicyEnabled !== null) {
        await setPolicyEnabled(originalPolicyEnabled);
      }
    } catch (error) {
      cleanupError = cleanupError || error;
    }

    try {
      await pool.end();
    } catch (error) {
      cleanupError = cleanupError || error;
    }

    if (cleanupError) throw cleanupError;
  }
}

main().catch(error => {
  console.error('P70 POLICY/AUDIT ACCEPTANCE: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
