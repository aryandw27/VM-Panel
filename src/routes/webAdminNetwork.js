const express = require('express');
const networkService = require('../services/networkService');
const vmService = require('../services/vmService');
const { requireAdmin } = require('../middleware/auth');
const { settings } = require('../lib/db');
const activity = require('../services/activityService');

const router = express.Router();
router.use(requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const [ifaces, pools, forwards, rules, vms] = await Promise.all([
      networkService.getInterfaces(),
      networkService.listIpPools(),
      networkService.listPortForwards(),
      networkService.listFirewallRules(),
      vmService.dbVms(),
    ]);

    res.render('admin/network', {
      page: 'admin-network',
      user: req.user,
      settings: settings.all(),
      ifaces,
      pools,
      forwards,
      rules,
      vms,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/api/interfaces', async (req, res) => {
  try {
    const ifaces = await networkService.getInterfaces();
    res.json({ ok: true, interfaces: ifaces });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/pools', async (req, res) => {
  try {
    const pools = await networkService.listIpPools();
    res.json({ ok: true, pools });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/pools/create', async (req, res) => {
  try {
    const pool = await networkService.createIpPool(req.body);
    await activity.logActivity({ user_id: req.user.id, event: 'network:pool_create', details: { subnet: pool.subnet } });
    res.json({ ok: true, pool });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/pools/delete', async (req, res) => {
  try {
    const result = await networkService.deleteIpPool(req.body.id);
    await activity.logActivity({ user_id: req.user.id, event: 'network:pool_delete', details: { id: req.body.id } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/forwards', async (req, res) => {
  try {
    const forwards = await networkService.listPortForwards();
    res.json({ ok: true, forwards });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/forwards/create', async (req, res) => {
  try {
    const forward = await networkService.createPortForward(req.body);
    await activity.logActivity({ user_id: req.user.id, event: 'network:forward_create', details: { host_port: forward.host_port } });
    res.json({ ok: true, forward });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/forwards/delete', async (req, res) => {
  try {
    const result = await networkService.deletePortForward(req.body.id);
    await activity.logActivity({ user_id: req.user.id, event: 'network:forward_delete', details: { id: req.body.id } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/firewall', async (req, res) => {
  try {
    const rules = await networkService.listFirewallRules();
    res.json({ ok: true, rules });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/firewall/create', async (req, res) => {
  try {
    const rule = await networkService.createFirewallRule(req.body);
    await activity.logActivity({ user_id: req.user.id, event: 'network:firewall_create', details: { name: rule.name } });
    res.json({ ok: true, rule });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/firewall/toggle', async (req, res) => {
  try {
    const result = await networkService.toggleFirewallRule(req.body.id, req.body.active);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/firewall/delete', async (req, res) => {
  try {
    const result = await networkService.deleteFirewallRule(req.body.id);
    await activity.logActivity({ user_id: req.user.id, event: 'network:firewall_delete', details: { id: req.body.id } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
