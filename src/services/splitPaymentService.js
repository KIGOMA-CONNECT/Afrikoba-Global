const crypto = require('crypto');
const pool = require('../config/db');
const config = require('../config');
const { generateReference, formatMoney } = require('../utils/helpers');
const { enqueueOutbox } = require('./outboxService');
const logger = require('../utils/logger');
const fin = require('../services/financialEngine');
const { writeAudit } = require('./auditService');

const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_LEDGER_REFERENCE_LENGTH = 50; // journal_entries.reference_id VARCHAR(50)
const MAX_WALLET_AMOUNT = 9999999999999.99; // project_business_wallets NUMERIC(15,2)
const SPLIT_TRIGGERS = new Set(['CRON', 'MANUAL']);

/**
 * AUTOMATED SPLIT PAYMENT ENGINE
 * Mapato ya mradi yanapoingia kwenye Project Business Account:
 *   - Operational Bucket (70%) -> mjasiriamali
 *   - Investor Returns (28%)   -> wawekezaji kulingana na hisa
 *   - Platform Commission (2%) -> company_revenue
 */
async function runSplitPayment(projectId, periodMonth, periodYear, { actorUserId = null, trigger = 'CRON' } = {}) {
  if (!SPLIT_TRIGGERS.has(trigger)) throw new Error(`Split trigger si sahihi: ${trigger}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const projectRes = await client.query(
      `SELECT p.*, u.phone_number, u.full_name
       FROM investment_projects p JOIN users u ON u.id = p.owner_user_id
       WHERE p.id = $1 FOR UPDATE OF p`,
      [projectId]
    );
    const project = projectRes.rows[0];
    if (!project) throw Object.assign(new Error('Mradi haujapatikana.'), { statusCode: 404, code: 'PROJECT_NOT_FOUND' });

    const duplicate = await client.query(
      'SELECT 1 FROM revenue_split_runs WHERE project_id = $1 AND period_month = $2 AND period_year = $3',
      [projectId, periodMonth, periodYear]
    );
    if (duplicate.rows.length > 0) {
      await client.query('ROLLBACK');
      return { success: false, duplicate: true, message: 'Split ya mwezi huu tayari imefanyika.' };
    }

    const rulesRes = await client.query(
      'SELECT * FROM project_settlement_rules WHERE project_id = $1',
      [projectId]
    );
    const rules = rulesRes.rows[0] || {};

    const walletRes = await client.query(
      'SELECT * FROM project_business_wallets WHERE project_id = $1 FOR UPDATE',
      [projectId]
    );
    const wallet = walletRes.rows[0];
    if (!wallet || Number(wallet.total_revenue_collected) <= 0) {
      throw Object.assign(new Error('Hakuna mapato ya kugawa.'), { statusCode: 409, code: 'NO_REVENUE_TO_SPLIT' });
    }

    const totalRevenue = Number(wallet.total_revenue_collected);
    const opPct = parseFloat(rules.reinvestment_percentage ?? config.fees.operationalPercent) / 100;
    const invPct = parseFloat(rules.investor_payout_percentage ?? config.fees.investorPayoutPercent) / 100;
    const commPct = parseFloat(rules.platform_comm_percentage ?? config.fees.platformCommPercent) / 100;

    const operationalShare = Math.round(totalRevenue * opPct * 100) / 100;
    const investorShare = Math.round(totalRevenue * invPct * 100) / 100;
    const platformShare = Math.round((totalRevenue - operationalShare - investorShare) * 100) / 100;
    // A negative leg means the settlement rules exceed 100 %: refuse rather than
    // post a reversed leg. Zero legs are simply not posted (nothing to move).
    if (operationalShare < 0 || investorShare < 0 || platformShare < 0) {
      throw Object.assign(new Error('Kanuni za mgawanyo zinazidi 100% au si sahihi.'), { statusCode: 422 });
    }

    // 1. Operational -> wallet ya mjasiriamali
    if (operationalShare > 0) {
      const opRes = await fin.creditWallet({
        client,
        userId: project.owner_user_id,
        amount: Number(operationalShare),
        reference: `SPLIT:${projectId}:${periodYear}-${periodMonth}:OP`,
        fromAccount: 'SUSPENSE',
        description: 'Operational share split payout',
      });
      // The OP reference is unique per project and period; a dedup means the
      // owner was not credited by this run. Fail closed rather than recording
      // the run (and resetting collected revenue) without the owner's credit.
      if (opRes.dedup) {
        throw Object.assign(
          new Error(`Malipo ya mjasiriamali tayari yapo kwa kipindi hiki (${opRes.reference}).`),
          { statusCode: 409, code: 'SPLIT_OWNER_ALREADY_CREDITED' }
        );
      }
    }

    // 2. Investor Returns -> kwa wawekezaji kulingana na hisa zao.
    // One investor may hold several ACTIVE investment rows (repeat or auto-invest
    // purchases). The payout reference is per investor, so the rows are summed
    // per investor: one credit for all of the investor's shares.
    const investors = await client.query(
      `SELECT i.investor_user_id, SUM(i.shares_bought)::bigint AS shares_bought,
              u.full_name, u.phone_number
       FROM investments i
       JOIN users u ON u.id = i.investor_user_id
       WHERE i.project_id = $1 AND i.status = 'ACTIVE'
       GROUP BY i.investor_user_id, u.full_name, u.phone_number
       ORDER BY i.investor_user_id`,
      [projectId]
    );
    const investorRows = investors.rows.map((r) => ({ ...r, shares_bought: Number(r.shares_bought) }));
    const totalShares = investorRows.reduce((sum, inv) => sum + inv.shares_bought, 0);
    let investorsPaid = 0;
    let investorPaidTotal = 0;

    for (const inv of investorRows) {
      if (totalShares === 0 || investorShare === 0) break;
      const shareOfInvestor = Math.round((inv.shares_bought / totalShares) * investorShare * 100) / 100;
      if (shareOfInvestor <= 0) continue;

      const res = await fin.creditWallet({
        client,
        userId: inv.investor_user_id,
        amount: Number(shareOfInvestor),
        reference: `SPLIT:${projectId}:${periodYear}-${periodMonth}:INV:${inv.investor_user_id}`,
        fromAccount: 'SUSPENSE',
        description: 'Investor return split payout',
      });
      // The reference is unique per investor and period, so a dedup here means
      // the credit already exists outside this run: fail closed instead of
      // recording a SUCCESS payout row for money that was not credited now.
      if (res.dedup) {
        throw Object.assign(
          new Error(`Malipo ya mwekezaji tayari yapo kwa kipindi hiki (${res.reference}).`),
          { statusCode: 409, code: 'SPLIT_INVESTOR_ALREADY_CREDITED' }
        );
      }
      investorsPaid += 1;
      investorPaidTotal = Math.round((investorPaidTotal + shareOfInvestor) * 100) / 100;
      await client.query(
        `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
         VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'INVESTMENT_PAYOUT', $4)`,
        [generateReference('ROI'), inv.investor_user_id, shareOfInvestor, JSON.stringify({
          project_id: projectId,
          period: `${periodYear}-${periodMonth}`,
          // links the payout row to its credit / journal reference (reconciliation)
          split_reference: res.reference,
        })]
      );
      await enqueueOutbox({
        eventType: 'PROJECT_SPLIT_SMS',
        aggregateId: String(projectId),
        reference: `PROJECT_SPLIT_SMS:${projectId}:${periodYear}-${periodMonth}:INV:${inv.investor_user_id}`,
        payload: {
          phone: inv.phone_number,
          body: `Habari ${inv.full_name}, umepokea faida ya ${formatMoney(shareOfInvestor)} kutoka ${project.title} (${periodMonth}/${periodYear}).`,
        },
        tx: client,
      });
    }

    // 3. Platform Commission -> company_revenue (+ ledger: fund from the revenue
    //    booked into SUSPENSE at recordProjectRevenue time)
    if (platformShare > 0) {
      await fin.postJournal({
        client,
        lines: [
          { accountCode: 'SUSPENSE', direction: 'DR', amount: platformShare },
          { accountCode: 'PLATFORM_FEES', direction: 'CR', amount: platformShare },
        ],
        referenceId: `SPLIT:${projectId}:${periodYear}-${periodMonth}:PF`, description: 'Platform commission split from project revenue',
      });
      await client.query(
        `UPDATE company_revenue SET total_platform_fees = total_platform_fees + $1, updated_at = NOW() WHERE id = 1`,
        [platformShare]
      );
    }

    // 4. Rekodi ya split
    await client.query(
      `INSERT INTO revenue_split_runs
        (project_id, period_month, period_year, total_revenue, operational_share, investor_share, platform_share)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, periodMonth, periodYear, totalRevenue, operationalShare, investorShare, platformShare]
    );

    // 5. Reset Project Business Wallet (mapato yamegawanywa)
    await client.query(
      `UPDATE project_business_wallets
       SET total_revenue_collected = 0,
           operational_balance = operational_balance + $1,
           investor_reserved_balance = investor_reserved_balance + $2,
           platform_commission_balance = platform_commission_balance + $3
       WHERE project_id = $4`,
      [operationalShare, investorShare, platformShare, projectId]
    );

    await enqueueOutbox({
      eventType: 'PROJECT_SPLIT_SMS',
      aggregateId: String(projectId),
      reference: `PROJECT_SPLIT_SMS:${projectId}:${periodYear}-${periodMonth}:OWNER`,
      payload: {
        phone: project.phone_number,
        body: `Habari ${project.full_name}, mapato ya ${formatMoney(totalRevenue)} yamegawanywa: Wewe ${formatMoney(operationalShare)}, Wawekezaji ${formatMoney(investorShare)}, Jukwaa ${formatMoney(platformShare)}.`,
      },
      tx: client,
    });

    // Audit inside the transaction: the split and its audit row commit together.
    await writeAudit({
      client,
      userId: actorUserId,
      action: 'P2P_PROJECT_SPLIT_RUN',
      entityType: 'P2P_PROJECT',
      entityId: projectId,
      meta: {
        referenceId: `SPLIT:${projectId}:${periodYear}-${periodMonth}`,
        details: {
          trigger, periodMonth, periodYear, totalRevenue, operationalShare, investorShare, platformShare,
          investorsPaid, investorPaidTotal,
        },
      },
    });

    await client.query('COMMIT');


    logger.info('SPLIT', `Project ${projectId}: ${formatMoney(totalRevenue)} imegawanywa`, {
      operationalShare,
      investorShare,
      platformShare,
    });
    return { success: true, operationalShare, investorShare, platformShare };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Ingiza mapato ya mradi kwenye Project Business Wallet
 */
async function recordProjectRevenue(projectId, amount, description, { actorUserId = null, idempotencyKey = null } = {}) {
  // The amount must be exactly representable by project_business_wallets
  // (NUMERIC(15,2)); the journal keeps 4 decimals, so a sub-cent amount would
  // leave the wallet and the ledger with different values.
  const amountRaw = typeof amount === 'string' ? amount.trim() : amount;
  const amountParsed = amountRaw === '' || amountRaw === null || amountRaw === undefined ? NaN : Number(amountRaw);
  const cents = amountParsed * 100;
  if (!Number.isFinite(amountParsed) || amountParsed <= 0 || amountParsed > MAX_WALLET_AMOUNT
      || Math.abs(cents - Math.round(cents)) > 1e-6) {
    throw Object.assign(new Error('Kiasi cha mapato si sahihi.'), { statusCode: 400, code: 'INVALID_REVENUE_AMOUNT' });
  }
  const amountNum = Math.round(cents) / 100;
  let keyedRef = null;
  if (idempotencyKey !== null && idempotencyKey !== undefined && idempotencyKey !== '') {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw Object.assign(new Error('Idempotency-Key si sahihi.'), { statusCode: 400 });
    }
    // Durable per-project key: same declaration replayed -> recorded once.
    // 32 hex (128 bits) keeps the reference within journal_entries.reference_id
    // (VARCHAR(50)) for every int4 project id: 'REV:' + 10 + ':K:' + 32 = 49.
    const digest = crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
    keyedRef = `REV:${projectId}:K:${digest}`;
    if (keyedRef.length > MAX_LEDGER_REFERENCE_LENGTH) {
      throw Object.assign(new Error('Mradi si sahihi.'), { statusCode: 400 });
    }
  }
  if (!keyedRef) {
    // Observability only (no behaviour change): a keyless declaration cannot be
    // de-duplicated on retry. Counts towards the mandatory-key decision (C4B-4).
    logger.warn('REVENUE_NO_IDEMPOTENCY_KEY', 'Project revenue recorded without Idempotency-Key', { projectId, actorUserId });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (keyedRef) {
      // Claims the key before any mutation; a concurrent duplicate waits on the
      // unique reference and then sees it as already claimed. A reused key with
      // a different amount raises OPERATION_SHAPE_MISMATCH (409).
      const op = await fin.claimOperation({
        client, operationType: 'PROJECT_REVENUE', reference: keyedRef, amount: amountNum, validateShape: true,
      });
      if (!op.claimed) {
        await client.query('ROLLBACK');
        const current = await pool.query('SELECT * FROM project_business_wallets WHERE project_id = $1', [projectId]);
        return { ...(current.rows[0] || {}), replay: true, reference: keyedRef };
      }
    }
    let result;
    try {
      result = await client.query(
        `UPDATE project_business_wallets
         SET total_revenue_collected = total_revenue_collected + $1
         WHERE project_id = $2 RETURNING *`,
        [amountNum, projectId]
      );
    } catch (e) {
      // numeric_value_out_of_range: accumulated total exceeds NUMERIC(15,2)
      if (e.code === '22003') {
        throw Object.assign(new Error('Jumla ya mapato inazidi kikomo cha hifadhi.'), { statusCode: 422, code: 'REVENUE_TOTAL_OVERFLOW' });
      }
      throw e;
    }
    if (result.rows.length === 0) {
      throw Object.assign(new Error('Project Business Wallet haijapatikana.'), { statusCode: 404, code: 'PROJECT_WALLET_NOT_FOUND' });
    }
    const ref = keyedRef || `REV:${projectId}:${Date.now()}`;
    await fin.postJournal({
      client,
      lines: [
        { accountCode: 'MNO_CLEARING', direction: 'DR', amount: amountNum },
        { accountCode: 'SUSPENSE', direction: 'CR', amount: amountNum },
      ],
      referenceId: ref, description: `Project revenue booked into suspense (${description || 'sales'})`,
    });
    if (keyedRef) await fin.setOperationState({ client, reference: keyedRef, status: 'SUCCESS' });
    await writeAudit({
      client,
      userId: actorUserId,
      action: 'P2P_PROJECT_REVENUE_RECORDED',
      entityType: 'P2P_PROJECT',
      entityId: projectId,
      meta: { referenceId: ref, amount: amountNum, details: { description: description || null, idempotent: !!keyedRef } },
    });
    await client.query('COMMIT');
    logger.info('REVENUE', `Project ${projectId} mapato +${amountNum}`, { description, reference: ref });
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run split payments kwa miradi yote iliyo na mapato (inayoitwa na Cron ya kila mwezi)
 */
async function runDueSplitPayments() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const result = await pool.query(
    `SELECT pw.project_id FROM project_business_wallets pw
     WHERE pw.total_revenue_collected > 0`
  );
  const processed = [];
  for (const row of result.rows) {
    try {
      const res = await runSplitPayment(row.project_id, month, year, { trigger: 'CRON' });
      if (res.success) processed.push(row.project_id);
    } catch (e) {
      logger.error('SPLIT-CRON', `Project ${row.project_id}: ${e.message}`);
    }
  }
  return { processed };
}

/**
 * READ-ONLY split payout integrity check (R24-07). Not scheduled; writes nothing.
 *
 * For every revenue_split_runs row of a project (or one period) it compares,
 * by reference and direction only (no account classification):
 *   - each investor credit operation SPLIT:<p>:<y>-<m>:INV:<uid> (SUCCESS)
 *     with its journal (DR total == CR total == operation amount) and with the
 *     SUCCESS INVESTMENT_PAYOUT rows of that user/project/period (exactly one,
 *     same amount);
 *   - payout rows without an investor credit;
 *   - run legs (OP / Σ INV / PF) with the posted operations / journal, and
 *     OP + INV + PF with total_revenue;
 *   - investor share not allocated beyond rounding (0.005 per credited
 *     investor) is REPORTED with its amount; what it means is an accounting
 *     question (AS-B1-res) and is not decided here;
 *   - split operations whose period has no run row.
 */
const CENT_TOLERANCE = 0.005;

async function verifySplitIntegrity({ projectId, periodMonth = null, periodYear = null } = {}) {
  const pid = Number(projectId);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw Object.assign(new Error('Mradi si sahihi.'), { statusCode: 400, code: 'INVALID_PROJECT_ID' });
  }
  const anomalies = [];
  const add = (a) => anomalies.push(a);
  const neq = (a, b) => Math.abs(Number(a) - Number(b)) >= CENT_TOLERANCE;
  const r2 = (v) => Math.round(Number(v) * 100) / 100;
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const runs = (await client.query(
      `SELECT period_month, period_year, total_revenue, operational_share, investor_share, platform_share
         FROM revenue_split_runs
        WHERE project_id = $1 AND ($2::int IS NULL OR period_month = $2) AND ($3::int IS NULL OR period_year = $3)
        ORDER BY period_year, period_month`,
      [pid, periodMonth, periodYear]
    )).rows;

    for (const run of runs) {
      const period = `${run.period_year}-${run.period_month}`;
      const base = `SPLIT:${pid}:${period}`;
      const ops = (await client.query(
        `SELECT reference_id, user_id, amount, status FROM financial_operations
          WHERE left(reference_id, $2) = $1`, [`${base}:`, base.length + 1])).rows;
      const journal = (await client.query(
        `SELECT reference_id,
                COALESCE(SUM(amount) FILTER (WHERE direction = 'DR'), 0) AS dr,
                COALESCE(SUM(amount) FILTER (WHERE direction = 'CR'), 0) AS cr
           FROM journal_entries WHERE left(reference_id, $2) = $1 GROUP BY reference_id`,
        [`${base}:`, base.length + 1])).rows;
      const jByRef = new Map(journal.map((j) => [j.reference_id, j]));
      const payouts = (await client.query(
        `SELECT id, user_id, wallet_amount, meta FROM transactions
          WHERE type = 'INVESTMENT_PAYOUT' AND status = 'SUCCESS'
            AND meta->>'project_id' = $1 AND meta->>'period' = $2`, [String(pid), period])).rows;

      const checkJournal = (ref, amount) => {
        const j = jByRef.get(ref);
        if (!j || neq(j.dr, j.cr) || neq(j.cr, amount)) {
          add({ type: 'JOURNAL_MISMATCH', period, reference: ref, expected: r2(amount), actual: j ? { dr: r2(j.dr), cr: r2(j.cr) } : null });
        }
      };

      // investor credits
      const invOps = ops.filter((o) => o.reference_id.startsWith(`${base}:INV:`));
      let paid = 0;
      const creditedUsers = new Set();
      for (const op of invOps) {
        const uid = Number(op.user_id);
        if (op.status !== 'SUCCESS') {
          add({ type: 'OPERATION_NOT_SUCCESS', period, reference: op.reference_id, actual: op.status });
          continue;
        }
        creditedUsers.add(uid);
        paid += Number(op.amount);
        checkJournal(op.reference_id, op.amount);
        const rows = payouts.filter((p) => Number(p.user_id) === uid);
        if (rows.length === 0) add({ type: 'PAYOUT_ROW_MISSING', period, reference: op.reference_id, userId: uid, expected: r2(op.amount) });
        if (rows.length > 1) add({ type: 'PAYOUT_ROW_DUPLICATE', period, reference: op.reference_id, userId: uid, actual: rows.length, rowIds: rows.map((p) => p.id) });
        for (const p of rows) {
          if (neq(p.wallet_amount, op.amount)) {
            add({ type: 'PAYOUT_AMOUNT_MISMATCH', period, reference: op.reference_id, userId: uid, expected: r2(op.amount), actual: r2(p.wallet_amount), rowId: p.id });
          }
          if (p.meta && p.meta.split_reference && p.meta.split_reference !== op.reference_id) {
            add({ type: 'PAYOUT_REFERENCE_MISMATCH', period, reference: op.reference_id, userId: uid, actual: p.meta.split_reference, rowId: p.id });
          }
        }
      }
      for (const p of payouts) {
        if (!creditedUsers.has(Number(p.user_id))) {
          add({ type: 'PAYOUT_ROW_WITHOUT_CREDIT', period, userId: Number(p.user_id), actual: r2(p.wallet_amount), rowId: p.id });
        }
      }

      // OP leg
      const opRef = `${base}:OP`;
      const opOp = ops.find((o) => o.reference_id === opRef);
      if (Number(run.operational_share) > 0) {
        if (!opOp || opOp.status !== 'SUCCESS' || neq(opOp.amount, run.operational_share)) {
          add({ type: 'RUN_LEG_MISMATCH', period, leg: 'OP', reference: opRef, expected: r2(run.operational_share), actual: opOp ? { amount: r2(opOp.amount), status: opOp.status } : null });
        } else {
          checkJournal(opRef, opOp.amount);
        }
      } else if (opOp) {
        add({ type: 'RUN_LEG_MISMATCH', period, leg: 'OP', reference: opRef, expected: 0, actual: { amount: r2(opOp.amount), status: opOp.status } });
      }

      // PF leg (journal only)
      const pfRef = `${base}:PF`;
      const pf = jByRef.get(pfRef);
      const pfPosted = pf ? Number(pf.dr) : 0;
      if (neq(pfPosted, run.platform_share) || (pf && neq(pf.dr, pf.cr))) {
        add({ type: 'RUN_LEG_MISMATCH', period, leg: 'PF', reference: pfRef, expected: r2(run.platform_share), actual: pf ? { dr: r2(pf.dr), cr: r2(pf.cr) } : null });
      }

      // INV leg vs run
      const residual = r2(Number(run.investor_share) - paid);
      const tolerance = CENT_TOLERANCE * Math.max(1, creditedUsers.size) + 1e-9;
      if (residual < -tolerance) {
        add({ type: 'RUN_LEG_MISMATCH', period, leg: 'INV', reference: `${base}:INV`, expected: r2(run.investor_share), actual: r2(paid) });
      } else if (residual > tolerance) {
        add({ type: 'INVESTOR_SHARE_UNALLOCATED', period, reference: `${base}:INV`, amount: residual, investorsCredited: creditedUsers.size });
      }

      // run arithmetic
      const legs = Number(run.operational_share) + Number(run.investor_share) + Number(run.platform_share);
      if (neq(legs, run.total_revenue)) {
        add({ type: 'RUN_TOTAL_MISMATCH', period, reference: base, expected: r2(run.total_revenue), actual: r2(legs) });
      }
    }

    // split operations whose period has no run row
    const opPeriods = (await client.query(
      `SELECT DISTINCT split_part(reference_id, ':', 3) AS period FROM financial_operations
        WHERE left(reference_id, $2) = $1`, [`SPLIT:${pid}:`, `SPLIT:${pid}:`.length])).rows.map((r) => r.period);
    const runPeriods = new Set((await client.query(
      'SELECT period_year, period_month FROM revenue_split_runs WHERE project_id = $1', [pid]
    )).rows.map((r) => `${r.period_year}-${r.period_month}`));
    for (const period of opPeriods) {
      const [y, m] = period.split('-').map(Number);
      if (periodMonth !== null && (m !== Number(periodMonth) || y !== Number(periodYear))) continue;
      if (!runPeriods.has(period)) add({ type: 'OPERATION_WITHOUT_RUN', period, reference: `SPLIT:${pid}:${period}` });
    }

    await client.query('COMMIT');
    return { ok: anomalies.length === 0, projectId: pid, runs: runs.length, anomalies };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { runSplitPayment, recordProjectRevenue, runDueSplitPayments, verifySplitIntegrity };
