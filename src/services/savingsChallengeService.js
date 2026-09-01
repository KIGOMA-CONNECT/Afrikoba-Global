/**
 * Savings Challenge Service
 * Group savings challenges with streaks and leaderboards.
 */

const pool = require('../config/db');
const { generateReference } = require('../utils/helpers');
const fin = require('./financialEngine');

async function createChallenge(creatorId, { name, target_amount, start_date, end_date, frequency, per_contribution }) {
  if (!name || !target_amount || !start_date || !end_date || !frequency || !per_contribution) {
    throw new Error('Taarifa zote zinahitajika.');
  }

  const result = await pool.query(
    `INSERT INTO savings_challenges (creator_id, name, target_amount, start_date, end_date, frequency, per_contribution)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [creatorId, name, target_amount, start_date, end_date, frequency, per_contribution]
  );

  // Auto-join creator
  await pool.query(
    `INSERT INTO savings_challenge_members (challenge_id, user_id) VALUES ($1, $2)`,
    [result.rows[0].id, creatorId]
  );

  return result.rows[0];
}

async function joinChallenge(userId, challengeId) {
  const challenge = await pool.query(`SELECT * FROM savings_challenges WHERE id = $1 AND status = 'ACTIVE'`, [challengeId]);
  if (challenge.rows.length === 0) throw new Error('Change haipatikani au imeisha.');

  const existing = await pool.query(
    `SELECT id FROM savings_challenge_members WHERE challenge_id = $1 AND user_id = $2`,
    [challengeId, userId]
  );
  if (existing.rows.length > 0) throw new Error('Umeshajiunga.');

  const result = await pool.query(
    `INSERT INTO savings_challenge_members (challenge_id, user_id) VALUES ($1, $2) RETURNING *`,
    [challengeId, userId]
  );
  return result.rows[0];
}

async function contribute(challengeId, userId, amount) {
  const challenge = await pool.query(`SELECT * FROM savings_challenges WHERE id = $1 AND status = 'ACTIVE'`, [challengeId]);
  if (challenge.rows.length === 0) throw new Error('Change haipatikani.');

  const member = await pool.query(
    `SELECT * FROM savings_challenge_members WHERE challenge_id = $1 AND user_id = $2`,
    [challengeId, userId]
  );
  if (member.rows.length === 0) throw new Error('Huwezi kuchangia. Hujaungana bado.');

  const ref = generateReference('SCC');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await fin.debitWallet({
      client, userId, amount, reference: ref,
      toAccount: 'SUSPENSE',
      description: `Savings challenge contribution to challenge ${challengeId}`
    });

    const dayNumber = parseInt(member.rows[0].contributions_count) + 1;

    await client.query(
      `INSERT INTO challenge_contributions (challenge_id, user_id, amount, day_number) VALUES ($1, $2, $3, $4)`,
      [challengeId, userId, amount, dayNumber]
    );

    // Update member
    const newStreak = parseInt(member.rows[0].streak) + 1;
    const newBestStreak = Math.max(newStreak, parseInt(member.rows[0].best_streak));

    await client.query(
      `UPDATE savings_challenge_members
       SET total_contributed = total_contributed + $1, contributions_count = contributions_count + 1,
           streak = $2, best_streak = $3
       WHERE challenge_id = $4 AND user_id = $5`,
      [amount, newStreak, newBestStreak, challengeId, userId]
    );

    // Update challenge total
    await client.query(
      `UPDATE savings_challenges SET current_amount = current_amount + $1, updated_at = NOW() WHERE id = $2`,
      [amount, challengeId]
    );

    // Check if challenge complete
    const updated = await client.query(`SELECT current_amount, target_amount FROM savings_challenges WHERE id = $1`, [challengeId]);
    if (parseFloat(updated.rows[0].current_amount) >= parseFloat(updated.rows[0].target_amount)) {
      await client.query(`UPDATE savings_challenges SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1`, [challengeId]);
    }

    await client.query(
      `INSERT INTO transactions (user_id, type, total_charged, commission, status, reference_id, meta)
       VALUES ($1, 'WITHDRAWAL', $2, 0, 'SUCCESS', $3, $4)`,
      [userId, amount, ref, JSON.stringify({ type: 'SAVINGS_CHALLENGE', challenge_id: challengeId })]
    );

    await client.query('COMMIT');
    return { success: true, streak: newStreak, dayNumber };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getChallenges(userId) {
  const myChallenges = await pool.query(
    `SELECT sc.*, scm.total_contributed, scm.streak, scm.contributions_count
     FROM savings_challenge_members scm
     JOIN savings_challenges sc ON scm.challenge_id = sc.id
     WHERE scm.user_id = $1
     ORDER BY sc.created_at DESC`,
    [userId]
  );
  return myChallenges.rows;
}

async function getLeaderboard(challengeId) {
  const result = await pool.query(
    `SELECT scm.*, u.phone, u.name
     FROM savings_challenge_members scm
     LEFT JOIN users u ON scm.user_id = u.id
     WHERE scm.challenge_id = $1
     ORDER BY scm.total_contributed DESC`,
    [challengeId]
  );
  return result.rows;
}

module.exports = { createChallenge, joinChallenge, contribute, getChallenges, getLeaderboard };
