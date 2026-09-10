const express = require('express');
const { authRequired, requireRoles } = require('../middleware/auth');
const saccos = require('../services/saccosService');
const shares = require('../services/saccosSharesService');
const savings = require('../services/saccosSavingsService');

const router = express.Router();

router.post('/', authRequired, async (req, res, next) => {
  try {
    const out = await saccos.createSaccos(req.user.id, req.body);
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/', authRequired, async (req, res, next) => {
  try {
    const saccosList = await saccos.listMySaccos(req.user.id);
    res.json({ success: true, result: saccosList });
  } catch (e) { next(e); }
});

router.get('/:id', authRequired, async (req, res, next) => {
  try {
    const org = await saccos.getSaccos(req.user.id, Number(req.params.id));
    res.json({ success: true, result: org });
  } catch (e) { next(e); }
});

router.post('/:id/activate', authRequired, requireRoles('MJUMBE', 'MWENYEKITI', 'KATIBU', 'MWEKAHAZINA', 'ADMIN'), async (req, res, next) => {
  try {
    const org = await saccos.activateSaccos(req.user.id, Number(req.params.id));
    res.json({ success: true, result: org });
  } catch (e) { next(e); }
});

router.get('/:id/compliance', authRequired, async (req, res, next) => {
  try {
    const compliance = await saccos.getCompliance(req.user.id, Number(req.params.id));
    res.json({ success: true, result: compliance });
  } catch (e) { next(e); }
});

router.post('/:id/members', authRequired, async (req, res, next) => {
  try {
    const membership = await saccos.inviteMember(req.user.id, Number(req.params.id), {
      phoneNumber: req.body.phoneNumber,
      role: req.body.role,
    });
    res.status(201).json({ success: true, result: membership });
  } catch (e) { next(e); }
});

router.get('/:id/members', authRequired, async (req, res, next) => {
  try {
    const members = await saccos.listMembers(req.user.id, Number(req.params.id));
    res.json({ success: true, result: members });
  } catch (e) { next(e); }
});

router.post('/:id/members/:memberId/accept', authRequired, async (req, res, next) => {
  try {
    const membership = await saccos.acceptMembership(req.user.id, Number(req.params.id), Number(req.params.memberId));
    res.json({ success: true, result: membership });
  } catch (e) { next(e); }
});

router.post('/:id/members/:memberId/suspend', authRequired, async (req, res, next) => {
  try {
    const membership = await saccos.suspendMember(req.user.id, Number(req.params.id), Number(req.params.memberId));
    res.json({ success: true, result: membership });
  } catch (e) { next(e); }
});

router.post('/:id/members/:memberId/exit', authRequired, async (req, res, next) => {
  try {
    const membership = await saccos.exitMember(req.user.id, Number(req.params.id), Number(req.params.memberId));
    res.json({ success: true, result: membership });
  } catch (e) { next(e); }
});

router.post('/:id/shares/purchase', authRequired, async (req, res, next) => {
  try {
    const purchase = await shares.purchaseShares(req.user.id, Number(req.params.id), { shares: req.body.shares });
    res.status(201).json({ success: true, result: purchase });
  } catch (e) { next(e); }
});

router.get('/:id/shares/mine', authRequired, async (req, res, next) => {
  try {
    const out = await shares.listMyShares(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/shares/purchases', authRequired, async (req, res, next) => {
  try {
    const purchases = await shares.listPurchases(req.user.id, Number(req.params.id));
    res.json({ success: true, result: purchases });
  } catch (e) { next(e); }
});

router.post('/:id/shares/purchases/:purchaseId/approve', authRequired, async (req, res, next) => {
  try {
    const out = await shares.decidePurchase(req.user.id, Number(req.params.id), Number(req.params.purchaseId), 'APPROVE');
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/shares/purchases/:purchaseId/reject', authRequired, async (req, res, next) => {
  try {
    const out = await shares.decidePurchase(req.user.id, Number(req.params.id), Number(req.params.purchaseId), 'REJECT');
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/shares/summary', authRequired, async (req, res, next) => {
  try {
    const out = await shares.sharesSummary(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/savings/deposit', authRequired, async (req, res, next) => {
  try {
    const out = await savings.deposit(req.user.id, Number(req.params.id), { amount: req.body.amount });
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/savings/withdraw', authRequired, async (req, res, next) => {
  try {
    const out = await savings.withdraw(req.user.id, Number(req.params.id), { amount: req.body.amount });
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/savings/mine', authRequired, async (req, res, next) => {
  try {
    const out = await savings.listMySavings(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/savings/accounts', authRequired, async (req, res, next) => {
  try {
    const out = await savings.listSavingsAccounts(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/savings/summary', authRequired, async (req, res, next) => {
  try {
    const out = await savings.savingsSummary(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/savings/withdrawals/:withdrawalId/approve', authRequired, async (req, res, next) => {
  try {
    const out = await savings.decideWithdrawal(req.user.id, Number(req.params.id), Number(req.params.withdrawalId), 'APPROVE');
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/savings/withdrawals/:withdrawalId/reject', authRequired, async (req, res, next) => {
  try {
    const out = await savings.decideWithdrawal(req.user.id, Number(req.params.id), Number(req.params.withdrawalId), 'REJECT');
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

module.exports = router;