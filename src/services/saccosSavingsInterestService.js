/**
 * SACCOS Digital Core - Savings Interest Accrual & Posting (increment 15).
 * Periodic interest on member savings, one cycle per calendar month.
 *
 *   prepareCycle (OWNER/BOARD): snapshots ACTIVE members with a positive
 *     savings balance into PENDING awards on a period-unique cycle at the
 *     configured annual rate `saccos.config.savings.interestRatePercent`
 *     (monthly = balance * rate/100 / 12, rounded to 2dp). Re-preparing the
 *     same month recomputes the awards (idempotent prep).
 *   postCycle (OWNER/BOARD): idempotent on an SVI-* claim - posts a balanced
 *     journal DR SACCOS<id>_SAVINGS_INTEREST_EXPENSE (EXPENSE) / CR
 *     SACCOS<id>_SAVINGS_LIABILITY (LIABILITY) totalling the awards, credits
 *     each member's account by their award (balance + 'INTEREST' APPROVED
 *     movement) and flips the cycle POSTED with posted_at/posted_by.
 *     total_interest = SUM of rounded awards so balances reconcile exactly
 *     to the liability.
 * All ACTIVE members can read their own interest history; ownership/bus
 * scoping matches the other SACCOS modules (403 RBAC / 404 cross-entity /
 * 403 platform ADMIN without membership).
 */
const pool = require('../config/db');
const crypto = require('crypto');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');
const fin = require('./financialEngine');
const saccosCore = require('./saccosService');

function interestExpenseCode(saccosId) {
  return `SACCOS${saccosId}_SAVINGS_INTEREST_EXPENSE`;
}
function savingsLiabilityCode(saccosId) {
  return `SACCOS${saccosId}_SAVINGS_LIABILITY`;
}
function newRef() {
  return 'SVI-' + crypto.randomBytes(5).toString('hex').toUpperCase();
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

async function ensureAccounts(client, saccosId) {
  await client.query(
    `INSERT INTO ledger_accounts (account_code, name, account_type)
     VALUES ($1, $2, 'EXPENSE') ON CONFLICT (account_code) DO NOTHING`,
    [interestExpenseCode(saccosId), `SACCOS #${saccosId} Savings Interest Expense`]
  );
  await client.query(
    `INSERT INTO ledger_accounts (account_code, name, account_type)
     VALUES ($1, $2, 'LIABILITY') ON CONFLICT (account_code) DO NOTHING`,
    [savingsLiabilityCode(saccosId), `SACCOS #${saccosId} Member Savings`]
  );
}

async function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

/** Snapshot the current month's interest awards from config rate. */
async function prepareCycle(actorId, saccosId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const saccos = await fetchActiveOrg(actorId, saccosId);
  const cfg = (saccos.config && saccos.config.savings) || {};
  const rate = Number(cfg.interestRatePercent || 0);
  if (!(rate > 0)) throw createAppError('SACCOS_SAVINGS_INTEREST_RATE');
  const period = await currentPeriod();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let cycleId;
    const existing = await client.query(
      `SELECT id, status FROM saccos_savings_interest_cycles WHERE saccos_id = $1 AND period = $2 FOR UPDATE`,
      [saccosId, period]
    );
    if (existing.rows.length) {
      if (existing.rows[0].status === 'POSTED') throw createAppError('SACCOS_SAVINGS_INTEREST_CYCLE_EXISTS');
      cycleId = existing.rows[0].id;
      await client.query('DELETE FROM saccos_savings_interest_awards WHERE cycle_id = $1', [cycleId]);
      await client.query('UPDATE saccos_savings_interest_cycles SET rate_percent = $1 WHERE id = $2', [rate, cycleId]);
    } else {
      const c = await client.query(
        `INSERT INTO saccos_savings_interest_cycles (saccos_id, period, rate_percent, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [saccosId, period, rate, actorId]
      );
      cycleId = c.rows[0].id;
    }
    const insert = await client.query(
      `INSERT INTO saccos_savings_interest_awards (cycle_id, member_id, account_id, basis_balance, interest)
       SELECT $1, a.member_id, a.id, a.balance, ROUND(a.balance * $2 / (100 * 12), 2)
       FROM saccos_savings_accounts a
       JOIN saccos_members m ON m.id = a.member_id
       WHERE a.saccos_id = $3 AND m.status = 'ACTIVE' AND a.balance > 0
       RETURNING id`,
      [cycleId, rate, saccosId]
    );
    const total = await client.query(
      `SELECT COALESCE(SUM(interest), 0)::numeric AS t FROM saccos_savings_interest_awards WHERE cycle_id = $1`,
      [cycleId]
    );
    await client.query('UPDATE saccos_savings_interest_cycles SET total_interest = $1 WHERE id = $2', [total.rows[0].t, cycleId]);
    const cycle = await client.query('SELECT * FROM saccos_savings_interest_cycles WHERE id = $1', [cycleId]);
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_SAVINGS_INTEREST_PREPARE', {
      referenceId: saccosId,
      details: { cycleId, period, rate, awards: insert.rows.length, total_interest: Number(total.rows[0].t) },
    }).catch(() => {});
    return { cycle: cycle.rows[0], awards: insert.rows.length, total_interest: Number(total.rows[0].t) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function fetchCycle(saccosId, cycleId) {
  const r = await pool.query(
    'SELECT * FROM saccos_savings_interest_cycles WHERE id = $1 AND saccos_id = $2',
    [cycleId, saccosId]
  );
  if (!r.rows.length) throw createAppError('SACCOS_SAVINGS_INTEREST_CYCLE_NOT_FOUND');
  return r.rows[0];
}

/** Post a PENDING cycle: journal + member credits + movements. */
async function postCycle(actorId, saccosId, cycleId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const cycle = await fetchCycle(saccosId, cycleId);
  if (cycle.status !== 'PENDING') throw createAppError('SACCOS_SAVINGS_INTEREST_STATE');
  const awards = await pool.query(
    'SELECT * FROM saccos_savings_interest_awards WHERE cycle_id = $1 ORDER BY id',
    [cycleId]
  );
  if (!awards.rows.length) throw createAppError('SACCOS_SAVINGS_INTEREST_NO_AWARDS');

  const reference = newRef();
  const total = Number(cycle.total_interest);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureAccounts(client, saccosId);
    const op = await fin.claimOperation({
      client, operationType: 'SACCOS_SAVINGS_INTEREST', reference, userId: actorId, amount: total,
    });
    if (!op.claimed) {
      await client.query('ROLLBACK');
      throw createAppError('SACCOS_SAVINGS_INTEREST_POSTED');
    }
    await fin.postJournal({
      client,
      lines: [
        { accountCode: interestExpenseCode(saccosId), direction: 'DR', amount: total },
        { accountCode: savingsLiabilityCode(saccosId), direction: 'CR', amount: total },
      ],
      referenceId: reference,
      description: `Riba ya amana SACCOS #${saccosId}`,
      postedBy: 'saccos:savings:interest',
    });
    for (const a of awards.rows) {
      await client.query(
        `UPDATE saccos_savings_accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
        [a.interest, a.account_id]
      );
      await client.query(
        `INSERT INTO saccos_savings_movements (saccos_id, member_id, account_id, reference_id, type, amount, status)
         VALUES ($1, $2, $3, $4, 'INTEREST', $5, 'APPROVED')`,
        [saccosId, a.member_id, a.account_id, reference, a.interest]
      );
      await client.query(
        `UPDATE saccos_savings_interest_awards SET status = 'POSTED', txn_reference = $1, posted_at = NOW() WHERE id = $2`,
        [reference, a.id]
      );
    }
    await client.query(
      `UPDATE saccos_savings_interest_cycles SET status = 'POSTED', total_interest = $1, posted_at = NOW(), posted_by = $2 WHERE id = $3`,
      [total, actorId, cycleId]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_SAVINGS_INTEREST_POST', {
      referenceId: saccosId,
      details: { cycleId, period: cycle.period, awards: awards.rows.length, total_interest: total, reference },
    }).catch(() => {});
    return { cycleId, reference, awards: awards.rows.length, total_interest: total };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** OWNER/BOARD cycle list with award counts. */
async function listCycles(actorId, saccosId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const r = await pool.query(
    `SELECT c.id, c.period, c.rate_percent, c.total_interest, c.status, c.posted_at,
            COUNT(ia.id)::int AS total_awards,
            COALESCE(COUNT(ia.id) FILTER (WHERE ia.status = 'POSTED'), 0)::int AS posted_awards
     FROM saccos_savings_interest_cycles c
     LEFT JOIN saccos_savings_interest_awards ia ON ia.cycle_id = c.id
     WHERE c.saccos_id = $1 GROUP BY c.id ORDER BY c.period DESC LIMIT 24`,
    [saccosId]
  );
  return r.rows.map((row) => ({ ...row, total_interest: Number(row.total_interest), rate_percent: Number(row.rate_percent) }));
}

/** OWNER/BOARD cycle detail (award roster). */
async function cycleDetail(actorId, saccosId, cycleId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const cycle = await fetchCycle(saccosId, cycleId);
  const awards = await pool.query(
    `SELECT ia.id, ia.member_id, ia.basis_balance, ia.interest, ia.status, ia.txn_reference, ia.posted_at,
            m.member_number, u.full_name
     FROM saccos_savings_interest_awards ia
     JOIN saccos_members m ON m.id = ia.member_id
     JOIN users u ON u.id = m.user_id
     WHERE ia.cycle_id = $1 ORDER BY u.full_name`,
    [cycleId]
  );
  return { cycle, awards: awards.rows };
}

/** Member reads own interest history. */
async function myInterest(actorId, saccosId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const r = await pool.query(
    `SELECT ia.id, ia.basis_balance, ia.interest, ia.status, ia.txn_reference, c.period, c.status AS cycle_status
     FROM saccos_savings_interest_awards ia
     JOIN saccos_savings_interest_cycles c ON c.id = ia.cycle_id
     WHERE ia.member_id = $1 AND c.saccos_id = $2 ORDER BY c.period DESC`,
    [membership.id, saccosId]
  );
  const posted = r.rows.filter((a) => a.status === 'POSTED').reduce((s, a) => s + Number(a.interest), 0);
  return { total_posted: posted, awards: r.rows.map((a) => ({ ...a, basis_balance: Number(a.basis_balance), interest: Number(a.interest) })) };
}

/** OWNER/BOARD summary for dashboards. */
async function interestSummary(actorId, saccosId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const saccos = await fetchActiveOrg(actorId, saccosId);
  const cfg = (saccos.config && saccos.config.savings) || {};
  const rate = Number(cfg.interestRatePercent || 0);
  const year = new Date().getFullYear();
  const r = await pool.query(
    `SELECT COALESCE(SUM(total_interest) FILTER (WHERE status = 'POSTED' AND period >= $2), 0)::numeric AS posted_this_year,
            COALESCE(SUM(total_interest) FILTER (WHERE status = 'PENDING'), 0)::numeric AS pending_total,
            COUNT(*) FILTER (WHERE status = 'POSTED')::int AS posted_cycles,
            COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending_cycles,
            MAX(posted_at) AS last_posted_at
     FROM saccos_savings_interest_cycles WHERE saccos_id = $1`,
    [saccosId, `${year}-01-01`]
  );
  const latest = await pool.query(
    `SELECT id, period, rate_percent, total_interest, status FROM saccos_savings_interest_cycles
     WHERE saccos_id = $1 ORDER BY period DESC LIMIT 1`,
    [saccosId]
  );
  return { rate, ...r.rows[0], pending_total: Number(r.rows[0].pending_total), posted_this_year: Number(r.rows[0].posted_this_year), latest: latest.rows[0] || null };
}

module.exports = {
  prepareCycle,
  postCycle,
  listCycles,
  cycleDetail,
  myInterest,
  interestSummary,
};