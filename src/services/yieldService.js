/**
 * Yield Service
 * Handles calculation and payout logic for Afrikoba Yield plans.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');
const fin = require('../services/financialEngine');

async function processYieldPayouts() {
  logger.info('YIELD', 'Starting automated yield payout job...');
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get all active investments due for payout
    const dueInvestments = await client.query(
      `SELECT id, user_id, monthly_payout_amount 
       FROM user_investments 
       WHERE status = 'ACTIVE' AND next_payout_date <= NOW()`
    );

    for (const inv of dueInvestments.rows) {
      // 1. Credit user wallet
      await fin.creditWallet({
        client,
        userId: inv.user_id,
        amount: Number(inv.monthly_payout_amount),
        reference: `YIELD:${inv.id}:CR`,
        fromAccount: 'INTEREST_INCOME',
        description: 'Yield interest payout',
      });

      // 2. Log payout
      await client.query(
        'INSERT INTO yield_payout_logs (investment_id, user_id, amount_paid) VALUES ($1, $2, $3)',
        [inv.id, inv.user_id, inv.monthly_payout_amount]
      );

      // 3. Update next payout date
      await client.query(
        `UPDATE user_investments 
         SET next_payout_date = next_payout_date + INTERVAL '1 month'
         WHERE id = $1`,
        [inv.id]
      );
    }

    // 4. Handle matured investments
    await client.query(
      `UPDATE user_investments 
       SET status = 'MATURED' 
       WHERE status = 'ACTIVE' AND maturity_date <= NOW()`
    );

    await client.query('COMMIT');
    logger.info('YIELD', `Processed ${dueInvestments.rows.length} payouts.`);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('YIELD_JOB_ERROR', err.message);
  } finally {
    client.release();
  }
}

module.exports = { processYieldPayouts };