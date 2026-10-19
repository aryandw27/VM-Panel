const express = require('express');
const pluginManager = require('../lib/pluginManager');
const moduleLoader = require('../lib/moduleLoader');
const { requireAdmin } = require('../middleware/auth');
const { settings } = require('../lib/db');
const activity = require('../services/activityService');

const router = express.Router();
router.use(requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const [plugins, modules] = await Promise.all([
      pluginManager.getConfigs(),
      moduleLoader.listModules(),
    ]);

    res.render('admin/plugins', {
      page: 'admin-plugins',
      user: req.user,
      settings: settings.all(),
      plugins,
      modules,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/api/plugins', async (req, res) => {
  try {
    const plugins = await pluginManager.getConfigs();
    res.json({ ok: true, plugins });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/plugins/:id/update', async (req, res) => {
  try {
    const updated = await pluginManager.updateConfig(req.params.id, req.body);
    await activity.logActivity({ user_id: req.user.id, event: 'plugin:update', details: { id: req.params.id } });
    res.json({ ok: true, plugin: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/plugins/:id/test', async (req, res) => {
  try {
    const result = await pluginManager.testPlugin(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/modules', (req, res) => {
  res.json({ ok: true, modules: moduleLoader.listModules() });
});

router.post('/api/modules/:slug/toggle', (req, res) => {
  try {
    const updated = moduleLoader.toggleModule(req.params.slug, req.body.enabled);
    res.json({ ok: true, module: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
