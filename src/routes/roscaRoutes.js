const express = require('express');
const roscaService = require('../services/roscaService');
const { authRequired, requireKycLevel } = require('../middleware/auth');
const { requireService } = require('../middleware/serviceGuard');
const { validate } = require('../middleware/validate');
const schemas = require('../validations/schemas');

const router = express.Router();

router.use(authRequired);

// Unda Pool (Upatu/Kikoba) - inahitaji kujiunga na huduma ya ROSCA
router.post('/pools', requireService('ROSCA'), validate(schemas.rosca.createPool), async (req, res, next) => {
  try {
    const { poolName, contributionAmount, cycleFrequency, totalMembers, poolType } = req.body;
    const pool = await roscaService.createPool(req.user.id, {
      poolName,
      contributionAmount,
      cycleFrequency,
      totalMembers,
      poolType,
    });
    return res.status(201).json({ success: true, pool });
  } catch (error) {
    next(error);
  }
});

// Jiunge na pool (KYC L2 inahitajika kwa PUBLIC pools)
router.post('/pools/:poolId/join', requireService('ROSCA'), requireKycLevel(2), async (req, res, next) => {
  try {
    const { wantEarlySlot, queueNumber } = req.body;
    const result = await roscaService.joinPool(req.user.id, parseInt(req.params.poolId, 10), {
      wantEarlySlot,
      queueNumber,
    });
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// Orodha ya pools
router.get('/pools', async (req, res, next) => {
  try {
    const pools = await roscaService.listPools(req.query.status);
    return res.json({ success: true, pools });
  } catch (error) {
    next(error);
  }
});

// Maelezo ya pool
router.get('/pools/:poolId', async (req, res, next) => {
  try {
    const details = await roscaService.getPoolDetails(parseInt(req.params.poolId, 10));
    return res.json({ success: true, pool: details });
  } catch (error) {
    next(error);
  }
});

// ROSCA trust/history summary for the logged-in member (trust_score from history)
router.get('/trust/summary', async (req, res, next) => {
  try {
    const summary = await roscaService.getMemberRoscaSummary(req.user.id);
    return res.json({ success: true, ...summary });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// PHASE 2: UPATU GOVERNANCE
// ---------------------------------------------------------------------------

// Configure grace period / late fee / payout order (pool creator only).
router.post('/pools/:poolId/governance', async (req, res, next) => {
  try {
    const { grace_days, late_fee_amount, payout_order } = req.body;
    const pool = await roscaService.setPoolGovernance(req.user.id, parseInt(req.params.poolId, 10), { grace_days, late_fee_amount, payout_order });
    return res.json({ success: true, pool });
  } catch (error) { next(error); }
});

// Versioned constitution + per-member acceptance.
router.post('/pools/:poolId/constitution', async (req, res, next) => {
  try {
    const { title, body } = req.body;
    const constitution = await roscaService.createConstitution(req.user.id, parseInt(req.params.poolId, 10), { title, body });
    return res.status(201).json({ success: true, constitution });
  } catch (error) { next(error); }
});

router.get('/pools/:poolId/constitution', async (req, res, next) => {
  try {
    const constitution = await roscaService.getConstitution(parseInt(req.params.poolId, 10));
    return res.json({ success: true, constitution });
  } catch (error) { next(error); }
});

router.get('/pools/:poolId/constitution/:version', async (req, res, next) => {
  try {
    const constitution = await roscaService.getConstitution(parseInt(req.params.poolId, 10), parseInt(req.params.version, 10));
    return res.json({ success: true, constitution });
  } catch (error) { next(error); }
});

router.get('/pools/:poolId/constitutions', async (req, res, next) => {
  try {
    const constitutions = await roscaService.listConstitutions(parseInt(req.params.poolId, 10));
    return res.json({ success: true, constitutions });
  } catch (error) { next(error); }
});

router.post('/pools/:poolId/constitution/accept', async (req, res, next) => {
  try {
    const { version } = req.body;
    const accepted = await roscaService.acceptConstitution(req.user.id, parseInt(req.params.poolId, 10), version);
    return res.json({ success: true, accepted });
  } catch (error) { next(error); }
});

module.exports = router;
