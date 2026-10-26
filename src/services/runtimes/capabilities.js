'use strict';

const fs = require('fs');
const os = require('os');
const { run } = require('./util');
const { runtimeForKind, definitionFor, KIND_ORDER } = require('./definitions');

const CACHE_MS = 30000;
let cached = null;

function readVersion(command, args) {
  const result = run(command, args, { timeout: 2500 });
  if (result.error || result.code !== 0) return null;
  return String(result.stdout || '').trim().split(/\r?\n/)[0] || null;
}

function hasKvm() {
  if (process.env.NO_KVM === '1' || process.env.NOKVM === '1') return false;
  try {
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function detectLocal() {
  const qemuVersion = readVersion('qemu-system-x86_64', ['--version']);
  const dockerInfo = run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 2500 });
  const dockerVersion = dockerInfo.error || dockerInfo.code !== 0
    ? null
    : (String(dockerInfo.stdout || '').trim() || 'present');
  const lxcInfo = run('lxc', ['info'], { timeout: 2500 });
  const lxcVersion = lxcInfo.error || lxcInfo.code !== 0 ? null : (readVersion('lxc', ['--version']) || 'present');
  const incusInfo = run('incus', ['info'], { timeout: 2500 });
  const incusVersion = incusInfo.error || incusInfo.code !== 0 ? null : (readVersion('incus', ['--version']) || 'present');
  const cpus = os.cpus() || [];

  return {
    detected_at: new Date().toISOString(),
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpu_cores: cpus.length || 1,
      cpu_model: cpus[0] ? cpus[0].model : '',
      memory_mb: Math.round(os.totalmem() / 1024 / 1024),
      load_avg: os.loadavg().map((value) => Number(value.toFixed(2))),
    },
    runtimes: {
      qemu: { available: Boolean(qemuVersion), version: qemuVersion || '', kvm: hasKvm() },
      docker: { available: Boolean(dockerVersion), version: dockerVersion || '' },
      lxc: { available: Boolean(lxcVersion), version: lxcVersion || '' },
      incus: { available: Boolean(incusVersion), version: incusVersion || '' },
    },
  };
}

function detectCached({ force = false } = {}) {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = detectLocal();
  cached = { at: Date.now(), value };
  return value;
}

function resetCache() {
  cached = null;
}

function runtimeAvailable(runtime, capabilities) {
  const entry = capabilities && capabilities.runtimes ? capabilities.runtimes[runtime] : null;
  if (!entry || !entry.available) return false;
  return true;
}

function kindAvailability(kind, capabilities) {
  const definition = definitionFor(kind);
  if (!runtimeAvailable(definition.runtime, capabilities)) {
    return { available: false, reason: `${definition.runtime} is not installed or not reachable on this node` };
  }
  if (definition.supports_kvm && definition.runtime === 'qemu' && !capabilities.runtimes.qemu.kvm) {
    // QEMU can still run with TCG, but only the shared kind is offered without KVM.
    return {
      available: kind === 'qemu-shared',
      reason: kind === 'qemu-dedicated' ? 'Hardware virtualization (/dev/kvm) is not available; use a shared CPU VM' : '',
    };
  }
  if (definition.runtime === 'incus' && definition.is_vm && !capabilities.runtimes.incus.available) {
    return { available: false, reason: 'Incus is not available on this node' };
  }
  return { available: true, reason: '' };
}

function publicAvailability(capabilities) {
  const result = {};
  for (const kind of KIND_ORDER) {
    const entry = kindAvailability(kind, capabilities);
    result[kind] = { available: entry.available, reason: entry.reason };
  }
  return result;
}

function assertKindAvailable(kind, capabilities, { nodeName = 'this node' } = {}) {
  const entry = kindAvailability(kind, capabilities);
  if (!entry.available) {
    const definition = definitionFor(kind);
    throw Object.assign(
      new Error(`${definition.label} cannot run on ${nodeName}: ${entry.reason || 'runtime unavailable'}`),
      { category: 'runtime_unavailable' },
    );
  }
}

function unknownCapabilities() {
  return {
    detected_at: null,
    host: null,
    runtimes: {
      qemu: { available: false, version: '', kvm: false },
      docker: { available: false, version: '' },
      lxc: { available: false, version: '' },
      incus: { available: false, version: '' },
    },
  };
}

function normalizeIncoming(value) {
  // Wings registers a capabilities object; older daemons only send an array of
  // command names. Normalize both shapes so the panel can gate the create form.
  // Missing data means "unknown", never "the panel host's own capabilities".
  if (!value) return unknownCapabilities();
  if (Array.isArray(value)) {
    const has = (name) => value.includes(name);
    return {
      detected_at: new Date().toISOString(),
      host: null,
      runtimes: {
        qemu: { available: has('vm_create') || has('qemu'), version: '', kvm: has('vm_create') || has('qemu') },
        docker: { available: has('docker'), version: '' },
        lxc: { available: has('lxc'), version: '' },
        incus: { available: has('incus'), version: '' },
      },
    };
  }
  if (value.runtimes) return value;
  return unknownCapabilities();
}

module.exports = {
  detectLocal,
  detectCached,
  resetCache,
  hasKvm,
  runtimeAvailable,
  kindAvailability,
  publicAvailability,
  assertKindAvailable,
  normalizeIncoming,
  unknownCapabilities,
  runtimeForKind,
};
