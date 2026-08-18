const pool = require('../config/db');
const config = require('../config');
const crypto = require('crypto');
const { generateReference, formatMoney, toInternationalFormat } = require('../utils/helpers');
const { sendSMS } = require('./smsService');
const logger = require('../utils/logger');

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

/**
 * Kuweka hisa/akiba (Share Contribution) - fedha inatoka wallet ya mwanachama
 * kwenda Group Wallet ya VICOBA
 */
async function contributeShares(groupId, userId, amount, sharesCount) {
  const amountNum = parseFloat(amount);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const memberRes = await client.query(
      `SELECT vm.*, u.wallet_balance, u.phone_number, u.full_name
       FROM vicoba_members vm
       JOIN users u ON u.id = vm.user_id
       WHERE vm.group_id = $1 AND vm.user_id = $2
       FOR UPDATE OF u`,
      [groupId, userId]
    );
    if (memberRes.rows.length === 0) {
      throw Object.assign(new Error('Hauko kwenye kikundi hiki.'), { statusCode: 403 });
    }
    const member = memberRes.rows[0];
    if (Number(member.wallet_balance) < amountNum) {
      throw Object.assign(new Error('Salio la wallet lako halitoshi.'), { statusCode: 400 });
    }

    const referenceId = generateReference('VS');
    const tx = await client.query(
      `INSERT INTO transactions
        (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'VICOBA_SHARE', $4)
       RETURNING id`,
      [referenceId, userId, amountNum, JSON.stringify({ group_id: groupId })]
    );

    await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [amountNum, userId]);
    await client.query('UPDATE vicoba_groups SET group_wallet_balance = group_wallet_balance + $1 WHERE id = $2', [amountNum, groupId]);
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

/**
 * Multi-Sig Loan Workflow:
 * 1) MWENYEKITI anapendekeza/ana-add ombi la mkopo kwa mwanachama
 * 2) KATIBU/MWEKAHAZINA anathibitisha kiasi (2nd Approver)
 * 3) Mfumo unapatia fedha moja kwa moja kwenye Wallet au MNO ya mwombaji
 */
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

    await client.query(
      'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2',
      [finalAmount, ctx.applicant_id]
    );
    await client.query(
      'UPDATE vicoba_groups SET group_wallet_balance = group_wallet_balance - $1 WHERE id = $2',
      [finalAmount, loan.group_id]
    );
    await client.query(
      'UPDATE vicoba_loan_requests SET status = $1, updated_at = NOW() WHERE id = $2',
      ['DISBURSED', loanId]
    );

    await client.query('COMMIT');

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

/**
 * Monthly Maintenance Fee (SaaS) inakatwa kutoka Group Wallet kwenda company_revenue
 */
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

/**
 * Jiunge na kikundi kwa msimbo wa kikundi (join code)
 */
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

/**
 * Mwenyekiti/Katibu anatuma mialiko ya SMS kwa wanachama (wanaokubali kwa msimbo)
 */
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
};
