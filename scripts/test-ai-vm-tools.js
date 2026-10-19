const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVmToolRunner, validateArguments, TOOL_DEFINITIONS, defaultToolPermissions, MAX_LOG_BYTES } = require('../src/services/aiVmTools');

function fixture(t, { enabled = true, accessible = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpanel-ai-vm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vm = { id: 7, owner_id: 10, name: 'test-vm', status: 'running', cpus: 4, memory: 2048, disk_size: '40G', os_type: 'Linux', codename: 'Test', img_file: '/private/host/path/disk.qcow2', agent_token: 'SECRET_AGENT', password: 'SECRET_PASSWORD', ssh_port: 2222, port_forwards: [{ host: 8080, guest: 80 }], gui_mode: false, created_at: '2026-01-01T00:00:00Z' };
  const records = { audit: [], finish: [], stats: 0, lookups: 0 };
  const cursor = (items) => ({ sort() { return this; }, limit() { return this; }, async toArray() { return items; } });
  const collections = {
    vms: { find: (query) => cursor(query.owner_id === 10 ? [vm] : []) },
    subusers: { find: () => cursor([]) },
    activity_logs: { find: () => cursor([{ event: 'vm:start', created_at: '2026-01-02', details: { password: 'SECRET_PASSWORD' }, user_id: 99, arbitrary: 'private' }, { event: 'unknown:event', details: { secret: 'hidden' } }]) },
    backups: { find: () => cursor([{ id: 3, vm_id: 7, name: 'daily', size: 1000, kind: 'qemu', created_at: '2026-01-03', file: '/private/backup.img' }]) },
  };
  const vmService = {
    async getVm(id) { records.lookups += 1; return id === 7 ? vm : { ...vm, id, owner_id: 999 }; },
    async canAccess(_user, target) { return accessible && target.owner_id === 10; },
    serializeVm: (item) => item,
    liveStats() { records.stats += 1; return { running: true, updated_at: '2026-01-04T00:00:00Z', uptime: 30, pid: 4321, ports: { ssh: 22, agent: 123 }, cpu: { percent: 12.5 }, memory: { used_bytes: 5000 }, disk: { actual_bytes: 7000 } }; },
  };
  const permissions = Object.fromEntries(TOOL_DEFINITIONS.map((tool) => [tool.name, enabled]));
  const run = createVmToolRunner({ vmService, collections, vmRoot: root, getPermissions: async () => permissions, auditStart: async (e) => records.audit.push(e), auditFinish: async (id, update) => records.finish.push({ id, update }) });
  return { root, vm, records, run, permissions };
}

test('tool registry exposes bounded read-only VM capabilities only', () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((tool) => tool.name), ['list_deployments', 'inspect_deployment', 'read_deployment_logs', 'get_vm_stats', 'search_vm_logs', 'inspect_vm_config', 'get_vm_events', 'list_vm_backups', 'start_vm', 'stop_vm', 'restart_vm']);
  assert.ok(TOOL_DEFINITIONS.slice(0, 8).every((tool) => tool.risk === 'read_only' && tool.approval_required === false));
  assert.ok(TOOL_DEFINITIONS.slice(8).every((tool) => tool.approval_required === true));
  assert.ok(TOOL_DEFINITIONS.slice(0, 8).every((tool) => defaultToolPermissions()[tool.name] === true));
  assert.ok(TOOL_DEFINITIONS.slice(8).every((tool) => defaultToolPermissions()[tool.name] === false));
  assert.throws(() => validateArguments('inspect_vm_config', { vm_id: 7, command: 'id' }), { category: 'invalid_tool_arguments' });
  assert.throws(() => validateArguments('search_vm_logs', { vm_id: 7, query: '   ' }), { category: 'invalid_tool_arguments' });
  assert.throws(() => validateArguments('read_deployment_logs', { deployment_id: 7, lines: 101 }), { category: 'invalid_tool_arguments' });
});

test('forged VM identifiers are denied and audited without collecting stats', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run({ id: 10 }, 'get_vm_stats', { vm_id: 88 }), { category: 'vm_access_denied' });
  assert.equal(f.records.stats, 0);
  assert.equal(f.records.audit[0].payload.tool_enabled, true);
  assert.equal(f.records.finish[0].update['payload.status'], 'denied');
});

test('disabled tools are denied server-side before VM lookup', async (t) => {
  const f = fixture(t, { enabled: false });
  await assert.rejects(f.run({ id: 10 }, 'get_vm_stats', { vm_id: 7 }), { category: 'tool_disabled' });
  assert.equal(f.records.lookups, 0);
  assert.equal(f.records.finish[0].update['payload.result_category'], 'tool_disabled');
});

test('lifecycle tools remain disabled by default and direct runner calls cannot bypass the setting', async (t) => {
  const f = fixture(t);
  f.permissions.start_vm = false;
  await assert.rejects(f.run({ id: 10 }, 'start_vm', { vm_id: 7 }), { category: 'tool_disabled' });
  assert.equal(f.records.lookups, 0);
});

test('stats and config return real sanitized host metrics without host paths or secrets', async (t) => {
  const f = fixture(t);
  const stats = await f.run({ id: 10 }, 'get_vm_stats', { vm_id: 7 });
  assert.equal(stats.cpu.host_process_average_percent, 12.5);
  assert.equal(stats.cpu.guest_utilization_available, false);
  assert.equal(stats.memory.qemu_host_rss_bytes, 5000);
  assert.equal(stats.disk.qemu_image_file_length_bytes, 7000);
  assert.equal(JSON.stringify(stats).includes('4321'), false);
  assert.equal(JSON.stringify(stats).includes('agent'), false);
  const config = await f.run({ id: 10 }, 'inspect_vm_config', { vm_id: 7 });
  const encoded = JSON.stringify(config);
  assert.equal(encoded.includes('/private/host'), false);
  assert.equal(encoded.includes('SECRET_AGENT'), false);
  assert.equal(encoded.includes('SECRET_PASSWORD'), false);
  assert.equal(config.network.port_forwards[0].guest_port, 80);
});

test('logs are bounded, searched, and redact common credentials', async (t) => {
  const f = fixture(t);
  const dir = path.join(f.root, '7');
  fs.mkdirSync(dir);
  const secret = 'abc123-private-secret';
  fs.writeFileSync(path.join(dir, 'boot.log'), `earlier\nPASSWORD=${secret}\nAuthorization: Bearer token-value-123\n${'x'.repeat(MAX_LOG_BYTES + 1000)}\nERROR missing package\n`);
  fs.writeFileSync(path.join(dir, 'qemu.log'), `could not open /home/admin/panel/vms/7/disk.qcow2\n`);
  const result = await f.run({ id: 10 }, 'read_deployment_logs', { deployment_id: 7, lines: 100 });
  const output = JSON.stringify(result);
  assert.ok(Buffer.byteLength(output) < 14000);
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes('token-value-123'), false);
  const qemuLog = await f.run({ id: 10 }, 'search_vm_logs', { vm_id: 7, query: 'could not open', context_lines: 0 });
  assert.equal(JSON.stringify(qemuLog).includes('/home/admin/panel'), false);
  const search = await f.run({ id: 10 }, 'search_vm_logs', { vm_id: 7, query: 'missing package', context_lines: 1 });
  assert.equal(search.match_count, 1);
  assert.equal(search.snippets[0].lines.some((line) => line.matched), true);
});

test('symlinked VM log directories are not followed', async (t) => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vpanel-ai-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'boot.log'), 'private data');
  fs.symlinkSync(outside, path.join(f.root, '7'));
  await assert.rejects(f.run({ id: 10 }, 'read_deployment_logs', { deployment_id: 7 }), { category: 'log_access_denied' });
});

test('events and backup inventory omit sensitive detail and host file paths', async (t) => {
  const f = fixture(t);
  const events = await f.run({ id: 10 }, 'get_vm_events', { vm_id: 7 });
  assert.deepEqual(events.events, [{ event: 'vm:start', timestamp: '2026-01-02' }]);
  assert.equal(JSON.stringify(events).includes('SECRET_PASSWORD'), false);
  const backups = await f.run({ id: 10 }, 'list_vm_backups', { vm_id: 7 });
  assert.equal(JSON.stringify(backups).includes('/private/backup.img'), false);
});

test('VM-list ownership is rechecked for each row and output is minimized', async (t) => {
  const f = fixture(t);
  const result = await f.run({ id: 10 }, 'list_deployments', {});
  assert.deepEqual(result.vms, [{ id: 7, name: 'test-vm', status: 'running', vcpus: 4, configured_memory_mb: 2048 }]);
  assert.equal(JSON.stringify(result).includes('img_file'), false);
});
