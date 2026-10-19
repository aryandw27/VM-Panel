const express = require('express');
const apiManagerService = require('../services/apiManagerService');
const { requireAdmin } = require('../middleware/auth');
const { settings } = require('../lib/db');
const activity = require('../services/activityService');

const router = express.Router();
router.use(requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const [keys, webhooks] = await Promise.all([
      apiManagerService.listApiKeys(),
      apiManagerService.listWebhooks(),
    ]);
    const docs = apiManagerService.getApiDocs();

    res.render('admin/api', {
      page: 'admin-api',
      user: req.user,
      settings: settings.all(),
      keys,
      webhooks,
      docs,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/api/keys', async (req, res) => {
  try {
    const keys = await apiManagerService.listApiKeys();
    res.json({ ok: true, keys });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/keys/create', async (req, res) => {
  try {
    const key = await apiManagerService.createApiKey(req.body.name, req.body.scopes, req.user.id);
    await activity.logActivity({ user_id: req.user.id, event: 'api_key:create', details: { name: key.name } });
    res.json({ ok: true, key });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/keys/revoke', async (req, res) => {
  try {
    const result = await apiManagerService.revokeApiKey(req.body.id);
    await activity.logActivity({ user_id: req.user.id, event: 'api_key:revoke', details: { id: req.body.id } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/webhooks', async (req, res) => {
  try {
    const webhooks = await apiManagerService.listWebhooks();
    res.json({ ok: true, webhooks });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/webhooks/create', async (req, res) => {
  try {
    const webhook = await apiManagerService.createWebhook(req.body);
    await activity.logActivity({ user_id: req.user.id, event: 'webhook:create', details: { target_url: webhook.target_url } });
    res.json({ ok: true, webhook });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/webhooks/delete', async (req, res) => {
  try {
    const result = await apiManagerService.deleteWebhook(req.body.id);
    await activity.logActivity({ user_id: req.user.id, event: 'webhook:delete', details: { id: req.body.id } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/webhooks/test', async (req, res) => {
  try {
    const result = await apiManagerService.testWebhook(req.body.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
