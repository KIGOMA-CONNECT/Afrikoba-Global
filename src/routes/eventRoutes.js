const express = require('express');
const eventService = require('../services/eventService');
const governanceService = require('../services/governanceService');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

router.use(authRequired);

// Four-eyes executor: when an admin approves a high-value event withdrawal,
// actually move the money from the event pool back to the recipient wallet.
governanceService.registerExecutor('EVENT_WITHDRAWAL', async (payload) => {
  return eventService.executeEventWithdrawal(payload);
});

// Jiunge na tukio kupitia kodi ya mwaliko (inserted before /:eventId so 'join' is not parsed as an event id)
router.post('/join', async (req, res, next) => {
  try {
    const result = await eventService.joinEventByCode(req.user.id, req.body.code);
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// Unda tukio (Harusi, send-off, mahafali...)
router.post('/', async (req, res, next) => {
  try {
    const event = await eventService.createEvent(req.user.id, req.body);
    return res.status(201).json({ success: true, event });
  } catch (error) {
    next(error);
  }
});

// Orodha ya matukio aliyoendesha au kuchangia
router.get('/', async (req, res, next) => {
  try {
    const events = await eventService.listUserEvents(req.user.id);
    return res.json({ success: true, events });
  } catch (error) {
    next(error);
  }
});

// Maelezo ya tukio
router.get('/:eventId', async (req, res, next) => {
  try {
    const event = await eventService.getEventContents(req.user.id, parseInt(req.params.eventId, 10));
    return res.json({ success: true, event });
  } catch (error) {
    next(error);
  }
});

// Sasisha tukio
router.patch('/:eventId', async (req, res, next) => {
  try {
    const event = await eventService.updateEvent(req.user.id, parseInt(req.params.eventId, 10), req.body);
    return res.json({ success: true, event });
  } catch (error) {
    next(error);
  }
});

// Changia/weka kidogo kwenye tukio
router.post('/:eventId/contributions', async (req, res, next) => {
  try {
    const result = await eventService.contribute(req.user.id, parseInt(req.params.eventId, 10), req.body);
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// Orodha ya michango ya tukio
router.get('/:eventId/contributions', async (req, res, next) => {
  try {
    const contributions = await eventService.listContributions(parseInt(req.params.eventId, 10), req.query);
    return res.json({ success: true, contributions });
  } catch (error) {
    next(error);
  }
});

// Ingiza kipengele cha bajeti
router.post('/:eventId/budget', async (req, res, next) => {
  try {
    const item = await eventService.addBudgetItem(req.user.id, parseInt(req.params.eventId, 10), req.body);
    return res.status(201).json({ success: true, item });
  } catch (error) {
    next(error);
  }
});

// Bajeti ya tukio
router.get('/:eventId/budget', async (req, res, next) => {
  try {
    const items = await eventService.listBudget(parseInt(req.params.eventId, 10));
    return res.json({ success: true, items });
  } catch (error) {
    next(error);
  }
});

// Ondoa kipengele cha bajeti
router.delete('/:eventId/budget/:itemId', async (req, res, next) => {
  try {
    const result = await eventService.deleteBudgetItem(req.user.id, parseInt(req.params.eventId, 10), parseInt(req.params.itemId, 10));
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// Dashibodi: muhtasari wa tukio (lengo, mchango, bajeti, ahadi, mipango)
router.get('/:eventId/dashboard', async (req, res, next) => {
  try {
    const dashboard = await eventService.eventDashboard(parseInt(req.params.eventId, 10));
    return res.json({ success: true, dashboard });
  } catch (error) {
    next(error);
  }
});

// Ahadi (commitment): toa ahadi ya kuchangia
router.post('/:eventId/commitments', async (req, res, next) => {
  try {
    const commitment = await eventService.makeCommitment(req.user.id, parseInt(req.params.eventId, 10), req.body);
    return res.status(201).json({ success: true, commitment });
  } catch (error) {
    next(error);
  }
});

// Orodha ya ahadi za tukio
router.get('/:eventId/commitments', async (req, res, next) => {
  try {
    const commitments = await eventService.listCommitments(parseInt(req.params.eventId, 10));
    return res.json({ success: true, commitments });
  } catch (error) {
    next(error);
  }
});

// Ghairi ahadi
router.post('/:eventId/commitments/:commitmentId/cancel', async (req, res, next) => {
  try {
    const result = await eventService.cancelCommitment(req.user.id, parseInt(req.params.eventId, 10), parseInt(req.params.commitmentId, 10));
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// Unda mpango wa akiba (collaborative savings plan)
router.post('/:eventId/savings-plans', async (req, res, next) => {
  try {
    const plan = await eventService.createSavingsPlan(req.user.id, parseInt(req.params.eventId, 10), req.body);
    return res.status(201).json({ success: true, plan });
  } catch (error) {
    next(error);
  }
});

// Mipango ya akiba ya tukio
router.get('/:eventId/savings-plans', async (req, res, next) => {
  try {
    const plans = await eventService.listSavingsPlans(parseInt(req.params.eventId, 10));
    return res.json({ success: true, plans });
  } catch (error) {
    next(error);
  }
});

// Funga/kamilisha mpango wa akiba
router.post('/:eventId/savings-plans/:planId/close', async (req, res, next) => {
  try {
    const plan = await eventService.closeSavingsPlan(req.user.id, parseInt(req.params.eventId, 10), parseInt(req.params.planId, 10));
    return res.json({ success: true, plan });
  } catch (error) {
    next(error);
  }
});

// Omba uondoaji wa fedha za tukio
router.post('/:eventId/withdrawals', async (req, res, next) => {
  try {
    const result = await eventService.requestEventWithdrawal(req.user.id, parseInt(req.params.eventId, 10), req.body);
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// Uondoaji wa tukio
router.get('/:eventId/withdrawals', async (req, res, next) => {
  try {
    const withdrawals = await eventService.listEventWithdrawals(parseInt(req.params.eventId, 10), req.query);
    return res.json({ success: true, withdrawals });
  } catch (error) {
    next(error);
  }
});

// Ghairi uondoaji (kabla ya kuchakata)
router.post('/:eventId/withdrawals/:withdrawalId/cancel', async (req, res, next) => {
  try {
    const result = await eventService.cancelEventWithdrawal(req.user.id, parseInt(req.params.eventId, 10), parseInt(req.params.withdrawalId, 10));
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// Unda mwaliko wa kujiunga (invite code)
router.post('/:eventId/invites', async (req, res, next) => {
  try {
    const invite = await eventService.createInvite(req.user.id, parseInt(req.params.eventId, 10), req.body);
    return res.status(201).json({ success: true, invite });
  } catch (error) {
    next(error);
  }
});

// Mialiko ya tukio
router.get('/:eventId/invites', async (req, res, next) => {
  try {
    const invites = await eventService.listInvites(req.user.id, parseInt(req.params.eventId, 10));
    return res.json({ success: true, invites });
  } catch (error) {
    next(error);
  }
});

// Ongeza mwanachama kwa namba ya simu
router.post('/:eventId/members', async (req, res, next) => {
  try {
    const result = await eventService.addMemberByPhone(req.user.id, parseInt(req.params.eventId, 10), req.body);
    return res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

// Wanachama wa tukio
router.get('/:eventId/members', async (req, res, next) => {
  try {
    const members = await eventService.listEventMembers(parseInt(req.params.eventId, 10));
    return res.json({ success: true, members });
  } catch (error) {
    next(error);
  }
});

// Ondoa mwanachama
router.delete('/:eventId/members/:userId', async (req, res, next) => {
  try {
    const result = await eventService.removeMember(req.user.id, parseInt(req.params.eventId, 10), parseInt(req.params.userId, 10));
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// Kumbusho za tukio
router.get('/:eventId/reminders', async (req, res, next) => {
  try {
    const reminders = await eventService.listEventReminders(parseInt(req.params.eventId, 10));
    return res.json({ success: true, reminders });
  } catch (error) {
    next(error);
  }
});

module.exports = router;