const express = require('express');
const serviceService = require('../services/serviceService');

const router = express.Router();

// Matangazo ya huduma (public - salama kutumika nje ya mfumo: ads, landing pages, banners)
router.get('/offers', (req, res, next) => {
  try {
    const offers = serviceService.getMarketingCatalog();
    res.json({
      success: true,
      offers,
      share: 'Afrikoba Global - Digital Banking & Upatu. https://afrikoba.com',
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
