const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const config = require('../src/lib/config');
const discordLogger = require('../bot/discordLogger');
const appStore = require('../src/services/appStoreService');
const vmService = require('../src/services/vmService');

test('Discord logging validates routes and templates before persistence', () => {
  assert.ok(discordLogger.EVENTS.includes('mongodb:document_insert'));
  assert.ok(discordLogger.EVENTS.includes('auth:password_reset'));
  const route = discordLogger.normalizeRoutes([{
    event: 'vm:start',
    guildId: '12345678901234567',
    channelId: '12345678901234568',
    template: '{user} started {server} from {ip}',
    color: '#5865F2',
  }])[0];
  assert.equal(route.event, 'vm:start');
  assert.equal(route.enabled, true);
  assert.match(route.id, /^[0-9a-f-]{36}$/i);
  assert.throws(() => discordLogger.normalizeRoutes([{
    event: 'arbitrary:event',
    guildId: '12345678901234567',
    channelId: '12345678901234568',
    template: 'hello',
  }]), /supported logging event/);
  assert.throws(() => discordLogger.normalizeRoutes([{
    event: 'vm:start',
    guildId: 'bad',
    channelId: '12345678901234568',
    template: 'hello',
  }]), /valid Discord server and channel/);
});

test('Discord templates substitute only supported placeholders and redact sensitive detail fields', () => {
  assert.equal(
    discordLogger.renderTemplate('{user} · {server} · {details} · {unknown}', {
      user: 'operator',
      server: 'db-01',
      details: '{"status":"running"}',
    }),
    'operator · db-01 · {"status":"running"} · {unknown}'
  );
  const details = discordLogger.safeDetails({
    action: 'update',
    password: 'not-for-discord',
    credentials: { apiKey: 'not-for-discord' },
    nested: [{ token: 'not-for-discord', status: 'ok' }],
  });
  assert.match(details, /"action":"update"/);
  assert.match(details, /"status":"ok"/);
  assert.doesNotMatch(details, /not-for-discord/);
});

test('Discord token encryption authenticates and never stores the token as plaintext', () => {
  const original = config.jwtSecret;
  const token = 'a'.repeat(48);
  try {
    config.jwtSecret = 'integration-test-secret-that-is-at-least-32-characters';
    const encrypted = discordLogger.encryptToken(token);
    assert.equal(discordLogger.decryptToken(encrypted), token);
    assert.ok(!JSON.stringify(encrypted).includes(token));
    assert.throws(() => discordLogger.decryptToken({ ...encrypted, tag: Buffer.alloc(16).toString('base64') }));
  } finally {
    config.jwtSecret = original;
  }
});

test('reviewed app scripts are bounded, private by default, and use stable guest ports', () => {
  const wordpress = appStore.wordpressScript();
  assert.match(wordpress, /docker-compose-v2/);
  assert.match(wordpress, /APP_PORT=8080/);
  assert.match(wordpress, /database:/);
  assert.match(wordpress, /chmod 600 \.env/);

  const openclaw = appStore.openClawScript('f'.repeat(64));
  assert.match(openclaw, /github\.com\/openclaw\/openclaw\.git/);
  assert.match(openclaw, /"mode":"token"/);
  assert.match(openclaw, /NET_ADMIN/);
  assert.match(openclaw, /OPENCLAW_GATEWAY_TOKEN/);
  assert.equal(appStore.MAX_CUSTOM_SCRIPT_BYTES, 16 * 1024);
});

test('VM port-forward parser handles legacy strings and serialized app-store mappings', () => {
  assert.deepEqual(vmService.parseForwards('25501:22,8080:80'), [
    { host: 25501, guest: 22 },
    { host: 8080, guest: 80 },
  ]);
  assert.deepEqual(vmService.parseForwards('[{"host":25501,"guest":22}]'), [
    { host: 25501, guest: 22 },
  ]);
  assert.deepEqual(vmService.parseForwards([{ host: 8080, guest: 80 }, { host: -1, guest: 99999 }]), [
    { host: 8080, guest: 80 },
  ]);
});

test('VM port-forward settings reject duplicate and invalid host ports', () => {
  assert.deepEqual(vmService.normalizePortForwards([{ host: '18080', guest: '80' }]), [
    { host: 18080, guest: 80 },
  ]);
  assert.throws(
    () => vmService.normalizePortForwards([{ host: 8080, guest: 80 }, { host: 8080, guest: 443 }]),
    /Host port 8080 is forwarded more than once/
  );
  assert.throws(() => vmService.normalizePortForwards([{ host: 70000, guest: 80 }]), /between 1 and 65535/);
});

test('VM host-forward validation automatically remaps occupied and already-reserved ports', async () => {
  const vm = { id: 12, ssh_port: 25512, agent_port: 26112, vnc_port: 25912 };
  const occupied = await vmService.validateHostForwards(vm, [{ host: 18080, guest: 8080 }], {
      reservedVms: [],
      isPortAvailable: async (port) => port !== 18080,
    });
  assert.deepEqual(occupied, [{ host: 25501, guest: 8080 }]);

  const reserved = await vmService.validateHostForwards(vm, [{ host: 18080, guest: 8080 }], {
      reservedVms: [{ id: 13, name: 'existing-vm', port_forwards: [{ host: 18080, guest: 80 }] }],
      isPortAvailable: async () => true,
    });
  assert.deepEqual(reserved, [{ host: 25501, guest: 8080 }]);
});

test('VM startup explains QEMU host-port bind failures with the mapping to change', () => {
  assert.match(
    vmService.explainQemuStartFailure("Could not set up host forwarding rule 'tcp::8080-:8080'"),
    /host port 8080 for guest port 8080.*different unused host port/
  );
  assert.match(vmService.explainQemuStartFailure('unsupported QEMU option'), /Review the VM boot log/);
});

test('host port availability check detects a listener already bound on the host', async (t) => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal(await vmService.checkHostPortAvailable(server.address().port), false);
});

test('QEMU host forwards share the existing guest NIC instead of adding extra default routes', () => {
  const args = vmService.buildQemuArgs({
    id: 77,
    memory: 1024,
    cpus: 1,
    ssh_port: 25501,
    agent_port: 26101,
    vnc_port: null,
    img_file: 'disk.qcow2',
    seed_file: 'seed.iso',
    port_forwards: [{ host: 25502, guest: 8080 }],
  });
  assert.equal(args.filter((value) => value === '-netdev').length, 1);
  assert.ok(args.includes('user,id=n0,hostfwd=tcp::25501-:22,hostfwd=tcp::26101-:9090,hostfwd=tcp::25502-:8080'));
});
