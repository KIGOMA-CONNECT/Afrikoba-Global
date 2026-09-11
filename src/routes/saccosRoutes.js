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
const exit = require('../services/saccosExitService');
const reporting = require('../services/saccosReportingService');
const installments = require('../services/saccosInstallmentService');
const meetings = require('../services/saccosMeetingsService');
const savingsInterest = require('../services/saccosSavingsInterestService');
const welfare = require('../services/saccosWelfareService');
const loanWorkout = require('../services/saccosLoanWorkoutService');
const standingOrders = require('../services/saccosStandingOrderService');
const treasury = require('../services/saccosTreasuryService');

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

// ---------- Lending products config (increment 19) ----------
router.get('/:id/loans/products', authRequired, async (req, res, next) => {
  try {
    const out = await credit.listProducts(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/loans/products', authRequired, async (req, res, next) => {
  try {
    const out = await credit.createProduct(req.user.id, Number(req.params.id), req.body);
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/loans/products/:productId/archive', authRequired, async (req, res, next) => {
  try {
    const out = await credit.archiveProduct(req.user.id, Number(req.params.id), Number(req.params.productId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

// ---------- Lending risk limits (increment 21b) ----------
router.get('/:id/loans/risk', authRequired, async (req, res, next) => {
  try {
    const out = await credit.getMemberRiskSummary(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.patch('/:id/loans/risk-limits', authRequired, async (req, res, next) => {
  try {
    const out = await credit.updateRiskLimits(req.user.id, Number(req.params.id), req.body);
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/loans/apply', authRequired, async (req, res, next) => {
  try {
    const out = await credit.applyLoan(req.user.id, Number(req.params.id), { amount: req.body.amount, termMonths: req.body.termMonths, purpose: req.body.purpose, productId: req.body.productId });
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/loans/mine', authRequired, async (req, res, next) => {
  try {
    const out = await credit.listMyLoans(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/loans/backing', authRequired, async (req, res, next) => {
  try {
    const out = await credit.myBacking(req.user.id, Number(req.params.id));
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

router.post('/:id/exits/settle', authRequired, async (req, res, next) => {
  try {
    const out = await exit.settleAndExit(req.user.id, Number(req.params.id));
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/exits', authRequired, async (req, res, next) => {
  try {
    const out = await exit.listExits(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/exits/mine', authRequired, async (req, res, next) => {
  try {
    const out = await exit.myExit(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/statements/mine', authRequired, async (req, res, next) => {
  try {
    const out = await reporting.myStatement(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/members/:memberId/statement', authRequired, async (req, res, next) => {
  try {
    const out = await reporting.memberStatement(req.user.id, Number(req.params.id), Number(req.params.memberId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/reports/regulatory', authRequired, async (req, res, next) => {
  try {
    const out = await reporting.regulatoryReport(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/loans/:loanId/installments', authRequired, async (req, res, next) => {
  try {
    const out = await installments.listInstallments(req.user.id, Number(req.params.id), Number(req.params.loanId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/loans/:loanId/installments/generate', authRequired, async (req, res, next) => {
  try {
    const out = await installments.generateInstallments(req.user.id, Number(req.params.id), Number(req.params.loanId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/loans/:loanId/installments/:installmentId/pay', authRequired, async (req, res, next) => {
  try {
    const out = await installments.payInstallment(req.user.id, Number(req.params.id), Number(req.params.loanId), Number(req.params.installmentId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/loans/installments/summary', authRequired, async (req, res, next) => {
  try {
    const out = await installments.installmentSummary(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/loans/arrears', authRequired, async (req, res, next) => {
  try {
    const out = await installments.arrearsSummary(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/loans/recompute-arrears', authRequired, async (req, res, next) => {
  try {
    const out = await installments.recomputeArrears(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/meetings', authRequired, async (req, res, next) => {
  try {
    const out = await meetings.createMeeting(req.user.id, Number(req.params.id), req.body);
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/meetings', authRequired, async (req, res, next) => {
  try {
    const out = await meetings.listMeetings(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/meetings/summary', authRequired, async (req, res, next) => {
  try {
    const out = await meetings.meetingsSummary(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/meetings/:meetingId', authRequired, async (req, res, next) => {
  try {
    const out = await meetings.meetingDetail(req.user.id, Number(req.params.id), Number(req.params.meetingId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/meetings/:meetingId/open', authRequired, async (req, res, next) => {
  try {
    const out = await meetings.openMeeting(req.user.id, Number(req.params.id), Number(req.params.meetingId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/meetings/:meetingId/checkin', authRequired, async (req, res, next) => {
  try {
    const out = await meetings.checkIn(req.user.id, Number(req.params.id), Number(req.params.meetingId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/meetings/:meetingId/attendance', authRequired, async (req, res, next) => {
  try {
    const out = await meetings.markAttendance(req.user.id, Number(req.params.id), Number(req.params.meetingId), Number(req.body.memberId), req.body.status);
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/meetings/:meetingId/close', authRequired, async (req, res, next) => {
  try {
    const out = await meetings.closeMeeting(req.user.id, Number(req.params.id), Number(req.params.meetingId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/meetings/:meetingId/minutes', authRequired, async (req, res, next) => {
  try {
    const out = await meetings.publishMinutes(req.user.id, Number(req.params.id), Number(req.params.meetingId), req.body);
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/savings-interest/prepare', authRequired, async (req, res, next) => {
  try {
    const out = await savingsInterest.prepareCycle(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/savings-interest/cycles', authRequired, async (req, res, next) => {
  try {
    const out = await savingsInterest.listCycles(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/savings-interest/cycles/:cycleId', authRequired, async (req, res, next) => {
  try {
    const out = await savingsInterest.cycleDetail(req.user.id, Number(req.params.id), Number(req.params.cycleId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/savings-interest/cycles/:cycleId/post', authRequired, async (req, res, next) => {
  try {
    const out = await savingsInterest.postCycle(req.user.id, Number(req.params.id), Number(req.params.cycleId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/savings-interest/summary', authRequired, async (req, res, next) => {
  try {
    const out = await savingsInterest.interestSummary(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/savings-interest/mine', authRequired, async (req, res, next) => {
  try {
    const out = await savingsInterest.myInterest(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

// --- Welfare / social fund (increment 16) ---
router.post('/:id/welfare/schemes', authRequired, async (req, res, next) => {
  try {
    const out = await welfare.createScheme(req.user.id, Number(req.params.id), req.body);
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/welfare/schemes', authRequired, async (req, res, next) => {
  try {
    const out = await welfare.listSchemes(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/welfare/contributions', authRequired, async (req, res, next) => {
  try {
    const out = await welfare.contribute(req.user.id, Number(req.params.id), req.body);
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/welfare/contributions/mine', authRequired, async (req, res, next) => {
  try {
    const out = await welfare.myContributions(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/welfare/claims', authRequired, async (req, res, next) => {
  try {
    const out = await welfare.submitClaim(req.user.id, Number(req.params.id), req.body);
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/welfare/claims', authRequired, async (req, res, next) => {
  try {
    const out = await welfare.listClaims(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/welfare/claims/:claimId/review', authRequired, async (req, res, next) => {
  try {
    const out = await welfare.reviewClaim(req.user.id, Number(req.params.id), Number(req.params.claimId), req.body.decision);
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/welfare/claims/:claimId/pay', authRequired, async (req, res, next) => {
  try {
    const out = await welfare.payClaim(req.user.id, Number(req.params.id), Number(req.params.claimId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/welfare/summary', authRequired, async (req, res, next) => {
  try {
    const out = await welfare.welfareSummary(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

// ---------- Loan guarantors / co-signers (increment 17) ----------
router.post('/:id/loans/applications/:applicationId/guarantees', authRequired, async (req, res, next) => {
  try {
    const out = await credit.addGuarantor(req.user.id, Number(req.params.id), Number(req.params.applicationId), req.body);
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/loans/applications/:applicationId/guarantees', authRequired, async (req, res, next) => {
  try {
    const out = await credit.listGuarantees(req.user.id, Number(req.params.id), Number(req.params.applicationId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/loans/guarantees/:guaranteeId/accept', authRequired, async (req, res, next) => {
  try {
    const out = await credit.acceptGuarantee(req.user.id, Number(req.params.id), Number(req.params.guaranteeId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/loans/guarantees/:guaranteeId/remove', authRequired, async (req, res, next) => {
  try {
    const out = await credit.removeGuarantee(req.user.id, Number(req.params.id), Number(req.params.guaranteeId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/loans/guarantees/mine', authRequired, async (req, res, next) => {
  try {
    const out = await credit.myGuarantees(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/loans/:loanId/guarantees/:guaranteeId/pay', authRequired, async (req, res, next) => {
  try {
    const out = await loanWorkout.payGuarantorArrears(req.user.id, Number(req.params.id), Number(req.params.loanId), Number(req.params.guaranteeId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

// ---------- Loan restructure / reschedule (increment 17) ----------
router.post('/:id/loans/:loanId/restructure', authRequired, async (req, res, next) => {
  try {
    const out = await loanWorkout.restructureLoan(req.user.id, Number(req.params.id), Number(req.params.loanId), req.body);
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/loans/:loanId/restructures', authRequired, async (req, res, next) => {
  try {
    const out = await loanWorkout.listRestructures(req.user.id, Number(req.params.id), Number(req.params.loanId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

// ---------- Loan write-off (increment 17) ----------
router.post('/:id/loans/:loanId/write-off', authRequired, async (req, res, next) => {
  try {
    const out = await loanWorkout.writeOffLoan(req.user.id, Number(req.params.id), Number(req.params.loanId), req.body);
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/loans/write-offs', authRequired, async (req, res, next) => {
  try {
    const out = await loanWorkout.listWriteOffs(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

// ---------- Standing orders / recurring contributions (increment 17) ----------
router.post('/:id/standing-orders', authRequired, async (req, res, next) => {
  try {
    const out = await standingOrders.createOrder(req.user.id, Number(req.params.id), req.body);
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/standing-orders/mine', authRequired, async (req, res, next) => {
  try {
    const out = await standingOrders.listMyOrders(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/standing-orders', authRequired, async (req, res, next) => {
  try {
    const out = await standingOrders.listOrders(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/standing-orders/:orderId/deactivate', authRequired, async (req, res, next) => {
  try {
    const out = await standingOrders.deactivateOrder(req.user.id, Number(req.params.id), Number(req.params.orderId));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/standing-orders/run', authRequired, async (req, res, next) => {
  try {
    const out = await standingOrders.runDue(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/reports/management', authRequired, async (req, res, next) => {
  try {
    const out = await reporting.managementReport(req.user.id, Number(req.params.id), Number(req.query.months || 6));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

// ---------- Treasury & liquidity panel (increment 20) ----------
router.get('/:id/treasury', authRequired, async (req, res, next) => {
  try {
    const out = await treasury.getTreasury(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.post('/:id/treasury/snapshot', authRequired, async (req, res, next) => {
  try {
    const out = await treasury.snapshotTreasury(req.user.id, Number(req.params.id));
    res.status(201).json({ success: true, result: out });
  } catch (e) { next(e); }
});

router.get('/:id/treasury/history', authRequired, async (req, res, next) => {
  try {
    const out = await treasury.treasuryHistory(req.user.id, Number(req.params.id));
    res.json({ success: true, result: out });
  } catch (e) { next(e); }
});

module.exports = router;