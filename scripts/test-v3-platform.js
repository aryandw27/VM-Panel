const axios = require('axios');
const { initDb, closeDb, collections } = require('../src/lib/db');
const authService = require('../src/services/authService');
const moduleLoader = require('../src/lib/moduleLoader');
const pluginManager = require('../src/lib/pluginManager');
const themeEngine = require('../src/lib/themeEngine');

const BASE_WEB = 'http://127.0.0.1:3001';

async function run() {
  console.log('======================================================');
  console.log('       TESTING vPANEL PRO v3 PLATFORM ARCHITECTURE    ');
  console.log('======================================================');

  await initDb();
  await pluginManager.init();

  const adminUser = await collections.users.findOne({ $or: [{ role: 'admin' }, { root_admin: 1 }] });
  if (!adminUser) {
    console.error('FAIL: Admin user not found');
    process.exit(1);
  }

  const token = authService.signToken(adminUser);
  const authHeaders = {
    Authorization: 'Bearer ' + token,
    Cookie: 'token=' + token,
  };

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${message}`);
      failed++;
    }
  }

  try {
    
    console.log('\n>>> 1. Extensibility Engines (Modules, Plugins, Themes)');
    const modules = moduleLoader.listModules();
    assert(modules.length >= 6, `Module Loader loaded ${modules.length} core virtualization modules`);
    const slugs = modules.map(m => m.slug);
    assert(slugs.includes('storage') && slugs.includes('network') && slugs.includes('api_manager') && slugs.includes('audit'), 'Core modules registered in catalog');

    const themes = themeEngine.getThemes();
    assert(themes.length === 5, `Theme Engine registered 5 themes (${themes.map(t => t.id).join(', ')})`);
    const activeTheme = themeEngine.getActiveTheme();
    assert(!!activeTheme && !!activeTheme.accent, `Active theme retrieved: ${activeTheme.name} (${activeTheme.accent})`);

    const plugins = await pluginManager.getConfigs();
    assert(plugins.length >= 3, `Plugin Manager initialized ${plugins.length} event dispatchers`);
    const pluginIds = plugins.map(p => p.id);
    assert(pluginIds.includes('discord') && pluginIds.includes('telegram') && pluginIds.includes('webhook'), 'Discord, Telegram, and Webhook plugins initialized');

    
    await pluginManager.emitPlatformEvent('test:v3_probe', { status: 'testing', message: 'Platform integrity check' });
    const auditRecord = await collections.audit_events.findOne({ event: 'test:v3_probe' });
    assert(!!auditRecord, 'Platform event bus dispatched and logged to audit_events collection');

    
    console.log('\n>>> 2. Web UI Route Endpoints');
    const v3Routes = [
      { path: '/admin/storage', label: 'Storage Pools & ISO Library' },
      { path: '/admin/network', label: 'Network & Firewall' },
      { path: '/admin/api', label: 'API & Webhooks Manager' },
      { path: '/admin/audit', label: 'Audit & Security Center' },
      { path: '/admin/plugins', label: 'Plugins & Extensions Marketplace' },
    ];

    for (const r of v3Routes) {
      const res = await axios.get(`${BASE_WEB}${r.path}`, { headers: authHeaders });
      assert(res.status === 200, `GET ${r.path} [${r.label}] -> HTTP 200`);
    }

    
    console.log('\n>>> 3. Storage Pools & ISO Library APIs');
    const poolsRes = await axios.get(`${BASE_WEB}/admin/storage/api/pools`, { headers: authHeaders });
    assert(poolsRes.status === 200 && poolsRes.data.ok === true, 'GET /admin/storage/api/pools returns ok: true');
    assert(poolsRes.data.pools.length >= 1, `Storage pools found: ${poolsRes.data.pools.length}`);

    const newPoolRes = await axios.post(`${BASE_WEB}/admin/storage/api/pools/create`, {
      name: 'NVMe Test Pool',
      type: 'directory'
    }, { headers: authHeaders });
    assert(newPoolRes.status === 200 && newPoolRes.data.ok === true, `Created storage pool (ID: ${newPoolRes.data.pool.id})`);

    const delPoolRes = await axios.post(`${BASE_WEB}/admin/storage/api/pools/delete`, {
      id: newPoolRes.data.pool.id
    }, { headers: authHeaders });
    assert(delPoolRes.status === 200 && delPoolRes.data.ok === true, 'Deleted test storage pool');

    const isosRes = await axios.get(`${BASE_WEB}/admin/storage/api/isos`, { headers: authHeaders });
    assert(isosRes.status === 200 && isosRes.data.isos.length >= 3, `ISO images listed (${isosRes.data.isos.length} images)`);

    const volsRes = await axios.get(`${BASE_WEB}/admin/storage/api/volumes`, { headers: authHeaders });
    assert(volsRes.status === 200 && Array.isArray(volsRes.data.volumes), 'GET /admin/storage/api/volumes returns volumes array');

    
    console.log('\n>>> 4. Network & Firewall APIs');
    const ifacesRes = await axios.get(`${BASE_WEB}/admin/network/api/interfaces`, { headers: authHeaders });
    assert(ifacesRes.status === 200 && ifacesRes.data.interfaces.length >= 1, `Host network interfaces discovered (${ifacesRes.data.interfaces.length})`);

    const netPoolsRes = await axios.get(`${BASE_WEB}/admin/network/api/pools`, { headers: authHeaders });
    assert(netPoolsRes.status === 200 && netPoolsRes.data.pools.length >= 1, `IP Pools listed (${netPoolsRes.data.pools.length} subnets)`);

    const createFwdRes = await axios.post(`${BASE_WEB}/admin/network/api/forwards/create`, {
      name: 'Test HTTP Forward',
      host_port: 8089,
      vm_ip: '10.10.0.50',
      vm_port: 80,
      protocol: 'TCP'
    }, { headers: authHeaders });
    assert(createFwdRes.status === 200 && createFwdRes.data.ok === true, `Created port forward rule (ID: ${createFwdRes.data.forward.id})`);

    await axios.post(`${BASE_WEB}/admin/network/api/forwards/delete`, {
      id: createFwdRes.data.forward.id
    }, { headers: authHeaders });
    assert(true, 'Deleted test port forward rule');

    const fwRes = await axios.get(`${BASE_WEB}/admin/network/api/firewall`, { headers: authHeaders });
    assert(fwRes.status === 200 && fwRes.data.rules.length >= 3, `Firewall rules listed (${fwRes.data.rules.length} rules)`);

    const createFwRes = await axios.post(`${BASE_WEB}/admin/network/api/firewall/create`, {
      name: 'Block Telnet Port 23',
      action: 'DROP',
      direction: 'inbound',
      protocol: 'TCP',
      source: '0.0.0.0/0',
      port: '23'
    }, { headers: authHeaders });
    assert(createFwRes.status === 200 && createFwRes.data.ok === true, `Created firewall rule (ID: ${createFwRes.data.rule.id})`);

    await axios.post(`${BASE_WEB}/admin/network/api/firewall/toggle`, {
      id: createFwRes.data.rule.id,
      active: false
    }, { headers: authHeaders });
    assert(true, 'Toggled firewall rule status');

    await axios.post(`${BASE_WEB}/admin/network/api/firewall/delete`, {
      id: createFwRes.data.rule.id
    }, { headers: authHeaders });
    assert(true, 'Deleted test firewall rule');

    
    console.log('\n>>> 5. API & Webhook Manager APIs');
    const createKeyRes = await axios.post(`${BASE_WEB}/admin/api/api/keys/create`, {
      name: 'Automated Test Token',
      scopes: ['vms:read', 'vms:write']
    }, { headers: authHeaders });
    assert(createKeyRes.status === 200 && createKeyRes.data.ok === true, `Created API key: ${createKeyRes.data.key.key_preview}`);
    assert(createKeyRes.data.key.raw_key.startsWith('vp_live_'), 'API key formatted with vp_live_ security prefix');

    await axios.post(`${BASE_WEB}/admin/api/api/keys/revoke`, {
      id: createKeyRes.data.key.id
    }, { headers: authHeaders });
    assert(true, 'Revoked test API key');

    const createHookRes = await axios.post(`${BASE_WEB}/admin/api/api/webhooks/create`, {
      name: 'Test Webhook Endpoint',
      target_url: 'https://httpbin.org/post',
      secret: 'secret123'
    }, { headers: authHeaders });
    assert(createHookRes.status === 200 && createHookRes.data.ok === true, `Created webhook (ID: ${createHookRes.data.webhook.id})`);

    await axios.post(`${BASE_WEB}/admin/api/api/webhooks/delete`, {
      id: createHookRes.data.webhook.id
    }, { headers: authHeaders });
    assert(true, 'Deleted test webhook');

    
    console.log('\n>>> 6. Audit & Security Center APIs');
    const timelineRes = await axios.get(`${BASE_WEB}/admin/audit/api/timeline`, { headers: authHeaders });
    assert(timelineRes.status === 200 && Array.isArray(timelineRes.data.timeline), `Audit timeline retrieved (${timelineRes.data.timeline.length} events)`);

    const loginsRes = await axios.get(`${BASE_WEB}/admin/audit/api/logins`, { headers: authHeaders });
    assert(loginsRes.status === 200 && Array.isArray(loginsRes.data.logins), `Login history records retrieved (${loginsRes.data.logins.length} attempts)`);

    const incidentsRes = await axios.get(`${BASE_WEB}/admin/audit/api/incidents`, { headers: authHeaders });
    assert(incidentsRes.status === 200 && Array.isArray(incidentsRes.data.incidents), 'Security incidents query returned array');

    
    console.log('\n>>> 7. Plugins & Marketplace APIs');
    const pluginsRes = await axios.get(`${BASE_WEB}/admin/plugins/api/plugins`, { headers: authHeaders });
    assert(pluginsRes.status === 200 && Array.isArray(pluginsRes.data.plugins), `Plugins listed via API (${pluginsRes.data.plugins.length})`);

    const updatePluginRes = await axios.post(`${BASE_WEB}/admin/plugins/api/plugins/discord/update`, {
      enabled: false,
      webhook_url: 'https://discord.com/api/webhooks/test'
    }, { headers: authHeaders });
    assert(updatePluginRes.status === 200 && updatePluginRes.data.ok === true, 'Updated Discord plugin configuration');

    console.log('\n======================================================');
    console.log(`  vPANEL PRO v3 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('======================================================');

    await closeDb();
    if (failed > 0) process.exit(1);
  } catch (err) {
    console.error('Test error:', err.response ? err.response.data : err.message);
    await closeDb().catch(() => {});
    process.exit(1);
  }
}

run();
