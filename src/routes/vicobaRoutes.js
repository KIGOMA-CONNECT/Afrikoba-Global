const express = require('express');
const vicobaService = require('../services/vicobaService');
const { authRequired } = require('../middleware/auth');
const { requireService } = require('../middleware/serviceGuard');
const { validate } = require('../middleware/validate');
const schemas = require('../validations/schemas');

const router = express.Router();

router.use(authRequired);
router.use(requireService('VICOBA'));

// Unda kikundi cha VICOBA
router.post('/groups', validate(schemas.vicoba.createGroup), async (req, res, next) => {
  try {
    const { groupName, cycleType, shareValue, monthlyMaintenanceFee } = req.body;
    const group = await vicobaService.createGroup(req.user.id, {
      groupName,
      cycleType,
      shareValue,
      monthlyMaintenanceFee,
    });
    return res.status(201).json({ success: true, group });
  } catch (error) {
    next(error);
  }
});

// Jiunge na kikundi kwa msimbo wa kujiunga (join code)
router.post('/groups/join', validate(schemas.vicoba.join), async (req, res, next) => {
  try {
    const { joinCode } = req.body;
    const result = await vicobaService.joinByCode(req.user.id, joinCode);
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// Mwenyekiti/Katibu: tuma mialiko ya SMS kwa wanachama
router.post('/groups/:groupId/invite', validate(schemas.vicoba.invite), async (req, res, next) => {
  try {
    const { phoneNumbers } = req.body;
    const result = await vicobaService.inviteMembers(
      req.user.id,
      parseInt(req.params.groupId, 10),
      phoneNumbers
    );
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// Ongeza mwanachama kwenye kikundi (viongozi pekee)
router.post('/groups/:groupId/members', async (req, res, next) => {
  try {
    const { userId, roleInGroup } = req.body;
    const member = await vicobaService.addMember(req.user.id, parseInt(req.params.groupId, 10), userId, roleInGroup);
    return res.status(201).json({ success: true, member });
  } catch (error) {
    next(error);
  }
});

// Weka hisa (Share Contribution)
router.post('/groups/:groupId/contribute', async (req, res, next) => {
  try {
    const { amount, sharesCount } = req.body;
    const result = await vicobaService.contributeShares(
      parseInt(req.params.groupId, 10),
      req.user.id,
      amount,
      sharesCount
    );
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// Mwenyekiti: ongeza ombi la mkopo kwa mwanachama
router.post('/groups/:groupId/loans', async (req, res, next) => {
  try {
    const { applicantUserId, requestedAmount, interestRate, repaymentMonths } = req.body;
    const loan = await vicobaService.requestLoan(req.user.id, {
      groupId: parseInt(req.params.groupId, 10),
      applicantUserId,
      requestedAmount,
      interestRate,
      repaymentMonths,
    });
    return res.status(201).json({ success: true, loan });
  } catch (error) {
    next(error);
  }
});

// Mwekahazina/Katibu: idhinisha na kutoa mkopo (2nd Approver)
router.post('/loans/:loanId/approve', async (req, res, next) => {
  try {
    const { approvedAmount } = req.body;
    const result = await vicobaService.approveLoan(req.user.id, parseInt(req.params.loanId, 10), approvedAmount);
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// Orodha ya vikundi vya mtumiaji
router.get('/groups', async (req, res, next) => {
  try {
    const groups = await vicobaService.listUserGroups(req.user.id);
    return res.json({ success: true, groups });
  } catch (error) {
    next(error);
  }
});

// Mikopo ya kikundi
router.get('/groups/:groupId/loans', async (req, res, next) => {
  try {
    const loans = await vicobaService.listGroupLoans(parseInt(req.params.groupId, 10));
    return res.json({ success: true, loans });
  } catch (error) {
    next(error);
  }
});

// Maelezo ya kikundi
router.get('/groups/:groupId', async (req, res, next) => {
  try {
    const details = await vicobaService.getGroupDetails(parseInt(req.params.groupId, 10), req.user.id);
    return res.json({ success: true, group: details });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// CONTRIBUTION SCHEDULES
// ==========================================

// Create contribution schedule (MWENYEKITI/MWEKAHAZINA/KATIBU)
router.post('/groups/:groupId/schedules', validate(schemas.vicoba.createSchedule), async (req, res, next) => {
  try {
    const { cycleNumber, dueDate } = req.body;
    const schedule = await vicobaService.createContributionSchedule(
      parseInt(req.params.groupId, 10),
      cycleNumber,
      dueDate
    );
    return res.status(201).json({ success: true, schedule });
  } catch (error) {
    next(error);
  }
});

// Pay contribution for a cycle (checks if late, applies penalty)
router.post('/groups/:groupId/schedules/:cycleNumber/pay', validate(schemas.vicoba.payContribution), async (req, res, next) => {
  try {
    const { amount, sharesCount } = req.body;
    const result = await vicobaService.payContribution(
      parseInt(req.params.groupId, 10),
      req.user.id,
      parseInt(req.params.cycleNumber, 10),
      amount,
      sharesCount
    );
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// List contribution schedules for a group
router.get('/groups/:groupId/schedules', async (req, res, next) => {
  try {
    const schedules = await vicobaService.getContributionSchedules(parseInt(req.params.groupId, 10));
    return res.json({ success: true, schedules });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// PENALTIES
// ==========================================

// List penalties for a group
router.get('/groups/:groupId/penalties', async (req, res, next) => {
  try {
    const status = req.query.status || 'UNPAID';
    const penalties = await vicobaService.listPenalties(parseInt(req.params.groupId, 10), status);
    return res.json({ success: true, penalties });
  } catch (error) {
    next(error);
  }
});

// Pay a penalty
router.post('/penalties/:penaltyId/pay', async (req, res, next) => {
  try {
    const result = await vicobaService.payPenalty(req.user.id, parseInt(req.params.penaltyId, 10));
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// Waive a penalty (MWENYEKITI/MWEKAHAZINA only)
router.post('/penalties/:penaltyId/waive', async (req, res, next) => {
  try {
    const result = await vicobaService.waivePenalty(req.user.id, parseInt(req.params.penaltyId, 10));
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// ==========================================
// SOCIAL FUND (Msiba / Family Events)
// ==========================================

// Initialize social fund for a group (MWENYEKITI)
router.post('/groups/:groupId/social-fund', validate(schemas.vicoba.socialFund), async (req, res, next) => {
  try {
    const { monthlyContribution } = req.body;
    const fund = await vicobaService.initSocialFund(
      parseInt(req.params.groupId, 10),
      monthlyContribution
    );
    return res.status(201).json({ success: true, fund });
  } catch (error) {
    next(error);
  }
});

// Contribute to social fund
router.post('/groups/:groupId/social-fund/contribute', validate(schemas.vicoba.socialFundContribute), async (req, res, next) => {
  try {
    const { month } = req.body;
    const result = await vicobaService.contributeSocialFund(
      parseInt(req.params.groupId, 10),
      req.user.id,
      month
    );
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// Request disbursement from social fund
router.post('/groups/:groupId/social-fund/request', validate(schemas.vicoba.socialFundRequest), async (req, res, next) => {
  try {
    const { reasonType, reasonDetail, requestedAmount } = req.body;
    const result = await vicobaService.requestSocialFundDisbursement(
      parseInt(req.params.groupId, 10),
      req.user.id,
      { reasonType, reasonDetail, requestedAmount }
    );
    return res.status(201).json({ success: true, request: result });
  } catch (error) {
    next(error);
  }
});

// Approve social fund disbursement (MWENYEKITI/MWEKAHAZINA)
router.post('/social-fund-requests/:requestId/approve', async (req, res, next) => {
  try {
    const { approvedAmount } = req.body;
    const result = await vicobaService.approveSocialFundDisbursement(
      req.user.id,
      parseInt(req.params.requestId, 10),
      approvedAmount
    );
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// Reject social fund disbursement (MWENYEKITI/MWEKAHAZINA)
router.post('/social-fund-requests/:requestId/reject', async (req, res, next) => {
  try {
    const result = await vicobaService.rejectSocialFundDisbursement(
      req.user.id,
      parseInt(req.params.requestId, 10)
    );
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// Get social fund details
router.get('/groups/:groupId/social-fund', async (req, res, next) => {
  try {
    const details = await vicobaService.getSocialFundDetails(parseInt(req.params.groupId, 10));
    return res.json({ success: true, socialFund: details });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// LOAN REPAYMENT
// ==========================================

// Repay loan installment
router.post('/loans/:loanId/repay', validate(schemas.vicoba.repayLoan), async (req, res, next) => {
  try {
    const { amount, note } = req.body;
    const result = await vicobaService.repayLoan(req.user.id, parseInt(req.params.loanId, 10), amount, note);
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// Get loan repayment schedule
router.get('/loans/:loanId/schedule', async (req, res, next) => {
  try {
    const schedule = await vicobaService.getLoanSchedule(parseInt(req.params.loanId, 10));
    return res.json({ success: true, schedule });
  } catch (error) {
    next(error);
  }
});

// Get loan repayment history
router.get('/loans/:loanId/repayments', async (req, res, next) => {
  try {
    const repayments = await vicobaService.getLoanRepayments(parseInt(req.params.loanId, 10));
    return res.json({ success: true, repayments });
  } catch (error) {
    next(error);
  }
});

// PATCH /groups/:groupId — Update group settings (chairman only)
router.patch('/groups/:groupId', async (req, res, next) => {
  try {
    const pool = require('../config/db');
    const groupId = parseInt(req.params.groupId, 10);
    const member = await pool.query('SELECT role_in_group FROM vicoba_members WHERE group_id = $1 AND user_id = $2', [groupId, req.user.id]);
    if (member.rows.length === 0 || member.rows[0].role_in_group !== 'MWENYEKITI') {
      return res.status(403).json({ success: false, code: 'AUTH_INSUFFICIENT_SCOPE', message: 'Mwenyekiti pekee anaweza kubadilisha mipangilio.' });
    }
    const { name, contributionAmount, cycleType } = req.body;
    const updates = [];
    const params = [];
    let idx = 1;
    if (name) { updates.push(`group_name = $${idx++}`); params.push(name); }
    if (contributionAmount) { updates.push(`contribution_amount = $${idx++}`); params.push(contributionAmount); }
    if (cycleType) { updates.push(`cycle_type = $${idx++}`); params.push(cycleType); }
    if (updates.length === 0) return res.status(400).json({ success: false, message: 'Hakuna kitu cha kubadilisha.' });
    params.push(groupId);
    await pool.query(`UPDATE vicoba_groups SET ${updates.join(', ')} WHERE id = $${idx}`, params);
    return res.json({ success: true, message: 'Mipangilio imesasishwa.' });
  } catch (error) {
    next(error);
  }
});

// DELETE /groups/:groupId/members/:userId — Remove member (chairman only)
router.delete('/groups/:groupId/members/:userId', async (req, res, next) => {
  try {
    const pool = require('../config/db');
    const groupId = parseInt(req.params.groupId, 10);
    const targetUserId = parseInt(req.params.userId, 10);
    const member = await pool.query('SELECT role_in_group FROM vicoba_members WHERE group_id = $1 AND user_id = $2', [groupId, req.user.id]);
    if (member.rows.length === 0 || member.rows[0].role_in_group !== 'MWENYEKITI') {
      return res.status(403).json({ success: false, code: 'AUTH_INSUFFICIENT_SCOPE', message: 'Mwenyekiti pekee anaweza kuondoa wanachama.' });
    }
    if (req.user.id === targetUserId) {
      return res.status(400).json({ success: false, message: 'Huwezi kuondoa mwenyewe.' });
    }
    await pool.query('DELETE FROM vicoba_members WHERE group_id = $1 AND user_id = $2', [groupId, targetUserId]);
    return res.json({ success: true, message: 'Mwanachama ameondolewa.' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
