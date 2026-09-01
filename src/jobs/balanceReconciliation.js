/**
 * BALANCE RECONCILIATION ENGINE (Phase 5)
 * Runs periodically (daily) and on demand. Compares the authoritative
 * double-entry ledger against application projections and records every
 * check as a line item (MATCHED / MISSING / AMOUNT_MISMATCH) in a
 * reconciliation run.
 *
 * The north-star invariant is "reconciliation difference = 0". Any divergence
 * here means a financial event mutated a balance without a balanced journal
 * posting - surfaced, not silently absorbed.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');
const fin = require('../services/financialEngine');

// Map of ledger account -> how to derive its expected (projected) balance from
// application tables. Each projection returns a numeric balance.
const PROJECTIONS = {
  CUSTOMER_WALLET: {
    label: 'Sum users.wallet_balance (available customer stored funds)',
    sql: `SELECT COALESCE(SUM(wallet_balance),0)::numeric AS v FROM users`,
  },
  CARD_HOLD: {
    label: 'Sum users.locked_balance (authorized holds)',
    sql: `SELECT COALESCE(SUM(locked_balance),0)::numeric AS v FROM users`,
  },
  COMMISSION: {
    label: 'company_revenue.total_commission',
    sql: `SELECT COALESCE(SUM(total_commission),0)::numeric AS v FROM company_revenue`,
  },
  AGENT_BALANCE: {
    label: 'Sum agents.balance (agent float liability)',
    sql: `SELECT COALESCE(SUM(balance),0)::numeric AS v FROM agents`,
  },
  PARTNER_BALANCE: {
    label: 'Sum partners.balance (partner liability)',
    sql: `SELECT COALESCE(SUM(balance),0)::numeric AS v FROM partners`,
  },
  FAMILY_WALLET: {
    label: 'Sum family_wallets.balance (shared wallet liability)',
    sql: `SELECT COALESCE(SUM(balance),0)::numeric AS v FROM family_wallets`,
  },
  REFERRAL_REWARD: {
    label: 'Sum referral_rewards.reward_amount (paid referral expense)',
    sql: `SELECT COALESCE(SUM(reward_amount),0)::numeric AS v FROM referral_rewards`,
  },
};

/**
 * Net balance of a ledger account as recorded in the journal:
 *   ASSET/EXPENSE accounts:  balance = sum(DR) - sum(CR)
 *   LIABILITY/REVENUE/EQUITY: balance = sum(CR) - sum(DR)
 * A positive CUSTOMER_WALLET net is customer money we owe (liability);
 * a positive MNO_CLEARING net is mobile-money funds we hold (asset).
 */
async function journalBalance(client, accountCode) {
  const acct = await client.query(
    `SELECT account_type FROM ledger_accounts WHERE account_code = $1`, [accountCode]
  );
  if (acct.rows.length === 0) {
    throw new Error(`Unknown account ${accountCode} for reconciliation`);
  }
  const type = acct.rows[0].account_type;
  const r = await client.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DR'),0) dr,
            COALESCE(SUM(amount) FILTER (WHERE direction='CR'),0) cr
     FROM journal_entries je
     JOIN ledger_accounts la ON la.id = je.account_id
     WHERE la.account_code = $1`, [accountCode]
  );
  const { dr, cr } = r.rows[0];
  if (type === 'ASSET' || type === 'EXPENSE') {
    return Number(dr) - Number(cr);
  }
  return Number(cr) - Number(dr);
}

async function expectedBalance(client, accountCode, projection) {
  const r = await client.query(projection.sql);
  return Number(r.rows[0].v || 0);
}

/**
 * Run a full balance reconciliation. Returns the run summary.
 * @param {string} runType 'DAILY' | 'MANUAL'
 */
async function runBalanceReconciliation(runType = 'DAILY') {
  const client = await pool.connect();
  let runId = null;
  try {
    await client.query('BEGIN');

    // unique run-id for this execution (backed by a row we can fail safely with)
    const runInsert = await client.query(
      `INSERT INTO reconciliation_runs (run_type, status, started_at, ws_end)
       VALUES ($1,'RUNNING', NOW(), NOW()) RETURNING id`, [runType]
    );
    runId = runInsert.rows[0].id;

    let totalChecked = 0, totalMatched = 0, totalMissing = 0, totalDiff = 0;
    let aggregateDifference = 0;

    // Compare every projection account against its journal balance.
    for (const [accountCode, projection] of Object.entries(PROJECTIONS)) {
      const journalBal = await journalBalance(client, accountCode);
      let expectedBal = null;
      try {
        expectedBal = await expectedBalance(client, accountCode, projection);
      } catch (e) {
        // Projection source missing (e.g. no company_revenue row yet) -> MISSING.
        await client.query(
          `INSERT INTO reconciliation_line_items
             (run_id, account_code, balance_name, state, journal_balance, expected_balance, difference, detail)
           VALUES ($1,$2,$3,'MISSING',$4,0,0,$5::jsonb)`,
          [runId, accountCode, projection.label, journalBal,
           JSON.stringify({ reason: 'projection_source_unavailable', error: e.message })]
        );
        totalChecked += 1; totalMissing += 1;
        aggregateDifference += Math.abs(journalBal);
        continue;
      }

      const diff = journalBal - expectedBal;
      let state;
      if (Math.abs(journalBal) < 0.000001 && Math.abs(expectedBal) < 0.000001) state = 'MATCHED';
      else if (Math.abs(diff) > 0.01) state = 'AMOUNT_MISMATCH';
      else state = 'MATCHED';

      await client.query(
        `INSERT INTO reconciliation_line_items
           (run_id, account_code, balance_name, state, journal_balance, expected_balance, difference, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [runId, accountCode, projection.label, state, journalBal, expectedBal, diff,
         JSON.stringify({ journalBalance: journalBal, expectedBalance: expectedBal })]
      );

      totalChecked += 1;
      if (state === 'MATCHED') totalMatched += 1;
      else if (state === 'MISSING') totalMissing += 1;
      else totalDiff += 1;
      aggregateDifference += Math.abs(diff);

      // Any real mismatch is also surfaced as an OPEN reconciliation exception.
      if (state === 'AMOUNT_MISMATCH') {
        await client.query(
          `INSERT INTO reconciliation_exceptions (exception_type, reference_id, detail)
           VALUES ('BALANCE_MISMATCH', $1, $2::jsonb)
           ON CONFLICT DO NOTHING`,
          [`RECON-${accountCode}-${Date.now()}`,
           JSON.stringify({
             accountCode,
             journalBalance: journalBal,
             expectedBalance: expectedBal,
             difference: diff,
             runId,
           })]
        );
      }
    }

    // Run the stored financial invariants and record as extra line items.
    const invariants = await client.query('SELECT * FROM fn_financial_invariants()');
    for (const inv of invariants.rows) {
      totalChecked += 1;
      const state = inv.ok ? 'MATCHED' : 'AMOUNT_MISMATCH';
      if (inv.ok) totalMatched += 1; else { totalDiff += 1; aggregateDifference += 1; }
      await client.query(
        `INSERT INTO reconciliation_line_items
           (run_id, account_code, balance_name, state, journal_balance, expected_balance, difference, detail)
         VALUES ($1,$2,$3,$4,0,0,$5,$6::jsonb)`,
        [runId, inv.check_name, inv.note, state,
         inv.ok ? 0 : 1, JSON.stringify({ invariant: inv.check_name })]
      );
    }

    await client.query(
      `UPDATE reconciliation_runs
       SET status = CASE WHEN $2 > 0 THEN 'COMPLETE_WITH_DIFF' ELSE 'COMPLETE' END,
           finished_at = NOW(),
           total_checked = $3, total_matched = $4, total_missing = $5, total_diff = $6,
           difference = $7
       WHERE id = $1`,
      [runId, aggregateDifference, totalChecked, totalMatched, totalMissing, totalDiff, aggregateDifference]
    );

    await client.query('COMMIT');

    const summary = { runId, totalChecked, totalMatched, totalMissing, totalDiff, aggregateDifference };
    if (aggregateDifference > 0) {
      logger.warn('BALANCE_RECON', `Difference ${aggregateDifference} across ${runType} run #${runId}`);
      // Surface summary to exception stream for the dashboard/ops.
      await fin.recordException({
        type: 'BALANCE_RECON_DIFF',
        reference: `RECON-RUN-${runId}`,
        detail: summary,
      });
    } else {
      logger.info('BALANCE_RECON', `${runType} run #${runId} fully reconciled (0 difference)`);
    }
    return summary;
  } catch (error) {
    if (runId) {
      await client.query(
        `UPDATE reconciliation_runs SET status='FAILED', finished_at=NOW() WHERE id=$1`, [runId]
      ).catch(() => {});
    }
    await client.query('ROLLBACK').catch(() => {});
    logger.error('BALANCE_RECON', error.message);
    throw error;
  } finally {
    client.release();
  }
}

/** Get the latest reconciliation runs (for dashboards / ad-hoc checks). */
async function recentRuns(limit = 20) {
  const r = await pool.query(
    `SELECT id, run_type, started_at, finished_at, status, total_checked, total_matched,
            total_missing, total_diff, difference
     FROM reconciliation_runs ORDER BY started_at DESC LIMIT $1`, [limit]
  );
  return r.rows;
}

module.exports = { runBalanceReconciliation, recentRuns };
