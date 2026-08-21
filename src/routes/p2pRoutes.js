const express = require('express');
const p2pService = require('../services/p2pService');
const { authRequired, requireKycLevel, requireRoles } = require('../middleware/auth');
const { requireService } = require('../middleware/serviceGuard');

const router = express.Router();

router.use(authRequired);

// ISSUER: unda mradi - inahitaji kujiunga na huduma ya P2P
// TAINFUND: inahitaji business_plan + team_info, huanza kama SUBMITTED
router.post('/projects', requireService('P2P'), requireRoles('ISSUER', 'ADMIN'), async (req, res, next) => {
  try {
    const project = await p2pService.createProject(req.user.id, req.body);
    return res.status(201).json({ success: true, project, message: 'Mradi umewasilishwa kwa ukaguzi.' });
  } catch (error) {
    next(error);
  }
});

// Orodha ya miradi (wazi kwa ACTIVE pekee kwa watumiaji wa kawaida)
router.get('/projects', async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'ADMIN';
    const projects = await p2pService.listProjects(req.query.status, req.query.sector, isAdmin);
    return res.json({ success: true, projects });
  } catch (error) {
    next(error);
  }
});

// Maelezo ya mradi
router.get('/projects/:projectId', async (req, res, next) => {
  try {
    const details = await p2pService.getProjectDetails(parseInt(req.params.projectId, 10));
    if (req.user.role !== 'ADMIN') {
      details.investors = (details.investors || []).map((inv) => ({
        ...inv,
        full_name: inv.full_name ? inv.full_name.charAt(0) + '***' : '***',
        phone_number: inv.phone_number ? '***' + inv.phone_number.slice(-4) : '***',
      }));
      delete details.businessWallet;
      delete details.settlementRules;
    }
    return res.json({ success: true, project: details });
  } catch (error) {
    next(error);
  }
});

// TAINFUND: Portfolio ya mwekezaji - jumla ya uwekezaji, mradi, mapato
router.get('/portfolio', requireService('P2P'), async (req, res, next) => {
  try {
    const portfolio = await p2pService.getInvestorPortfolio(req.user.id);
    return res.json({ success: true, portfolio });
  } catch (error) {
    next(error);
  }
});

// INVEST: wekeza kwenye mradi (KYC L2) - inahitaji kujiunga na huduma ya P2P
// TAINFUND: min_investment + max_per_investor checks
router.post('/projects/:projectId/invest', requireService('P2P'), requireKycLevel(2), async (req, res, next) => {
  try {
    const { shares } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const result = await p2pService.invest(req.user.id, parseInt(req.params.projectId, 10), shares, ip);
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
