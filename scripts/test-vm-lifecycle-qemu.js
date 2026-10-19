const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function assertIsolated() {
  if (process.env.AI_VM_STAGING_CONFIRMED !== '1' || process.env.AI_VM_LIFECYCLE_ENABLED !== '1') throw new Error('Explicit isolated staging confirmation and lifecycle test enablement are required.');
  const root = path.resolve(process.env.AI_VM_STAGING_ROOT || '');
  const vmRoot = path.resolve(process.env.VM_DIR || '');
  const uri = new URL(process.env.MONGO_URI || '');
  if (!root || !vmRoot.startsWith(`${root}${path.sep}`) || !['127.0.0.1', 'localhost', '[::1]'].includes(uri.hostname) || !uri.pathname.slice(1).startsWith('vpanel_ai_validation_')) {
    throw new Error('Refusing QEMU test: VM storage or MongoDB is not an explicitly isolated staging target.');
  }
  if (!fs.existsSync(path.join(root, '.vpanel-staging-marker'))) throw new Error('Staging root marker is missing.');
  if (os.userInfo().username === 'admin' && root.startsWith('/home/admin/panel')) throw new Error('Production panel storage is forbidden for this test.');
  return { root, vmRoot };
}

function qemuImgCreate(stageRoot, imageFile) {
  const result = spawnSync('docker', [
    'run', '--rm', '--network=none', '--user', `${process.getuid()}:${process.getgid()}`,
    '--volume', `${stageRoot}:${stageRoot}`, '--entrypoint', '/usr/bin/qemu-img',
    'vpanel-qemu-staging:local', 'create', '-f', 'qcow2', imageFile, '16M',
  ], { encoding: 'utf8', timeout: 20000 });
  if (result.status !== 0) throw new Error('Could not create the synthetic staging disk image.');
}

async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test('real QEMU lifecycle against a synthetic, isolated staging disk', async (t) => {
  const { root, vmRoot } = assertIsolated();
  const config = require('../src/lib/config');
  const { collections, ensureConnected, closeDb } = require('../src/lib/db');
  const vmService = require('../src/services/vmService');
  await ensureConnected();
  const existing = await collections.vms.countDocuments();
  assert.equal(existing, 0, 'staging database must start empty');

  const id = Number(String(Date.now()).slice(-8)) + 100000000;
  const vmDir = path.join(vmRoot, String(id));
  fs.mkdirSync(vmDir, { recursive: true });
  const disk = path.join(vmDir, 'disk.qcow2');
  qemuImgCreate(root, disk);
  const seed = path.join(vmDir, 'seed.iso');
  fs.writeFileSync(seed, Buffer.alloc(64 * 1024));
  const vm = {
    id, owner_id: 1, name: `Staging-${id}`, cpus: 1, memory: 128, disk_size: '16M',
    img_file: disk, seed_file: seed, ssh_port: 39121, vnc_port: 39122, agent_port: 39123,
    agent_token: 'isolated-test-only', port_forwards: '[]', gui_mode: 0, status: 'stopped', suspended: false,
  };
  await collections.vms.insertOne(vm);
  t.after(async () => {
    try {
      if (vmService.isRunning(vm)) {
        const pid = fs.readFileSync(path.join(vmDir, 'qemu.pid'), 'utf8').trim();
        if (/^\d+$/.test(pid)) process.kill(Number(pid), 'SIGKILL');
      }
    } catch (_) {}
    const stopDeadline = Date.now() + 5000;
    while (vmService.isRunning(vm) && Date.now() < stopDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
    if (vmService.isRunning(vm)) throw new Error('Staging QEMU is still active; preserving its disk directory for safe manual recovery.');
    await collections.vms.deleteOne({ id });
    if (process.env.AI_VM_STAGING_KEEP_ARTIFACTS !== '1') await fs.promises.rm(vmDir, { recursive: true, force: true });
  });

  const started = await vmService.start(vm, { user: { id: 1 } });
  assert.equal(started.ok, true);
  assert.equal(vmService.isRunning(vm), true);
  const firstPid = fs.readFileSync(path.join(vmDir, 'qemu.pid'), 'utf8').trim();
  assert.match(firstPid, /^\d+$/);
  assert.equal((await vmService.start(vm, { user: { id: 1 } })).noop, true);

  const restarted = await vmService.restart(vm, { id: 1 });
  assert.equal(restarted.ok, true);
  assert.equal(vmService.isRunning(vm), true);
  assert.equal((await vmService.stop(vm, { user: { id: 1 } })).state, 'stopped');
  assert.equal(vmService.isRunning(vm), false);
  assert.equal((await vmService.stop(vm, { user: { id: 1 } })).noop, true);

  await vmService.start(vm, { user: { id: 1 } });
  const pid = Number(fs.readFileSync(path.join(vmDir, 'qemu.pid'), 'utf8').trim());
  process.kill(pid, 'SIGKILL');
  assert.equal(await until(() => !vmService.isRunning(vm)), true, 'unexpected QEMU exit is observed');
  await until(async () => (await collections.vms.findOne({ id })).status === 'stopped');

  const invalidId = id + 1;
  const invalidDir = path.join(vmRoot, String(invalidId));
  fs.mkdirSync(invalidDir, { recursive: true });
  const invalidVm = { ...vm, id: invalidId, name: `Invalid-${invalidId}`, img_file: path.join(invalidDir, 'invalid.qcow2'), seed_file: path.join(invalidDir, 'seed.iso') };
  delete invalidVm._id;
  invalidVm.uuid = crypto.randomUUID();
  fs.writeFileSync(invalidVm.img_file, 'not a qcow2 image');
  fs.writeFileSync(invalidVm.seed_file, Buffer.alloc(1024));
  await collections.vms.insertOne(invalidVm);
  t.after(async () => { await ensureConnected(); await collections.vms.deleteOne({ id: invalidId }); await fs.promises.rm(invalidDir, { recursive: true, force: true }); await closeDb(); });
  await assert.rejects(vmService.start(invalidVm, { user: { id: 1 } }), { category: 'vm_start_failed' });
  assert.equal(vmService.isRunning(invalidVm), false);
});
