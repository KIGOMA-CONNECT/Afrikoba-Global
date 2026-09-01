/**
 * Savings Goals Service
 * Target-based saving with auto-save support.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');
const { generateReference } = require('../utils/helpers');
const fin = require('./financialEngine');

/**
 * Get all savings goals for user.
 */
async function getGoals(userId) {
  const result = await pool.query(
    `SELECT *, 
       CASE WHEN target_amount > 0 THEN ROUND((current_amount / target_amount * 100)::numeric, 1) ELSE 0 END AS progress_pct
     FROM savings_goals
     WHERE user_id = $1
     ORDER BY is_completed ASC, progress_pct DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * Create savings goal.
 */
async function createGoal(userId, { name, target_amount, deadline, icon, color, auto_save_amount, auto_save_frequency }) {
  if (target_amount <= 0) {
    throw new Error('Kikomo lazima kiwe chanya.');
  }

  const result = await pool.query(
    `INSERT INTO savings_goals (user_id, name, target_amount, deadline, icon, color, auto_save_amount, auto_save_frequency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [userId, name, target_amount, deadline || null, icon || 'target', color || '#4CAF50', auto_save_amount || null, auto_save_frequency || null]
  );

  return result.rows[0];
}

/**
 * Update savings goal.
 */
async function updateGoal(userId, goalId, updates) {
  const { name, target_amount, deadline, icon, color, auto_save_amount, auto_save_frequency } = updates;

  const result = await pool.query(
    `UPDATE savings_goals
     SET name = COALESCE($1, name),
         target_amount = COALESCE($2, target_amount),
         deadline = COALESCE($3, deadline),
         icon = COALESCE($4, icon),
         color = COALESCE($5, color),
         auto_save_amount = $6,
         auto_save_frequency = $7,
         updated_at = NOW()
     WHERE id = $8 AND user_id = $9 AND is_completed = FALSE
     RETURNING *`,
    [name, target_amount, deadline, icon, color, auto_save_amount || null, auto_save_frequency || null, goalId, userId]
  );

  return result.rows[0];
}

/**
 * Deposit to savings goal.
 */
async function deposit(userId, goalId, amount) {
  if (amount <= 0) throw new Error('Kiasi lazima kiwe chanya.');

  const goal = await pool.query(
    `SELECT * FROM savings_goals WHERE id = $1 AND user_id = $2 AND is_completed = FALSE`,
    [goalId, userId]
  );

  if (goal.rows.length === 0) {
    throw new Error('Lengo haipatikani au imeshakamilika.');
  }

  const g = goal.rows[0];

  const ref = generateReference('SGD');

  const newAmount = parseFloat(g.current_amount) + amount;
  const isCompleted = newAmount >= parseFloat(g.target_amount);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await fin.debitWallet({
      client, userId, amount, reference: ref,
      toAccount: 'SUSPENSE',
      description: `Savings goal deposit: ${g.name}`
    });

    const result = await client.query(
      `UPDATE savings_goals
       SET current_amount = $1, is_completed = $2, completed_at = CASE WHEN $2 THEN NOW() ELSE completed_at END, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [newAmount, isCompleted, goalId]
    );

    // Record transaction
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, status, description, category_id, reference_id)
       VALUES ($1, 'SAVINGS_DEPOSIT', $2, 'COMPLETED', $3, (SELECT id FROM spending_categories WHERE name = 'Savings'), $4)`,
      [userId, amount, `Akiba kwenye: ${g.name}`, ref]
    );

    if (isCompleted) {
      logger.info('SAVINGS', `Goal "${g.name}" completed by user ${userId}!`);
    }

    await client.query('COMMIT');
    return { goal: result.rows[0], isCompleted };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Withdraw from savings goal (only completed goals or partial).
 */
async function withdraw(userId, goalId, amount) {
  if (amount <= 0) throw new Error('Kiasi lazima kiwe chanya.');

  const goal = await pool.query(
    `SELECT * FROM savings_goals WHERE id = $1 AND user_id = $2`,
    [goalId, userId]
  );

  if (goal.rows.length === 0) {
    throw new Error('Lengo haipatikani.');
  }

  const g = goal.rows[0];
  if (parseFloat(g.current_amount) < amount) {
    throw new Error('Kikomo cha akiba haikitosha.');
  }

  const ref = generateReference('SGW');

  const newAmount = parseFloat(g.current_amount) - amount;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await fin.creditWallet({
      client, userId, amount, reference: ref,
      fromAccount: 'SUSPENSE',
      description: `Savings goal withdrawal: ${g.name}`
    });

    const result = await client.query(
      `UPDATE savings_goals
       SET current_amount = $1, is_completed = FALSE, completed_at = NULL, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [newAmount, goalId]
    );

    await client.query(
      `INSERT INTO transactions (user_id, type, amount, status, description, category_id, reference_id)
       VALUES ($1, 'SAVINGS_WITHDRAWAL', $2, 'COMPLETED', $3, (SELECT id FROM spending_categories WHERE name = 'Savings'), $4)`,
      [userId, amount, `Kutoa kutoka: ${g.name}`, ref]
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get savings summary.
 */
async function getSummary(userId) {
  const result = await pool.query(
    `SELECT 
       COUNT(*)::int AS total_goals,
       COUNT(*) FILTER (WHERE is_completed)::int AS completed,
       COALESCE(SUM(current_amount), 0)::numeric AS total_saved,
       COALESCE(SUM(target_amount), 0)::numeric AS total_target
     FROM savings_goals WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0];
}

module.exports = { getGoals, createGoal, updateGoal, deposit, withdraw, getSummary };
