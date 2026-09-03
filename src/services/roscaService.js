const pool = require('../config/db');
const config = require('../config');
const { generateReference, formatMoney } = require('../utils/helpers');
const { sendSMS } = require('./smsService');
const { triggerPayout } = require('./azampayService');
const { logAudit } = require('./auditService');
const logger = require('../utils/logger');
const fin = require('./financialEngine');

/**
 * Adjust a user's trust_score from ROSCA activity (0-100) and record
 * the exact delta/reason so members & auditors can see WHY it changed.
 * Trust history from contribution reliability mirrors eRosca's
 * "credit score from contribution history" behaviour.
 */
async function applyTrustDelta(client, { userId, poolId, cycleNumber, delta, reason }) {
  const userRes = await client.query(
    'SELECT trust_score FROM users WHERE id = $1 FOR UPDATE',
    [userId]
  );
  if (userRes.rows.length === 0) return;
  const before = Number(userRes.rows[0].trust_score) || 0;
  const scoreAfter = Math.max(0, Math.min(100, before + delta));
  await client.query(
    'UPDATE users SET trust_score = $1 WHERE id = $2',
    [scoreAfter, userId]
  );
  await client.query(
    `INSERT INTO rosca_trust_history (user_id, pool_id, cycle_number, delta, score_after, reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, poolId, cycleNumber, delta, scoreAfter, reason]
  );
  return { before, after: scoreAfter, delta };
}

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

    // Constitution acceptance is required before joining when a pool has a
    // versioned constitution (mandatory for PRIVATE_KIKOBA, optional PUBLIC).
    const constCheck = await client.query(
      'SELECT COUNT(*)::int AS n FROM rosca_constitutions WHERE pool_id = $1',
      [poolId]
    );
    if (constCheck.rows[0].n > 0) {
      const acc = await client.query(
        `SELECT 1 FROM rosca_constitution_acceptance ca
         JOIN rosca_constitutions c ON c.id = ca.constitution_id
         WHERE ca.user_id = $1 AND ca.pool_id = $2
           AND c.id = (SELECT id FROM rosca_constitutions WHERE pool_id = $2 ORDER BY version DESC LIMIT 1)`,
        [userId, poolId]
      );
      if (acc.rows.length === 0) {
        throw Object.assign(new Error('Lazima ukubali katiba ya Upatu kabla ya kujiunga. Tuma /rosca/pools/:poolId/constitution/accept.'), { statusCode: 400 });
      }
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
      const lockRef = generateReference('RL');
      await fin.lockWallet({ client, userId, amount: collateral, reference: `${lockRef}:LK`, description: 'ROSCA Locked Collateral' });
      await client.query(
        `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
         VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'ROSCA_LOCK', $4)`,
        [lockRef, userId, collateral, JSON.stringify({ pool_id: poolId, queue_number: queueNumber })]
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
 * Pool ikijaa - tengeneza rosca_schedules kwa kila mzunguko.
 * Payout order is configurable per pool:
 *   SEQUENTIAL - recipient = assigned queue number
 *   TRUST      - recipients ranked by trust_score (highest first)
 *   DRAW       - recipients drawn deterministically (seeded by pool id + cycle)
 */
async function activatePool(client, rosca) {
  const members = await client.query(
    `SELECT rm.user_id, rm.assigned_queue_number, u.trust_score
     FROM rosca_members rm JOIN users u ON u.id = rm.user_id
     WHERE rm.pool_id = $1 ORDER BY rm.assigned_queue_number ASC`,
    [rosca.id]
  );

  let order = members.rows;
  const po = rosca.payout_order || 'SEQUENTIAL';
  if (po === 'TRUST') {
    order = [...members.rows].sort((a, b) => (Number(b.trust_score) || 0) - (Number(a.trust_score) || 0));
  } else if (po === 'DRAW') {
    order = [...members.rows];
    const seed = rosca.id;
    order = order
      .map((m, i) => ({ m, k: (seed * 31 + i * 17) % 997 }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.m);
  }

  const totalCycles = order.length;
  for (let cycle = 1; cycle <= totalCycles; cycle++) {
    const recipient = order[cycle - 1];
    if (!recipient) continue;
    const scheduledDate = new Date();
    const cycleIndex = cycle - 1;
    if (rosca.cycle_frequency === 'WEEKLY') scheduledDate.setDate(scheduledDate.getDate() + cycleIndex * 7);
    else scheduledDate.setMonth(scheduledDate.getMonth() + cycleIndex);

    const totalPayout = Math.round(rosca.contribution_amount * rosca.total_members * 100) / 100;
    const commAmount = Math.round(totalPayout * 0.01 * 100) / 100;

    await client.query(
      `INSERT INTO rosca_schedules
        (pool_id, cycle_number, recipient_user_id, scheduled_date, contribution_amount, total_payout_amount, comm_amount,
         expected_amount, collection_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'OPEN')`,
      [rosca.id, cycle, recipient.user_id, scheduledDate, rosca.contribution_amount, totalPayout, commAmount, totalPayout]
    );
  }

  await client.query('UPDATE rosca_pools SET status = $1, current_cycle = 1 WHERE id = $2', ['ACTIVE', rosca.id]);
  logger.info('ROSCA', `Pool ${rosca.pool_name} imeanza (${totalCycles} cycles, order=${po})`);
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
      `SELECT s.*, p.pool_name, p.contribution_amount, u.phone_number, u.full_name,
              p.grace_days, p.late_fee_amount, p.total_members
       FROM rosca_schedules s
       JOIN rosca_pools p ON p.id = s.pool_id
       JOIN users u ON u.id = s.recipient_user_id
       WHERE s.status = 'PENDING'
         AND s.scheduled_date <= CURRENT_DATE - (COALESCE(p.grace_days,0) * INTERVAL '1 day')
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
      const shortMembers = [];
      const collected = [];
      for (const member of contributors.rows) {
        if (Number(member.wallet_balance) < Number(sched.contribution_amount)) {
          insufficient = true;
          shortMembers.push(member.user_id);
        }
      }

      if (insufficient) {
        // Meme (grace period tayari imepita): toza ada ya kuchelewa kwa kila
        // mshiriki aliyekosa, rekodi miss, na weka hali ya mzunguko.
        const lateFee = Number(sched.late_fee_amount) || 0;
        let feeChargedTotal = 0;
        for (const member of contributors.rows) {
          if (Number(member.wallet_balance) < Number(sched.contribution_amount) && shortMembers.includes(member.user_id) && lateFee > 0) {
            if (Number(member.wallet_balance) >= lateFee) {
              const feeRef = `${referenceId}:LF:${member.user_id}`;
              await fin.debitWallet({ client, userId: member.user_id, amount: lateFee, reference: feeRef, toAccount: 'PLATFORM_FEES', description: 'ROSCA Late Fee' });
              feeChargedTotal += lateFee;
            }
          }
        }
        await client.query(
          `UPDATE rosca_schedules
             SET status = 'SKIPPED', collection_status = 'PARTIALLY_FUNDED', late_fee_charged = $1
           WHERE id = $2`,
          [feeChargedTotal, sched.id]
        );
        // Record misses for the members who actually fell short and apply a
        // small trust_score penalty (they disrupted the payout cycle).
        if (shortMembers.length > 0) {
          await client.query(
            `UPDATE rosca_members SET contributions_missed = contributions_missed + 1, on_time_streak = 0
             WHERE pool_id = $1 AND user_id = ANY($2::int[])`,
            [sched.pool_id, shortMembers]
          );
          for (const shortId of shortMembers) {
            const chg = await applyTrustDelta(client, { userId: shortId, poolId: sched.pool_id, cycleNumber: sched.cycle_number, delta: -3, reason: 'MISSED_CONTRIBUTION' });
            logger.warn('ROSCA', `Member ${shortId} trust ${chg.before}->${chg.after} (missed cycle #${sched.cycle_number})`);
          }
        }
        logger.warn('ROSCA', `Mzunguko #${sched.cycle_number} umerukwa - michango haitoshi (pool ${sched.pool_id}), late fee ${feeChargedTotal}`);
        continue;
      }

      for (const member of contributors.rows) {
        const memberRef = `${referenceId}:RC:${member.user_id}`;
        await fin.debitWallet({ client, userId: member.user_id, amount: sched.contribution_amount, reference: memberRef, toAccount: 'ROSICA_POOL', description: 'ROSCA Contribution' });
        await client.query(
          `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
           VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'ROSCA_CONTRIBUTION', $4)`,
          [memberRef, member.user_id, sched.contribution_amount, JSON.stringify({ pool_id: sched.pool_id, cycle_number: sched.cycle_number })]
        );
        // Reliability: on-time contributor gains trust (capped 100).
        await client.query(
          `UPDATE rosca_members SET contributions_ok = contributions_ok + 1, on_time_streak = on_time_streak + 1
           WHERE pool_id = $1 AND user_id = $2`,
          [sched.pool_id, member.user_id]
        );
        await client.query(
          `UPDATE users SET trust_score = LEAST(100, (COALESCE(trust_score,0) + 1)) WHERE id = $1`,
          [member.user_id]
        );
        await client.query(
          `INSERT INTO rosca_trust_history (user_id, pool_id, cycle_number, delta, score_after, reason)
           SELECT $1, $2, $3, 1, trust_score, 'ON_TIME_CONTRIBUTION' FROM users WHERE id = $1`,
          [member.user_id, sched.pool_id, sched.cycle_number]
        );
        collected.push(member.user_id);
      }

      const netPayout = Math.round((sched.total_payout_amount - sched.comm_amount) * 100) / 100;

      await client.query(
        `UPDATE rosca_schedules SET collection_status = 'PAYOUT_PENDING', collected_amount = $1 WHERE id = $2`,
        [Number(sched.total_payout_amount), sched.id]
      );

      await fin.groupToWallet({ client, userId: sched.recipient_user_id, groupId: sched.pool_id, groupAccount: 'ROSICA_POOL', amount: netPayout, reference: `${referenceId}:PO`, description: 'ROSCA Payout' });
      if (sched.comm_amount > 0) {
        await fin.postJournal({
          client,
          lines: [
            { accountCode: 'ROSICA_POOL', direction: 'DR', amount: Number(sched.comm_amount) },
            { accountCode: 'COMMISSION', direction: 'CR', amount: Number(sched.comm_amount) },
          ],
          referenceId: `${referenceId}:CM`,
          description: 'ROSCA Commission',
        });
      }
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
        `UPDATE rosca_schedules
           SET collection_status = 'DISBURSED',
               collected_amount = $1,
               expected_amount = $2
         WHERE id = $3`,
        [Number(sched.total_payout_amount), Number(sched.total_payout_amount), sched.id]
      );

      await client.query(
        `UPDATE rosca_pools SET current_cycle = current_cycle + 1 WHERE id = $1`,
        [sched.pool_id]
      );

      const smsMsg = `Habari ${sched.full_name}, umepokea ${formatMoney(netPayout)} kutoka ${sched.pool_name} (Mzunguko #${sched.cycle_number}). Ref: ${referenceId}`;
      await sendSMS(sched.phone_number, smsMsg);
      await logAudit({ eventType: 'ROSCA_PAYOUT', action: 'RELEASE', entityType: 'ROSCA_SCHEDULE', userId: sched.recipient_user_id, entityId: sched.id, referenceId, amount: netPayout, afterData: { pool_id: sched.pool_id, cycle: sched.cycle_number } });
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
  const constitution = await pool.query(
    'SELECT * FROM rosca_constitutions WHERE pool_id = $1 ORDER BY version DESC LIMIT 1',
    [poolId]
  );
  return {
    ...poolRes.rows[0],
    members: members.rows,
    schedules: schedules.rows,
    constitution: constitution.rows[0] || null,
  };
}

/**
 * Sum a member's ROSCA contribution reliability + trust history across all
 * pools, and return the per-pool counters. Used to render the "trust from
 * history" view on the dashboard.
 */
async function getMemberRoscaSummary(userId) {
  const totals = await pool.query(
    `SELECT COALESCE(SUM(contributions_ok)::int,0) AS contributions_ok,
            COALESCE(SUM(contributions_missed)::int,0) AS contributions_missed,
            COALESCE(MAX(on_time_streak)::int,0) AS best_streak
     FROM rosca_members WHERE user_id = $1`,
    [userId]
  );
  const history = await pool.query(
    `SELECT rth.pool_id, p.pool_name, rth.cycle_number, rth.delta, rth.score_after, rth.reason, rth.created_at
     FROM rosca_trust_history rth
     LEFT JOIN rosca_pools p ON p.id = rth.pool_id
     WHERE rth.user_id = $1
     ORDER BY rth.created_at DESC
     LIMIT 50`,
    [userId]
  );
  return {
    totals: totals.rows[0],
    history: history.rows,
  };
}

// (module.exports moved to end of file)

// ============================================================================
// PHASE 2: UPATU GOVERNANCE (configurable grace/late fee/payout order,
// versioned constitution, per-member acceptance, richer round statuses)
// ============================================================================

async function setPoolGovernance(userId, poolId, { grace_days, late_fee_amount, payout_order }) {
  const poolRes = await pool.query('SELECT * FROM rosca_pools WHERE id = $1', [poolId]);
  if (poolRes.rows.length === 0) throw Object.assign(new Error('Pool haijapatikana.'), { statusCode: 404 });
  const rosca = poolRes.rows[0];
  if (rosca.created_by_user_id !== userId) {
    throw Object.assign(new Error('Wewe ndiye mwanzilishi pekee anayeweza kubadilisha utawala wa pool.'), { statusCode: 403 });
  }
  const r = await pool.query(
    `UPDATE rosca_pools
       SET grace_days = $1, late_fee_amount = $2, payout_order = $3, updated_at = NOW()
     WHERE id = $4 RETURNING *`,
    [grace_days ?? rosca.grace_days ?? 0, late_fee_amount ?? rosca.late_fee_amount ?? 0,
     payout_order ?? rosca.payout_order ?? 'SEQUENTIAL', poolId]
  );
  await logAudit({ eventType: 'ROSCA_GOVERNANCE', action: 'UPDATE', entityType: 'ROSCA_POOL', userId, entityId: poolId, afterData: { grace_days, late_fee_amount, payout_order } });
  return r.rows[0];
}

async function createConstitution(userId, poolId, { title, body }) {
  if (!body || typeof body !== 'object') throw Object.assign(new Error('Katiba (body) inahitajika.'), { statusCode: 400 });
  const poolRes = await pool.query('SELECT * FROM rosca_pools WHERE id = $1', [poolId]);
  if (poolRes.rows.length === 0) throw Object.assign(new Error('Pool haijapatikana.'), { statusCode: 404 });
  if (poolRes.rows[0].created_by_user_id !== userId) {
    throw Object.assign(new Error('Wewe ndiye mwanzilishi pekee anayeweza kuweka katiba.'), { statusCode: 403 });
  }
  const verRow = await pool.query(
    'SELECT COALESCE(MAX(version),0)+1 AS v FROM rosca_constitutions WHERE pool_id = $1',
    [poolId]
  );
  const r = await pool.query(
    `INSERT INTO rosca_constitutions (pool_id, version, title, body, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [poolId, verRow.rows[0].v, title || 'Katiba ya Upatu', body, userId]
  );
  await logAudit({ eventType: 'ROSCA_CONSTITUTION', action: 'CREATE', entityType: 'ROSCA_CONSTITUTION', userId, entityId: r.rows[0].id, afterData: { pool_id: poolId, version: verRow.rows[0].v } });
  return r.rows[0];
}

async function getConstitution(poolId, version) {
  if (version) {
    const r = await pool.query(
      'SELECT * FROM rosca_constitutions WHERE pool_id = $1 AND version = $2',
      [poolId, version]
    );
    if (r.rows.length === 0) throw Object.assign(new Error('Katiba haipatikani.'), { statusCode: 404 });
    return r.rows[0];
  }
  const r = await pool.query(
    'SELECT * FROM rosca_constitutions WHERE pool_id = $1 ORDER BY version DESC LIMIT 1',
    [poolId]
  );
  if (r.rows.length === 0) return null;
  return r.rows[0];
}

async function listConstitutions(poolId) {
  const r = await pool.query(
    'SELECT * FROM rosca_constitutions WHERE pool_id = $1 ORDER BY version DESC',
    [poolId]
  );
  return r.rows;
}

async function acceptConstitution(userId, poolId, version) {
  const constRow = await pool.query(
    'SELECT * FROM rosca_constitutions WHERE pool_id = $1 AND version = $2',
    [poolId, version]
  );
  if (constRow.rows.length === 0) throw Object.assign(new Error('Katiba haipatikani.'), { statusCode: 404 });
  const accepted = await pool.query(
    `INSERT INTO rosca_constitution_acceptance (user_id, pool_id, constitution_id)
     VALUES ($1, $2, $3) RETURNING *`,
    [userId, poolId, constRow.rows[0].id]
  );
  await logAudit({ eventType: 'ROSCA_ACCEPT', action: 'ACCEPT', entityType: 'ROSCA_CONSTITUTION', userId, entityId: constRow.rows[0].id, afterData: { pool_id: poolId, version } });
  return accepted.rows[0];
}

async function hasAcceptedConstitution(userId, poolId) {
  const constRow = await pool.query(
    'SELECT id FROM rosca_constitutions WHERE pool_id = $1 ORDER BY version DESC LIMIT 1',
    [poolId]
  );
  if (constRow.rows.length === 0) return { exists: false, accepted: true };
  const acc = await pool.query(
    'SELECT 1 FROM rosca_constitution_acceptance WHERE user_id = $1 AND pool_id = $2 AND constitution_id = $3',
    [userId, poolId, constRow.rows[0].id]
  );
  return { exists: true, accepted: acc.rows.length > 0 };
}

module.exports = {
  createPool, joinPool, listPools, disburseDuePayouts, getPoolDetails, getMemberRoscaSummary, applyTrustDelta,
  setPoolGovernance, createConstitution, getConstitution, listConstitutions, acceptConstitution, hasAcceptedConstitution,
};
