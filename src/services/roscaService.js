const pool = require('../config/db');
const config = require('../config');
const { generateReference, formatMoney } = require('../utils/helpers');
const { sendSMS } = require('./smsService');
const { triggerPayout } = require('./azampayService');
const logger = require('../utils/logger');

async function createPool(userId, { poolName, contributionAmount, cycleFrequency, totalMembers, poolType }) {
  if (parseInt(totalMembers, 10) < 3) {
    throw Object.assign(new Error('Kikoba kinahitaji angalau wanachama 3.'), { statusCode: 400 });
  }
  if (parseFloat(contributionAmount) <= 0) {
    throw Object.assign(new Error('Kiasi cha mchango lazima kiwe kubwa kuliko 0.'), { statusCode: 400 });
  }
  const result = await pool.query(
    `INSERT INTO rosca_pools
      (pool_name, contribution_amount, cycle_frequency, total_members, pool_type, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [poolName, contributionAmount, cycleFrequency, totalMembers, poolType || 'PUBLIC', userId]
  );
  return result.rows[0];
}

/**
 * Join Pool - kwa PUBLIC pools:
 * - wanachama wapya wanapewa namba za katikati/mwisho (si Namba 1/2)
 * - Trust Score ya juu inaruhusu namba za mwanzo
 * - Locked Collateral Deposit kwa wale wanaotaka namba za mwanzo
 */
async function joinPool(userId, poolId, opts = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const poolRes = await client.query('SELECT * FROM rosca_pools WHERE id = $1 FOR UPDATE', [poolId]);
    if (poolRes.rows.length === 0) throw Object.assign(new Error('Pool haijapatikana.'), { statusCode: 404 });
    const rosca = poolRes.rows[0];
    if (rosca.status !== 'WAITING_MEMBERS') {
      throw Object.assign(new Error('Pool hii haikubali wanachama tena.'), { statusCode: 400 });
    }

    const userRes = await client.query(
      'SELECT id, trust_score, wallet_balance, locked_balance, full_name, phone_number FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    const user = userRes.rows[0];

    const existing = await client.query(
      'SELECT 1 FROM rosca_members WHERE pool_id = $1 AND user_id = $2',
      [poolId, userId]
    );
    if (existing.rows.length > 0) {
      throw Object.assign(new Error('Tayari umejiunga na pool hii.'), { statusCode: 400 });
    }

    const countRes = await client.query(
      'SELECT COUNT(*)::int AS cnt FROM rosca_members WHERE pool_id = $1',
      [poolId]
    );
    const currentCount = countRes.rows[0].cnt;
    if (currentCount >= rosca.total_members) {
      throw Object.assign(new Error('Pool imejaa.'), { statusCode: 400 });
    }

    let queueNumber = null;
    const isPublic = rosca.pool_type === 'PUBLIC';
    const wantsEarlySlot = opts.wantEarlySlot === true || opts.queueNumber === 1 || opts.queueNumber === 2;

    if (opts.queueNumber) {
      queueNumber = opts.queueNumber;
    } else if (!isPublic) {
      queueNumber = currentCount + 1;
    } else {
      const base = currentCount + 1;
      if (wantsEarlySlot && base <= 2 && user.trust_score >= 90) {
        queueNumber = base;
      } else {
        queueNumber = Math.max(base, Math.min(rosca.total_members, base + 2));
      }
    }

    // Locked Collateral kwa namba 1 & 2 (PUBLIC pools)
    if (isPublic && (queueNumber === 1 || queueNumber === 2) && wantsEarlySlot) {
      const collateral = Math.round(rosca.contribution_amount * (rosca.locked_collateral_percent / 100) * 100) / 100;
      if (Number(user.wallet_balance) < collateral) {
        throw Object.assign(new Error(`Unahitaji Locked Collateral ya ${formatMoney(collateral)} kwenye wallet kupata namba hii.`), { statusCode: 400 });
      }
      await client.query(
        'UPDATE users SET wallet_balance = wallet_balance - $1, locked_balance = locked_balance + $1 WHERE id = $2',
        [collateral, userId]
      );
      await client.query(
        `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
         VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'ROSCA_LOCK', $4)`,
        [generateReference('RL'), userId, collateral, JSON.stringify({ pool_id: poolId, queue_number: queueNumber })]
      );
    }

    await client.query(
      `INSERT INTO rosca_members (pool_id, user_id, assigned_queue_number)
       VALUES ($1, $2, $3)`,
      [poolId, userId, queueNumber]
    );

    const msg = `Habari ${user.full_name}, umejiunga na ${rosca.pool_name}. Namba yako ya mzunguko: ${queueNumber}. Mchango: ${formatMoney(rosca.contribution_amount)}`;
    await sendSMS(user.phone_number, msg);

    if (currentCount + 1 >= rosca.total_members) {
      await activatePool(client, rosca);
    }

    await client.query('COMMIT');
    return { success: true, queueNumber, message: `Umejiunga. Namba yako: ${queueNumber}` };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Pool ikijaa - tengeneza rosca_schedules kwa kila mzunguko
 */
async function activatePool(client, rosca) {
  const members = await client.query(
    `SELECT user_id, assigned_queue_number FROM rosca_members
     WHERE pool_id = $1 ORDER BY assigned_queue_number ASC`,
    [rosca.id]
  );

  const totalCycles = members.rows.length;
  for (let cycle = 1; cycle <= totalCycles; cycle++) {
    const recipient = members.rows.find((m) => m.assigned_queue_number === cycle);
    if (!recipient) continue;
    const scheduledDate = new Date();
    const cycleIndex = cycle - 1;
    if (rosca.cycle_frequency === 'WEEKLY') scheduledDate.setDate(scheduledDate.getDate() + cycleIndex * 7);
    else scheduledDate.setMonth(scheduledDate.getMonth() + cycleIndex);

    const totalPayout = Math.round(rosca.contribution_amount * rosca.total_members * 100) / 100;
    const commAmount = Math.round(totalPayout * 0.01 * 100) / 100;

    await client.query(
      `INSERT INTO rosca_schedules
        (pool_id, cycle_number, recipient_user_id, scheduled_date, contribution_amount, total_payout_amount, comm_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [rosca.id, cycle, recipient.user_id, scheduledDate, rosca.contribution_amount, totalPayout, commAmount]
    );
  }

  await client.query('UPDATE rosca_pools SET status = $1, current_cycle = 1 WHERE id = $2', ['ACTIVE', rosca.id]);
  logger.info('ROSCA', `Pool ${rosca.pool_name} imeanza (${totalCycles} cycles)`);
}

async function listPools(status) {
  const result = await pool.query(
    `SELECT p.*,
            (SELECT COUNT(*) FROM rosca_members rm WHERE rm.pool_id = p.id)::int AS current_members
     FROM rosca_pools p
     WHERE ($1::varchar IS NULL OR p.status = $1)
     ORDER BY p.created_at DESC`,
    [status || null]
  );
  return result.rows;
}

/**
 * Payout Engine - Siku ya mzunguko: kusanya michango, mpe mwenye zamu
 * Inaendeshwa na Cron Job
 */
async function disburseDuePayouts() {
  const client = await pool.connect();
  let processed = 0;
  try {
    await client.query('BEGIN');

    const dueSchedules = await client.query(
      `SELECT s.*, p.pool_name, p.contribution_amount, u.phone_number, u.full_name
       FROM rosca_schedules s
       JOIN rosca_pools p ON p.id = s.pool_id
       JOIN users u ON u.id = s.recipient_user_id
       WHERE s.status = 'PENDING' AND s.scheduled_date <= CURRENT_DATE
       LIMIT 20
       FOR UPDATE OF s`,
    );

    for (const sched of dueSchedules.rows) {
      const referenceId = generateReference('RP');

      const contributors = await client.query(
        `SELECT rm.user_id, u.wallet_balance, u.phone_number
         FROM rosca_members rm
         JOIN users u ON u.id = rm.user_id
         WHERE rm.pool_id = $1
         FOR UPDATE OF u`,
        [sched.pool_id]
      );

      let insufficient = false;
      const collected = [];
      for (const member of contributors.rows) {
        if (Number(member.wallet_balance) < Number(sched.contribution_amount)) {
          insufficient = true;
          break;
        }
      }

      if (insufficient) {
        await client.query(
          'UPDATE rosca_schedules SET status = $1 WHERE id = $2',
          ['SKIPPED', sched.id]
        );
        logger.warn('ROSCA', `Mzunguko #${sched.cycle_number} umerukwa - michango haitoshi (pool ${sched.pool_id})`);
        continue;
      }

      for (const member of contributors.rows) {
        await client.query(
          'UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2',
          [sched.contribution_amount, member.user_id]
        );
        await client.query(
          `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
           VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'ROSCA_CONTRIBUTION', $4)`,
          [generateReference('RC'), member.user_id, sched.contribution_amount, JSON.stringify({ pool_id: sched.pool_id, cycle_number: sched.cycle_number })]
        );
        collected.push(member.user_id);
      }

      const netPayout = Math.round((sched.total_payout_amount - sched.comm_amount) * 100) / 100;

      await client.query(
        'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2',
        [netPayout, sched.recipient_user_id]
      );
      await client.query(
        `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
         VALUES ($1, $2, $3, $4, $3, 'SUCCESS', 'ROSCA_PAYOUT', $5)`,
        [referenceId, sched.recipient_user_id, netPayout, sched.comm_amount, JSON.stringify({ pool_id: sched.pool_id, cycle_number: sched.cycle_number })]
      );

      await client.query(
        `UPDATE company_revenue SET total_commission = total_commission + $1, updated_at = NOW() WHERE id = 1`,
        [sched.comm_amount]
      );

      await client.query(
        `UPDATE rosca_members SET has_received_payout = TRUE, received_payout_amount = $1
         WHERE pool_id = $2 AND user_id = $3`,
        [netPayout, sched.pool_id, sched.recipient_user_id]
      );

      await client.query(
        'UPDATE rosca_schedules SET status = $1, disbursed_at = NOW() WHERE id = $2',
        ['DISBURSED', sched.id]
      );

      await client.query(
        `UPDATE rosca_pools SET current_cycle = current_cycle + 1 WHERE id = $1`,
        [sched.pool_id]
      );

      const smsMsg = `Habari ${sched.full_name}, umepokea ${formatMoney(netPayout)} kutoka ${sched.pool_name} (Mzunguko #${sched.cycle_number}). Ref: ${referenceId}`;
      await sendSMS(sched.phone_number, smsMsg);
      processed++;
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('ROSCA PAYOUT', error.message);
    throw error;
  } finally {
    client.release();
  }
  return { processed };
}

async function getPoolDetails(poolId) {
  const poolRes = await pool.query('SELECT * FROM rosca_pools WHERE id = $1', [poolId]);
  if (poolRes.rows.length === 0) throw new Error('Pool haijapatikana.');
  const members = await pool.query(
    `SELECT rm.assigned_queue_number, rm.has_received_payout, u.full_name, u.phone_number, u.trust_score
     FROM rosca_members rm JOIN users u ON u.id = rm.user_id
     WHERE rm.pool_id = $1 ORDER BY rm.assigned_queue_number`,
    [poolId]
  );
  const schedules = await pool.query(
    'SELECT * FROM rosca_schedules WHERE pool_id = $1 ORDER BY cycle_number',
    [poolId]
  );
  return { ...poolRes.rows[0], members: members.rows, schedules: schedules.rows };
}

module.exports = { createPool, joinPool, listPools, disburseDuePayouts, getPoolDetails };
