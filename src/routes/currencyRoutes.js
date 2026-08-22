const express = require('express');
const currencyService = require('../services/currencyService');
const { authRequired, requireRoles } = require('../middleware/auth');

const router = express.Router();

// Public: list currencies
router.get('/currencies', async (req, res, next) => {
  try {
    const currencies = await currencyService.getCurrencies();
    return res.json({ success: true, currencies });
  } catch (error) {
    next(error);
  }
});

// Public: get exchange rate
router.get('/rates/:from/:to', async (req, res, next) => {
  try {
    const rate = await currencyService.getExchangeRate(req.params.from.toUpperCase(), req.params.to.toUpperCase());
    if (!rate) return res.status(404).json({ success: false, message: 'Exchange rate haipatikani.' });
    return res.json({ success: true, ...rate });
  } catch (error) {
    next(error);
  }
});

// Public: convert amount
router.get('/convert', async (req, res, next) => {
  try {
    const { amount, from, to } = req.query;
    if (!amount || !from || !to) {
      return res.status(400).json({ success: false, message: 'amount, from, zinahitajika.' });
    }
    const result = await currencyService.convert(parseFloat(amount), from.toUpperCase(), to.toUpperCase());
    return res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// Auth: get/set user currency
router.get('/my-currency', authRequired, async (req, res, next) => {
  try {
    const currency = await currencyService.getUserCurrency(req.user.id);
    return res.json({ success: true, currency });
  } catch (error) {
    next(error);
  }
});

router.put('/my-currency', authRequired, async (req, res, next) => {
  try {
    const { currency } = req.body;
    if (!currency) return res.status(400).json({ success: false, message: 'currency inahitajika.' });
    const result = await currencyService.setUserCurrency(req.user.id, currency.toUpperCase());
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// Admin: update exchange rate
router.put('/rates', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const { from, to, rate } = req.body;
    if (!from || !to || !rate) {
      return res.status(400).json({ success: false, message: 'from, to, rate zinahitajika.' });
    }
    const result = await currencyService.updateRate(from.toUpperCase(), to.toUpperCase(), parseFloat(rate));
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
