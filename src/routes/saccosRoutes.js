const express = require('express');
const { authRequired } = require('../middleware/auth');
const {
  CAPABILITIES: CAP,
  SACCOS_GOVERNING_ROLES,
  authorizeGroupContext,
} = require('../services/governanceAuthorizationService');
const resourceBinding = require('../services/governanceResourceBindingService');
const { matchRouteParams, patternMatches } = resourceBinding;
const logger = require('../utils/logger');
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

// ============ G3 — SACCOS GOVERNANCE SURFACE CONSOLIDATION ============
//
// This router carries a second governance surface alongside /api/v1/governance:
//
//   /:id/governance/*   8 routes   resolutions + rollup summary
//   /:id/meetings/*     9 routes   meeting lifecycle, attendance, minutes
//
// Both halves of the same invariant now run here instead of only deep inside
// the services:
//   G1  "may THIS user act on THIS SACCOS with THIS capability?"
//   G2  "which SACCOS owns THIS resolution / meeting / member?"
//
// Layers run ONLY for paths inside the surface. The other 122 endpoints in this
// file keep their inline `authRequired` and their own service-level checks
// untouched — they are a separate backlog.
//
// Order (every denial happens before the handler, so no denial can leave a
// partial mutation behind):
//   1 g3Authenticate      surface paths authenticate here; the inline
//                         authRequired on each route still runs afterwards,
//                         which is deliberate — double auth is cheap and
//                         strictly safer than a missed one
//   2 g3CapabilityLayer   ROUTE_SACCOS_AUTHZ. No entry => 403, fail closed
//   3 g3BindingLayer      ROUTE_SACCOS_RESOURCES. No entry => 403, fail closed
//
// Decisions that shape this block:
//   * The group context comes from the server-controlled `:id` path segment,
//     never from body/query — a client cannot choose which SACCOS it is being
//     authorized as, and every group claim it does send must agree with it.
//   * GOVERN mutations run `assertActiveRole(OWNER, BOARD)` FIRST. Without it
//     G1 alone would turn an outsider's write from 403 SACCOS_NOT_MEMBER into
//     404 (assertVisible runs first there), and would let a platform ADMIN
//     through on the documented SACCOS:GOVERN override that the services have
//     never allowed for writes. Decision 3: G3 does not migrate the error
//     contract.
//   * `GET /:id/governance/summary` maps to plain GOVERN with NO pre-check.
//     That is the single place the SACCOS:GOVERN platform-admin override
//     applies, and it is what the existing oversight test pins.
//   * Service-level assert*/requireActiveMember checks stay in place as
//     defense in depth. This layer is not a replacement for them.

const G3_GROUP_TYPE = 'SACCO';
const G3_SURFACE = /^\/[^/]+\/(?:governance|meetings)(?:\/|$)/;

function inG3Surface(path) {
  return G3_SURFACE.test(typeof path === 'string' ? path : '/');
}

/**
 * The authorization matrix for the surface: [method, path, capability, adminPreCheck].
 *
 * `adminPreCheck` (4th element) means "run assertActiveRole(OWNER, BOARD)
 * before the capability check" — see the decision note above. It is present on
 * every GOVERN route that must keep denying platform ADMIN and outsiders with
 * 403, which is every GOVERN route except the oversight summary.
 */
const ROUTE_SACCOS_AUTHZ = [
  ['POST', '/:id/governance/resolutions', CAP.GOVERN, true],
  ['GET', '/:id/governance/resolutions', CAP.READ],
  ['GET', '/:id/governance/resolutions/:resolutionId', CAP.READ],
  ['POST', '/:id/governance/resolutions/:resolutionId/open', CAP.GOVERN, true],
  ['POST', '/:id/governance/resolutions/:resolutionId/vote', CAP.VOTE],
  ['POST', '/:id/governance/resolutions/:resolutionId/close', CAP.GOVERN, true],
  ['POST', '/:id/governance/resolutions/:resolutionId/cancel', CAP.GOVERN, true],
  ['GET', '/:id/governance/summary', CAP.GOVERN],
  ['POST', '/:id/meetings', CAP.GOVERN, true],
  ['GET', '/:id/meetings', CAP.READ],
  ['GET', '/:id/meetings/summary', CAP.GOVERN, true],
  ['GET', '/:id/meetings/:meetingId', CAP.READ],
  ['POST', '/:id/meetings/:meetingId/open', CAP.GOVERN, true],
  ['POST', '/:id/meetings/:meetingId/checkin', CAP.WRITE],
  ['POST', '/:id/meetings/:meetingId/attendance', CAP.GOVERN, true],
  ['POST', '/:id/meetings/:meetingId/close', CAP.GOVERN, true],
  ['POST', '/:id/meetings/:meetingId/minutes', CAP.GOVERN, true],
];

const SACCOS_P = (type, key) => ({ from: 'path', keys: [key], type });
const SACCOS_B = (type, keys) => ({ from: 'body', keys, type });

/**
 * The resource matrix for the surface: [method, path, descriptors].
 *
 * Mirrors ROUTE_SACCOS_AUTHZ in the same order, so a route missing from either
 * table cannot reach its handler. Every id below is resolved by
 * governanceResourceBindingService against the row's own `saccos_id`, which is
 * the composite `saccos_id + resource_id` binding the services already did —
 * hoisted here so it happens before the handler rather than inside it.
 *
 * `GET /:id/meetings/summary` must stay above `GET /:id/meetings/:meetingId`:
 * both are three segments, and the first match wins.
 */
const ROUTE_SACCOS_RESOURCES = [
  ['POST', '/:id/governance/resolutions', []],
  ['GET', '/:id/governance/resolutions', []],
  ['GET', '/:id/governance/resolutions/:resolutionId', [SACCOS_P('SACCOS_RESOLUTION', 'resolutionId')]],
  ['POST', '/:id/governance/resolutions/:resolutionId/open', [SACCOS_P('SACCOS_RESOLUTION', 'resolutionId')]],
  ['POST', '/:id/governance/resolutions/:resolutionId/vote', [SACCOS_P('SACCOS_RESOLUTION', 'resolutionId')]],
  ['POST', '/:id/governance/resolutions/:resolutionId/close', [SACCOS_P('SACCOS_RESOLUTION', 'resolutionId')]],
  ['POST', '/:id/governance/resolutions/:resolutionId/cancel', [SACCOS_P('SACCOS_RESOLUTION', 'resolutionId')]],
  ['GET', '/:id/governance/summary', []],
  ['POST', '/:id/meetings', []],
  ['GET', '/:id/meetings', []],
  ['GET', '/:id/meetings/summary', []],
  ['GET', '/:id/meetings/:meetingId', [SACCOS_P('SACCOS_MEETING', 'meetingId')]],
  ['POST', '/:id/meetings/:meetingId/open', [SACCOS_P('SACCOS_MEETING', 'meetingId')]],
  ['POST', '/:id/meetings/:meetingId/checkin', [SACCOS_P('SACCOS_MEETING', 'meetingId')]],
  ['POST', '/:id/meetings/:meetingId/attendance', [
    SACCOS_P('SACCOS_MEETING', 'meetingId'),
    SACCOS_B('SACCOS_MEMBER', ['memberId', 'member_id']),
  ]],
  ['POST', '/:id/meetings/:meetingId/close', [SACCOS_P('SACCOS_MEETING', 'meetingId')]],
  ['POST', '/:id/meetings/:meetingId/minutes', [SACCOS_P('SACCOS_MEETING', 'meetingId')]],
];

function denyUnregistered(res, code) {
  return res.status(403).json({ success: false, code, message: 'Huna ruhusa ya hatua hii.' });
}

function denyAppError(res, err) {
  return res.status(err.statusCode).json({
    success: false,
    code: err.code,
    message: err.message,
    ...(err.details ? { details: err.details } : {}),
  });
}

// ---- layer 1: authentication for the surface only ------------------------
function g3Authenticate(req, res, next) {
  if (!inG3Surface(req.path)) return next();
  return authRequired(req, res, next);
}

// ---- layer 2: capability -> role, fail closed ----------------------------
async function g3CapabilityLayer(req, res, next) {
  if (!inG3Surface(req.path)) return next();
  const method = req.method.toUpperCase();
  const path = req.path || '/';
  try {
    const hit = ROUTE_SACCOS_AUTHZ.find(([m, p]) => m === method && patternMatches(p, path));
    if (!hit) return denyUnregistered(res, 'GOV_AUTHZ_UNREGISTERED');

    const params = matchRouteParams(hit[1], path) || {};
    const groupId = Number(params.id);
    if (!Number.isSafeInteger(groupId) || groupId <= 0) return denyUnregistered(res, 'GOV_AUTHZ_UNREGISTERED');

    // Defense-contract pre-check: must run BEFORE authorizeGroupContext so the
    // pre-existing 403 codes for writes are preserved (see decision note).
    if (hit[3] === true) {
      await saccos.assertActiveRole(req.user.id, groupId, SACCOS_GOVERNING_ROLES);
    }

    req.governance = await authorizeGroupContext({
      userId: req.user.id,
      userRole: req.user.role,
      groupType: G3_GROUP_TYPE,
      groupId,
      capability: hit[2],
    });
    return next();
  } catch (err) {
    if (err && err.statusCode && err.code) {
      logger.warn('SACCOS_GOV_AUTHZ_DENIED', `method=${method} path=${path} code=${err.code} user=${req.user ? req.user.id : 'anon'}`);
      return denyAppError(res, err);
    }
    return next(err);
  }
}

// ---- layer 3: resource -> SACCOS binding, runs before every handler ------
async function g3BindingLayer(req, res, next) {
  if (!inG3Surface(req.path)) return next();
  const method = req.method.toUpperCase();
  const path = req.path || '/';
  const hit = ROUTE_SACCOS_RESOURCES.find(([m, p]) => m === method && patternMatches(p, path));
  if (!hit) return denyUnregistered(res, 'GOV_RESOURCE_UNREGISTERED');

  try {
    // One request, one SACCOS: a group id/type or a saccos_id anywhere else in
    // the request must agree with the `:id` the context was built from.
    resourceBinding.assertRequestGroupConsistent(req.governance, req, {
      idKeys: ['saccos_id', 'saccosId'],
    });

    const pathParams = matchRouteParams(hit[1], path) || {};
    for (const descriptor of hit[2]) {
      const source = descriptor.from === 'path'
        ? pathParams
        : descriptor.from === 'query' ? req.query : (req.body || {});

      let value = null;
      let present = false;
      for (const key of descriptor.keys) {
        const candidate = source[key];
        if (candidate !== undefined && candidate !== null && candidate !== '') {
          value = candidate;
          present = true;
          break;
        }
      }

      let recordType = null;
      let recordTypePresent = false;
      if (descriptor.via) {
        for (const key of descriptor.via) {
          const candidate = source[key];
          if (candidate !== undefined && candidate !== null && candidate !== '') {
            recordType = candidate;
            recordTypePresent = true;
            break;
          }
        }
      }

      if (descriptor.via && present !== recordTypePresent) {
        throw resourceBinding.denyMissingResourceParam(descriptor.type, `incomplete ${descriptor.from} pair`);
      }
      if (!present) {
        if (descriptor.optional) continue;
        throw resourceBinding.denyMissingResourceParam(descriptor.type, `${descriptor.from} required`);
      }

      // Deliberately sequential: each descriptor settles before the next is
      // considered, and none may run after next().
      // eslint-disable-next-line no-await-in-loop
      await resourceBinding.assertResourceInContext(descriptor.type, value, req.governance, { recordType });
    }

    return next();
  } catch (err) {
    if (err && err.statusCode && err.code) {
      logger.warn('SACCOS_GOV_BIND_DENIED_HTTP', `method=${method} path=${path} code=${err.code} user=${req.user ? req.user.id : 'anon'}`);
      return denyAppError(res, err);
    }
    return next(err);
  }
}

router.use(g3Authenticate);
router.use(g3CapabilityLayer);
router.use(g3BindingLayer);

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

// G3: the HTTP `requireRoles(MJUMBE, ...)` guard that used to sit here checked
// the PLATFORM role, which defaults to MJUMBE for every registered user and so
// admitted anyone. The real authorization is `activateSaccos -> assertActiveRole(['OWNER'])`
// inside the service, and it is unchanged (defense in depth, decision 4).
router.post('/:id/activate', authRequired, async (req, res, next) => {
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

// Exposed for tests: the G3 matrices must stay in exact 1:1 correspondence with
// the governance surface declared above (a route with no entry is unreachable,
// an entry with no route is dead), and the two tables must mirror each other in
// the same order. `inG3Surface` is exported so a test can prove the surface
// contains those 17 routes and nothing else.
router.ROUTE_SACCOS_AUTHZ = ROUTE_SACCOS_AUTHZ;
router.ROUTE_SACCOS_RESOURCES = ROUTE_SACCOS_RESOURCES;
router.inG3Surface = inG3Surface;

module.exports = router;