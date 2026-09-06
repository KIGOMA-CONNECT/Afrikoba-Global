const express = require('express');
const serviceService = require('../services/serviceService');
const { authRequired } = require('../middleware/auth');
const cache = require('../utils/cache');
const { queryRead } = require('../config/replica');

const router = express.Router();

router.use(authRequired);

// Katalogi ya huduma zote + hali ya usajili wa mtumiaji (cache per-user, 20s)
router.get('/catalog', async (req, res, next) => {
  try {
    const cacheKey = `services:catalog:${req.user.id}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json({ success: true, catalog: cached.source });
    const catalog = await serviceService.getCatalogForUser(req.user.id, queryRead);
    await cache.set(cacheKey, { source: catalog }, 20000);
    res.json({ success: true, catalog });
  } catch (error) {
    next(error);
  }
});

// Jiunge na huduma (subscription)
router.post('/subscribe', async (req, res, next) => {
  try {
    const { serviceKey } = req.body;
    if (!serviceKey) return res.status(400).json({ success: false, message: 'serviceKey inahitajika.' });
    const subscription = await serviceService.subscribe(req.user.id, serviceKey);
    await cache.bust('services:catalog:');
    res.json({ success: true, subscription });
  } catch (error) {
    next(error);
  }
});

// Ondoka kwenye huduma (unsubscribe)
router.post('/unsubscribe', async (req, res, next) => {
  try {
    const { serviceKey } = req.body;
    await serviceService.unsubscribe(req.user.id, serviceKey);
    await cache.bust('services:catalog:');
    res.json({ success: true, message: 'Umeondoka kwenye huduma hiyo.' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
