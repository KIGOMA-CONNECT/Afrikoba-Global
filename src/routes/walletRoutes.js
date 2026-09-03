const express = require('express');
const pool = require('../config/db');
const walletService = require('../services/walletService');
const limitService = require('../services/limitService');
const fraudDetectionService = require('../services/fraudDetectionService');
const governanceService = require('../services/governanceService');
const { authRequired, requireKycLevel } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { idempotent } = require('../middleware/idempotent');
const schemas = require('../validations/schemas');

const router = express.Router();

router.use(authRequired);

// A user's own pending high-value approvals (maker-checker visibility).
router.get('/pending-approvals', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, action_type, ref_type, ref_id, data, status, created_at
       FROM approval_flows WHERE requester_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.user.id]
    );
    res.json({ success: true, flows: result.rows });
  } catch (error) { next(error); }
});

// Register executors for four-eyes maker-checker operations handled by wallet.
// On approval of a high-value WALLET_TRANSFER, actually run the transfer.
governanceService.registerExecutor('WALLET_TRANSFER', async (payload) => {
  const result = await walletService.transferWallet(payload.fromUserId, payload.toPhoneNumber, payload.amount, payload.note);
  return result;
});

// Resolve live high-value threshold (TZS). Admin override via config_settings.
async function getHighValueThreshold(req) {
  if (req.user && req.user.role === 'ADMIN') return Infinity; // admins bypass the gate
  const stored = await governanceService.getSetting('HIGH_VALUE_TRANSFER_THRESHOLD');
  const parsed = parseFloat(stored);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000000;
}

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

    // B1: Check transaction limits
    const limitCheck = await limitService.checkLimits(req.user.id, parseFloat(amount), 'TRANSFER');
    if (!limitCheck.allowed) {
      return res.status(429).json({
        success: false,
        message: limitCheck.failures[0].message,
        code: 'LIMIT_EXCEEDED',
        limits: limitCheck.failures,
      });
    }

    // B9: Run fraud detection
    const fraudCheck = await fraudDetectionService.runFraudChecks(req.user.id, {
      amount: parseFloat(amount),
      recipient_phone: toPhoneNumber,
      ipAddress: req.ip,
      fingerprint: req.headers['x-device-fingerprint'] || '',
    });

    if (fraudCheck.shouldBlock) {
      return res.status(403).json({
        success: false,
        message: 'Muamala umekatwa kwa usalama. Wasiliana na msaidizi.',
        code: 'FRAUD_BLOCKED',
        alerts: fraudCheck.alerts,
      });
    }

    // Four-eyes gate: high-value transfers need a second approver (maker-checker).
    // A non-admin's transfer above the threshold becomes a pending approval_flow
    // and only executes once an admin (other than the requester) approves it.
    const threshold = await getHighValueThreshold(req);
    if (parseFloat(amount) >= threshold) {
      const flow = await governanceService.createApprovalFlow({
        requesterId: req.user.id,
        actionType: 'WALLET_TRANSFER',
        refType: 'WALLET_TRANSFER',
        data: { fromUserId: req.user.id, toPhoneNumber, amount: parseFloat(amount), note: note || null },
      });
      return res.json({
        success: true,
        requiresApproval: true,
        approvalFlowId: flow.id,
        status: 'PENDING_APPROVAL',
        message: 'Muamala wa kiasi kikubwa unahitaji idhini ya msimamizi mwingine (four-eyes).',
      });
    }

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

    // B1: Check transaction limits
    const limitCheck = await limitService.checkLimits(req.user.id, parseFloat(amount), 'WITHDRAWAL');
    if (!limitCheck.allowed) {
      return res.status(429).json({
        success: false,
        message: limitCheck.failures[0].message,
        code: 'LIMIT_EXCEEDED',
        limits: limitCheck.failures,
      });
    }

    // B9: Run fraud detection
    const fraudCheck = await fraudDetectionService.runFraudChecks(req.user.id, {
      amount: parseFloat(amount),
      ipAddress: req.ip,
      fingerprint: req.headers['x-device-fingerprint'] || '',
    });

    if (fraudCheck.shouldBlock) {
      return res.status(403).json({
        success: false,
        message: 'Utoaji umekatwa kwa usalama. Wasiliana na msaidizi.',
        code: 'FRAUD_BLOCKED',
        alerts: fraudCheck.alerts,
      });
    }

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
