const express = require('express');
const countryService = require('../services/countryService');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// Auth: all active countries with regulatory/licensing snapshot (UI + corridors)
router.get('/', authRequired, async (req, res, next) => {
  try {
    const countries = await countryService.listCountries(true);
    return res.json({
      success: true,
      countries: countries.map((c) => ({
        code: c.code,
        name: c.name,
        currency: c.currency,
        region: c.region,
        callingCode: c.calling_code,
        license: {
          status: c.regulatory_license_status,
          name: c.regulatory_license_name
        },
        ussd: {
          shortcode: c.ussd_shortcode,
          status: c.ussd_shortcode_status
        }
      }))
    });
  } catch (error) {
    next(error);
  }
});

// Auth: my country's regulatory config + today's usage against the daily cap
router.get('/me', authRequired, async (req, res, next) => {
  try {
    const country = await countryService.getCountryForUser(req.user.id);
    if (!country) {
      return res.status(404).json({ success: false, message: res.t('COUNTRY_NOT_FOUND'), code: 'COUNTRY_NOT_FOUND' });
    }
    const config = await countryService.getRegulatoryConfig(country);
    const used = await countryService.getDailyUsage({ userId: req.user.id, countryCode: country.code });
    const remaining = config.maxDailyTransferLimit == null
      ? null : Math.max(0, config.maxDailyTransferLimit - used);
    return res.json({ success: true, ...config, todayUsage: used, remaining });
  } catch (error) {
    next(error);
  }
});

module.exports = router;