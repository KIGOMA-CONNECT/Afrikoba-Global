const express = require('express');
const eventService = require('../services/eventService');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

router.use(authRequired);

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

// Dashibodi: muhtasari wa tukio (lengo, mchango, bajeti)
router.get('/:eventId/dashboard', async (req, res, next) => {
  try {
    const dashboard = await eventService.eventDashboard(parseInt(req.params.eventId, 10));
    return res.json({ success: true, dashboard });
  } catch (error) {
    next(error);
  }
});

module.exports = router;