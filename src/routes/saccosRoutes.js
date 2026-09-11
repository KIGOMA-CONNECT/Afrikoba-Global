const express = require('express');
const { authRequired, requireRoles } = require('../middleware/auth');
const saccos = require('../services/saccosService');
const shares = require('../services/saccosSharesService');
const savings = require('../services/saccosSavingsService');
const credit = require('../services/saccosCreditService');
const governance = require('../services/saccosGovernanceService');
const accounting = require('../services/saccosAccountingService');
const investments = require('../services/saccosInvestmentsService');
const dividends = require('../services/saccosDividendsService');
const funds = require('../services/saccosFundsService');

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

router.post('/:id/loans/apply', authRequired, async (req, res, next) => {
  try {
    const out = await credit.applyLoan(req.user.id, Number(req.params.id), { amount: req.body.amount, termMonths: req.body.termMonths, purpose: req.body.purpose });
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/loans/mine', authRequired, async (req, res, next) => {
  try {
    const out = await credit.listMyLoans(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/loans/applications', authRequired, async (req, res, next) => {
  try {
    const out = await credit.listApplications(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/loans/applications/:applicationId/approve', authRequired, async (req, res, next) => {
  try {
    const out = await credit.decideApplication(req.user.id, Number(req.params.id), Number(req.params.applicationId), 'APPROVE');
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/loans/applications/:applicationId/reject', authRequired, async (req, res, next) => {
  try {
    const out = await credit.decideApplication(req.user.id, Number(req.params.id), Number(req.params.applicationId), 'REJECT');
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/loans/:loanId/disburse', authRequired, async (req, res, next) => {
  try {
    const out = await credit.disburseLoan(req.user.id, Number(req.params.id), Number(req.params.loanId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/loans/:loanId/repay', authRequired, async (req, res, next) => {
  try {
    const out = await credit.repayLoan(req.user.id, Number(req.params.id), Number(req.params.loanId), { amount: req.body.amount });
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/loans/:loanId/repayments', authRequired, async (req, res, next) => {
  try {
    const out = await credit.listLoanRepayments(req.user.id, Number(req.params.id), Number(req.params.loanId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/loans/summary', authRequired, async (req, res, next) => {
  try {
    const out = await credit.creditSummary(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/governance/resolutions', authRequired, async (req, res, next) => {
  try {
    const out = await governance.createResolution(req.user.id, Number(req.params.id), req.body);
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/governance/resolutions', authRequired, async (req, res, next) => {
  try {
    const out = await governance.listResolutions(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/governance/resolutions/:resolutionId', authRequired, async (req, res, next) => {
  try {
    const out = await governance.resolutionDetail(req.user.id, Number(req.params.id), Number(req.params.resolutionId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/governance/resolutions/:resolutionId/open', authRequired, async (req, res, next) => {
  try {
    const out = await governance.openResolution(req.user.id, Number(req.params.id), Number(req.params.resolutionId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/governance/resolutions/:resolutionId/vote', authRequired, async (req, res, next) => {
  try {
    const out = await governance.castVote(req.user.id, Number(req.params.id), Number(req.params.resolutionId), { choice: req.body.choice });
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/governance/resolutions/:resolutionId/close', authRequired, async (req, res, next) => {
  try {
    const out = await governance.closeResolution(req.user.id, Number(req.params.id), Number(req.params.resolutionId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/governance/resolutions/:resolutionId/cancel', authRequired, async (req, res, next) => {
  try {
    const out = await governance.cancelResolution(req.user.id, Number(req.params.id), Number(req.params.resolutionId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/governance/summary', authRequired, async (req, res, next) => {
  try {
    const out = await governance.governanceSummary(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/accounting/periods', authRequired, async (req, res, next) => {
  try {
    const out = await accounting.openPeriod(req.user.id, Number(req.params.id), req.body);
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/accounting/periods', authRequired, async (req, res, next) => {
  try {
    const out = await accounting.listPeriods(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/accounting/periods/:periodId/close', authRequired, async (req, res, next) => {
  try {
    const out = await accounting.closePeriod(req.user.id, Number(req.params.id), Number(req.params.periodId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/accounting/periods/:periodId/reopen', authRequired, async (req, res, next) => {
  try {
    const out = await accounting.reopenPeriod(req.user.id, Number(req.params.id), Number(req.params.periodId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/accounting/entries', authRequired, async (req, res, next) => {
  try {
    const out = await accounting.bookEntry(req.user.id, Number(req.params.id), req.body);
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/accounting/entries', authRequired, async (req, res, next) => {
  try {
    const out = await accounting.listEntries(req.user.id, Number(req.params.id), req.query.periodId ? Number(req.query.periodId) : null);
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/accounting/chart', authRequired, async (req, res, next) => {
  try {
    const out = await accounting.chart(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/accounting/trial-balance', authRequired, async (req, res, next) => {
  try {
    const out = await accounting.trialBalance(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/accounting/income-statement', authRequired, async (req, res, next) => {
  try {
    const out = await accounting.incomeStatement(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/accounting/balance-sheet', authRequired, async (req, res, next) => {
  try {
    const out = await accounting.balanceSheet(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/accounting/summary', authRequired, async (req, res, next) => {
  try {
    const out = await accounting.accountingSummary(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/investments/products', authRequired, async (req, res, next) => {
  try {
    const out = await investments.createProduct(req.user.id, Number(req.params.id), req.body);
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/investments/products', authRequired, async (req, res, next) => {
  try {
    const out = await investments.listProducts(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/investments/products/:productId/archive', authRequired, async (req, res, next) => {
  try {
    const out = await investments.archiveProduct(req.user.id, Number(req.params.id), Number(req.params.productId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/investments/apply', authRequired, async (req, res, next) => {
  try {
    const out = await investments.applyInvestment(req.user.id, Number(req.params.id), req.body);
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/investments/mine', authRequired, async (req, res, next) => {
  try {
    const out = await investments.listMine(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/investments/:investmentId/approve', authRequired, async (req, res, next) => {
  try {
    const out = await investments.decideInvestment(req.user.id, Number(req.params.id), Number(req.params.investmentId), true);
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/investments/:investmentId/reject', authRequired, async (req, res, next) => {
  try {
    const out = await investments.decideInvestment(req.user.id, Number(req.params.id), Number(req.params.investmentId), false);
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/investments/:investmentId/redeem', authRequired, async (req, res, next) => {
  try {
    const out = await investments.redeemInvestment(req.user.id, Number(req.params.id), Number(req.params.investmentId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/investments/summary', authRequired, async (req, res, next) => {
  try {
    const out = await investments.investmentsSummary(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/dividends', authRequired, async (req, res, next) => {
  try {
    const out = await dividends.declareDividend(req.user.id, Number(req.params.id), req.body);
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/dividends', authRequired, async (req, res, next) => {
  try {
    const out = await dividends.listRuns(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/dividends/runs/:runId/payouts', authRequired, async (req, res, next) => {
  try {
    const out = await dividends.listPayouts(req.user.id, Number(req.params.id), Number(req.params.runId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/dividends/runs/:runId/distribute', authRequired, async (req, res, next) => {
  try {
    const out = await dividends.distributeDividend(req.user.id, Number(req.params.id), Number(req.params.runId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/dividends/mine', authRequired, async (req, res, next) => {
  try {
    const out = await dividends.myDividends(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/dividends/summary', authRequired, async (req, res, next) => {
  try {
    const out = await dividends.dividendsSummary(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/funds', authRequired, async (req, res, next) => {
  try {
    const out = await funds.createFund(req.user.id, Number(req.params.id), req.body);
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/funds', authRequired, async (req, res, next) => {
  try {
    const out = await funds.listFunds(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/funds/:fundId/archive', authRequired, async (req, res, next) => {
  try {
    const out = await funds.archiveFund(req.user.id, Number(req.params.id), Number(req.params.fundId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/funds/:fundId/contribute', authRequired, async (req, res, next) => {
  try {
    const out = await funds.contributeFund(req.user.id, Number(req.params.id), Number(req.params.fundId), req.body.amount);
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/funds/transfers', authRequired, async (req, res, next) => {
  try {
    const out = await funds.transferFund(req.user.id, Number(req.params.id), req.body);
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/funds/transfers', authRequired, async (req, res, next) => {
  try {
    const out = await funds.listTransfers(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/funds/contributions/mine', authRequired, async (req, res, next) => {
  try {
    const out = await funds.myContributions(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/funds/summary', authRequired, async (req, res, next) => {
  try {
    const out = await funds.fundsSummary(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/loan-loss/provision', authRequired, async (req, res, next) => {
  try {
    const out = await funds.provisionLoanLoss(req.user.id, Number(req.params.id), req.body);
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/loan-loss/:llrId/release', authRequired, async (req, res, next) => {
  try {
    const out = await funds.releaseLoanLoss(req.user.id, Number(req.params.id), Number(req.params.llrId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/loan-loss', authRequired, async (req, res, next) => {
  try {
    const out = await funds.listLoanLossReserves(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/loan-loss/summary', authRequired, async (req, res, next) => {
  try {
    const out = await funds.loanLossSummary(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

module.exports = router;