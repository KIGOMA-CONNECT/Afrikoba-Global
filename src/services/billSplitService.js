/**
 * Bill Split Service
 * Split bills among members.
 */

const pool = require('../config/db');
const { generateReference } = require('../utils/helpers');
const fin = require('./financialEngine');

async function createSplit(creatorId, { title, total_amount, participant_phones }) {
  if (!title || !total_amount || !participant_phones || participant_phones.length < 2) {
    throw new Error('Taarifa zote zinahitajika. Washirika 2+ wakihitajika.');
  }

  const total = parseFloat(total_amount);
  const count = participant_phones.length;
  const perPerson = Math.ceil(total / count * 100) / 100; // Round up to 2 decimals

  const split = await pool.query(
    `INSERT INTO bill_splits (creator_id, title, total_amount, split_count, per_person)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [creatorId, title, total, count, perPerson]
  );

  const splitId = split.rows[0].id;

  // Find user IDs for phones
  for (const phone of participant_phones) {
    const user = await pool.query(`SELECT id FROM users WHERE phone = $1`, [phone]);
    if (user.rows.length > 0) {
      await pool.query(
        `INSERT INTO bill_split_participants (split_id, user_id, amount_owed)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [splitId, user.rows[0].id, perPerson]
      );
    }
  }

  return split.rows[0];
}

async function getSplits(userId) {
  const created = await pool.query(
    `SELECT bs.*, 'CREATOR' AS role FROM bill_splits bs WHERE bs.creator_id = $1 ORDER BY bs.created_at DESC`,
    [userId]
  );
  const participating = await pool.query(
    `SELECT bs.*, 'PARTICIPANT' AS role, bsp.amount_owed, bsp.amount_paid, bsp.status AS my_status
     FROM bill_split_participants bsp
     JOIN bill_splits bs ON bsp.split_id = bs.id
     WHERE bsp.user_id = $1 ORDER BY bs.created_at DESC`,
    [userId]
  );
  return [...created.rows, ...participating.rows].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function getSplitDetail(splitId) {
  const split = await pool.query(`SELECT * FROM bill_splits WHERE id = $1`, [splitId]);
  if (split.rows.length === 0) throw new Error('Split haipatikani.');

  const participants = await pool.query(
    `SELECT bsp.*, u.phone, u.name
     FROM bill_split_participants bsp
     LEFT JOIN users u ON bsp.user_id = u.id
     WHERE bsp.split_id = $1`,
    [splitId]
  );

  return { split: split.rows[0], participants: participants.rows };
}

async function paySplit(splitId, userId, amount) {
  const participant = await pool.query(
    `SELECT * FROM bill_split_participants WHERE split_id = $1 AND user_id = $2`,
    [splitId, userId]
  );
  if (participant.rows.length === 0) throw new Error('Huwezi kulipa split hii.');

  const p = participant.rows[0];
  const remaining = parseFloat(p.amount_owed) - parseFloat(p.amount_paid);
  if (amount > remaining) amount = remaining;

  const newPaid = parseFloat(p.amount_paid) + amount;

  // Transfer from wallet to creator
  const split = await pool.query(`SELECT creator_id FROM bill_splits WHERE id = $1`, [splitId]);
  if (split.rows.length === 0) throw new Error('Split haipatikani.');
  const creatorId = split.rows[0].creator_id;

  const ref = generateReference('BS');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE bill_split_participants
       SET amount_paid = $1, status = CASE WHEN $1 >= amount_owed THEN 'PAID' ELSE 'PENDING' END,
           paid_at = CASE WHEN $1 >= amount_owed THEN NOW() ELSE paid_at END
       WHERE id = $2`,
      [newPaid, p.id]
    );

    // Check if split is complete
    const allPaid = await client.query(
      `SELECT COUNT(*)::int AS unpaid
       FROM bill_split_participants
       WHERE split_id = $1 AND status != 'PAID'`,
      [splitId]
    );

    if (allPaid.rows[0].unpaid === 0) {
      await client.query(`UPDATE bill_splits SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1`, [splitId]);
    } else {
      await client.query(`UPDATE bill_splits SET status = 'PARTIAL', updated_at = NOW() WHERE id = $1`, [splitId]);
    }

    await fin.internalTransfer({
      client, fromUserId: userId, toUserId: creatorId, amount,
      reference: ref, description: `Bill split payment for split ${splitId}`
    });

    await client.query(
      `INSERT INTO transactions (user_id, type, total_charged, commission, status, reference_id, meta)
       VALUES ($1, 'TRANSFER', $2, 0, 'SUCCESS', $3, $4)`,
      [userId, amount, ref, JSON.stringify({ split_id: splitId, type: 'BILL_SPLIT', unique: ref })]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  return { success: true, message: `Umelipa TSh ${amount.toLocaleString()}` };
}

module.exports = { createSplit, getSplits, getSplitDetail, paySplit };
