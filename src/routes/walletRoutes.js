const express = require('express');
const walletService = require('../services/walletService');
const { authRequired, requireKycLevel } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { idempotent } = require('../middleware/idempotent');
const schemas = require('../validations/schemas');

const router = express.Router();

router.use(authRequired);

// Deposit - AzamPay USSD Push (1% add-on fee)
router.post('/deposit/initiate', requireKycLevel(1), validate(schemas.wallet.deposit), async (req, res, next) => {
  try {
    const { amount, provider } = req.body;
    const result = await walletService.initiateDeposit(req.user.id, amount, provider);
    return res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// Transfer wallet-to-wallet
router.post('/transfer', validate(schemas.wallet.transfer), idempotent(async (req, res, next) => {
  try {
    const { toPhoneNumber, amount, note } = req.body;
    const result = await walletService.transferWallet(req.user.id, toPhoneNumber, amount, note);
    return res.json(result);
  } catch (error) {
    next(error);
  }
}));

// Withdrawal kwenda MNO
router.post('/withdraw', requireKycLevel(1), validate(schemas.wallet.withdraw), idempotent(async (req, res, next) => {
  try {
    const { amount, provider } = req.body;
    const result = await walletService.withdrawToMno(req.user.id, amount, provider);
    return res.json(result);
  } catch (error) {
    next(error);
  }
}));

// Salio
router.get('/balance', async (req, res, next) => {
  try {
    const balance = await walletService.getBalance(req.user.id);
    return res.json({ success: true, balance });
  } catch (error) {
    next(error);
  }
});

// Historia ya miamala
router.get('/transactions', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const txs = await walletService.getTransactionHistory(req.user.id, limit);
    return res.json({ success: true, transactions: txs });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
