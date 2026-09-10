/**
 * SACCOS Digital Core - Dividends (increment 8).
 * Surplus distribution closing the economic loop. The board
 * declares a dividend run (DIV-*) against a CLOSED accounting
 * period (authoritative source of surplus, usable once); eligible
 * shares = ACTIVE members' holdings (share_count). Distribution
 * pays each holder share_count * per_share to their
 * CUSTOMER_WALLET through an entity-scoped EXPENSE journal:
 *   DR `SACCOS<id>_DIVIDEND_DISTRIBUTED` (EXPENSE)
 *   CR CUSTOMER_WALLET
 * idempotent per payout on DIVP-* (claim + postJournal, wallet
 * FOR UPDATE). Runs distribute once; re-running only pays
 * PENDING rows. Members read their own payouts; cross-entity 404.
 */
const pool = require('../config/db');
const crypto = require('crypto');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');
const fin = require('./financialEngine');
const saccosCore = require('./saccosService');

const DEFAULT_DIVIDEND_CONFIG = {};
function dividendConfig(saccos) {
  return { ...DEFAULT_DIVIDEND_CONFIG, ...((saccos.config && saccos.config.dividends) || {}) };
}

function newRef(prefix) {
  return prefix + '-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

function dividendExpenseCode(saccosId) {
  return `SACCOS${saccosId}_DIVIDEND_DISTRIBUTED`;
}

async function fetchActiveOrg(actorId, saccosId) {
  const org = await pool.query('SELECT * FROM saccos WHERE id = $1', [saccosId]);
  if (!org.rows.length) throw createAppError('SACCOS_NOT_FOUND');
  if (org.rows[0].status !== 'ACTIVE') throw createAppError('SACCOS_SHARES_NOT_ACTIVE');
  return org.rows[0];
}

async function requireActiveMember(actorId, saccosId) {
  const { membership } = await saccosCore.assertVisible(actorId, saccosId);
  if (!membership || membership.status !== 'ACTIVE') throw createAppError('SACCOS_NOT_MEMBER');
  return membership;
}

async function requireAdminOrActive(actorId, saccosId) {
  const { membership, isPlatformAdmin } = await saccosCore.assertVisible(actorId, saccosId);
  if (isPlatformAdmin) return { membership: null };
  if (!membership || membership.status !== 'ACTIVE') throw createAppError('SACCOS_NOT_MEMBER');
  return { membership };
}

async function fetchRun(saccosId, runId) {
  const r = await pool.query('SELECT * FROM saccos_dividend_runs WHERE id = $1 AND saccos_id = $2', [runId, saccosId]);
  if (!r.rows.length) throw createAppError('SACCOS_DIV_RUN_NOT_FOUND');
  return r.rows[0];
}

async function eligibleHoldings(client, saccosId) {
  const r = await client.query(
    `SELECT h.member_id, h.share_count
     FROM saccos_share_holdings h
     JOIN saccos_members m ON m.id = h.member_id
     WHERE h.saccos_id = $1 AND m.status = 'ACTIVE' AND h.share_count > 0`,
    [saccosId]
  );
  return r.rows;
}

async function declareDividend(actorId, saccosId, { periodId, perShare, totalAmount, title }) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const saccos = await fetchActiveOrg(actorId, saccosId);
  dividendConfig(saccos);

  const period = await pool.query(
    'SELECT * FROM saccos_accounting_periods WHERE id = $1 AND saccos_id = $2',
    [periodId, saccosId]
  );
  if (!period.rows.length) throw createAppError('SACCOS_ACC_PERIOD_NOT_FOUND');
  if (period.rows[0].status !== 'CLOSED') throw createAppError('SACCOS_DIV_PERIOD_CLOSED');

  const used = await pool.query(
    'SELECT id FROM saccos_dividend_runs WHERE period_id = $1 AND saccos_id = $2',
    [periodId, saccosId]
  );
  if (used.rows.length) throw createAppError('SACCOS_DIV_PERIOD_USED');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const holdings = await eligibleHoldings(client, saccosId);
    if (!holdings.length) throw createAppError('SACCOS_DIV_NO_SHARES');
    const eligibleShares = holdings.reduce((s, h) => s + Number(h.share_count), 0);

    let perShareN;
    if (perShare !== undefined && perShare !== null) {
      perShareN = Number(perShare);
      if (!(perShareN > 0)) throw createAppError('SACCOS_DIV_PER_SHARE');
    } else {
      const totalN = Number(totalAmount);
      if (!(totalN > 0)) throw createAppError('SACCOS_DIV_TOTAL');
      perShareN = Math.floor((totalN / eligibleShares) * 100) / 100;
      if (!(perShareN > 0)) throw createAppError('SACCOS_DIV_PER_SHARE');
    }

    const totalN = Math.round(perShareN * eligibleShares * 100) / 100;
    const run = await client.query(
      `INSERT INTO saccos_dividend_runs (saccos_id, period_id, reference_id, title, per_share, total_amount, eligible_share_count, declared_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [saccosId, periodId, newRef('DIV'), title || null, perShareN, totalN, eligibleShares, actorId]
    );

    await client.query(
      `INSERT INTO saccos_dividend_payouts (saccos_id, run_id, member_id, share_count, amount, reference_id)
       SELECT $1, $2, h.member_id, h.share_count, h.share_count * $3, 'DIVP-' || UPPER(LEFT(md5(random()::text), 10))
       FROM saccos_share_holdings h
       JOIN saccos_members m ON m.id = h.member_id
       WHERE h.saccos_id = $1 AND m.status = 'ACTIVE' AND h.share_count > 0`,
      [saccosId, run.rows[0].id, perShareN]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_DIV_DECLARED', { referenceId: saccosId, details: { runId: run.rows[0].id, reference: run.rows[0].reference_id, perShare: perShareN, eligibleShares } }).catch(() => {});
    return { ...run.rows[0], per_share: Number(run.rows[0].per_share), total_amount: Number(run.rows[0].total_amount) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function distributeDividend(actorId, saccosId, runId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const run = await fetchRun(saccosId, runId);
  if (run.status !== 'DECLARED' && run.status !== 'DISTRIBUTED') throw createAppError('SACCOS_DIV_STATE');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO ledger_accounts (account_code, name, account_type)
       VALUES ($1, $2, 'EXPENSE') ON CONFLICT (account_code) DO NOTHING`,
      [dividendExpenseCode(saccosId), `SACCOS #${saccosId} Dividend Distributed`]
    );

    const payouts = await client.query(
      `SELECT p.*, m.user_id FROM saccos_dividend_payouts p
       JOIN saccos_members m ON m.id = p.member_id
       WHERE p.run_id = $1 AND p.status = 'PENDING' ORDER BY p.id`,
      [runId]
    );

    for (const payout of payouts.rows) {
      const amountN = Number(payout.amount);
      const ref = payout.reference_id;
      const userBefore = await client.query(`SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE`, [payout.user_id]);
      const before = Number(userBefore.rows[0].wallet_balance);
      const op = await fin.claimOperation({ client, operationType: 'SACCOS_DIVIDEND_PAYOUT', reference: ref, userId: payout.user_id, amount: amountN });
      if (!op.claimed) continue;
      await fin.postJournal({
        client,
        lines: [
          { accountCode: dividendExpenseCode(saccosId), direction: 'DR', amount: amountN },
          { accountCode: 'CUSTOMER_WALLET', direction: 'CR', amount: amountN },
        ],
        referenceId: ref, description: `SACCOS #${saccosId} dividend payout`, postedBy: 'saccos-dividends',
      });
      await client.query(`UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2`, [amountN, payout.user_id]);
      await fin.auditBalance({ client, accountKind: 'USER_BALANCE', accountId: payout.user_id, operation: 'dividend_payout', amount: amountN, balanceBefore: before, balanceAfter: before + amountN, reference: ref, actor: 'saccos-dividends' }).catch(() => {});
      await client.query(
        `UPDATE saccos_dividend_payouts SET status = 'PAID', paid_at = NOW() WHERE id = $1`,
        [payout.id]
      );
    }

    const stillPending = await client.query(
      'SELECT COUNT(*)::int AS n FROM saccos_dividend_payouts WHERE run_id = $1 AND status = $2',
      [runId, 'PENDING']
    );
    const status = stillPending.rows[0].n > 0 ? 'DECLARED' : 'DISTRIBUTED';
    const r = await client.query(
      `UPDATE saccos_dividend_runs SET status = $1, distributed_by = $2, distributed_at = NOW() WHERE id = $3 RETURNING *`,
      [status, actorId, runId]
    );
    const summary = await client.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'PAID'), 0)::numeric AS paid,
              COUNT(*) FILTER (WHERE status = 'PAID')::int AS paid_count,
              COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending_count
       FROM saccos_dividend_payouts WHERE run_id = $1`,
      [runId]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_DIV_DISTRIBUTED', { referenceId: saccosId, details: { runId, paid: summary.rows[0].paid_count } }).catch(() => {});
    return { ...r.rows[0], per_share: Number(r.rows[0].per_share), total_amount: Number(r.rows[0].total_amount), summary: { paid: Number(summary.rows[0].paid), paid_count: summary.rows[0].paid_count, pending_count: summary.rows[0].pending_count } };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function listRuns(actorId, saccosId) {
  await requireAdminOrActive(actorId, saccosId);
  const r = await pool.query('SELECT * FROM saccos_dividend_runs WHERE saccos_id = $1 ORDER BY declared_at DESC', [saccosId]);
  return r.rows.map((x) => ({ ...x, per_share: Number(x.per_share), total_amount: Number(x.total_amount) }));
}

async function listPayouts(actorId, saccosId, runId) {
  await requireAdminOrActive(actorId, saccosId);
  await fetchRun(saccosId, runId);
  const r = await pool.query(
    `SELECT p.*, m.member_number, u.full_name FROM saccos_dividend_payouts p
     JOIN saccos_members m ON m.id = p.member_id
     JOIN users u ON u.id = m.user_id
     WHERE p.run_id = $1 AND p.saccos_id = $2 ORDER BY p.amount DESC`,
    [runId, saccosId]
  );
  return r.rows.map((x) => ({ ...x, amount: Number(x.amount) }));
}

async function myDividends(actorId, saccosId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const r = await pool.query(
    `SELECT p.*, d.reference_id AS run_reference, d.title AS run_title, d.status AS run_status
     FROM saccos_dividend_payouts p
     JOIN saccos_dividend_runs d ON d.id = p.run_id
     WHERE p.member_id = $1 AND p.saccos_id = $2 ORDER BY p.created_at DESC`,
    [membership.id, saccosId]
  );
  return r.rows.map((x) => ({ ...x, amount: Number(x.amount) }));
}

async function dividendsSummary(actorId, saccosId) {
  await requireAdminOrActive(actorId, saccosId);
  const r = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'DECLARED')::int AS declared,
            COUNT(*) FILTER (WHERE status = 'DISTRIBUTED')::int AS distributed,
            COALESCE(SUM(total_amount) FILTER (WHERE status = 'DISTRIBUTED'), 0)::numeric AS distributed_total,
            (SELECT COUNT(*)::int FROM saccos_dividend_payouts p JOIN saccos_dividend_runs d ON d.id = p.run_id
              WHERE p.saccos_id = $1 AND p.status = 'PAID') AS paid_payouts
     FROM saccos_dividend_runs WHERE saccos_id = $1`,
    [saccosId]
  );
  return { ...r.rows[0], distributed_total: Number(r.rows[0].distributed_total) };
}

module.exports = {
  declareDividend,
  distributeDividend,
  listRuns,
  listPayouts,
  myDividends,
  dividendsSummary,
};