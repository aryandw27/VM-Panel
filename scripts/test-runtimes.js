const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const definitions = require('../src/services/runtimes/definitions');
const util = require('../src/services/runtimes/util');
const provision = require('../src/services/runtimes/provision');
const docker = require('../src/services/runtimes/docker');
const lxc = require('../src/services/runtimes/lxc');
const incus = require('../src/services/runtimes/incus');
const qemuLimits = require('../src/services/runtimes/qemuLimits');
const containerTerminal = require('../src/services/containerTerminal');

function fakeCursor(rows) {
  const cursor = {
    sort() { return cursor; },
    limit() { return cursor; },
    async toArray() { return rows.map((row) => structuredClone(row)); },
  };
  return cursor;
}

function loadCapacity({ vms = [], node = null } = {}) {
  const dbPath = require.resolve('../src/lib/db');
  const capacityPath = require.resolve('../src/services/capacityService');
  delete require.cache[capacityPath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      collections: {
        vms: { find: () => fakeCursor(vms) },
        nodes: { findOne: async () => node },
      },
    },
  };
  const capabilities = require('../src/services/runtimes/capabilities');
  const original = capabilities.detectCached;
  return {
    service: require('../src/services/capacityService'),
    restore() {
      capabilities.detectCached = original;
      delete require.cache[dbPath];
      delete require.cache[capacityPath];
    },
  };
}

test('six deployment kinds are exposed in a stable order and legacy rows default to QEMU', () => {
  assert.deepEqual(definitions.KIND_ORDER, [
    'qemu-dedicated', 'qemu-shared', 'docker', 'lxc', 'incus-container', 'incus-vm',
  ]);
  assert.equal(definitions.publicKinds().length, 6);
  assert.equal(definitions.normalizeKind('not-a-kind'), definitions.DEFAULT_KIND);
  assert.equal(definitions.normalizeKind('docker'), 'docker');
  assert.equal(definitions.isContainerKind('docker'), true);
  assert.equal(definitions.isContainerKind('lxc'), true);
  assert.equal(definitions.isContainerKind('incus-container'), true);
  assert.equal(definitions.isContainerKind('incus-vm'), false);
  assert.equal(definitions.isContainerKind('qemu-shared'), false);
  assert.equal(definitions.runtimeForKind('incus-vm'), 'incus');
});

test('nodes without KVM offer shared VMs but not dedicated VMs', () => {
  const capabilities = require('../src/services/runtimes/capabilities');
  const caps = {
    runtimes: {
      qemu: { available: true, kvm: false },
      docker: { available: true },
      lxc: { available: false },
      incus: { available: false },
    },
  };
  assert.equal(capabilities.kindAvailability('qemu-dedicated', caps).available, false);
  assert.match(capabilities.kindAvailability('qemu-dedicated', caps).reason, /shared CPU VM/);
  assert.equal(capabilities.kindAvailability('qemu-shared', caps).available, true);
  assert.equal(capabilities.kindAvailability('docker', caps).available, true);
  assert.equal(capabilities.kindAvailability('lxc', caps).available, false);
});

test('container image references reject shell metacharacters and accept curated images', () => {
  assert.equal(definitions.isValidImage('docker', 'ubuntu:24.04'), true);
  assert.equal(definitions.isValidImage('docker', 'ghcr.io/example/app:1.2'), true);
  assert.equal(definitions.isValidImage('lxc', 'images:debian/12'), true);
  assert.equal(definitions.isValidImage('docker', 'ubuntu:24.04; rm -rf /'), false);
  assert.equal(definitions.isValidImage('docker', "ubuntu:24.04' && curl evil"), false);
  assert.equal(definitions.isValidImage('docker', 'ubuntu:24.04\nRUN echo'), false);
  assert.equal(definitions.isValidImage('docker', ''), false);
});

test('shared and dedicated kinds carry different admission overcommit factors', () => {
  const dedicated = definitions.definitionFor('qemu-dedicated');
  const shared = definitions.definitionFor('qemu-shared');
  assert.equal(dedicated.cpu_overcommit, 1);
  assert.ok(shared.cpu_overcommit > 1);
  assert.equal(dedicated.memory_overcommit, 1);
  assert.equal(shared.memory_overcommit, 1);
  assert.equal(dedicated.is_vm, true);
  assert.equal(shared.is_vm, true);
});

test('access and port parsing is strict', () => {
  assert.deepEqual(util.normalizeAccess(undefined), { ssh: true, terminal: true, ports: true });
  assert.deepEqual(util.normalizeAccess({ ssh: false, terminal: '0', ports: 1 }), { ssh: false, terminal: false, ports: true });
  assert.deepEqual(
    util.normalizeForwards([{ host: 8080, guest: 80 }, { host: '0', guest: 80 }, { host: 9000, guest: 'x' }]),
    [{ host: 8080, guest: 80 }],
  );
  assert.equal(util.dockerSizeToBytes('12.5MiB'), Math.round(12.5 * 1024 * 1024));
  assert.equal(util.dockerSizeToBytes('2GiB'), 2 * 1024 ** 3);
  assert.equal(util.parseDiskGb('20G'), 20);
  assert.equal(util.parseDiskGb('512M'), 1);
});

test('Docker run arguments enforce caps and publish only requested ports', () => {
  const args = docker.buildRunArgs({
    id: 12, name: 'Web Box', hostname: 'web-box', cpus: 2, memory: 2048,
    image: 'debian:12', ssh_port: 25501,
    access: { ssh: true, terminal: true, ports: true },
    port_forwards: [{ host: 8080, guest: 80 }, { host: 25501, guest: 22 }],
  });
  const joined = args.join(' ');
  assert.match(joined, /--cpus 2/);
  assert.match(joined, /--memory 2048m/);
  assert.match(joined, /--memory-swap 2048m/);
  assert.match(joined, /--pids-limit 512/);
  assert.match(joined, /-p 0\.0\.0\.0:25501:22/);
  assert.match(joined, /-p 0\.0\.0\.0:8080:80/);
  assert.equal(args.filter((value) => value === '-p').length, 2);
  assert.equal(args[args.length - 4], 'debian:12');

  const terminalOnly = docker.buildRunArgs({
    id: 13, cpus: 1, memory: 512, image: 'alpine:3.20', ssh_port: 25502,
    access: { ssh: false, terminal: true, ports: false },
    port_forwards: [{ host: 8080, guest: 80 }],
  });
  assert.equal(terminalOnly.filter((value) => value === '-p').length, 0);
});

test('hard limits are present in every runtime command', () => {
  assert.match(docker.nameFor({ id: 7 }), /^vpanel-7$/);
  assert.deepEqual(docker.terminalArgv({ id: 7 }), ['docker', 'exec', '-it', 'vpanel-7', '/bin/sh']);
  assert.deepEqual(lxc.terminalArgv({ id: 7 }), ['lxc', 'exec', '-t', 'vpanel-7', '--', '/bin/sh']);
  assert.deepEqual(incus.terminalArgv({ id: 7 }), ['incus', 'exec', '-t', 'vpanel-7', '--', '/bin/sh']);
  assert.equal(qemuLimits.describe({ id: 7, cpus: 2, memory: 2048 }).cpu_quota_percent, 200);
  assert.equal(qemuLimits.describe({ id: 7, cpus: 2, memory: 2048 }).memory_max_mb, 2048);
});

test('SSH provisioning escapes passwords and refuses newline injection', () => {
  const script = provision.sshProvisionScript({ username: 'deploy', password: "p'a$s" });
  assert.match(script, /openssh-server/);
  assert.match(script, /deploy/);
  assert.match(script, /PermitRootLogin PasswordAuthentication KbdInteractiveAuthentication UsePAM/);
  assert.match(script, /vpanel-ssh-ready/);
  assert.throws(() => provision.sshProvisionScript({ username: 'root', password: 'a\nb' }), /Invalid SSH password/);
  const cloud = provision.cloudInitUserData({ hostname: 'web', username: 'ubuntu', password: 'secret' });
  assert.match(cloud, /#cloud-config/);
  assert.match(cloud, /plain_text_passwd: secret/);
  assert.match(cloud, /root:secret/);
});

test('admission control blocks oversized shared CPU and memory requests', async () => {
  const harness = loadCapacity();
  try {
    const os = require('os');
    const cores = (os.cpus() || []).length || 4;
    const memory = Math.round(os.totalmem() / 1024 / 1024);
    const tooManyCpus = Math.ceil(cores * 4) + 10;
    await assert.rejects(
      harness.service.assertCapacity({ nodeId: 1, kind: 'docker', cpus: tooManyCpus, memory: 256, disk_size: '20G' }),
      (error) => error.category === 'capacity_exceeded',
    );
    await assert.rejects(
      harness.service.assertCapacity({ nodeId: 1, kind: 'docker', cpus: 1, memory: memory + 1024, disk_size: '20G' }),
      (error) => error.category === 'capacity_exceeded',
    );
    const accepted = await harness.service.assertCapacity({ nodeId: 1, kind: 'docker', cpus: 1, memory: 256, disk_size: '20G' });
    assert.equal(accepted.requested.cpus, 1);
  } finally {
    harness.restore();
  }
});

test('admission control counts existing workloads and reserves host headroom', async () => {
  const os = require('os');
  const cores = (os.cpus() || []).length || 4;
  const memory = Math.round(os.totalmem() / 1024 / 1024);
  const harness = loadCapacity({
    vms: [{ id: 1, kind: 'qemu-dedicated', node_id: 1, cpus: cores, memory: 512, disk_size: '1G', status: 'running' }],
  });
  try {
    await assert.rejects(
      harness.service.assertCapacity({ nodeId: 1, kind: 'qemu-dedicated', cpus: 1, memory: 256, disk_size: '1G' }),
      (error) => error.category === 'capacity_exceeded',
    );
    const small = await harness.service.assertCapacity({ nodeId: 1, kind: 'docker', cpus: 1, memory: 128, disk_size: '20G' });
    assert.ok(small.cpu_limit >= 4);
  } finally {
    harness.restore();
  }
});

test('shared VMs admit more vCPUs than dedicated VMs on the same node', async () => {
  const runtime_capabilities = {
    detected_at: new Date().toISOString(),
    host: { cpu_cores: 8, memory_mb: 16384 },
    runtimes: {
      qemu: { available: true, kvm: true },
      docker: { available: false },
      lxc: { available: false },
      incus: { available: false },
    },
  };
  const harness = loadCapacity({ node: { id: 2, name: 'node-2', memory: 16384, disk: 500, runtime_capabilities } });
  try {
    await assert.rejects(
      harness.service.assertCapacity({ nodeId: 2, kind: 'qemu-dedicated', cpus: 8, memory: 1024, disk_size: '10G' }),
      (error) => error.category === 'capacity_exceeded',
    );
    const shared = await harness.service.assertCapacity({ nodeId: 2, kind: 'qemu-shared', cpus: 8, memory: 1024, disk_size: '10G' });
    assert.equal(shared.cpu_limit, 17.5);
  } finally {
    harness.restore();
  }
});

test('remote containers require reported host capacity, while legacy QEMU nodes still work', async () => {
  const harness = loadCapacity({ node: { id: 2, name: 'node-2', memory: 8192, disk: 100 } });
  try {
    await assert.rejects(
      harness.service.assertCapacity({ nodeId: 2, kind: 'docker', cpus: 1, memory: 512, disk_size: '20G' }),
      (error) => error.category === 'capacity_unknown',
    );
    const legacy = await harness.service.assertCapacity({ nodeId: 2, kind: 'qemu-dedicated', cpus: 2, memory: 1024, disk_size: '20G' });
    assert.ok(legacy.cpu_limit === Infinity || legacy.warning);
  } finally {
    harness.restore();
  }
});

test('terminal command is built through the runtime registry', () => {
  assert.equal(containerTerminal.commandFor({ kind: 'docker', id: 4 }), "'docker' 'exec' '-it' 'vpanel-4' '/bin/sh'");
  assert.equal(containerTerminal.commandFor({ kind: 'lxc', id: 4 }), "'lxc' 'exec' '-t' 'vpanel-4' '--' '/bin/sh'");
});

test('admin create page requires a deployment type and exposes container images and access', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'create.ejs'), 'utf8');
  assert.match(view, /name="kind"/);
  assert.match(view, /id="kindGrid"/);
  assert.match(view, /id="fImage"/);
  assert.match(view, /id="fAccessSsh"/);
  assert.match(view, /id="fAccessTerminal"/);
  assert.match(view, /id="fAccessPorts"/);
  assert.match(view, /id="containerImageSection"/);

  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'webAdmin.js'), 'utf8');
  assert.match(route, /deploymentKinds: runtimes\.definitions\.publicKinds\(\)/);
  assert.match(route, /nodeAvailability/);
});

test('Wings advertises capabilities and branches container commands', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'Wings', 'src', 'websocket', 'client.js'), 'utf8');
  assert.match(client, /capabilities: capabilities\.detectCached\(\)/);
  const wingsVm = fs.readFileSync(path.join(__dirname, '..', 'Wings', 'src', 'services', 'vmService.js'), 'utf8');
  assert.match(wingsVm, /runtimes\.driverForKind/);
  assert.match(wingsVm, /runtime_caps/);
  assert.match(wingsVm, /qemuLimits\.systemdAvailable/);
});
