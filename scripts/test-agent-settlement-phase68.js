'use strict';

const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Target endpoint is configurable. By default this harness targets the approved
// regression database. To run against an isolated/disposable database, set
// P68_HARNESS_OVERRIDE=1 and supply P68_DB_HOST, P68_DB_PORT, P68_DB_NAME,
// P68_DB_USER and P68_DB_PASSWORD. This keeps write-capable runs off the shared
// regression database unless it is explicitly intended.
// ---------------------------------------------------------------------------
const overrideEndpoint = process.env.P68_HARNESS_OVERRIDE === '1';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`P68_HARNESS_OVERRIDE=1 requires environment variable ${name}`);
  }
  return value;
}

process.env.DB_HOST = overrideEndpoint ? requiredEnv('P68_DB_HOST') : '127.0.0.1';
process.env.DB_PORT = overrideEndpoint ? requiredEnv('P68_DB_PORT') : '5436';
process.env.DB_NAME = overrideEndpoint ? requiredEnv('P68_DB_NAME') : 'afrikoba_regression';
process.env.DB_USER = overrideEndpoint ? requiredEnv('P68_DB_USER') : 'afrikoba_r';
process.env.DB_PASSWORD = overrideEndpoint ? requiredEnv('P68_DB_PASSWORD') : 'afrikoba_ro_strong';

// ---------------------------------------------------------------------------
// Misdirection guard. The override exists to target disposable databases; it
// must not be usable to accidentally hit the shared regression (or a
// production) database. The guard runs before any connection is opened.
// ---------------------------------------------------------------------------
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];
const RESERVED_DB_NAMES = ['afrikoba_regression', 'afrikoba_global', 'afrikoba_prod', 'afrikoba'];
const SHARED_ENDPOINTS = [
  { host: '127.0.0.1', port: '5436', database: 'afrikoba_regression', user: 'afrikoba_r' },
  { host: 'localhost', port: '5436', database: 'afrikoba_regression', user: 'afrikoba_r' },
];

if (overrideEndpoint) {
  const resolved = {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
  };
  const isSharedEndpoint = SHARED_ENDPOINTS.some(
    (e) => e.host === resolved.host && e.port === resolved.port &&
           e.database === resolved.database && e.user === resolved.user
  );
  const hasReservedName = RESERVED_DB_NAMES.includes(resolved.database);
  const isLoopback = LOOPBACK_HOSTS.includes(resolved.host);

  if ((isSharedEndpoint || hasReservedName) && process.env.P68_ALLOW_SHARED !== '1') {
    throw new Error(
      `Refusing override: target ${resolved.user}@${resolved.host}:${resolved.port}/${resolved.database} ` +
      'looks like the shared/production database. Use the default (no P68_HARNESS_OVERRIDE) for the ' +
      'shared regression database, or set P68_ALLOW_SHARED=1 to override deliberately.'
    );
  }
  if (!isLoopback && process.env.P68_ALLOW_REMOTE !== '1') {
    throw new Error(
      `Refusing override to non-loopback host ${resolved.host}. Disposable test databases must be local. ` +
      'Set P68_ALLOW_REMOTE=1 only if you have deliberately provisioned an isolated remote test database.'
    );
  }

  console.log(`[target] override -> ${resolved.user}@${resolved.host}:${resolved.port}/${resolved.database}`);
}

// Safe, connection-free inspection of the resolved target.
if (process.env.P68_HARNESS_DRYRUN === '1') {
  console.log(
    `[dryrun] target=${process.env.DB_USER}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME} ` +
    `override=${overrideEndpoint}`
  );
  process.exit(0);
}

let pool;
let fixture = {};

function pass(message) {
  console.log(`[PASS] ${message}`);
}

function assertEqual(actual, expected, message) {
  assert.equal(actual, expected, `${message}: expected ${expected}, got ${actual}`);
}

async function main() {
  // Prevent the DB pool's diagnostic interval from keeping this test alive.
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

  // No writes are permitted until the actual connection identity is verified.
  const identity = await pool.query(`
    SELECT current_database() AS db,
           current_user AS db_user,
           inet_server_port() AS port,
           current_setting('transaction_read_only') AS read_only
  `);
  const db = identity.rows[0];

  // Identity guard: the database name and role must match the configured
  // endpoint before any write. Port handling: PostgreSQL reports its own
  // listen port via inet_server_port(), which legitimately differs from the
  // client port under Docker/host port forwarding. When the operator supplies
  // P68_DB_SERVER_PORT we assert it exactly; otherwise a forwarded mismatch is
  // accepted with an explicit note instead of a false failure.
  assertEqual(db.db, process.env.DB_NAME, 'Database identity');
  assertEqual(db.db_user, process.env.DB_USER, 'Database user identity');
  const clientPort = Number(process.env.DB_PORT);
  const serverPort = Number(db.port);
  const expectedServerPort = process.env.P68_DB_SERVER_PORT
    ? Number(process.env.P68_DB_SERVER_PORT)
    : null;
  if (expectedServerPort !== null) {
    assertEqual(serverPort, expectedServerPort, 'Database server port identity');
  } else if (serverPort !== clientPort) {
    console.log(`[info] server listen port ${serverPort} != client port ${clientPort} (port forwarding); accepted`);
  }
  assertEqual(db.read_only, 'off', 'Target database must permit writes');
  const targetLabel = overrideEndpoint ? 'isolated/disposable' : 'explicitly approved regression';
  pass(`Connected to the ${targetLabel} database (${db.db} @ ${db.db_user})`);

  try {
    const policyResult = await pool.query(
      `SELECT action_code, required_approvers, approver_roles,
              enabled, allow_self_approve
         FROM four_eyes_policies
        WHERE action_code = 'AGENT_SETTLEMENT'`
    );
    assertEqual(policyResult.rows.length, 1, 'Settlement policy exists');
    const policy = policyResult.rows[0];
    assertEqual(policy.enabled, true, 'Settlement policy enabled');
    assertEqual(Number(policy.required_approvers), 1, 'Required approver count');
    assert(policy.approver_roles.includes('ADMIN'), 'ADMIN must be an allowed approver');
    assertEqual(policy.allow_self_approve, false, 'Self-approval must be disabled');
    pass('AGENT_SETTLEMENT policy is enabled and requires an independent ADMIN');

    const usersResult = await pool.query(
      `SELECT id, role, is_active
         FROM users
        WHERE id = ANY($1::int[])
        ORDER BY id`,
      [[1, 3, 5]]
    );
    const users = new Map(usersResult.rows.map(u => [Number(u.id), u]));
    for (const [id, role] of [[1, 'MJUMBE'], [3, 'MJUMBE'], [5, 'ADMIN']]) {
      assert(users.has(id), `Expected test user ${id} to exist`);
      assertEqual(users.get(id).role, role, `Role for user ${id}`);
      assertEqual(users.get(id).is_active, true, `Active status for user ${id}`);
    }
    pass('Requester, unauthorized approver and ADMIN are active with expected roles');

    const accountsResult = await pool.query(
      `SELECT account_code
         FROM ledger_accounts
        WHERE account_code = ANY($1::varchar[])`,
      [['MNO_CLEARING', 'AGENT_BALANCE']]
    );
    const accountCodes = new Set(accountsResult.rows.map(r => r.account_code));
    assert(accountCodes.has('MNO_CLEARING'), 'MNO_CLEARING ledger account missing');
    assert(accountCodes.has('AGENT_BALANCE'), 'AGENT_BALANCE ledger account missing');
    pass('Required double-entry ledger accounts exist');

    const stamp = `${Date.now()}-${process.pid}`;
    const agentCode = `P68-${Date.now().toString(36)}-${process.pid.toString(36)}`.slice(0, 20);
    const phone = `P68${String(Date.now()).slice(-9)}`;

    const agentResult = await pool.query(
      `INSERT INTO agents
         (user_id, agent_code, business_name, owner_name, phone, status, tier, balance)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', 'BRONZE', 0)
       RETURNING id, balance`,
      [1, agentCode, `Phase 68 Acceptance ${stamp}`, 'Phase 68 Test', phone]
    );
    fixture.agentId = Number(agentResult.rows[0].id);
    assertEqual(Number(agentResult.rows[0].balance), 0, 'Initial agent balance');
    pass(`Created isolated test agent id=${fixture.agentId}`);

    const fourEyes = require('../src/services/fourEyesService');
    const network = require('../src/services/networkService');

    // Mirrors the AGENT_SETTLEMENT executor registration in fourEyesRoutes.js.
    fourEyes.registerExecutor('AGENT_SETTLEMENT', async (payload, approverId) =>
      network.executeAgentSettlement(payload, approverId)
    );

    const initiated = await network.agentSettlement(
      fixture.agentId, '100.00', 'DEPOSIT', 1
    );
    assertEqual(initiated.success, true, 'Settlement initiation success');
    assertEqual(initiated.status, 'PENDING', 'Initial settlement status');
    fixture.reference = initiated.reference;
    fixture.requestId = Number(initiated.fourEyesRequestId);

    const settlementResult = await pool.query(
      `SELECT id, agent_id, amount, type, reference, status
         FROM agent_settlements
        WHERE reference = $1`,
      [fixture.reference]
    );
    assertEqual(settlementResult.rows.length, 1, 'Settlement record count');
    const settlement = settlementResult.rows[0];
    fixture.settlementId = Number(settlement.id);
    assertEqual(Number(settlement.agent_id), fixture.agentId, 'Settlement agent');
    assertEqual(Number(settlement.amount), 100, 'Settlement amount');
    assertEqual(settlement.type, 'DEPOSIT', 'Settlement type');
    assertEqual(settlement.status, 'PENDING', 'Settlement must begin pending');

    let requestResult = await pool.query(
      `SELECT id, action_code, requester_id, payload, status
         FROM four_eyes_requests
        WHERE id = $1`,
      [fixture.requestId]
    );
    assertEqual(requestResult.rows.length, 1, 'Four-Eyes request exists');
    assertEqual(requestResult.rows[0].action_code, 'AGENT_SETTLEMENT', 'Request action');
    assertEqual(Number(requestResult.rows[0].requester_id), 1, 'Request maker');
    assertEqual(requestResult.rows[0].status, 'PENDING', 'Request begins pending');

    const payload = typeof requestResult.rows[0].payload === 'string'
      ? JSON.parse(requestResult.rows[0].payload)
      : requestResult.rows[0].payload;
    assertEqual(Number(payload.settlementId), fixture.settlementId, 'Payload settlement ID');
    assertEqual(Number(payload.agentId), fixture.agentId, 'Payload agent ID');
    assertEqual(Number(payload.amount), 100, 'Payload amount');
    assertEqual(payload.type, 'DEPOSIT', 'Payload type');
    assertEqual(payload.reference, fixture.reference, 'Payload reference');

    const beforeApproval = await pool.query(
      `SELECT a.balance,
              (SELECT COUNT(*)::int FROM journal_entries
                WHERE reference_id = $1) AS journal_count,
              (SELECT COUNT(*)::int FROM financial_operations
                WHERE reference_id = $2) AS operation_count
         FROM agents a
        WHERE a.id = $3`,
      [ `${fixture.reference}:STL`, `${fixture.reference}:STL`, fixture.agentId ]
    );
    assertEqual(Number(beforeApproval.rows[0].balance), 0, 'Balance before approval');
    assertEqual(Number(beforeApproval.rows[0].journal_count), 0, 'Journal before approval');
    assertEqual(Number(beforeApproval.rows[0].operation_count), 0, 'Financial operation before approval');
    pass('Initiation creates pending records without financial side effects');

    // A role not listed in the policy must be rejected without recording approval.
    let denied = false;
    try {
      await fourEyes.approve(
        fixture.requestId, 3, 'MJUMBE', 'Phase 68 unauthorized-role test'
      );
    } catch (error) {
      denied = Number(error.statusCode || error.status) === 403;
      if (!denied) throw error;
    }
    assertEqual(denied, true, 'Unauthorized role must receive HTTP-style 403');

    const afterDenied = await pool.query(
      `SELECT r.status,
              (SELECT COUNT(*)::int FROM four_eyes_approvals
                WHERE request_id = r.id) AS approval_count,
              (SELECT COUNT(*)::int FROM journal_entries
                WHERE reference_id = $2) AS journal_count,
              (SELECT COUNT(*)::int FROM financial_operations
                WHERE reference_id = $2) AS operation_count,
              (SELECT balance FROM agents WHERE id = $3) AS balance
         FROM four_eyes_requests r
        WHERE r.id = $1`,
      [fixture.requestId, `${fixture.reference}:STL`, fixture.agentId]
    );
    assertEqual(afterDenied.rows.length, 1, 'Request after role denial exists');
    assertEqual(afterDenied.rows[0].status, 'PENDING', 'Request remains pending after denial');
    assertEqual(Number(afterDenied.rows[0].approval_count), 0, 'No approval recorded for denied role');
    assertEqual(Number(afterDenied.rows[0].journal_count), 0, 'No journal after role denial');
    assertEqual(Number(afterDenied.rows[0].operation_count), 0, 'No financial operation after role denial');
    assertEqual(Number(afterDenied.rows[0].balance), 0, 'Balance unchanged after role denial');
    pass('Unauthorized MJUMBE approval is rejected with no financial effect');

    const approval = await fourEyes.approve(
      fixture.requestId, 5, 'ADMIN', 'Phase 68 settlement acceptance'
    );
    assertEqual(approval.request.status, 'EXECUTED', 'Request status after ADMIN approval');

    const finalResult = await pool.query(
      `SELECT r.status AS request_status,
              r.executed_by,
              r.execution_result,
              r.error AS request_error,
              s.status AS settlement_status,
              s.settled_by,
              s.amount,
              s.type,
              a.balance
         FROM four_eyes_requests r
         JOIN agent_settlements s
           ON s.id = (r.payload->>'settlementId')::bigint
         JOIN agents a ON a.id = s.agent_id
        WHERE r.id = $1`,
      [fixture.requestId]
    );
    assertEqual(finalResult.rows.length, 1, 'Final request/settlement join exists');
    const final = finalResult.rows[0];
    assertEqual(final.request_status, 'EXECUTED', 'Persisted request status');
    assertEqual(Number(final.executed_by), 5, 'Request executor');
    assertEqual(final.request_error, null, 'Request execution error');
    assertEqual(final.settlement_status, 'SETTLED', 'Persisted settlement status');
    assertEqual(Number(final.settled_by), 5, 'Settlement approver');
    assertEqual(Number(final.amount), 100, 'Settled amount');
    assertEqual(final.type, 'DEPOSIT', 'Settled type');
    assertEqual(Number(final.balance), 100, 'Agent balance after settlement');

    const executionResult = typeof final.execution_result === 'string'
      ? JSON.parse(final.execution_result)
      : final.execution_result;
    assertEqual(executionResult.success, true, 'Executor result success');
    assertEqual(executionResult.status, 'SETTLED', 'Executor result status');
    assertEqual(executionResult.duplicate, false, 'First execution is not a duplicate');
    pass('ADMIN approval executes settlement and credits agent balance exactly once');

    const opResult = await pool.query(
      `SELECT operation_type, reference_id, user_id, amount, status
         FROM financial_operations
        WHERE reference_id = $1`,
      [`${fixture.reference}:STL`]
    );
    assertEqual(opResult.rows.length, 1, 'Financial operation count');
    assertEqual(opResult.rows[0].operation_type, 'AGENT_SETTLEMENT_DEPOSIT', 'Operation type');
    assertEqual(opResult.rows[0].reference_id, `${fixture.reference}:STL`, 'Operation reference');
    assertEqual(Number(opResult.rows[0].user_id), 5, 'Operation user');
    assertEqual(Number(opResult.rows[0].amount), 100, 'Operation amount');
    assertEqual(opResult.rows[0].status, 'SUCCESS', 'Operation terminal status');

    const journalResult = await pool.query(
      `SELECT j.direction, j.amount, j.reference_id, l.account_code
         FROM journal_entries j
         JOIN ledger_accounts l ON l.id = j.account_id
        WHERE j.reference_id = $1
        ORDER BY l.account_code`,
      [`${fixture.reference}:STL`]
    );
    assertEqual(journalResult.rows.length, 2, 'Exactly two journal entries');
    const journal = new Map(journalResult.rows.map(row => [row.account_code, row]));
    assert(journal.has('MNO_CLEARING'), 'MNO_CLEARING journal line missing');
    assert(journal.has('AGENT_BALANCE'), 'AGENT_BALANCE journal line missing');
    assertEqual(journal.get('MNO_CLEARING').direction, 'DR', 'MNO_CLEARING direction');
    assertEqual(Number(journal.get('MNO_CLEARING').amount), 100, 'MNO_CLEARING amount');
    assertEqual(journal.get('AGENT_BALANCE').direction, 'CR', 'AGENT_BALANCE direction');
    assertEqual(Number(journal.get('AGENT_BALANCE').amount), 100, 'AGENT_BALANCE amount');
    const debitTotal = journalResult.rows
      .filter(row => row.direction === 'DR')
      .reduce((sum, row) => sum + Number(row.amount), 0);
    const creditTotal = journalResult.rows
      .filter(row => row.direction === 'CR')
      .reduce((sum, row) => sum + Number(row.amount), 0);
    assertEqual(debitTotal, 100, 'Total journal debit');
    assertEqual(creditTotal, 100, 'Total journal credit');
    assertEqual(debitTotal, creditTotal, 'Journal balance');
    pass('Financial operation is SUCCESS and the two-line journal balances');

    const approvalsResult = await pool.query(
      `SELECT approver_id, approver_role, decision
         FROM four_eyes_approvals
        WHERE request_id = $1`,
      [fixture.requestId]
    );
    assertEqual(approvalsResult.rows.length, 1, 'Recorded approval count');
    assertEqual(Number(approvalsResult.rows[0].approver_id), 5, 'Recorded approver');
    assertEqual(approvalsResult.rows[0].approver_role, 'ADMIN', 'Recorded approver role');
    assertEqual(approvalsResult.rows[0].decision, 'APPROVE', 'Recorded decision');
    pass('Only the authorized ADMIN approval was recorded');

    // Directly retry the executor to verify its post-settlement duplicate guard.
    const retry = await network.executeAgentSettlement(payload, 5);
    assertEqual(retry.success, true, 'Duplicate retry success');
    assertEqual(retry.status, 'SETTLED', 'Duplicate retry status');
    assertEqual(retry.duplicate, true, 'Duplicate retry indicator');

    const retryCheck = await pool.query(
      `SELECT a.balance,
              (SELECT COUNT(*)::int FROM journal_entries
                WHERE reference_id = $1) AS journal_count,
              (SELECT COUNT(*)::int FROM financial_operations
                WHERE reference_id = $1) AS operation_count
         FROM agents a
        WHERE a.id = $2`,
      [`${fixture.reference}:STL`, fixture.agentId]
    );
    assertEqual(Number(retryCheck.rows[0].balance), 100, 'Balance after duplicate retry');
    assertEqual(Number(retryCheck.rows[0].journal_count), 2, 'Journal count after retry');
    assertEqual(Number(retryCheck.rows[0].operation_count), 1, 'Operation count after retry');
    pass('Retry is idempotent: no extra balance, journal entries or operation');



    // Simulate settlement committed while Four-Eyes status remained APPROVED.
    const simulatedSplitCommit = await pool.query(
      `UPDATE four_eyes_requests
          SET status = 'APPROVED', executed_by = NULL,
              execution_result = NULL, error = 'simulated split-commit'
        WHERE id = $1 AND status = 'EXECUTED'
        RETURNING id`,
      [fixture.requestId]
    );
    assertEqual(simulatedSplitCommit.rows.length, 1,
      'Split-commit fixture request updated');

    const recovered = await fourEyes.retry(fixture.requestId, 5);
    assertEqual(recovered.recoveredSettledAgentRequest, true,
      'Retry identifies settled-request recovery');
    assertEqual(recovered.request.status, 'EXECUTED',
      'Recovered request status');

    const recoveredResult =
      typeof recovered.request.execution_result === 'string'
        ? JSON.parse(recovered.request.execution_result)
        : recovered.request.execution_result;
    assertEqual(recoveredResult.success, true, 'Recovered executor succeeds');
    assertEqual(recoveredResult.status, 'SETTLED', 'Recovered settlement status');
    assertEqual(recoveredResult.duplicate, true, 'Recovery uses duplicate guard');

    const recoveredCheck = await pool.query(
      `SELECT a.balance,
              (SELECT COUNT(*)::int FROM journal_entries
                WHERE reference_id = $1) AS journal_count,
              (SELECT COUNT(*)::int FROM financial_operations
                WHERE reference_id = $1) AS operation_count
         FROM agents a
        WHERE a.id = $2`,
      [`${fixture.reference}:STL`, fixture.agentId]
    );
    assertEqual(Number(recoveredCheck.rows[0].balance), 100,
      'Balance after recovery');
    assertEqual(Number(recoveredCheck.rows[0].journal_count), 2,
      'Journal count after recovery');
    assertEqual(Number(recoveredCheck.rows[0].operation_count), 1,
      'Operation count after recovery');
    pass('Split-commit recovery creates no duplicate financial effects');

    // Use an isolated zero-balance agent for the PENDING recovery test.
    const pendingStamp = `${Date.now()}-${process.pid}`;
    const pendingAgentCode =
      `P68P-${Date.now().toString(36)}-${process.pid.toString(36)}`.slice(0, 20);
    const pendingPhone = `P68${String(Date.now() + 2).slice(-9)}`;

    const pendingAgentResult = await pool.query(
      `INSERT INTO agents
         (user_id, agent_code, business_name, owner_name, phone, status, tier, balance)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', 'BRONZE', 0)
       RETURNING id, balance`,
      [1, pendingAgentCode, `Phase 68 Pending Recovery ${pendingStamp}`,
       'Phase 68 Pending Test', pendingPhone]
    );
    const pendingAgentId = Number(pendingAgentResult.rows[0].id);
    assertEqual(Number(pendingAgentResult.rows[0].balance), 0,
      'Pending recovery agent initial balance');

    // An APPROVED request must not recover while its settlement is still PENDING.
    const pendingInitiated = await network.agentSettlement(
      pendingAgentId, '5.00', 'DEPOSIT', 1
    );
    assertEqual(pendingInitiated.status, 'PENDING', 'Pending settlement status');

    const pendingRequestId = Number(pendingInitiated.fourEyesRequestId);
    const pendingUpdated = await pool.query(
      `UPDATE four_eyes_requests SET status = 'APPROVED'
        WHERE id = $1 AND status = 'PENDING' RETURNING id`,
      [pendingRequestId]
    );
    assertEqual(pendingUpdated.rows.length, 1, 'Pending request fixture updated');

    let rejectedPendingRecovery = false;
    try {
      await fourEyes.retry(pendingRequestId, 5);
    } catch (error) {
      rejectedPendingRecovery = Number(error.statusCode || error.status) === 409;
      if (!rejectedPendingRecovery) throw error;
    }
    assertEqual(rejectedPendingRecovery, true,
      'Recovery rejects a PENDING settlement');

    const pendingCheck = await pool.query(
      `SELECT r.status AS request_status, s.status AS settlement_status,
              a.balance,
              (SELECT COUNT(*)::int FROM journal_entries
                WHERE reference_id = $1) AS journal_count,
              (SELECT COUNT(*)::int FROM financial_operations
                WHERE reference_id = $1) AS operation_count
         FROM four_eyes_requests r
         JOIN agent_settlements s ON s.id = (r.payload->>'settlementId')::bigint
         JOIN agents a ON a.id = s.agent_id
        WHERE r.id = $2`,
      [`${pendingInitiated.reference}:STL`, pendingRequestId]
    );
    assertEqual(pendingCheck.rows.length, 1, 'Pending recovery records exist');
    assertEqual(pendingCheck.rows[0].request_status, 'APPROVED',
      'Rejected recovery preserves request status');
    assertEqual(pendingCheck.rows[0].settlement_status, 'PENDING',
      'Rejected recovery preserves settlement status');
    assertEqual(Number(pendingCheck.rows[0].balance), 0,
      'Rejected recovery leaves isolated agent balance unchanged');
    assertEqual(Number(pendingCheck.rows[0].journal_count), 0,
      'Rejected recovery creates no journal entries');
    assertEqual(Number(pendingCheck.rows[0].operation_count), 0,
      'Rejected recovery creates no financial operation');
    pass('Pending-settlement recovery is rejected without financial effects');

    // Isolated WITHDRAWAL acceptance using a separate agent with sufficient test balance.
    const withdrawalStamp = `${Date.now()}-${process.pid}`;
    const withdrawalAgentCode =
      `P68W-${Date.now().toString(36)}-${process.pid.toString(36)}`.slice(0, 20);
    const withdrawalPhone = `P68${String(Date.now() + 1).slice(-9)}`;

    const withdrawalAgentResult = await pool.query(
      `INSERT INTO agents
         (user_id, agent_code, business_name, owner_name, phone, status, tier, balance)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', 'BRONZE', 250.00)
       RETURNING id, balance`,
      [1, withdrawalAgentCode, `Phase 68 Withdrawal ${withdrawalStamp}`,
       'Phase 68 Withdrawal Test', withdrawalPhone]
    );
    const withdrawalAgentId = Number(withdrawalAgentResult.rows[0].id);
    assertEqual(Number(withdrawalAgentResult.rows[0].balance), 250,
      'Withdrawal agent initial balance');

    const withdrawalInitiated = await network.agentSettlement(
      withdrawalAgentId, '40.00', 'WITHDRAWAL', 1
    );
    assertEqual(withdrawalInitiated.success, true, 'Withdrawal initiation success');
    assertEqual(withdrawalInitiated.status, 'PENDING', 'Withdrawal starts pending');

    const withdrawalRequestId = Number(withdrawalInitiated.fourEyesRequestId);
    const withdrawalSettlementResult = await pool.query(
      `SELECT id, agent_id, amount, type, reference, status
         FROM agent_settlements
        WHERE reference = $1`,
      [withdrawalInitiated.reference]
    );
    assertEqual(withdrawalSettlementResult.rows.length, 1,
      'Withdrawal settlement record count');

    const withdrawalSettlement = withdrawalSettlementResult.rows[0];
    const withdrawalSettlementId = Number(withdrawalSettlement.id);
    assertEqual(Number(withdrawalSettlement.agent_id), withdrawalAgentId,
      'Withdrawal agent ID');
    assertEqual(Number(withdrawalSettlement.amount), 40, 'Withdrawal amount');
    assertEqual(withdrawalSettlement.type, 'WITHDRAWAL', 'Withdrawal type');
    assertEqual(withdrawalSettlement.status, 'PENDING', 'Withdrawal settlement pending');

    const withdrawalRequestResult = await pool.query(
      `SELECT id, action_code, requester_id, payload, status
         FROM four_eyes_requests
        WHERE id = $1`,
      [withdrawalRequestId]
    );
    assertEqual(withdrawalRequestResult.rows.length, 1,
      'Withdrawal Four-Eyes request exists');
    assertEqual(withdrawalRequestResult.rows[0].action_code, 'AGENT_SETTLEMENT',
      'Withdrawal request action');
    assertEqual(withdrawalRequestResult.rows[0].status, 'PENDING',
      'Withdrawal request starts pending');

    const withdrawalPayload =
      typeof withdrawalRequestResult.rows[0].payload === 'string'
        ? JSON.parse(withdrawalRequestResult.rows[0].payload)
        : withdrawalRequestResult.rows[0].payload;

    assertEqual(Number(withdrawalPayload.settlementId), withdrawalSettlementId,
      'Withdrawal payload settlement ID');
    assertEqual(Number(withdrawalPayload.agentId), withdrawalAgentId,
      'Withdrawal payload agent ID');
    assertEqual(Number(withdrawalPayload.amount), 40, 'Withdrawal payload amount');
    assertEqual(withdrawalPayload.type, 'WITHDRAWAL', 'Withdrawal payload type');
    assertEqual(withdrawalPayload.reference, withdrawalInitiated.reference,
      'Withdrawal payload reference');

    const withdrawalBeforeApproval = await pool.query(
      `SELECT a.balance,
              (SELECT COUNT(*)::int FROM journal_entries
                WHERE reference_id = $1) AS journal_count,
              (SELECT COUNT(*)::int FROM financial_operations
                WHERE reference_id = $1) AS operation_count
         FROM agents a
        WHERE a.id = $2`,
      [`${withdrawalInitiated.reference}:STL`, withdrawalAgentId]
    );
    assertEqual(Number(withdrawalBeforeApproval.rows[0].balance), 250,
      'Withdrawal balance before approval');
    assertEqual(Number(withdrawalBeforeApproval.rows[0].journal_count), 0,
      'Withdrawal journal before approval');
    assertEqual(Number(withdrawalBeforeApproval.rows[0].operation_count), 0,
      'Withdrawal financial operation before approval');
    pass('WITHDRAWAL initiation creates pending records without financial side effects');

    const withdrawalApproval = await fourEyes.approve(
      withdrawalRequestId, 5, 'ADMIN', 'Phase 68 withdrawal acceptance'
    );
    assertEqual(withdrawalApproval.request.status, 'EXECUTED',
      'Withdrawal request status after ADMIN approval');

    const withdrawalFinalResult = await pool.query(
      `SELECT r.status AS request_status,
              r.executed_by,
              r.execution_result,
              r.error AS request_error,
              s.status AS settlement_status,
              s.settled_by,
              s.amount,
              s.type,
              a.balance
         FROM four_eyes_requests r
         JOIN agent_settlements s
           ON s.id = (r.payload->>'settlementId')::bigint
         JOIN agents a ON a.id = s.agent_id
        WHERE r.id = $1`,
      [withdrawalRequestId]
    );
    assertEqual(withdrawalFinalResult.rows.length, 1,
      'Withdrawal final request/settlement join exists');

    const withdrawalFinal = withdrawalFinalResult.rows[0];
    assertEqual(withdrawalFinal.request_status, 'EXECUTED',
      'Persisted withdrawal request status');
    assertEqual(Number(withdrawalFinal.executed_by), 5,
      'Withdrawal request executor');
    assertEqual(withdrawalFinal.request_error, null, 'Withdrawal request error');
    assertEqual(withdrawalFinal.settlement_status, 'SETTLED',
      'Persisted withdrawal settlement status');
    assertEqual(Number(withdrawalFinal.settled_by), 5, 'Withdrawal approver');
    assertEqual(Number(withdrawalFinal.amount), 40, 'Settled withdrawal amount');
    assertEqual(withdrawalFinal.type, 'WITHDRAWAL', 'Settled withdrawal type');
    assertEqual(Number(withdrawalFinal.balance), 210, 'Balance after withdrawal');

    const withdrawalExecutionResult =
      typeof withdrawalFinal.execution_result === 'string'
        ? JSON.parse(withdrawalFinal.execution_result)
        : withdrawalFinal.execution_result;
    assertEqual(withdrawalExecutionResult.success, true,
      'Withdrawal executor result success');
    assertEqual(withdrawalExecutionResult.status, 'SETTLED',
      'Withdrawal executor result status');
    assertEqual(withdrawalExecutionResult.duplicate, false,
      'First withdrawal execution is not a duplicate');
    pass('ADMIN approval debits the agent balance exactly once');

    const withdrawalOperationResult = await pool.query(
      `SELECT operation_type, reference_id, user_id, amount, status
         FROM financial_operations
        WHERE reference_id = $1`,
      [`${withdrawalInitiated.reference}:STL`]
    );
    assertEqual(withdrawalOperationResult.rows.length, 1,
      'Withdrawal financial operation count');
    assertEqual(withdrawalOperationResult.rows[0].operation_type,
      'AGENT_SETTLEMENT_WITHDRAWAL', 'Withdrawal operation type');
    assertEqual(Number(withdrawalOperationResult.rows[0].user_id), 5,
      'Withdrawal operation user');
    assertEqual(Number(withdrawalOperationResult.rows[0].amount), 40,
      'Withdrawal operation amount');
    assertEqual(withdrawalOperationResult.rows[0].status, 'SUCCESS',
      'Withdrawal operation terminal status');

    const withdrawalJournalResult = await pool.query(
      `SELECT j.direction, j.amount, j.reference_id, l.account_code
         FROM journal_entries j
         JOIN ledger_accounts l ON l.id = j.account_id
        WHERE j.reference_id = $1
        ORDER BY l.account_code`,
      [`${withdrawalInitiated.reference}:STL`]
    );
    assertEqual(withdrawalJournalResult.rows.length, 2,
      'Withdrawal journal entry count');

    const withdrawalJournal = new Map(
      withdrawalJournalResult.rows.map(row => [row.account_code, row])
    );
    assert(withdrawalJournal.has('AGENT_BALANCE'),
      'Withdrawal AGENT_BALANCE journal line missing');
    assert(withdrawalJournal.has('MNO_CLEARING'),
      'Withdrawal MNO_CLEARING journal line missing');
    assertEqual(withdrawalJournal.get('AGENT_BALANCE').direction, 'DR',
      'Withdrawal AGENT_BALANCE direction');
    assertEqual(Number(withdrawalJournal.get('AGENT_BALANCE').amount), 40,
      'Withdrawal AGENT_BALANCE amount');
    assertEqual(withdrawalJournal.get('MNO_CLEARING').direction, 'CR',
      'Withdrawal MNO_CLEARING direction');
    assertEqual(Number(withdrawalJournal.get('MNO_CLEARING').amount), 40,
      'Withdrawal MNO_CLEARING amount');

    const withdrawalDebitTotal = withdrawalJournalResult.rows
      .filter(row => row.direction === 'DR')
      .reduce((sum, row) => sum + Number(row.amount), 0);
    const withdrawalCreditTotal = withdrawalJournalResult.rows
      .filter(row => row.direction === 'CR')
      .reduce((sum, row) => sum + Number(row.amount), 0);
    assertEqual(withdrawalDebitTotal, 40, 'Withdrawal total debit');
    assertEqual(withdrawalCreditTotal, 40, 'Withdrawal total credit');
    assertEqual(withdrawalDebitTotal, withdrawalCreditTotal,
      'Withdrawal journal balance');
    pass('WITHDRAWAL operation is SUCCESS and its double-entry journal balances');

    const withdrawalRetry = await network.executeAgentSettlement(
      withdrawalPayload, 5
    );
    assertEqual(withdrawalRetry.success, true, 'Withdrawal duplicate retry success');
    assertEqual(withdrawalRetry.status, 'SETTLED', 'Withdrawal duplicate retry status');
    assertEqual(withdrawalRetry.duplicate, true,
      'Withdrawal duplicate retry indicator');

    const withdrawalRetryCheck = await pool.query(
      `SELECT a.balance,
              (SELECT COUNT(*)::int FROM journal_entries
                WHERE reference_id = $1) AS journal_count,
              (SELECT COUNT(*)::int FROM financial_operations
                WHERE reference_id = $1) AS operation_count
         FROM agents a
        WHERE a.id = $2`,
      [`${withdrawalInitiated.reference}:STL`, withdrawalAgentId]
    );
    assertEqual(Number(withdrawalRetryCheck.rows[0].balance), 210,
      'Withdrawal balance after duplicate retry');
    assertEqual(Number(withdrawalRetryCheck.rows[0].journal_count), 2,
      'Withdrawal journal count after retry');
    assertEqual(Number(withdrawalRetryCheck.rows[0].operation_count), 1,
      'Withdrawal operation count after retry');
    pass('WITHDRAWAL retry is idempotent: no extra debit, journal or operation');

    console.log('');
    console.log('PHASE 68 ACCEPTANCE: PASS');
    console.log(`Database: ${db.db} @ ${db.port} (${db.db_user})`);
    console.log(`Agent ID: ${fixture.agentId}`);
    console.log(`Settlement ID: ${fixture.settlementId}`);
    console.log(`Four-Eyes request ID: ${fixture.requestId}`);
    console.log(`Reference: ${fixture.reference}`);
    console.log('Test records are intentionally retained for inspection.');
  } finally {
    if (pool) await pool.end();
  }
}

main().catch(error => {
  console.error('');
  console.error('PHASE 68 ACCEPTANCE: FAIL');
  console.error(error && error.stack ? error.stack : error);
  if (fixture.agentId) console.error(`Test agent ID: ${fixture.agentId}`);
  if (fixture.settlementId) console.error(`Test settlement ID: ${fixture.settlementId}`);
  if (fixture.requestId) console.error(`Four-Eyes request ID: ${fixture.requestId}`);
  if (fixture.reference) console.error(`Reference: ${fixture.reference}`);
  process.exitCode = 1;
});
