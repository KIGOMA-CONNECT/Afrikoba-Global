const express = require('express');
const recurrenceService = require('../services/recurrenceService');
const { authRequired, requireRoles } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

router.post('/rules', requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const rule = await recurrenceService.createRule(req.user.id, req.body);
    res.json({ success: true, rule });
  } catch (error) { next(error); }
});

router.get('/rules', requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const rules = await recurrenceService.listRules(req.query.include_disabled === 'true');
    res.json({ success: true, rules });
  } catch (error) { next(error); }
});

router.patch('/rules/:id', requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const rule = await recurrenceService.setRuleEnabled(parseInt(req.params.id, 10), req.body.enabled !== false);
    res.json({ success: true, rule });
  } catch (error) { next(error); }
});

router.get('/executions', requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const executions = await recurrenceService.executions(req.query.rule_id ? parseInt(req.query.rule_id, 10) : null);
    res.json({ success: true, executions });
  } catch (error) { next(error); }
});

router.post('/sweep', requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const result = await recurrenceService.runDueTasks();
    res.json({ success: true, ...result });
  } catch (error) { next(error); }
});

module.exports = router;
