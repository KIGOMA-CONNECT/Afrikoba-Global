const express = require('express');
const vicobaService = require('../services/vicobaService');
const { authRequired } = require('../middleware/auth');
const { requireService } = require('../middleware/serviceGuard');

const router = express.Router();

router.use(authRequired);
router.use(requireService('VICOBA'));

// Unda kikundi cha VICOBA
router.post('/groups', async (req, res, next) => {
  try {
    const { groupName, cycleType, shareValue, monthlyMaintenanceFee } = req.body;
    if (!groupName || !cycleType || !shareValue) {
      return res.status(400).json({ success: false, message: 'Jaza groupName, cycleType na shareValue.' });
    }
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
router.post('/groups/join', async (req, res, next) => {
  try {
    const { joinCode } = req.body;
    if (!joinCode) return res.status(400).json({ success: false, message: 'Msimbo wa kujiunga unahitajika.' });
    const result = await vicobaService.joinByCode(req.user.id, joinCode);
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// Mwenyekiti/Katibu: tuma mialiko ya SMS kwa wanachama
router.post('/groups/:groupId/invite', async (req, res, next) => {
  try {
    const { phoneNumbers } = req.body;
    if (!Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
      return res.status(400).json({ success: false, message: 'Taja phoneNumbers (list ya namba za simu).' });
    }
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

module.exports = router;
