const { MongoClient } = require('mongodb');
const config = require('./config');
const logger = require('./logger');

const client = new MongoClient(config.mongoUri, {
  maxPoolSize: 20,
  minPoolSize: 2,
  serverSelectionTimeoutMS: 5000,
});

let dbInstance = null;
let connectingPromise = null;
const collections = {};
const settingsCache = {};

async function getNextId(name) {
  await ensureConnected();
  let maxId = 0;
  try {
    if (collections[name]) {
      const highest = await collections[name]
        .find({ id: { $type: 'number' } })
        .sort({ id: -1 })
        .limit(1)
        .toArray();
      if (highest.length > 0 && typeof highest[0].id === 'number') {
        maxId = highest[0].id;
      }
    }
  } catch (_) {}

  const ret = await collections.counters.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  let nextSeq = typeof ret.seq === 'number' ? ret.seq : (ret.value?.seq || 1);
  if (nextSeq <= maxId) {
    nextSeq = maxId + 1;
    await collections.counters.updateOne({ _id: name }, { $set: { seq: nextSeq } });
  }
  return nextSeq;
}

const defaultSettings = {
  'panel.name': 'SiliconHost',
  'panel.logo_mode': 'url',
  'panel.logo_url': '',
  'panel.logo_file': '',
  'panel.favicon_name': 'SiliconHost',
  'panel.favicon_mode': 'url',
  'panel.favicon_url': '',
  'panel.favicon_file': '',
  'panel.bg_mode': 'color',
  'panel.bg_color': '#000000',
  'panel.bg_url': '',
  'panel.bg_file': '',
  'panel.bg_video_file': '',
  'panel.bg_video_url': '',
  'panel.bg_cover': '1',
  'panel.bg_overlay': '0.55',
  'panel.music_mode': 'none',
  'panel.music_url': '',
  'panel.music_file': '',
  'panel.music_youtube': '',
  'panel.music_autoplay': '0',
  'panel.music_loop': '1',
  'panel.music_volume': '35',
  'panel.navbar_style': 'glass',
  'panel.navbar_transparent': '1',
  'panel.navbar_blur': '1',
  'panel.accent': '#38bdf8',
  'panel.theme': 'dark',
  'panel.wallpapers_api_key': '',
  'billing.currency': 'USD',
  'billing.currency_symbol': '$',
  'billing.stripe_enabled': '0',
  'billing.paypal_enabled': '0',
  'billing.bank_transfer_enabled': '1',
  'billing.bank_details': 'Bank: Global Cloud Bank\nAccount: 0123-4567-8901\nRouting/IFSC: GCB000452',
  'update.channel': 'stable',
  'update.auto_check': '1',
  'update.backup_before': '1',
  'update.auto_pm2_restart': '1',
  'update.repo': 'nobita329/vpanel-pro',
  'update.last_checked': '',
  'update.latest_version': '',
  'update.available': '0',
  'update.ignored_version': '',
  'mail.host': config.mail.host,
  'mail.port': String(config.mail.port),
  'mail.secure': String(config.mail.secure),
  'mail.user': config.mail.user,
  'mail.pass': config.mail.pass,
  'mail.from': config.mail.from,
  'mail.verify': String(Boolean(config.mail.host)),
  'security.allow_register': config.allowRegister ? '1' : '0',
  'security.require_verify': '0',
  'security.force_tfa': '0',
  'security.rate_limit': JSON.stringify({
    enabled: true,
    maxRequests: 120,
    windowSeconds: 60,
    punishmentSeconds: 900,
  }),
  'vm.auto_port_min': String(config.autoPortMin),
  'vm.auto_port_max': String(config.autoPortMax),
  'vm.vnc_port_min': String(config.autoVncPortMin),
  'vm.vnc_port_max': String(config.autoVncPortMax),
  'vm.agent_port_min': String(config.autoAgentPortMin),
  'vm.agent_port_max': String(config.autoAgentPortMax),
  'vm.default_memory': '2048',
  'vm.default_cpus': '2',
  'vm.default_disk': '20G',
  'vm.default_os': 'Ubuntu 24.04',
  'vm.os_list': JSON.stringify([
    ['Ubuntu 22.04', 'ubuntu', 'jammy', 'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img', 'ubuntu', 'root'],
    ['Ubuntu 24.04', 'ubuntu', 'noble', 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img', 'ubuntu', 'root'],
    ['Ubuntu 25.10', 'ubuntu', 'questing', 'https://cloud-images.ubuntu.com/releases/questing/release/ubuntu-25.10-server-cloudimg-amd64.img', 'ubuntu', 'root'],
    ['Ubuntu 26.04', 'ubuntu', 'resolute', 'https://cloud-images.ubuntu.com/releases/resolute/release/ubuntu-26.04-server-cloudimg-amd64.img', 'ubuntu', 'root'],
    ['Debian 11', 'debian', 'bullseye', 'https://cloud.debian.org/images/cloud/bullseye/latest/debian-11-generic-amd64.qcow2', 'debian', 'root'],
    ['Debian 12', 'debian', 'bookworm', 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2', 'debian', 'root'],
    ['Debian 13', 'debian', 'trixie', 'https://cloud.debian.org/images/cloud/trixie/latest/debian-13-generic-amd64.qcow2', 'debian', 'root'],
    ['Kali Linux 2026.2', 'kali', '2026.2', 'https://kali.download/cloud-images/current/kali-linux-2026.2-cloud-genericcloud-amd64.tar.xz', 'kali', 'root'],
    ['Fedora 43', 'fedora', '43', 'https://download.fedoraproject.org/pub/fedora/linux/releases/43/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-43-1.6.x86_64.qcow2', 'fedora', 'root'],
    ['CentOS Stream 9', 'centos', 'stream9', 'https://cloud.centos.org/centos/9-stream/x86_64/images/CentOS-Stream-GenericCloud-9-latest.x86_64.qcow2', 'centos', 'root'],
    ['CentOS Stream 10', 'centos', 'stream10', 'https://cloud.centos.org/centos/10-stream/x86_64/images/CentOS-Stream-GenericCloud-10-latest.x86_64.qcow2', 'cloud-user', 'root'],
    ['AlmaLinux 9', 'almalinux', '9', 'https://repo.almalinux.org/almalinux/9/cloud/x86_64/images/AlmaLinux-9-GenericCloud-latest.x86_64.qcow2', 'almalinux', 'root'],
    ['AlmaLinux 10', 'almalinux', '10', 'https://repo.almalinux.org/almalinux/10/cloud/x86_64/images/AlmaLinux-10-GenericCloud-latest.x86_64.qcow2', 'almalinux', 'root'],
    ['Rocky Linux 9', 'rockylinux', '9', 'https://download.rockylinux.org/pub/rocky/9/images/x86_64/Rocky-9-GenericCloud.latest.x86_64.qcow2', 'rocky', 'root'],
    ['Rocky Linux 10', 'rockylinux', '10', 'https://download.rockylinux.org/pub/rocky/10/images/x86_64/Rocky-10-GenericCloud.latest.x86_64.qcow2', 'rocky', 'root']
  ]),
  'vm.os_catalog_version': '0',
  'vm.template_repo': 'https://github.com/nobita329/Template.git',
  'user.default_cpu_cores': '8',
  'user.default_ram_mb': '8192',
  'user.default_disk_gb': '100',
  'user.default_bandwidth_gb': '1000',
  'user.default_ipv4': '2',
  'user.default_snapshots': '5',
  'user.default_backups': '10',
  'cache.auto_clear_enabled': '1',
  'cache.auto_clear_interval': '6h',
  'cache.last_cleared': '',
  'cache.total_clears': '0',
};

for (const [k, v] of Object.entries(defaultSettings)) {
  settingsCache[k] = v;
}

const S = {
  get(key, fallback = null) {
    if (key in settingsCache) {
      const val = settingsCache[key];
      try { return JSON.parse(val); } catch (_) { return val; }
    }
    return fallback;
  },
  async set(key, value) {
    await ensureConnected();
    const valStr = typeof value === 'string' ? value : JSON.stringify(value);
    settingsCache[key] = valStr;
    await collections.settings.updateOne(
      { key },
      { $set: { key, value: valStr } },
      { upsert: true }
    );
  },
  all() {
    const out = {};
    for (const [k, v] of Object.entries(settingsCache)) {
      try { out[k] = JSON.parse(v); } catch (_) { out[k] = v; }
    }
    
    delete out['ai.api_key'];
    return out;
  },
  async reload() {
    await ensureConnected();
    const allDocs = await collections.settings.find().toArray();
    for (const [k, v] of Object.entries(defaultSettings)) {
      settingsCache[k] = v;
    }
    for (const doc of allDocs) {
      settingsCache[doc.key] = doc.value;
    }
    if (!settingsCache['panel.name'] || settingsCache['panel.name'] === 'vpanel' || settingsCache['panel.name'] === 'vPanel Pro') {
      settingsCache['panel.name'] = 'SiliconHost';
    }
    return Object.keys(settingsCache).length;
  },
};

async function initDb() {
  if (dbInstance) return { db: dbInstance, collections, settings: S, getNextId };
  await client.connect();
  dbInstance = client.db('vpanel');

  const names = [
    'users', 'vms', 'subusers', 'backups', 'schedules',
    'activity_logs', 'settings', 'login_attempts', 'reset_tokens',
    'notifications', 'counters',
    'storage_pools', 'storage_volumes', 'iso_images',
    'network_bridges', 'ip_pools', 'port_forwards', 'firewall_rules',
    'api_keys', 'webhooks', 'audit_events', 'plugins_config',
    'billing_plans', 'billing_invoices', 'billing_coupons',
    'update_history', 'quotas', 'templates', 'user_sessions',
    'nodes', 'node_allocations', 'locations',
    'ai_credentials', 'ai_conversations', 'ai_messages', 'ai_events', 'ai_preferences',
    'ai_approvals', 'vm_operations', 'vm_operation_locks', 'incidents',
    'security_request_analytics', 'security_ip_blocks'
  ];
  for (const name of names) {
    collections[name] = dbInstance.collection(name);
  }

  try {
    await Promise.all([
      collections.user_sessions.createIndex({ session_id: 1 }, { unique: true }),
      collections.user_sessions.createIndex({ user_id: 1 }),
      collections.user_sessions.createIndex({ last_active_at: -1 }),
      collections.templates.createIndex({ vmid: 1 }, { unique: true, sparse: true }),
      collections.templates.createIndex({ id: 1 }, { unique: true }),
      collections.users.createIndex({ id: 1 }, { unique: true }),
      collections.users.createIndex({ username: 1 }, { unique: true }),
      collections.users.createIndex({ email: 1 }, { unique: true }),
      collections.vms.createIndex({ id: 1 }, { unique: true }),
      collections.vms.createIndex({ uuid: 1 }, { unique: true }),
      collections.vms.createIndex({ owner_id: 1 }),
      collections.subusers.createIndex({ id: 1 }, { unique: true }),
      collections.subusers.createIndex({ vm_id: 1 }),
      collections.subusers.createIndex({ user_id: 1 }),
      collections.backups.createIndex({ id: 1 }, { unique: true }),
      collections.backups.createIndex({ vm_id: 1 }),
      collections.schedules.createIndex({ id: 1 }, { unique: true }),
      collections.schedules.createIndex({ vm_id: 1 }),
      collections.activity_logs.createIndex({ id: 1 }, { unique: true }),
      collections.activity_logs.createIndex({ user_id: 1 }),
      collections.activity_logs.createIndex({ vm_id: 1 }),
      collections.activity_logs.createIndex({ created_at: -1 }),
      collections.settings.createIndex({ key: 1 }, { unique: true }),
      collections.login_attempts.createIndex({ ip: 1 }),
      collections.reset_tokens.createIndex({ token: 1 }),
      collections.notifications.createIndex({ user_id: 1 }),
      collections.storage_pools.createIndex({ id: 1 }, { unique: true }),
      collections.storage_volumes.createIndex({ id: 1 }, { unique: true }),
      collections.iso_images.createIndex({ id: 1 }, { unique: true }),
      collections.firewall_rules.createIndex({ id: 1 }, { unique: true }),
      collections.port_forwards.createIndex({ id: 1 }, { unique: true }),
      collections.api_keys.createIndex({ key: 1 }, { unique: true }),
      collections.webhooks.createIndex({ id: 1 }, { unique: true }),
      collections.audit_events.createIndex({ timestamp: -1 }),
      collections.billing_plans.createIndex({ id: 1 }, { unique: true }),
      collections.billing_invoices.createIndex({ id: 1 }, { unique: true }),
      collections.billing_coupons.createIndex({ id: 1 }, { unique: true }),
      collections.update_history.createIndex({ id: 1 }, { unique: true }),
      collections.update_history.createIndex({ timestamp: -1 }),
      collections.ai_credentials.createIndex({ user_id: 1, id: 1 }, { unique: true }),
      collections.ai_credentials.createIndex({ user_id: 1, active: 1 }),
      collections.ai_conversations.createIndex({ user_id: 1, updated_at: -1 }),
      collections.ai_messages.createIndex({ user_id: 1, conversation_id: 1, created_at: 1 }),
      collections.ai_events.createIndex({ user_id: 1, created_at: -1 }),
      collections.ai_preferences.createIndex({ user_id: 1 }, { unique: true }),
      collections.ai_approvals.createIndex({ approval_id: 1 }, { unique: true }),
      collections.ai_approvals.createIndex({ active_key: 1 }, { unique: true, sparse: true }),
      collections.ai_approvals.createIndex({ user_id: 1, conversation_id: 1, created_at: -1 }),
      collections.ai_approvals.createIndex({ created_at: 1 }, { expireAfterSeconds: 7776000 }),
      collections.vm_operations.createIndex({ operation_id: 1 }, { unique: true }),
      collections.vm_operations.createIndex({ vm_id: 1, created_at: -1 }),
      collections.vm_operations.createIndex({ created_at: 1 }, { expireAfterSeconds: 7776000 }),
      collections.vm_operation_locks.createIndex({ vm_id: 1 }, { unique: true }),
      collections.incidents.createIndex({ id: 1 }, { unique: true }),
      collections.incidents.createIndex({ dedupe_key: 1 }, { sparse: true }),
      collections.incidents.createIndex({ owner_id: 1, status: 1, last_observed_at: -1 }),
      collections.incidents.createIndex({ resource_type: 1, resource_id: 1, status: 1 }),
      collections.incidents.createIndex({ created_at: 1 }, { expireAfterSeconds: 7776000 }),
      collections.security_request_analytics.createIndex({ bucketStart: -1, lastSeenAt: -1 }),
      collections.security_request_analytics.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      collections.security_ip_blocks.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ]);
  } catch (e) {
    logger.warn('[mongo] index creation: ' + e.message);
  }

  try {
    const all = await collections.settings.find().toArray();
    for (const row of all) {
      settingsCache[row.key] = row.value;
    }
    for (const [k, v] of Object.entries(defaultSettings)) {
      if (!(k in settingsCache)) {
        await collections.settings.insertOne({ key: k, value: v });
        settingsCache[k] = v;
      }
    }
    const osCatalogVersion = Number(settingsCache['vm.os_catalog_version'] || 0);
    if (osCatalogVersion < 3) {
      let osList = settingsCache['vm.os_list'];
      if (typeof osList === 'string') osList = JSON.parse(osList);
      if (!Array.isArray(osList)) throw new Error('vm.os_list must be an array');

      const catalogAdditions = [
        ['Ubuntu 25.10', 'ubuntu', 'questing', 'https://cloud-images.ubuntu.com/releases/questing/release/ubuntu-25.10-server-cloudimg-amd64.img', 'ubuntu', 'root'],
        ['Ubuntu 26.04', 'ubuntu', 'resolute', 'https://cloud-images.ubuntu.com/releases/resolute/release/ubuntu-26.04-server-cloudimg-amd64.img', 'ubuntu', 'root'],
        ['Kali Linux 2026.2', 'kali', '2026.2', 'https://kali.download/cloud-images/current/kali-linux-2026.2-cloud-genericcloud-amd64.tar.xz', 'kali', 'root'],
        ['Fedora 43', 'fedora', '43', 'https://download.fedoraproject.org/pub/fedora/linux/releases/43/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-43-1.6.x86_64.qcow2', 'fedora', 'root'],
        ['CentOS Stream 10', 'centos', 'stream10', 'https://cloud.centos.org/centos/10-stream/x86_64/images/CentOS-Stream-GenericCloud-10-latest.x86_64.qcow2', 'cloud-user', 'root'],
        ['AlmaLinux 10', 'almalinux', '10', 'https://repo.almalinux.org/almalinux/10/cloud/x86_64/images/AlmaLinux-10-GenericCloud-latest.x86_64.qcow2', 'almalinux', 'root'],
        ['Rocky Linux 10', 'rockylinux', '10', 'https://download.rockylinux.org/pub/rocky/10/images/x86_64/Rocky-10-GenericCloud.latest.x86_64.qcow2', 'rocky', 'root'],
      ];
      const currentFedora = catalogAdditions.find((entry) => entry[0] === 'Fedora 43');
      const updatedOsList = osList.map((entry) => entry[0] === 'Fedora 40' ? currentFedora : entry);
      for (const entry of catalogAdditions) {
        if (!updatedOsList.some((existing) => existing[0] === entry[0])) updatedOsList.push(entry);
      }

      const serializedOsList = JSON.stringify(updatedOsList);
      await collections.settings.updateOne(
        { key: 'vm.os_list' },
        { $set: { key: 'vm.os_list', value: serializedOsList } },
        { upsert: true }
      );
      await collections.settings.updateOne(
        { key: 'vm.os_catalog_version' },
        { $set: { key: 'vm.os_catalog_version', value: '3' } },
        { upsert: true }
      );
      settingsCache['vm.os_list'] = serializedOsList;
      settingsCache['vm.os_catalog_version'] = '3';
    }
  } catch (e) {
    logger.warn('[mongo] settings cache init: ' + e.message);
  }

  return { db: dbInstance, collections, settings: S, getNextId };
}

function ensureConnected() {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (!connectingPromise) {
    connectingPromise = initDb()
      .then(() => dbInstance)
      .catch((err) => {
        connectingPromise = null;
        throw err;
      });
  }
  return connectingPromise;
}

ensureConnected().catch((err) => {
  logger.error('[mongo] connection error: ' + err.message);
});

async function closeDb() {
  try {
    await client.close();
  } catch (_) {}
  dbInstance = null;
  connectingPromise = null;
}

module.exports = {
  client,
  get db() { return dbInstance; },
  collections,
  getNextId,
  initDb,
  closeDb,
  settings: S,
  ensureConnected,
};
