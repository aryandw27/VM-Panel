const express = require('express');
const auditService = require('../services/auditService');
const { requireAdmin } = require('../middleware/auth');
const { settings } = require('../lib/db');

const router = express.Router();
router.use(requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const [timeline, loginHistory, incidents] = await Promise.all([
      auditService.getTimeline(60),
      auditService.getLoginHistory(40),
      auditService.getSecurityIncidents(),
    ]);

    res.render('admin/audit', {
      page: 'admin-audit',
      user: req.user,
      settings: settings.all(),
      timeline,
      loginHistory,
      incidents,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/api/timeline', async (req, res) => {
  try {
    const timeline = await auditService.getTimeline(100);
    res.json({ ok: true, timeline });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/logins', async (req, res) => {
  try {
    const logins = await auditService.getLoginHistory(50);
    res.json({ ok: true, logins });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/incidents', async (req, res) => {
  try {
    const incidents = await auditService.getSecurityIncidents();
    res.json({ ok: true, incidents });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
