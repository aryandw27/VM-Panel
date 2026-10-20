const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const discordLogger = require('../../bot/discordLogger');
const activity = require('../services/activityService');
const logger = require('../lib/logger');

const router = express.Router();
router.use(requireAdmin);

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) {
        return res.status(403).json({ ok: false, error: 'Cross-origin logging changes are not allowed' });
      }
    } catch (_) {
      return res.status(403).json({ ok: false, error: 'Invalid request origin' });
    }
  } else if (req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ ok: false, error: 'Cross-origin logging changes are not allowed' });
  }
  return next();
}

router.get('/', async (req, res, next) => {
  try {
    const logging = await discordLogger.getAdminState();
    res.render('admin/logging', {
      page: 'admin-logging',
      user: req.user,
      settings: require('../lib/db').settings.all(),
      logging,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/api', async (req, res) => {
  try {
    res.json({ ok: true, logging: await discordLogger.getAdminState() });
  } catch (error) {
    logger.error(`[logging] failed to load Discord settings: ${error.message}`);
    res.status(500).json({ ok: false, error: 'Unable to load Discord logging settings' });
  }
});

router.get('/api/guilds/:guildId/channels', async (req, res) => {
  try {
    res.json({ ok: true, channels: await discordLogger.getGuildChannels(req.params.guildId) });
  } catch (error) {
    const status = error instanceof TypeError ? 400 : 502;
    if (status === 502) logger.warn(`[logging] failed to load Discord channels: ${error.message}`);
    res.status(status).json({ ok: false, error: status === 400 ? error.message : 'Unable to load channels; check bot permissions and connection' });
  }
});

router.post('/api/save', requireSameOrigin, express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const logging = await discordLogger.save(req.body || {});
    await activity.logActivity({
      user_id: req.user.id,
      event: 'admin:logging_config_update',
      details: { enabled: logging.enabled, routeCount: logging.routes.length },
      ip: req.ip,
      user_agent: req.get('user-agent'),
    });
    res.json({ ok: true, logging });
  } catch (error) {
    const status = error instanceof TypeError ? 400 : 500;
    if (status === 500) logger.error(`[logging] failed to save Discord settings: ${error.message}`);
    res.status(status).json({ ok: false, error: status === 400 ? error.message : 'Unable to save Discord logging settings' });
  }
});

router.post('/api/test', requireSameOrigin, express.json({ limit: '8kb' }), async (req, res) => {
  try {
    await discordLogger.sendTest(req.body?.guildId, req.body?.channelId);
    res.json({ ok: true });
  } catch (error) {
    const status = error instanceof TypeError ? 400 : 502;
    if (status === 502) logger.warn(`[logging] Discord test delivery failed: ${error.message}`);
    res.status(status).json({ ok: false, error: error instanceof TypeError ? error.message : 'Discord test delivery failed; verify bot permissions and channel selection' });
  }
});

module.exports = router;
