const pool = require('../config/db');
const crypto = require('crypto');
const { generateReference, formatMoney, toInternationalFormat } = require('../utils/helpers');
const { sendSMS } = require('./smsService');
const { logAudit } = require('./auditService');
const logger = require('../utils/logger');

// ==========================================
// GROUP CONSTITUTION / RULES
// ==========================================

async function createConstitution(groupId, rules) {
  const {
    minSharesPerMember, maxSharesPerMember, sharePrice,
    maxLoanMultiplier, loanInterestRate, maxRepaymentMonths,
    finePerAbsence, finePerLateArrival, lateArrivalMinutes,
    meetingDay, meetingTime, meetingFrequency,
    minMembers, maxMembers, profitDistribution,
    shareRollover, require3TierApproval
  } = rules;

  const result = await pool.query(
    `INSERT INTO vicoba_group_constitutions
      (group_id, min_shares_per_member, max_shares_per_member, share_price,
       max_loan_multiplier, loan_interest_rate, max_repayment_months,
       fine_per_absence, fine_per_late_arrival, late_arrival_minutes,
       meeting_day, meeting_time, meeting_frequency,
       min_members, max_members, profit_distribution,
       share_rollover, require_3_tier_approval)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (group_id) DO UPDATE SET
       min_shares_per_member = EXCLUDED.min_shares_per_member,
       max_shares_per_member = EXCLUDED.max_shares_per_member,
       share_price = EXCLUDED.share_price,
       max_loan_multiplier = EXCLUDED.max_loan_multiplier,
       loan_interest_rate = EXCLUDED.loan_interest_rate,
       max_repayment_months = EXCLUDED.max_repayment_months,
       fine_per_absence = EXCLUDED.fine_per_absence,
       fine_per_late_arrival = EXCLUDED.fine_per_late_arrival,
       late_arrival_minutes = EXCLUDED.late_arrival_minutes,
       meeting_day = EXCLUDED.meeting_day,
       meeting_time = EXCLUDED.meeting_time,
       meeting_frequency = EXCLUDED.meeting_frequency,
       min_members = EXCLUDED.min_members,
       max_members = EXCLUDED.max_members,
       profit_distribution = EXCLUDED.profit_distribution,
       share_rollover = EXCLUDED.share_rollover,
       require_3_tier_approval = EXCLUDED.require_3_tier_approval,
       updated_at = NOW()
     RETURNING *`,
    [groupId, minSharesPerMember || 1, maxSharesPerMember || 100, sharePrice || 10000,
     maxLoanMultiplier || 3, loanInterestRate || 10, maxRepaymentMonths || 6,
     finePerAbsence || 5000, finePerLateArrival || 2000, lateArrivalMinutes || 15,
     meetingDay || 'SATURDAY', meetingTime || '10:00', meetingFrequency || 'WEEKLY',
     minMembers || 5, maxMembers || 30, profitDistribution || 'PROPORTIONAL',
     shareRollover !== false, require3TierApproval !== false]
  );
  return result.rows[0];
}

async function getConstitution(groupId) {
  const result = await pool.query(
    'SELECT * FROM vicoba_group_constitutions WHERE group_id = $1',
    [groupId]
  );
  return result.rows[0] || null;
}

// ==========================================
// SHARE PURCHASING SYSTEM
// ==========================================

async function buyShares(userId, groupId, sharesCount) {
  const count = parseInt(sharesCount, 10);
  if (count <= 0) throw Object.assign(new Error('Idadi ya hisa lazima iwe zaidi ya 0.'), { statusCode: 400 });

  const constRes = await pool.query(
    'SELECT * FROM vicoba_group_constitutions WHERE group_id = $1',
    [groupId]
  );
  if (constRes.rows.length === 0) {
    throw Object.assign(new Error('Katiba ya kikundi haipo. Weka katiba kwanza.'), { statusCode: 400 });
  }
  const rules = constRes.rows[0];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const memberRes = await client.query(
      `SELECT vm.*, u.wallet_balance, u.phone_number, u.full_name
       FROM vicoba_members vm
       JOIN users u ON u.id = vm.user_id
       WHERE vm.group_id = $1 AND vm.user_id = $2
       FOR UPDATE OF u, vm`,
      [groupId, userId]
    );
    if (memberRes.rows.length === 0) {
      throw Object.assign(new Error('Hauko kwenye kikundi hiki.'), { statusCode: 403 });
    }
    const member = memberRes.rows[0];

    if (member.total_shares + count > rules.max_shares_per_member) {
      throw Object.assign(new Error(`Hisa zako zimefikia kikomo. Unaweza kuongeza tena ${rules.max_shares_per_member - member.total_shares} hisa tu.`), { statusCode: 400 });
    }

    const cost = count * rules.share_price;
    if (Number(member.wallet_balance) < cost) {
      throw Object.assign(new Error(`Salio la wallet halitoshi. Unahitaji TSh ${formatMoney(cost)} kwa hisa ${count}.`), { statusCode: 400 });
    }

    await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [cost, userId]);
    await client.query('UPDATE vicoba_groups SET group_wallet_balance = group_wallet_balance + $1 WHERE id = $2', [cost, groupId]);
    await client.query(
      'UPDATE vicoba_members SET total_shares = total_shares + $1, share_capital = share_capital + $2 WHERE group_id = $3 AND user_id = $4',
      [count, cost, groupId, userId]
    );

    const referenceId = generateReference('VS');
    const txRes = await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'VICOBA_SHARE', $4)
       RETURNING id`,
      [referenceId, userId, cost, JSON.stringify({ group_id: groupId, action: 'BUY_SHARES', shares: count })]
    );

    await client.query(
      `INSERT INTO vicoba_share_purchases (group_id, user_id, shares_count, amount, cycle_number, reference_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [groupId, userId, count, cost, null, referenceId]
    );

    await client.query(
      `INSERT INTO wallet_ledger (transaction_id, reference_id, from_user_id, to_user_id, amount, description)
       VALUES ($1, $2, $3, NULL, $4, 'VICOBA Share Purchase')`,
       [txRes.rows[0].id, referenceId, userId, cost]
    );

    await client.query('COMMIT');
    await logAudit({ eventType: 'VICOBA_SHARE', action: 'CREATE', entityType: 'VICOBA_SHARE', userId, referenceId, amount: cost, afterData: { group_id: groupId, shares: count } });
    await sendSMS(member.phone_number, `Habari ${member.full_name}, umenunua hisa ${count} kwa TSh ${formatMoney(cost)} kwenye VICOBA "${(await pool.query('SELECT group_name FROM vicoba_groups WHERE id=$1', [groupId])).rows[0].group_name}". Jumla ya hisa: ${member.total_shares + count}`);

    return {
      success: true, referenceId, sharesCount: count, cost,
      totalShares: member.total_shares + count,
      message: `Hisa ${count} zimenunuliwa kwa TSh ${formatMoney(cost)}.`
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getSharePurchases(groupId, userId) {
  const query = userId
    ? `SELECT sp.*, u.full_name FROM vicoba_share_purchases sp
       JOIN users u ON u.id = sp.user_id
       WHERE sp.group_id = $1 AND sp.user_id = $2
       ORDER BY sp.created_at DESC`
    : `SELECT sp.*, u.full_name FROM vicoba_share_purchases sp
       JOIN users u ON u.id = sp.user_id
       WHERE sp.group_id = $1
       ORDER BY sp.created_at DESC`;
  const params = userId ? [groupId, userId] : [groupId];
  const result = await pool.query(query, params);
  return result.rows;
}

async function getMemberShareSummary(groupId) {
  const result = await pool.query(
    `SELECT vm.user_id, u.full_name, u.phone_number,
            vm.total_shares, vm.share_capital, vm.shares_rollover,
            vm.total_profit_earned,
            COUNT(sp.id) as purchase_count,
            COALESCE(SUM(sp.amount), 0) as total_invested
     FROM vicoba_members vm
     JOIN users u ON u.id = vm.user_id
     LEFT JOIN vicoba_share_purchases sp ON sp.group_id = vm.group_id AND sp.user_id = vm.user_id
     WHERE vm.group_id = $1
     GROUP BY vm.user_id, u.full_name, u.phone_number,
              vm.total_shares, vm.share_capital, vm.shares_rollover, vm.total_profit_earned
     ORDER BY vm.total_shares DESC`,
    [groupId]
  );
  return result.rows;
}

// ==========================================
// PROFIT SHARING ENGINE
// ==========================================

async function calculateProfitDistribution(groupId, cycleNumber, totalProfit) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const totalSharesRes = await client.query(
      'SELECT COALESCE(SUM(total_shares), 0) as total FROM vicoba_members WHERE group_id = $1',
      [groupId]
    );
    const totalShares = parseInt(totalSharesRes.rows[0].total, 10);
    if (totalShares === 0) throw Object.assign(new Error('Hakuna hisa za kugawana faida.'), { statusCode: 400 });

    const perShareDividend = totalProfit / totalShares;

    const distResult = await client.query(
      `INSERT INTO vicoba_profit_distributions (group_id, cycle_number, total_profit, total_shares_at_distribution, per_share_dividend, status)
       VALUES ($1, $2, $3, $4, $5, 'PENDING') RETURNING *`,
      [groupId, cycleNumber, totalProfit, totalShares, perShareDividend.toFixed(2)]
    );
    const distribution = distResult.rows[0];

    const members = await client.query(
      `SELECT vm.user_id, vm.total_shares, vm.share_capital, u.full_name, u.phone_number
       FROM vicoba_members vm
       JOIN users u ON u.id = vm.user_id
       WHERE vm.group_id = $1 AND vm.total_shares > 0`,
      [groupId]
    );

    const constitution = await client.query(
      'SELECT * FROM vicoba_group_constitutions WHERE group_id = $1',
      [groupId]
    );
    const rules = constitution.rows[0];
    const shareRollover = rules ? rules.share_rollover : true;

    let totalDistributed = 0;
    const payouts = [];

    for (const member of members.rows) {
      const dividend = member.total_shares * perShareDividend;
      const rolloverShares = shareRollover ? member.total_shares : 0;

      await client.query(
        `INSERT INTO vicoba_profit_payouts (distribution_id, user_id, shares_count, dividend_amount, rollover_shares)
         VALUES ($1, $2, $3, $4, $5)`,
        [distribution.id, member.user_id, member.total_shares, dividend.toFixed(2), rolloverShares]
      );

      await client.query(
        'UPDATE vicoba_members SET total_profit_earned = total_profit_earned + $1 WHERE group_id = $2 AND user_id = $3',
        [dividend, groupId, member.user_id]
      );

      totalDistributed += parseFloat(dividend);
      payouts.push({ userId: member.user_id, name: member.full_name, shares: member.total_shares, dividend: parseFloat(dividend.toFixed(2)) });
    }

    await client.query(
      'UPDATE vicoba_groups SET total_profit_pool = total_profit_pool + $1 WHERE id = $2',
      [totalProfit, groupId]
    );

    await client.query('COMMIT');
    await logAudit({ eventType: 'VICOBA_PROFIT_PAYOUT', action: 'CALCULATE', entityType: 'VICOBA_PROFIT_DISTRIBUTION', amount: totalProfit, afterData: { group_id: groupId, cycle: cycleNumber, members_paid: payouts.length } });

    logger.info('VICOBA', `Profit distribution: TSh ${formatMoney(totalProfit)} / ${totalShares} shares = TSh ${formatMoney(perShareDividend)} per share`);

    return { distribution, payouts, perShareDividend: parseFloat(perShareDividend.toFixed(2)), totalDistributed };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function approveProfitDistribution(distributionId, approverUserId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const distRes = await client.query(
      `SELECT pd.*, g.created_by_user_id
       FROM vicoba_profit_distributions pd
       JOIN vicoba_groups g ON g.id = pd.group_id
       WHERE pd.id = $1
       FOR UPDATE`,
      [distributionId]
    );
    if (distRes.rows.length === 0) throw Object.assign(new Error('Usambazaji wa faida haupatikani.'), { statusCode: 404 });
    const dist = distRes.rows[0];

    if (approverUserId !== dist.created_by_user_id) {
      throw Object.assign(new Error('Mwenyekiti pekee anaweza kuthibitisha mgawanyo wa faida.'), { statusCode: 403 });
    }

    if (dist.status !== 'PENDING') {
      throw Object.assign(new Error('Usambazaji wa faida tayari umeshachakatwa.'), { statusCode: 400 });
    }

    const payouts = await client.query(
      'SELECT * FROM vicoba_profit_payouts WHERE distribution_id = $1',
      [distributionId]
    );

    for (const payout of payouts.rows) {
      await client.query(
        'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2',
        [payout.dividend_amount, payout.user_id]
      );

      const referenceId = generateReference('PD');
      await client.query(
        `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
         VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'VICOBA_PROFIT_PAYOUT', $4)`,
        [referenceId, payout.user_id, payout.dividend_amount,
         JSON.stringify({ distribution_id: distributionId, shares: payout.shares_count, per_share: dist.per_share_dividend })]
      );

      await client.query(
        'UPDATE vicoba_profit_payouts SET paid = TRUE, paid_at = NOW() WHERE id = $1',
        [payout.id]
      );

      if (payout.rollover_shares > 0) {
        await client.query(
          'UPDATE vicoba_members SET shares_rollover = shares_rollover + $1 WHERE group_id = $2 AND user_id = $3',
          [payout.rollover_shares, dist.group_id, payout.user_id]
        );
      }
    }

    await client.query(
      "UPDATE vicoba_profit_distributions SET status = 'COMPLETED', distributed_at = NOW() WHERE id = $1",
      [distributionId]
    );

    await client.query('COMMIT');

    return { success: true, message: 'Mgawanyo wa faida umekamilika.', distributed: payouts.rows.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getProfitDistributions(groupId) {
  const result = await pool.query(
    `SELECT pd.*,
            (SELECT COUNT(*) FROM vicoba_profit_payouts pp WHERE pp.distribution_id = pd.id) as payout_count,
            (SELECT COALESCE(SUM(pp.dividend_amount), 0) FROM vicoba_profit_payouts pp WHERE pp.distribution_id = pd.id AND pp.paid = TRUE) as total_paid
     FROM vicoba_profit_distributions pd
     WHERE pd.group_id = $1
     ORDER BY pd.created_at DESC`,
    [groupId]
  );
  return result.rows;
}

async function getMyProfitPayouts(userId, groupId) {
  let query = `SELECT pp.*, pd.cycle_number, pd.per_share_dividend, pd.total_profit, g.group_name
               FROM vicoba_profit_payouts pp
               JOIN vicoba_profit_distributions pd ON pd.id = pp.distribution_id
               JOIN vicoba_groups g ON g.id = pd.group_id
               WHERE pp.user_id = $1`;
  let params = [userId];
  if (groupId) {
    query += ' AND pd.group_id = $2';
    params.push(groupId);
  }
  query += ' ORDER BY pp.created_at DESC';
  const result = await pool.query(query, params);
  return result.rows;
}

// ==========================================
// 3-TIER FUND TRANSFERS (Katibu → Mwekahazina → Mwenyekiti)
// ==========================================

async function initiateTransfer(userId, groupId, { transferType, recipientUserId, recipientPhone, amount, note }) {
  const amountNum = parseFloat(amount);
  if (amountNum <= 0) throw Object.assign(new Error('Kiasi lazima iwe zaidi ya 0.'), { statusCode: 400 });

  const roleRes = await pool.query(
    "SELECT role_in_group FROM vicoba_members WHERE group_id = $1 AND user_id = $2",
    [groupId, userId]
  );
  if (roleRes.rows.length === 0 || !['MWENYEKITI', 'MWEKAHAZINA', 'KATIBU'].includes(roleRes.rows[0].role_in_group)) {
    throw Object.assign(new Error('Viongozi pekee wanaweza kuanzisha uhamisho.'), { statusCode: 403 });
  }

  const group = await pool.query('SELECT group_wallet_balance FROM vicoba_groups WHERE id = $1', [groupId]);
  if (Number(group.rows[0].group_wallet_balance) < amountNum) {
    throw Object.assign(new Error('Salio la kikundi halitoshi.'), { statusCode: 400 });
  }

  const recipientType = recipientUserId ? 'MEMBER' : 'EXTERNAL';
  const referenceId = generateReference('FT');
  const result = await pool.query(
    `INSERT INTO vicoba_fund_transfers (group_id, initiated_by, transfer_type, recipient_type, recipient_user_id, recipient_phone, amount, initiator_note, reference_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'INITIATED') RETURNING *`,
    [groupId, userId, transferType || 'GROUP_WITHDRAWAL', recipientType, recipientUserId || null, recipientPhone || null, amountNum, note || null, referenceId]
  );

  return { success: true, transfer: result.rows[0], message: 'Uhamisho umeanzishwa. Inasubiri uthibitisho wa Mwekahazina.' };
}

async function verifyTransfer(verifierUserId, transferId, { approved, note }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const transferRes = await client.query(
      `SELECT ft.*, vm.role_in_group
       FROM vicoba_fund_transfers ft
       JOIN vicoba_members vm ON vm.group_id = ft.group_id AND vm.user_id = $1
       WHERE ft.id = $2 AND ft.status = 'INITIATED'
       FOR UPDATE`,
      [verifierUserId, transferId]
    );
    if (transferRes.rows.length === 0) throw Object.assign(new Error('Uhamisho haupatikani au tayari umeshakaguliwa.'), { statusCode: 404 });
    const transfer = transferRes.rows[0];

    if (transfer.role_in_group !== 'MWEKAHAZINA') {
      throw Object.assign(new Error('Mwekahazina pekee anaweza kuthibitisha uhamisho.'), { statusCode: 403 });
    }

    if (!approved) {
      await client.query(
        "UPDATE vicoba_fund_transfers SET status = 'REJECTED', verified_by = $1, verifier_note = $2, verified_at = NOW() WHERE id = $3",
        [verifierUserId, note || 'Imekataliwa', transferId]
      );
      await client.query('COMMIT');
      return { success: true, message: 'Uhamisho umekataliwa.' };
    }

    await client.query(
      "UPDATE vicoba_fund_transfers SET status = 'VERIFIED', verified_by = $1, verifier_note = $2, verified_at = NOW() WHERE id = $3",
      [verifierUserId, note || null, transferId]
    );
    await client.query('COMMIT');
    return { success: true, message: 'Uhamisho umeethibitishwa. Inasubiri idhinisho la Mwenyekiti.' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function approveTransfer(approverUserId, transferId, { approved, note }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const transferRes = await client.query(
      `SELECT ft.*, vm.role_in_group
       FROM vicoba_fund_transfers ft
       JOIN vicoba_members vm ON vm.group_id = ft.group_id AND vm.user_id = $1
       WHERE ft.id = $2`,
      [approverUserId, transferId]
    );
    if (transferRes.rows.length === 0) throw Object.assign(new Error('Uhamisho haupatikani.'), { statusCode: 404 });
    const transfer = transferRes.rows[0];

    if (transfer.role_in_group !== 'MWENYEKITI') {
      throw Object.assign(new Error('Mwenyekiti pekee anaweza kuidhinisha uhamisho wa mwisho.'), { statusCode: 403 });
    }

    if (transfer.status !== 'VERIFIED') {
      throw Object.assign(new Error('Uhamisho hauko katika hali sahihi ya kuthibitishwa.'), { statusCode: 400 });
    }

    if (!approved) {
      await client.query(
        "UPDATE vicoba_fund_transfers SET status = 'REJECTED', approved_by = $1, approver_note = $2, approved_at = NOW() WHERE id = $3",
        [approverUserId, note || 'Imekataliwa', transferId]
      );
      await client.query('COMMIT');
      return { success: true, message: 'Uhamisho umekataliwa na Mwenyekiti.' };
    }

    const groupRes = await client.query(
      'SELECT group_wallet_balance FROM vicoba_groups WHERE id = $1 FOR UPDATE',
      [transfer.group_id]
    );
    if (Number(groupRes.rows[0].group_wallet_balance) < transfer.amount) {
      throw Object.assign(new Error('Salio la kikundi halitoshi kwa uhamisho huu.'), { statusCode: 400 });
    }

    await client.query(
      'UPDATE vicoba_groups SET group_wallet_balance = group_wallet_balance - $1 WHERE id = $2',
      [transfer.amount, transfer.group_id]
    );

    if (transfer.recipient_type === 'MEMBER' && transfer.recipient_user_id) {
      await client.query(
        'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2',
        [transfer.amount, transfer.recipient_user_id]
      );

      const recipient = await client.query('SELECT full_name, phone_number FROM users WHERE id = $1', [transfer.recipient_user_id]);
      const refId = generateReference('TW');
      await client.query(
        `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
         VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'TRANSFER', $4)`,
        [refId, transfer.recipient_user_id, transfer.amount,
         JSON.stringify({ from_group: transfer.group_id, transfer_id: transferId, via: '3_TIER' })]
      );

      if (recipient.rows.length > 0) {
        await sendSMS(recipient.rows[0].phone_number, `Habari ${recipient.rows[0].full_name}, umepokea TSh ${formatMoney(transfer.amount)} kutoka kikundi.`);
      }
    }

    await client.query(
      "UPDATE vicoba_fund_transfers SET status = 'COMPLETED', approved_by = $1, approver_note = $2, approved_at = NOW(), completed_at = NOW() WHERE id = $3",
      [approverUserId, note || null, transferId]
    );

    await client.query('COMMIT');
    await logAudit({ eventType: 'VICOBA_TRANSFER', action: 'APPROVE', entityType: 'VICOBA_FUND_TRANSFER', userId: approverUserId, entityId: transferId, referenceId: transfer.reference_id, amount: transfer.amount, afterData: { group_id: transfer.group_id, recipient: transfer.recipient_user_id } });

    return { success: true, referenceId: transfer.reference_id, message: 'Uhamisho umekamilika. Fedha zimetolewa.' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function listTransfers(groupId, status) {
  let query = `SELECT ft.*, u_init.full_name as initiated_by_name, u_ver.full_name as verified_by_name, u_apr.full_name as approved_by_name
               FROM vicoba_fund_transfers ft
               JOIN users u_init ON u_init.id = ft.initiated_by
               LEFT JOIN users u_ver ON u_ver.id = ft.verified_by
               LEFT JOIN users u_apr ON u_apr.id = ft.approved_by
               WHERE ft.group_id = $1`;
  const params = [groupId];
  if (status) {
    query += ' AND ft.status = $2';
    params.push(status);
  }
  query += ' ORDER BY ft.created_at DESC';
  const result = await pool.query(query, params);
  return result.rows;
}

// ==========================================
// CROSS-NETWORK TOP-UP
// ==========================================

async function processCrossNetworkTopUp(groupId, userId, { amount, provider, externalRef, phone }) {
  const amountNum = parseFloat(amount);
  if (amountNum <= 0) throw Object.assign(new Error('Kiasi lazima iwe zaidi ya 0.'), { statusCode: 400 });

  const validProviders = ['M-PESA', 'AIRTEL', 'TIGO', 'HALOPESA', 'AZAMPAY', 'CRDB', 'NMB'];
  const providerUpper = (provider || 'AZAMPAY').toUpperCase();
  if (!validProviders.includes(providerUpper)) {
    throw Object.assign(new Error(`Mtandao ${provider} haujaidhinishwa. Matumizi: ${validProviders.join(', ')}`), { statusCode: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const memberRes = await client.query(
      'SELECT vm.*, u.phone_number, u.full_name FROM vicoba_members vm JOIN users u ON u.id = vm.user_id WHERE vm.group_id = $1 AND vm.user_id = $2 FOR UPDATE',
      [groupId, userId]
    );
    if (memberRes.rows.length === 0) throw Object.assign(new Error('Hauko kwenye kikundi hiki.'), { statusCode: 403 });

    await client.query(
      'UPDATE vicoba_groups SET group_wallet_balance = group_wallet_balance + $1 WHERE id = $2',
      [amountNum, groupId]
    );

    await client.query(
      'UPDATE vicoba_members SET contribution_balance = contribution_balance + $1 WHERE group_id = $2 AND user_id = $3',
      [amountNum, groupId, userId]
    );

    const referenceId = generateReference('CN');
    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'VICOBA_SHARE', $4)`,
      [referenceId, userId, amountNum, JSON.stringify({ group_id: groupId, provider: providerUpper, external_ref: externalRef, phone, cross_network: true })]
    );

    await client.query('COMMIT');

    logger.info('VICOBA', `Cross-network top-up: TSh ${formatMoney(amountNum)} via ${providerUpper} from ${phone || 'unknown'}`);

    return { success: true, referenceId, amount: amountNum, provider: providerUpper, message: `TSh ${formatMoney(amountNum)} zimeongezwa kupitia ${providerUpper}.` };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ==========================================
// MEETING ATTENDANCE TRACKING
// ==========================================

async function scheduleMeeting(groupId, meetingDate, notes) {
  const result = await pool.query(
    `INSERT INTO vicoba_meetings (group_id, meeting_date, notes)
     VALUES ($1, $2, $3)
     ON CONFLICT (group_id, meeting_date) DO UPDATE SET notes = EXCLUDED.notes
     RETURNING *`,
    [groupId, meetingDate, notes || null]
  );
  return result.rows[0];
}

async function recordAttendance(meetingId, userId, status, notes) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const meetingRes = await client.query(
      'SELECT * FROM vicoba_meetings WHERE id = $1 FOR UPDATE',
      [meetingId]
    );
    if (meetingRes.rows.length === 0) throw Object.assign(new Error('Mkutano haupatikani.'), { statusCode: 404 });
    const meeting = meetingRes.rows[0];

    const memberRes = await client.query(
      'SELECT * FROM vicoba_members WHERE group_id = $1 AND user_id = $2',
      [meeting.group_id, userId]
    );
    if (memberRes.rows.length === 0) throw Object.assign(new Error('Mwanachama haupo kwenye kikundi hiki.'), { statusCode: 403 });

    const existing = await client.query(
      'SELECT id FROM vicoba_meeting_attendance WHERE meeting_id = $1 AND user_id = $2',
      [meetingId, userId]
    );
    if (existing.rows.length > 0) {
      await client.query(
        'UPDATE vicoba_meeting_attendance SET status = $1, notes = $2 WHERE meeting_id = $3 AND user_id = $4',
        [status || 'PRESENT', notes || null, meetingId, userId]
      );
      await client.query('COMMIT');
      return { success: true, message: 'Hali ya ushiriki imesasishwa.' };
    }

    let fineApplied = 0;
    let finePenaltyId = null;
    if (status === 'ABSENT') {
      const constitution = await client.query(
        'SELECT fine_per_absence FROM vicoba_group_constitutions WHERE group_id = $1',
        [meeting.group_id]
      );
      if (constitution.rows.length > 0) {
        fineApplied = constitution.rows[0].fine_per_absence;
      }
    } else if (status === 'LATE') {
      const constitution = await client.query(
        'SELECT fine_per_late_arrival FROM vicoba_group_constitutions WHERE group_id = $1',
        [meeting.group_id]
      );
      if (constitution.rows.length > 0) {
        fineApplied = constitution.rows[0].fine_per_late_arrival;
      }
    }

    if (fineApplied > 0) {
      const penRes = await client.query(
        `INSERT INTO vicoba_penalties (group_id, user_id, penalty_type, amount, reason, status)
         VALUES ($1, $2, 'MEETING_ABSENCE', $3, $4, 'UNPAID') RETURNING id`,
        [meeting.group_id, userId, fineApplied, `Meeting absence/late on ${meeting.meeting_date}`]
      );
      finePenaltyId = penRes.rows[0].id;
    }

    await client.query(
      `INSERT INTO vicoba_meeting_attendance (meeting_id, user_id, status, fine_applied, fine_penalty_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [meetingId, userId, status || 'PRESENT', fineApplied, finePenaltyId, notes || null]
    );

    if (status === 'PRESENT' || status === 'LATE') {
      await client.query(
        'UPDATE vicoba_members SET meetings_attended = meetings_attended + 1 WHERE group_id = $1 AND user_id = $2',
        [meeting.group_id, userId]
      );
    } else {
      await client.query(
        'UPDATE vicoba_members SET meetings_missed = meetings_missed + 1 WHERE group_id = $1 AND user_id = $2',
        [meeting.group_id, userId]
      );
    }

    await client.query('COMMIT');
    return { success: true, fineApplied, finePenaltyId, message: fineApplied > 0 ? `Ushiriki umerekodwa. Faini: TSh ${formatMoney(fineApplied)}` : 'Ushiriki umerekodwa.' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function bulkRecordAttendance(meetingId, attendanceList) {
  const results = [];
  for (const entry of attendanceList) {
    const result = await recordAttendance(meetingId, entry.userId, entry.status, entry.notes);
    results.push({ userId: entry.userId, ...result });
  }
  return results;
}

async function getMeetingAttendance(meetingId) {
  const result = await pool.query(
    `SELECT maa.*, u.full_name, u.phone_number
     FROM vicoba_meeting_attendance maa
     JOIN users u ON u.id = maa.user_id
     WHERE maa.meeting_id = $1
     ORDER BY maa.status DESC, u.full_name`,
    [meetingId]
  );
  return result.rows;
}

async function getMemberAttendanceSummary(groupId, userId) {
  const member = await pool.query(
    `SELECT vm.user_id, u.full_name, vm.meetings_attended, vm.meetings_missed,
            (SELECT COUNT(*) FROM vicoba_meetings WHERE group_id = $1) as total_meetings,
            (SELECT COALESCE(SUM(p.amount), 0) FROM vicoba_penalties p
             JOIN vicoba_meeting_attendance maa ON maa.fine_penalty_id = p.id
             WHERE maa.user_id = $2 AND maa.meeting_id IN (SELECT id FROM vicoba_meetings WHERE group_id = $1)
             AND p.status = 'PAID') as total_fines_paid
     FROM vicoba_members vm
     JOIN users u ON u.id = vm.user_id
     WHERE vm.group_id = $1 AND vm.user_id = $2`,
    [groupId, userId]
  );
  return member.rows[0] || null;
}

async function getGroupAttendanceReport(groupId, cycleNumber) {
  let query = `SELECT vm.user_id, u.full_name,
                      vm.meetings_attended, vm.meetings_missed,
                      (SELECT COUNT(*) FROM vicoba_meetings WHERE group_id = $1) as total_meetings,
                      COALESCE(SUM(maa.fine_applied), 0) as total_fines,
                      COUNT(CASE WHEN maa.status = 'PRESENT' THEN 1 END) as present_count,
                      COUNT(CASE WHEN maa.status = 'ABSENT' THEN 1 END) as absent_count,
                      COUNT(CASE WHEN maa.status = 'LATE' THEN 1 END) as late_count
               FROM vicoba_members vm
               JOIN users u ON u.id = vm.user_id
               LEFT JOIN vicoba_meeting_attendance maa ON maa.user_id = vm.user_id
                 AND maa.meeting_id IN (SELECT id FROM vicoba_meetings WHERE group_id = $1)
               WHERE vm.group_id = $1
               GROUP BY vm.user_id, u.full_name, vm.meetings_attended, vm.meetings_missed
               ORDER BY u.full_name`;
  const result = await pool.query(query, [groupId]);
  return result.rows;
}

// ==========================================
// ADVANCED REPORTING
// ==========================================

async function getGroupFinancialSummary(groupId) {
  const group = await pool.query(
    `SELECT g.*,
            (SELECT COUNT(*) FROM vicoba_members WHERE group_id = $1) as member_count,
            (SELECT COALESCE(SUM(share_capital), 0) FROM vicoba_members WHERE group_id = $1) as total_share_capital,
            (SELECT COALESCE(SUM(total_shares), 0) FROM vicoba_members WHERE group_id = $1) as total_shares,
            (SELECT COALESCE(SUM(amount), 0) FROM vicoba_member_contributions mc
             JOIN vicoba_contribution_schedules cs ON cs.id = mc.schedule_id
             WHERE cs.group_id = $1) as total_contributions,
            (SELECT COALESCE(SUM(requested_amount), 0) FROM vicoba_loan_requests WHERE group_id = $1 AND status IN ('APPROVED','DISBURSED')) as total_loans_outstanding,
            (SELECT COALESCE(SUM(total_repaid), 0) FROM vicoba_loan_requests WHERE group_id = $1) as total_loan_repayments,
            (SELECT COALESCE(SUM(amount), 0) FROM vicoba_penalties WHERE group_id = $1) as total_penalties,
            (SELECT COALESCE(SUM(amount), 0) FROM vicoba_penalties WHERE group_id = $1 AND status = 'PAID') as penalties_collected,
            (SELECT COALESCE(SUM(total_profit_earned), 0) FROM vicoba_members WHERE group_id = $1) as total_profits_distributed,
            (SELECT COALESCE(total_profit_pool, 0) FROM vicoba_groups WHERE id = $1) as profit_pool
     FROM vicoba_groups g WHERE g.id = $1`,
    [groupId]
  );
  return group.rows[0] || null;
}

async function getMemberFinancialSummary(groupId, userId) {
  const result = await pool.query(
    `SELECT vm.*, u.full_name, u.phone_number,
            (SELECT COALESCE(SUM(mc.amount), 0) FROM vicoba_member_contributions mc
             JOIN vicoba_contribution_schedules cs ON cs.id = mc.schedule_id
             WHERE cs.group_id = $1 AND mc.user_id = $2) as total_contributions,
            (SELECT COALESCE(SUM(lr.requested_amount), 0) FROM vicoba_loan_requests lr
             WHERE lr.group_id = $1 AND lr.applicant_user_id = $2 AND lr.status IN ('APPROVED','DISBURSED')) as total_borrowed,
            (SELECT COALESCE(SUM(lrp.amount), 0) FROM vicoba_loan_repayments lrp
             JOIN vicoba_loan_requests lr ON lr.id = lrp.loan_id
             WHERE lr.group_id = $1 AND lrp.user_id = $2) as total_repaid,
            (SELECT COUNT(*) FROM vicoba_penalties WHERE group_id = $1 AND user_id = $2) as total_penalties,
            (SELECT COUNT(*) FROM vicoba_penalties WHERE group_id = $1 AND user_id = $2 AND status = 'PAID') as penalties_paid,
            (SELECT COUNT(*) FROM vicoba_share_purchases WHERE group_id = $1 AND user_id = $2) as share_purchases_count
     FROM vicoba_members vm
     JOIN users u ON u.id = vm.user_id
     WHERE vm.group_id = $1 AND vm.user_id = $2`,
    [groupId, userId]
  );
  return result.rows[0] || null;
}

async function getLoanAgingReport(groupId) {
  const result = await pool.query(
    `SELECT lr.*, u.full_name, u.phone_number,
            ls.due_date as next_due_date_val,
            (lr.outstanding_balance) as outstanding,
            CASE
              WHEN lr.outstanding_balance <= 0 THEN 'CLEARED'
              WHEN ls.due_date < CURRENT_DATE THEN 'OVERDUE'
              WHEN ls.due_date <= CURRENT_DATE + INTERVAL '7 days' THEN 'DUE_SOON'
              ELSE 'CURRENT'
            END as aging_status,
            CASE
              WHEN ls.due_date < CURRENT_DATE THEN CURRENT_DATE - ls.due_date
              ELSE 0
            END as days_overdue
     FROM vicoba_loan_requests lr
     JOIN users u ON u.id = lr.applicant_user_id
     LEFT JOIN vicoba_loan_schedules ls ON ls.loan_id = lr.id AND ls.status IN ('PENDING','LATE','OVERDUE')
       AND ls.id = (SELECT id FROM vicoba_loan_schedules WHERE loan_id = lr.id AND status IN ('PENDING','LATE','OVERDUE') ORDER BY installment_number ASC LIMIT 1)
     WHERE lr.group_id = $1 AND lr.status IN ('DISBURSED','REPAID')
     ORDER BY
       CASE WHEN lr.outstanding_balance <= 0 THEN 1 ELSE 0 END,
       days_overdue DESC`,
    [groupId]
  );
  return result.rows;
}

module.exports = {
  createConstitution,
  getConstitution,
  buyShares,
  getSharePurchases,
  getMemberShareSummary,
  calculateProfitDistribution,
  approveProfitDistribution,
  getProfitDistributions,
  getMyProfitPayouts,
  initiateTransfer,
  verifyTransfer,
  approveTransfer,
  listTransfers,
  processCrossNetworkTopUp,
  scheduleMeeting,
  recordAttendance,
  bulkRecordAttendance,
  getMeetingAttendance,
  getMemberAttendanceSummary,
  getGroupAttendanceReport,
  getGroupFinancialSummary,
  getMemberFinancialSummary,
  getLoanAgingReport,
};
