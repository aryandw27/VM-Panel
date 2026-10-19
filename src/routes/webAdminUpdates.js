const express = require('express');
const updateService = require('../services/updateService');
const { settings } = require('../lib/db');
const activity = require('../services/activityService');
const router = express.Router();

function render(res, view, vars = {}) {
  res.render(`admin/${view}`, {
    page: 'admin-updates',
    user: res.req.user,
    settings: settings.all(),
    ...vars,
  });
}


router.get('/', async (req, res, next) => {
  try {
    let updateInfo = await updateService.checkForUpdates(false);
    const history = await updateService.listHistory(20);
    const status = updateService.getStatus();

    render(res, 'updates', {
      updateInfo,
      status,
      history,
      updateSettings: {
        channel: settings.get('update.channel') || 'stable',
        auto_check: settings.get('update.auto_check') !== '0',
        backup_before: settings.get('update.backup_before') !== '0',
        auto_pm2_restart: settings.get('update.auto_pm2_restart') !== '0',
        repo: settings.get('update.repo') || 'nobita329/vpanel-pro',
      },
    });
  } catch (err) {
    next(err);
  }
});


router.post('/check', async (req, res) => {
  try {
    const updateInfo = await updateService.checkForUpdates(true);
    res.json({ ok: true, updateInfo, status: updateService.getStatus() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  
  sendEvent('status', updateService.getStatus());
  if (updateService.updateLogs && updateService.updateLogs.length > 0) {
    for (const line of updateService.updateLogs) {
      sendEvent('log', { text: line });
    }
  }

  const onStep = (step) => sendEvent('step', step);
  const onLog = (text) => sendEvent('log', { text });
  const onDone = (done) => sendEvent('done', done);
  const onError = (err) => sendEvent('error', err);

  updateService.on('step', onStep);
  updateService.on('log', onLog);
  updateService.on('done', onDone);
  updateService.on('error', onError);

  req.on('close', () => {
    updateService.off('step', onStep);
    updateService.off('log', onLog);
    updateService.off('done', onDone);
    updateService.off('error', onError);
  });
});


router.post('/start', async (req, res) => {
  try {
    if (updateService.isUpdating) {
      return res.status(400).json({ ok: false, error: 'An update is already running' });
    }

    await activity.logActivity({
      user_id: req.user.id,
      event: 'system:update_started',
      details: {
        from: updateService.getCurrentVersion(),
        to: settings.get('update.latest_version') || 'latest',
      },
      ip: req.ip,
    });

    
    updateService
      .startUpdate({ userId: req.user.id, username: req.user.username })
      .catch(() => {});

    res.json({ ok: true, message: 'Update pipeline started' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


router.post('/rollback/:id', async (req, res) => {
  try {
    const result = await updateService.rollback(req.params.id);
    await activity.logActivity({
      user_id: req.user.id,
      event: 'system:update_rollback',
      details: { history_id: req.params.id, snapshot: result.restoredFrom },
      ip: req.ip,
    });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


router.post('/settings', express.json(), async (req, res) => {
  try {
    const { channel, auto_check, backup_before, auto_pm2_restart, repo } = req.body;
    if (channel) settings.set('update.channel', channel === 'beta' ? 'beta' : 'stable');
    if (auto_check !== undefined) settings.set('update.auto_check', auto_check ? '1' : '0');
    if (backup_before !== undefined) settings.set('update.backup_before', backup_before ? '1' : '0');
    if (auto_pm2_restart !== undefined) settings.set('update.auto_pm2_restart', auto_pm2_restart ? '1' : '0');
    if (repo) settings.set('update.repo', String(repo).trim());

    res.json({ ok: true, message: 'Update settings saved' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


router.post('/ignore', express.json(), async (req, res) => {
  try {
    const version = req.body.version;
    if (version) {
      settings.set('update.ignored_version', version);
      settings.set('update.available', '0');
    }
    res.json({ ok: true, message: `Version ${version} will be ignored` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
