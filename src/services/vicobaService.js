const pool = require('../config/db');
const config = require('../config');
const crypto = require('crypto');
const { generateReference, formatMoney, toInternationalFormat } = require('../utils/helpers');
const { sendSMS } = require('./smsService');
const { logAudit } = require('./auditService');
const logger = require('../utils/logger');
const fin = require('./financialEngine');

function generateJoinCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

async function createGroup(userId, { groupName, cycleType, shareValue, monthlyMaintenanceFee }) {
  if (parseFloat(shareValue) <= 0) {
    throw Object.assign(new Error('Bei ya hisa lazima iwe kubwa kuliko 0.'), { statusCode: 400 });
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const joinCode = generateJoinCode();
    try {
      const result = await pool.query(
        `INSERT INTO vicoba_groups
          (group_name, cycle_type, share_value, monthly_maintenance_fee, created_by_user_id, join_code)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [groupName, cycleType, shareValue, monthlyMaintenanceFee || config.fees.vicobaMonthlyFee, userId, joinCode]
      );
      const group = result.rows[0];

      await pool.query(
        `INSERT INTO vicoba_members (group_id, user_id, role_in_group)
         VALUES ($1, $2, 'MWENYEKITI')`,
        [group.id, userId]
      );
      return group;
    } catch (error) {
      if (error.code === '23505') continue;
      throw error;
    }
  }
  throw new Error('Imeshindikana kuzalisha msimbo wa kikundi. Jaribu tena.');
}

async function addMember(actorUserId, groupId, userId, roleInGroup = 'MJUMBE') {
  const roleRes = await pool.query(
    'SELECT role_in_group FROM vicoba_members WHERE group_id = $1 AND user_id = $2',
    [groupId, actorUserId]
  );
  const allowed = ['MWENYEKITI', 'MWEKAHAZINA', 'KATIBU'];
  if (roleRes.rows.length === 0 || !allowed.includes(roleRes.rows[0].role_in_group)) {
    throw Object.assign(new Error('Viongozi wa kikundi pekee wanaweza kuongeza wanachama.'), { statusCode: 403 });
  }

  const member = await pool.query(
    `INSERT INTO vicoba_members (group_id, user_id, role_in_group)
     VALUES ($1, $2, $3)
     ON CONFLICT (group_id, user_id) DO NOTHING
     RETURNING *`,
    [groupId, userId, roleInGroup]
  );
  if (member.rows.length === 0) throw new Error('Mwanachama tayari yupo kwenye kikundi.');
  return member.rows[0];
}

async function contributeShares(groupId, userId, amount, sharesCount) {
  const amountNum = parseFloat(amount);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const memberRes = await client.query(
      `SELECT vm.*, u.phone_number, u.full_name
       FROM vicoba_members vm
       JOIN users u ON u.id = vm.user_id
       WHERE vm.group_id = $1 AND vm.user_id = $2`,
      [groupId, userId]
    );
    if (memberRes.rows.length === 0) {
      throw Object.assign(new Error('Hauko kwenye kikundi hiki.'), { statusCode: 403 });
    }
    const member = memberRes.rows[0];

    const referenceId = generateReference('VS');
    const tx = await client.query(
      `INSERT INTO transactions
        (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'VICOBA_SHARE', $4)
       RETURNING id`,
      [referenceId, userId, amountNum, JSON.stringify({ group_id: groupId })]
    );

    await fin.walletToGroup({ client, userId, groupId, groupAccount: 'VICOBA_GROUP', groupSql: 'UPDATE vicoba_groups SET group_wallet_balance = group_wallet_balance + $1 WHERE id = $2', amount: amountNum, reference: `${referenceId}:WG`, description: 'VICOBA Share Contribution' });
    await client.query(
      `UPDATE vicoba_members SET total_shares = total_shares + $1, contribution_balance = contribution_balance + $2
       WHERE group_id = $3 AND user_id = $4`,
      [sharesCount || 1, amountNum, groupId, userId]
    );

    await client.query(
      `INSERT INTO wallet_ledger (transaction_id, reference_id, from_user_id, to_user_id, amount, description)
       VALUES ($1, $2, $3, NULL, $4, 'VICOBA Share Contribution')`,
      [tx.rows[0].id, referenceId, userId, amountNum]
    );

    await client.query('COMMIT');
    await logAudit({ eventType: 'VICOBA_SHARE', action: 'CREATE', entityType: 'VICOBA_SHARE', userId, referenceId, amount: amountNum, afterData: { group_id: groupId, shares: sharesCount || 1 } });
    const msg = `Habari ${member.full_name}, umeweka hisa za ${formatMoney(amountNum)} kwenye VICOBA.`;
    await sendSMS(member.phone_number, msg);
    return { success: true, referenceId, message: 'Hisa zimewekwa.' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function requestLoan(chairmanUserId, { groupId, applicantUserId, requestedAmount, interestRate, repaymentMonths }) {
  const roleRes = await pool.query(
    'SELECT role_in_group FROM vicoba_members WHERE group_id = $1 AND user_id = $2',
    [groupId, chairmanUserId]
  );
  const allowed = ['MWENYEKITI', 'MWEKAHAZINA', 'KATIBU'];
  if (roleRes.rows.length === 0 || !allowed.includes(roleRes.rows[0].role_in_group)) {
    throw Object.assign(new Error('Mwenyekiti au Katibu ndiye anayeweza kuongeza ombi la mkopo.'), { statusCode: 403 });
  }

  const result = await pool.query(
    `INSERT INTO vicoba_loan_requests
      (group_id, applicant_user_id, requested_amount, interest_rate, repayment_months, chairman_approval, chairman_approved_by)
     VALUES ($1, $2, $3, $4, $5, TRUE, $6)
     RETURNING *`,
    [groupId, applicantUserId, requestedAmount, interestRate || 10, repaymentMonths || 3, chairmanUserId]
  );
  return result.rows[0];
}

async function approveLoan(approverUserId, loanId, approvedAmount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const roleRes = await client.query(
      `SELECT vm.role_in_group, g.group_name, u.phone_number, u.full_name, u.id as applicant_id
       FROM vicoba_loan_requests lr
       JOIN vicoba_members vm ON vm.group_id = lr.group_id AND vm.user_id = $1
       JOIN vicoba_groups g ON g.id = lr.group_id
       JOIN users u ON u.id = lr.applicant_user_id
       WHERE lr.id = $2
       FOR UPDATE OF lr`,
      [approverUserId, loanId]
    );
    if (roleRes.rows.length === 0) {
      throw Object.assign(new Error('Hauko kwenye kikundi husika.'), { statusCode: 403 });
    }
    const ctx = roleRes.rows[0];
    if (ctx.role_in_group !== 'MWEKAHAZINA' && ctx.role_in_group !== 'KATIBU') {
      throw Object.assign(new Error('Mwekahazina au Katibu ndiye anayeidhinisha kiasi.'), { statusCode: 403 });
    }

    const loanRes = await client.query(
      'SELECT * FROM vicoba_loan_requests WHERE id = $1 FOR UPDATE',
      [loanId]
    );
    const loan = loanRes.rows[0];
    if (loan.status !== 'PENDING') {
      throw Object.assign(new Error('Ombi hili tayari limechakatwa.'), { statusCode: 400 });
    }
    if (!loan.chairman_approval) {
      throw Object.assign(new Error('Ombi bado halijaidhinishwa na Mwenyekiti.'), { statusCode: 400 });
    }

    const finalAmount = approvedAmount || loan.requested_amount;
    if (finalAmount > loan.requested_amount) {
      throw Object.assign(new Error('Kiasi kilichoidhinishwa hakizidi kilichoombwa.'), { statusCode: 400 });
    }

    await client.query(
      `UPDATE vicoba_loan_requests
       SET approved_amount = $1, treasurer_approval = TRUE, treasurer_approved_by = $2, status = 'APPROVED', updated_at = NOW()
       WHERE id = $3`,
      [finalAmount, approverUserId, loanId]
    );

    const referenceId = generateReference('VL');
    await client.query(
      `INSERT INTO transactions
        (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'VICOBA_LOAN', $4)`,
      [referenceId, ctx.applicant_id, finalAmount, JSON.stringify({ group_id: loan.group_id, loan_id: loanId })]
    );

    await fin.groupToWallet({ client, userId: ctx.applicant_id, groupId: loan.group_id, groupAccount: 'VICOBA_GROUP', groupSql: 'UPDATE vicoba_groups SET group_wallet_balance = group_wallet_balance - $1 WHERE id = $2', amount: finalAmount, reference: `${referenceId}:GW`, description: 'VICOBA Loan Disbursement' });
    await client.query(
      'UPDATE vicoba_loan_requests SET status = $1, updated_at = NOW() WHERE id = $2',
      ['DISBURSED', loanId]
    );

    await client.query('COMMIT');
    await logAudit({ eventType: 'VICOBA_LOAN', action: 'APPROVE', entityType: 'VICOBA_LOAN', userId: approverUserId, entityId: loanId, referenceId, amount: finalAmount, afterData: { group_id: loan.group_id, applicant: loan.applicant_user_id } });

    // Generate repayment schedule after commit
    await generateLoanSchedule(loanId, loan.group_id, finalAmount, loan.interest_rate, loan.repayment_months);

    const msg = `Habari ${ctx.full_name}, mkopo wako wa ${formatMoney(finalAmount)} umetolewa kwenye wallet yako. Asante ${ctx.group_name}.`;
    await sendSMS(ctx.phone_number, msg);
    return { success: true, referenceId, amount: finalAmount, message: 'Mkopo umetolewa kwenye wallet ya mwombaji.' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function chargeMaintenanceFee(groupId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const groupRes = await client.query(
      'SELECT id, group_name, monthly_maintenance_fee, group_wallet_balance FROM vicoba_groups WHERE id = $1 FOR UPDATE',
      [groupId]
    );
    if (groupRes.rows.length === 0) throw new Error('Kikundi hakijapatikana.');
    const group = groupRes.rows[0];
    if (Number(group.group_wallet_balance) < Number(group.monthly_maintenance_fee)) {
      throw new Error('Salio la kikundi halitoshi kulipia ada ya huduma.');
    }

    await fin.postJournal({
      client,
      lines: [
        { accountCode: 'VICOBA_GROUP', direction: 'DR', amount: Number(group.monthly_maintenance_fee) },
        { accountCode: 'PLATFORM_FEES', direction: 'CR', amount: Number(group.monthly_maintenance_fee) },
      ],
      referenceId: `MF:${groupId}`,
      description: 'VICOBA Maintenance Fee',
    });
    await client.query(
      'UPDATE vicoba_groups SET group_wallet_balance = group_wallet_balance - $1 WHERE id = $2',
      [group.monthly_maintenance_fee, groupId]
    );
    await client.query(
      `UPDATE company_revenue SET total_maintenance_fees = total_maintenance_fees + $1, updated_at = NOW()
       WHERE id = 1`,
      [group.monthly_maintenance_fee]
    );
    await client.query('COMMIT');
    logger.info('VICOBA', `Maintenance fee ${group.monthly_maintenance_fee} imekatwa kwa ${group.group_name}`);
    return { success: true, amount: group.monthly_maintenance_fee };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function joinByCode(userId, joinCode) {
  const code = String(joinCode).trim().toUpperCase();
  const groupRes = await pool.query('SELECT * FROM vicoba_groups WHERE join_code = $1', [code]);
  if (groupRes.rows.length === 0) {
    throw Object.assign(new Error('Msimbo wa kikundi si sahihi.'), { statusCode: 404 });
  }
  const group = groupRes.rows[0];

  const existing = await pool.query(
    'SELECT 1 FROM vicoba_members WHERE group_id = $1 AND user_id = $2',
    [group.id, userId]
  );
  if (existing.rows.length > 0) {
    throw Object.assign(new Error('Tayari uko kwenye kikundi hiki.'), { statusCode: 400 });
  }

  const userRes = await pool.query('SELECT phone_number, full_name FROM users WHERE id = $1', [userId]);
  const user = userRes.rows[0];

  const member = await pool.query(
    `INSERT INTO vicoba_members (group_id, user_id, role_in_group)
     VALUES ($1, $2, 'MJUMBE')
     RETURNING *`,
    [group.id, userId]
  );

  await pool.query(
    `UPDATE vicoba_invites
     SET status = 'ACCEPTED', joined_user_id = $1
     WHERE group_id = $2 AND phone_number = $3 AND status = 'SENT'`,
    [userId, group.id, user.phone_number]
  );

  const chairman = await pool.query(
    `SELECT u.phone_number, u.full_name
     FROM vicoba_members vm
     JOIN users u ON u.id = vm.user_id
     WHERE vm.group_id = $1 AND vm.role_in_group = 'MWENYEKITI'`,
    [group.id]
  );
  if (chairman.rows.length > 0) {
    const msg = `Habari, ${user.full_name} amejiunga na kikundi chako cha ${group.group_name} kwa msimbo wa kikundi.`;
    await sendSMS(chairman.rows[0].phone_number, msg);
  }

  return { success: true, group, member: member.rows[0], message: `Umejiunga na ${group.group_name}.` };
}

async function inviteMembers(inviterUserId, groupId, phoneNumbers) {
  const roleRes = await pool.query(
    'SELECT role_in_group FROM vicoba_members WHERE group_id = $1 AND user_id = $2',
    [groupId, inviterUserId]
  );
  const allowed = ['MWENYEKITI', 'MWEKAHAZINA', 'KATIBU'];
  if (roleRes.rows.length === 0 || !allowed.includes(roleRes.rows[0].role_in_group)) {
    throw Object.assign(new Error('Viongozi wa kikundi ndio wanaoweza kutuma mialiko.'), { statusCode: 403 });
  }

  const groupRes = await pool.query('SELECT * FROM vicoba_groups WHERE id = $1', [groupId]);
  if (groupRes.rows.length === 0) throw new Error('Kikundi hakijapatikana.');
  const group = groupRes.rows[0];

  const sent = [];
  for (const rawPhone of phoneNumbers) {
    const phone = toInternationalFormat(rawPhone);
    await pool.query(
      'INSERT INTO vicoba_invites (group_id, phone_number) VALUES ($1, $2)',
      [groupId, phone]
    );
    const msg = `AFRIKOBA: Umealikwa kujiunga na kikundi cha VICOBA "${group.group_name}". Ingia AFRIKOBA, nenda VICOBA, weka msimbo wa kujiunga: ${group.join_code}.`;
    await sendSMS(phone, msg);
    sent.push(phone);
  }
  return { success: true, invited: sent.length, phones: sent, joinCode: group.join_code };
}

async function getGroupDetails(groupId, requesterUserId) {
  const group = await pool.query('SELECT * FROM vicoba_groups WHERE id = $1', [groupId]);
  if (group.rows.length === 0) throw new Error('Kikundi hakijapatikana.');
  const members = await pool.query(
    `SELECT vm.user_id, u.full_name, u.phone_number, vm.role_in_group, vm.total_shares,
            vm.social_fund_balance, vm.contribution_balance, vm.joined_at
     FROM vicoba_members vm
     JOIN users u ON u.id = vm.user_id
     WHERE vm.group_id = $1`,
    [groupId]
  );

  const detail = { ...group.rows[0], members: members.rows };
  if (requesterUserId) {
    const myRole = members.rows.find((m) => m.user_id === requesterUserId)?.role_in_group;
    const isLeader = ['MWENYEKITI', 'MWEKAHAZINA', 'KATIBU'].includes(myRole);
    if (!isLeader) delete detail.join_code;
  }
  return detail;
}

async function listUserGroups(userId) {
  const result = await pool.query(
    `SELECT g.*, vm.role_in_group
     FROM vicoba_groups g
     JOIN vicoba_members vm ON vm.group_id = g.id
     WHERE vm.user_id = $1
     ORDER BY g.created_at DESC`,
    [userId]
  );
  const LEADER_ROLES = ['MWENYEKITI', 'MWEKAHAZINA', 'KATIBU'];
  return result.rows.map((g) => {
    if (LEADER_ROLES.includes(g.role_in_group)) return g;
    const { join_code, ...rest } = g;
    return rest;
  });
}

async function listGroupLoans(groupId) {
  const result = await pool.query(
    `SELECT lr.*, u.full_name, u.phone_number
     FROM vicoba_loan_requests lr
     JOIN users u ON u.id = lr.applicant_user_id
     WHERE lr.group_id = $1
     ORDER BY lr.created_at DESC`,
    [groupId]
  );
  return result.rows;
}

// ==========================================
// CONTRIBUTION SCHEDULES & PENALTIES
// ==========================================

async function createContributionSchedule(groupId, cycleNumber, dueDate) {
  const result = await pool.query(
    `INSERT INTO vicoba_contribution_schedules (group_id, cycle_number, due_date)
     VALUES ($1, $2, $3)
     ON CONFLICT (group_id, cycle_number) DO NOTHING
     RETURNING *`,
    [groupId, cycleNumber, dueDate]
  );
  return result.rows[0] || null;
}

async function payContribution(groupId, userId, cycleNumber, amount, sharesCount) {
  const amountNum = parseFloat(amount);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const scheduleRes = await client.query(
      'SELECT * FROM vicoba_contribution_schedules WHERE group_id = $1 AND cycle_number = $2 FOR UPDATE',
      [groupId, cycleNumber]
    );
    if (scheduleRes.rows.length === 0) {
      throw Object.assign(new Error('Mzunguko huu haupo.'), { statusCode: 404 });
    }
    const schedule = scheduleRes.rows[0];

    const alreadyPaid = await client.query(
      'SELECT 1 FROM vicoba_member_contributions WHERE schedule_id = $1 AND user_id = $2',
      [schedule.id, userId]
    );
    if (alreadyPaid.rows.length > 0) {
      throw Object.assign(new Error('Umeshalipa mzunguku huu.'), { statusCode: 400 });
    }

    const today = new Date();
    const dueDate = new Date(schedule.due_date);
    const isLate = today > dueDate;

    let penaltyAmount = 0;
    let daysLate = 0;
    if (isLate) {
      const groupRes = await client.query(
        'SELECT penalty_rate, max_penalty_percent, share_value FROM vicoba_groups WHERE id = $1',
        [groupId]
      );
      const group = groupRes.rows[0];
      daysLate = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
      const maxPenalty = (group.max_penalty_percent / 100) * group.share_value;
      penaltyAmount = Math.min((group.penalty_rate / 100) * group.share_value * daysLate, maxPenalty);
      penaltyAmount = Math.round(penaltyAmount * 100) / 100;
    }

    const userRes = await client.query(
      'SELECT phone_number, full_name FROM users WHERE id = $1',
      [userId]
    );
    const user = userRes.rows[0];
    const totalDeduct = amountNum + penaltyAmount;

    const referenceId = generateReference('VC');
    await fin.walletToGroup({ client, userId, groupId, groupAccount: 'VICOBA_GROUP', groupSql: 'UPDATE vicoba_groups SET group_wallet_balance = group_wallet_balance + $1 WHERE id = $2', amount: amountNum, reference: `${referenceId}:WG`, description: 'VICOBA Contribution' });
    if (penaltyAmount > 0) {
      await fin.debitWallet({ client, userId, amount: penaltyAmount, reference: `${referenceId}:DR`, toAccount: 'PLATFORM_FEES', description: 'VICOBA Late Penalty' });
    }

    const tx = await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'VICOBA_SHARE', $4)
       RETURNING id`,
      [referenceId, userId, totalDeduct, JSON.stringify({ group_id: groupId, cycle: cycleNumber, penalty: penaltyAmount })]
    );

    await client.query(
      `INSERT INTO vicoba_member_contributions (schedule_id, group_id, user_id, amount, shares_count, is_late, penalty_paid)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [schedule.id, groupId, userId, amountNum, sharesCount || 1, isLate, penaltyAmount]
    );

    await client.query(
      `UPDATE vicoba_members SET total_shares = total_shares + $1, contribution_balance = contribution_balance + $2
       WHERE group_id = $3 AND user_id = $4`,
      [sharesCount || 1, amountNum, groupId, userId]
    );

    if (penaltyAmount > 0) {
      await client.query(
        `INSERT INTO vicoba_penalties (group_id, user_id, penalty_type, amount, reason, related_schedule_id, status)
         VALUES ($1, $2, 'LATE_CONTRIBUTION', $3, $4, $5, 'UNPAID')`,
        [groupId, userId, penaltyAmount, `Late payment for cycle ${cycleNumber} (${daysLate} days late)`, schedule.id]
      );
      await client.query(
        `UPDATE company_revenue SET updated_at = NOW() WHERE id = 1`
      );
    }

    await client.query(
      `INSERT INTO wallet_ledger (transaction_id, reference_id, from_user_id, to_user_id, amount, description)
       VALUES ($1, $2, $3, NULL, $4, 'VICOBA Contribution')`,
      [tx.rows[0].id, referenceId, userId, amountNum]
    );

    await client.query('COMMIT');

    const msg = isLate
      ? `Habari ${user.full_name}, umelipa mchango wa TSh ${formatMoney(amountNum)} + faini ya TSh ${formatMoney(penaltyAmount)} kwa kuchelewa siku ${daysLate}.`
      : `Habari ${user.full_name}, umelipa mchango wa TSh ${formatMoney(amountNum)} kwa mzunguko ${cycleNumber}.`;
    await sendSMS(user.phone_number, msg);

    return { success: true, referenceId, isLate, penaltyAmount, message: isLate ? 'Mchango umelipwa na faini.' : 'Mchango umefanikiwa.' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function checkOverdueContributions(groupId) {
  const today = new Date().toISOString().split('T')[0];
  const result = await pool.query(
    `UPDATE vicoba_contribution_schedules SET status = 'OVERDUE'
     WHERE group_id = $1 AND status = 'PENDING' AND due_date < $2
     RETURNING *`,
    [groupId, today]
  );
  return result.rows;
}

async function getContributionSchedules(groupId) {
  const result = await pool.query(
    `SELECT cs.*,
            (SELECT COUNT(*) FROM vicoba_member_contributions mc WHERE mc.schedule_id = cs.id) as paid_count,
            (SELECT COALESCE(SUM(mc.amount), 0) FROM vicoba_member_contributions mc WHERE mc.schedule_id = cs.id) as total_collected
     FROM vicoba_contribution_schedules cs
     WHERE cs.group_id = $1
     ORDER BY cs.cycle_number DESC`,
    [groupId]
  );
  return result.rows;
}

// ==========================================
// PENALTIES
// ==========================================

async function listPenalties(groupId, status = 'UNPAID') {
  const result = await pool.query(
    `SELECT p.*, u.full_name, u.phone_number
     FROM vicoba_penalties p
     JOIN users u ON u.id = p.user_id
     WHERE p.group_id = $1 AND p.status = $2
     ORDER BY p.created_at DESC`,
    [groupId, status]
  );
  return result.rows;
}

async function payPenalty(userId, penaltyId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const penaltyRes = await client.query(
      'SELECT * FROM vicoba_penalties WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [penaltyId, userId]
    );
    if (penaltyRes.rows.length === 0) {
      throw Object.assign(new Error('Faini haipo au si yako.'), { statusCode: 404 });
    }
    const penalty = penaltyRes.rows[0];
    if (penalty.status === 'PAID') {
      throw Object.assign(new Error('Faini tayari imelipwa.'), { statusCode: 400 });
    }

    const userRes = await client.query('SELECT phone_number, full_name FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    const referenceId = generateReference('VP');
    await fin.debitWallet({ client, userId, amount: penalty.amount, reference: `${referenceId}:DR`, toAccount: 'PLATFORM_FEES', description: 'VICOBA Penalty Payment' });
    await client.query("UPDATE vicoba_penalties SET status = 'PAID', paid_at = NOW() WHERE id = $1", [penaltyId]);

    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'VICOBA_PENALTY', $4)`,
      [referenceId, userId, penalty.amount, JSON.stringify({ group_id: penalty.group_id, penalty_id: penaltyId })]
    );

    await client.query('COMMIT');

    await sendSMS(user.phone_number, `Habari ${user.full_name}, umelipa faini ya TSh ${formatMoney(penalty.amount)}.`);
    return { success: true, referenceId, message: 'Faini imelipwa.' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function waivePenalty(actorUserId, penaltyId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const roleRes = await client.query(
      `SELECT vm.role_in_group FROM vicoba_penalties p
       JOIN vicoba_members vm ON vm.group_id = p.group_id AND vm.user_id = $1
       WHERE p.id = $2`,
      [actorUserId, penaltyId]
    );
    if (roleRes.rows.length === 0 || !['MWENYEKITI', 'MWEKAHAZINA'].includes(roleRes.rows[0].role_in_group)) {
      throw Object.assign(new Error('Mwenyekiti au Mwekahazina pekee anaweza kuondoa faini.'), { statusCode: 403 });
    }

    const penaltyRes = await client.query('SELECT * FROM vicoba_penalties WHERE id = $1', [penaltyId]);
    if (penaltyRes.rows.length === 0) throw Object.assign(new Error('Faini haipo.'), { statusCode: 404 });
    if (penaltyRes.rows[0].status === 'PAID') {
      throw Object.assign(new Error('Faini tayari imelipwa, haiwezi kuondolewa.'), { statusCode: 400 });
    }

    await client.query(
      "UPDATE vicoba_penalties SET status = 'WAIVED', waived_by = $1 WHERE id = $2",
      [actorUserId, penaltyId]
    );

    await client.query('COMMIT');
    return { success: true, message: 'Faini imeondolewa.' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ==========================================
// SOCIAL FUND (Msiba / Family Events)
// ==========================================

async function initSocialFund(groupId, monthlyContribution) {
  const amount = parseFloat(monthlyContribution);
  if (amount <= 0) throw Object.assign(new Error('Kiasi lazima iwe zaidi ya 0.'), { statusCode: 400 });

  const existing = await pool.query('SELECT 1 FROM vicoba_social_fund WHERE group_id = $1', [groupId]);
  if (existing.rows.length > 0) {
    throw Object.assign(new Error('Familia ya kijamii tayari imeanzishwa kwenye kikundi hiki.'), { statusCode: 400 });
  }

  const result = await pool.query(
    `INSERT INTO vicoba_social_fund (group_id, monthly_contribution)
     VALUES ($1, $2) RETURNING *`,
    [groupId, amount]
  );
  return result.rows[0];
}

async function contributeSocialFund(groupId, userId, month) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const fundRes = await client.query(
      'SELECT * FROM vicoba_social_fund WHERE group_id = $1 FOR UPDATE',
      [groupId]
    );
    if (fundRes.rows.length === 0) {
      throw Object.assign(new Error('Familia ya kijamii haipo kwenye kikundi hiki.'), { statusCode: 404 });
    }
    const fund = fundRes.rows[0];

    const existing = await client.query(
      'SELECT 1 FROM vicoba_social_fund_contributions WHERE fund_id = $1 AND user_id = $2 AND month = $3',
      [fund.id, userId, month]
    );
    if (existing.rows.length > 0) {
      throw Object.assign(new Error('Umeshachanga kwa mwezi huu.'), { statusCode: 400 });
    }

    const userRes = await client.query('SELECT phone_number, full_name FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    const referenceId = generateReference('SF');
    await fin.walletToGroup({ client, userId, groupId: fund.id, groupAccount: 'VICOBA_GROUP', groupSql: 'UPDATE vicoba_social_fund SET total_balance = total_balance + $1, total_collected = total_collected + $1 WHERE id = $2', amount: fund.monthly_contribution, reference: `${referenceId}:WG`, description: 'VICOBA Social Fund Contribution' });
    await client.query(
      `UPDATE vicoba_members SET social_fund_balance = social_fund_balance + $1 WHERE group_id = $2 AND user_id = $3`,
      [fund.monthly_contribution, groupId, userId]
    );

    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'VICOBA_SOCIAL_FUND', $4)`,
      [referenceId, userId, fund.monthly_contribution, JSON.stringify({ group_id: groupId, month })]
    );

    await client.query(
      `INSERT INTO vicoba_social_fund_contributions (group_id, fund_id, user_id, amount, month)
       VALUES ($1, $2, $3, $4, $5)`,
      [groupId, fund.id, userId, fund.monthly_contribution, month]
    );

    await client.query('COMMIT');
    await logAudit({ eventType: 'VICOBA_SOCIAL_FUND', action: 'CREATE', entityType: 'VICOBA_SOCIAL_FUND', userId, referenceId, amount: fund.monthly_contribution, afterData: { group_id: groupId, month } });

    await sendSMS(user.phone_number, `Habari ${user.full_name}, umechanga TSh ${formatMoney(fund.monthly_contribution)} kwenye mfuko wa kijamii kwa mwezi ${month}.`);
    return { success: true, referenceId, message: 'Mchango wa kijamii umefanikiwa.' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function requestSocialFundDisbursement(groupId, userId, { reasonType, reasonDetail, requestedAmount }) {
  const amount = parseFloat(requestedAmount);
  const fundRes = await pool.query('SELECT * FROM vicoba_social_fund WHERE group_id = $1', [groupId]);
  if (fundRes.rows.length === 0) {
    throw Object.assign(new Error('Familia ya kijamii haipo.'), { statusCode: 404 });
  }
  const fund = fundRes.rows[0];
  if (amount > fund.total_balance) {
    throw Object.assign(new Error(`Salio la mfuko ni TSh ${formatMoney(fund.total_balance)} - haileti TSh ${formatMoney(amount)}.`), { statusCode: 400 });
  }

  const result = await pool.query(
    `INSERT INTO vicoba_social_fund_requests (group_id, fund_id, requester_id, reason_type, reason_detail, requested_amount)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [groupId, fund.id, userId, reasonType, reasonDetail, amount]
  );
  return result.rows[0];
}

async function approveSocialFundDisbursement(actorUserId, requestId, approvedAmount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const requestRes = await client.query(
      `SELECT sfr.*, sf.total_balance
       FROM vicoba_social_fund_requests sfr
       JOIN vicoba_social_fund sf ON sf.id = sfr.fund_id
       WHERE sfr.id = $1 FOR UPDATE`,
      [requestId]
    );
    if (requestRes.rows.length === 0) throw Object.assign(new Error('Ombi halipo.'), { statusCode: 404 });
    const request = requestRes.rows[0];
    if (request.status !== 'PENDING') {
      throw Object.assign(new Error('Ombi tayari limechakatwa.'), { statusCode: 400 });
    }

    const roleRes = await client.query(
      'SELECT role_in_group FROM vicoba_members WHERE group_id = $1 AND user_id = $2',
      [request.group_id, actorUserId]
    );
    if (roleRes.rows.length === 0 || !['MWENYEKITI', 'MWEKAHAZINA'].includes(roleRes.rows[0].role_in_group)) {
      throw Object.assign(new Error('Mwenyekiti au Mwekahazina pekee anaweza kuthibitisha.'), { statusCode: 403 });
    }

    const finalAmount = approvedAmount || request.requested_amount;
    if (finalAmount > request.requested_amount) {
      throw Object.assign(new Error('Kiasi kilichoidhinishwa hakizidi kilichoombwa.'), { statusCode: 400 });
    }
    if (finalAmount > request.total_balance) {
      throw Object.assign(new Error('Salio la mfuko halitoshi.'), { statusCode: 400 });
    }

    const requesterRes = await client.query('SELECT phone_number, full_name FROM users WHERE id = $1', [request.requester_id]);

    await client.query(
      `UPDATE vicoba_social_fund_requests SET approved_amount = $1, approved_by = $2, status = 'APPROVED', updated_at = NOW() WHERE id = $3`,
      [finalAmount, actorUserId, requestId]
    );
    const referenceId = generateReference('SD');
    await fin.groupToWallet({ client, userId: request.requester_id, groupId: request.fund_id, groupAccount: 'VICOBA_GROUP', groupSql: 'UPDATE vicoba_social_fund SET total_balance = total_balance - $1, total_disbursed = total_disbursed + $1 WHERE id = $2', amount: finalAmount, reference: `${referenceId}:GW`, description: 'VICOBA Social Fund Disbursement' });

    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'VICOBA_SOCIAL_FUND_DISBURSEMENT', $4)`,
      [referenceId, request.requester_id, finalAmount, JSON.stringify({ group_id: request.group_id, request_id: requestId, reason_type: request.reason_type })]
    );

    await client.query("UPDATE vicoba_social_fund_requests SET status = 'DISBURSED', disbursement_reference = $1 WHERE id = $2", [referenceId, requestId]);

    await client.query('COMMIT');
    await logAudit({ eventType: 'VICOBA_SOCIAL_FUND_DISBURSEMENT', action: 'RELEASE', entityType: 'VICOBA_SOCIAL_FUND_REQUEST', userId: actorUserId, entityId: requestId, referenceId, amount: finalAmount, afterData: { group_id: request.group_id, requester: request.requester_id, reason_type: request.reason_type } });

    if (requesterRes.rows.length > 0) {
      const reasonMsg = request.reason_type === 'DEATH' ? 'msiba' : request.reason_type === 'WEDDING' ? 'harusi' : 'tukio la kifamilia';
      await sendSMS(
        requesterRes.rows[0].phone_number,
        `Habari ${requesterRes.rows[0].full_name}, ombi lako la TSh ${formatMoney(finalAmount)} kwa ajili ya ${reasonMsg} limekubalika. Fedha zimewekwa kwenye wallet yako.`
      );
    }

    return { success: true, referenceId, amount: finalAmount, message: 'Ombi limekubalika na fedha zimetolewa.' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function rejectSocialFundDisbursement(actorUserId, requestId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const requestRes = await client.query(
      'SELECT * FROM vicoba_social_fund_requests WHERE id = $1 FOR UPDATE',
      [requestId]
    );
    if (requestRes.rows.length === 0) throw Object.assign(new Error('Ombi halipo.'), { statusCode: 404 });
    const request = requestRes.rows[0];
    if (request.status !== 'PENDING') {
      throw Object.assign(new Error('Ombi tayari limechakatwa.'), { statusCode: 400 });
    }

    const roleRes = await client.query(
      'SELECT role_in_group FROM vicoba_members WHERE group_id = $1 AND user_id = $2',
      [request.group_id, actorUserId]
    );
    if (roleRes.rows.length === 0 || !['MWENYEKITI', 'MWEKAHAZINA'].includes(roleRes.rows[0].role_in_group)) {
      throw Object.assign(new Error('Mwenyekiti au Mwekahazina pekee anaweza kukataa.'), { statusCode: 403 });
    }

    await client.query(
      "UPDATE vicoba_social_fund_requests SET status = 'REJECTED', approved_by = $1, updated_at = NOW() WHERE id = $2",
      [actorUserId, requestId]
    );

    await client.query('COMMIT');
    return { success: true, message: 'Ombi limekataliwa.' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getSocialFundDetails(groupId) {
  const fund = await pool.query('SELECT * FROM vicoba_social_fund WHERE group_id = $1', [groupId]);
  if (fund.rows.length === 0) return null;

  const contributions = await pool.query(
    `SELECT sfc.*, u.full_name
     FROM vicoba_social_fund_contributions sfc
     JOIN users u ON u.id = sfc.user_id
     WHERE sfc.group_id = $1
     ORDER BY sfc.paid_at DESC`,
    [groupId]
  );

  const requests = await pool.query(
    `SELECT sfr.*, u.full_name as requester_name
     FROM vicoba_social_fund_requests sfr
     JOIN users u ON u.id = sfr.requester_id
     WHERE sfr.group_id = $1
     ORDER BY sfr.created_at DESC`,
    [groupId]
  );

  return {
    fund: fund.rows[0],
    contributions: contributions.rows,
    requests: requests.rows,
  };
}

// ==========================================
// LOAN REPAYMENT
// ==========================================

async function generateLoanSchedule(loanId, groupId, amount, interestRate, repaymentMonths) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const totalWithInterest = amount * (1 + (interestRate / 100));
    const monthlyPrincipal = amount / repaymentMonths;
    const monthlyInterest = (amount * interestRate / 100) / repaymentMonths;
    const monthlyTotal = monthlyPrincipal + monthlyInterest;

    const today = new Date();
    for (let i = 1; i <= repaymentMonths; i++) {
      const dueDate = new Date(today);
      dueDate.setMonth(dueDate.getMonth() + i);

      await client.query(
        `INSERT INTO vicoba_loan_schedules (loan_id, group_id, installment_number, due_date, principal_amount, interest_amount, total_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [loanId, groupId, i, dueDate.toISOString().split('T')[0], monthlyPrincipal.toFixed(2), monthlyInterest.toFixed(2), monthlyTotal.toFixed(2)]
      );
    }

    const firstDue = new Date(today);
    firstDue.setMonth(firstDue.getMonth() + 1);
    await client.query(
      `UPDATE vicoba_loan_requests SET outstanding_balance = $1, next_due_date = $2 WHERE id = $3`,
      [totalWithInterest.toFixed(2), firstDue.toISOString().split('T')[0], loanId]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function repayLoan(userId, loanId, amount, note) {
  const amountNum = parseFloat(amount);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const loanRes = await client.query(
      'SELECT * FROM vicoba_loan_requests WHERE id = $1 AND applicant_user_id = $2 FOR UPDATE',
      [loanId, userId]
    );
    if (loanRes.rows.length === 0) {
      throw Object.assign(new Error('Mkopo haupo au si wako.'), { statusCode: 404 });
    }
    const loan = loanRes.rows[0];
    if (loan.status !== 'DISBURSED') {
      throw Object.assign(new Error('Mkopo haujaondolewa au tayari umelipwa.'), { statusCode: 400 });
    }

    const userRes = await client.query('SELECT phone_number, full_name FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const user = userRes.rows[0];

    // Find next pending installment
    const scheduleRes = await client.query(
      "SELECT * FROM vicoba_loan_schedules WHERE loan_id = $1 AND status IN ('PENDING', 'LATE', 'OVERDUE') ORDER BY installment_number ASC LIMIT 1 FOR UPDATE",
      [loanId]
    );
    if (scheduleRes.rows.length === 0) {
      throw Object.assign(new Error('Hakuna deni la kulipa.'), { statusCode: 400 });
    }
    const schedule = scheduleRes.rows[0];

    // Check for late repayment penalty
    const today = new Date();
    const dueDate = new Date(schedule.due_date);
    let penaltyAmount = 0;
    let isLate = today > dueDate;
    if (isLate) {
      const groupRes = await client.query(
        'SELECT penalty_rate, max_penalty_percent, share_value FROM vicoba_groups WHERE id = $1',
        [loan.group_id]
      );
      const group = groupRes.rows[0];
      const daysLate = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
      const maxPenalty = (group.max_penalty_percent / 100) * schedule.total_amount;
      penaltyAmount = Math.min((group.penalty_rate / 100) * schedule.total_amount * daysLate, maxPenalty);
      penaltyAmount = Math.round(penaltyAmount * 100) / 100;
    }

    const totalDeduct = amountNum + penaltyAmount;

    const referenceId = generateReference('LR');
    await fin.walletToGroup({ client, userId, groupId: loan.group_id, groupAccount: 'VICOBA_GROUP', groupSql: 'UPDATE vicoba_groups SET group_wallet_balance = group_wallet_balance + $1 WHERE id = $2', amount: amountNum, reference: `${referenceId}:WG`, description: 'VICOBA Loan Repayment' });
    if (penaltyAmount > 0) {
      await fin.debitWallet({ client, userId, amount: penaltyAmount, reference: `${referenceId}:DR`, toAccount: 'PLATFORM_FEES', description: 'VICOBA Late Loan Penalty' });
    }

    // Update schedule
    const newPaid = Number(schedule.paid_amount) + amountNum;
    const scheduleStatus = newPaid >= Number(schedule.total_amount) ? 'PAID' : (isLate ? 'LATE' : 'PENDING');
    if (scheduleStatus === 'PAID') {
      await client.query(
        'UPDATE vicoba_loan_schedules SET paid_amount = $1, status = $2, paid_at = NOW() WHERE id = $3',
        [newPaid, scheduleStatus, schedule.id]
      );
    } else {
      await client.query(
        'UPDATE vicoba_loan_schedules SET paid_amount = $1, status = $2 WHERE id = $3',
        [newPaid, scheduleStatus, schedule.id]
      );
    }

    // Update loan totals
    const newTotalRepaid = Number(loan.total_repaid) + amountNum;
    const newOutstanding = Number(loan.outstanding_balance) - amountNum;
    await client.query(
      'UPDATE vicoba_loan_requests SET total_repaid = $1, outstanding_balance = $2 WHERE id = $3',
      [newTotalRepaid, Math.max(0, newOutstanding), loanId]
    );

    // Check if loan is fully repaid
    if (newOutstanding <= 0) {
      await client.query("UPDATE vicoba_loan_requests SET status = 'REPAID' WHERE id = $1", [loanId]);
    }

    // Record penalty if late
    if (penaltyAmount > 0) {
      await client.query(
        `INSERT INTO vicoba_penalties (group_id, user_id, penalty_type, amount, reason, related_loan_id, status)
         VALUES ($1, $2, 'LATE_LOAN_REPAYMENT', $3, $4, $5, 'UNPAID')`,
        [loan.group_id, userId, penaltyAmount, `Late repayment for installment ${schedule.installment_number}`, loanId]
      );
    }

    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'VICOBA_LOAN_REPAYMENT', $4)`,
      [referenceId, userId, totalDeduct, JSON.stringify({ group_id: loan.group_id, loan_id: loanId, penalty: penaltyAmount })]
    );

    await client.query(
      `INSERT INTO vicoba_loan_repayments (loan_id, schedule_id, user_id, amount, reference_id, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [loanId, schedule.id, userId, amountNum, referenceId, note || null]
    );

    await client.query('COMMIT');
    await logAudit({ eventType: 'VICOBA_LOAN_REPAYMENT', action: 'CREATE', entityType: 'VICOBA_LOAN_REPAYMENT', userId, entityId: loanId, referenceId, amount: amountNum, afterData: { group_id: loan.group_id, outstanding: Math.max(0, newOutstanding) } });

    const msg = isLate
      ? `Habari ${user.full_name}, umelipa deni la TSh ${formatMoney(amountNum)} + faini ya TSh ${formatMoney(penaltyAmount)}. Salio inayobaki: TSh ${formatMoney(Math.max(0, newOutstanding))}.`
      : `Habari ${user.full_name}, umelipa deni la TSh ${formatMoney(amountNum)}. Salio inayobaki: TSh ${formatMoney(Math.max(0, newOutstanding))}.`;
    await sendSMS(user.phone_number, msg);

    return {
      success: true, referenceId, isLate, penaltyAmount,
      remainingBalance: Math.max(0, newOutstanding),
      fullyRepaid: newOutstanding <= 0,
      message: newOutstanding <= 0 ? 'Mkopo umelipwa kikamilifu!' : 'Malipo yamepokewa.',
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getLoanSchedule(loanId) {
  const result = await pool.query(
    `SELECT ls.*, lr.applicant_user_id, u.full_name
     FROM vicoba_loan_schedules ls
     JOIN vicoba_loan_requests lr ON lr.id = ls.loan_id
     JOIN users u ON u.id = lr.applicant_user_id
     WHERE ls.loan_id = $1
     ORDER BY ls.installment_number ASC`,
    [loanId]
  );
  return result.rows;
}

async function getLoanRepayments(loanId) {
  const result = await pool.query(
    `SELECT lr.*, u.full_name
     FROM vicoba_loan_repayments lr
     JOIN users u ON u.id = lr.user_id
     WHERE lr.loan_id = $1
     ORDER BY lr.created_at DESC`,
    [loanId]
  );
  return result.rows;
}

module.exports = {
  createGroup,
  addMember,
  joinByCode,
  inviteMembers,
  contributeShares,
  requestLoan,
  approveLoan,
  chargeMaintenanceFee,
  getGroupDetails,
  listUserGroups,
  listGroupLoans,
  createContributionSchedule,
  payContribution,
  checkOverdueContributions,
  getContributionSchedules,
  listPenalties,
  payPenalty,
  waivePenalty,
  initSocialFund,
  contributeSocialFund,
  requestSocialFundDisbursement,
  approveSocialFundDisbursement,
  rejectSocialFundDisbursement,
  getSocialFundDetails,
  generateLoanSchedule,
  repayLoan,
  getLoanSchedule,
  getLoanRepayments,
};
