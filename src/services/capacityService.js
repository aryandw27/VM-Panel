'use strict';

const os = require('os');
const { collections } = require('../lib/db');
const capabilities = require('./runtimes/capabilities');
const { definitionFor } = require('./runtimes/definitions');

function parseDiskGb(value) {
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*([GMT])?B?$/i);
  if (!match) return 0;
  const amount = parseFloat(match[1]);
  const unit = (match[2] || 'G').toUpperCase();
  if (unit === 'T') return amount * 1024;
  if (unit === 'M') return amount / 1024;
  return amount;
}

function reserveFor(cores, memoryMb) {
  const reserveCores = Math.max(1, Number(process.env.CAPACITY_RESERVE_CORES) || Math.ceil(cores * 0.1));
  const reserveMemory = Math.max(
    512,
    Number(process.env.CAPACITY_RESERVE_MB) || Math.round(memoryMb * 0.1),
  );
  return { cores: reserveCores, memory_mb: reserveMemory };
}

async function nodeCapacity(nodeId) {
  const id = Number(nodeId) || 1;
  if (id === 1) {
    const detected = capabilities.detectCached();
    const cores = detected.host.cpu_cores || (os.cpus() || []).length || 1;
    const memory = detected.host.memory_mb || Math.round(os.totalmem() / 1024 / 1024);
    let diskGb = 0;
    try {
      if (typeof require('fs').statfsSync === 'function') {
        const stat = require('fs').statfsSync(require('../lib/config').root);
        diskGb = (Number(stat.bsize) * Number(stat.blocks)) / (1024 ** 3);
      }
    } catch (_) {}
    return { node_id: id, name: 'Local Cluster / Node 1', cores, memory_mb: memory, disk_gb: diskGb, capabilities: detected };
  }

  const node = await collections.nodes.findOne({ id });
  if (!node) throw Object.assign(new Error('The selected compute node does not exist.'), { category: 'node_not_found' });
  const detected = capabilities.normalizeIncoming(node.runtime_capabilities);
  const cores = (detected.host && detected.host.cpu_cores) || Number(node.cpu_cores) || 0;
  const memory = (detected.host && detected.host.memory_mb) || Number(node.memory) || 0;
  return {
    node_id: id,
    name: node.name || `Node ${id}`,
    cores,
    memory_mb: memory,
    disk_gb: Number(node.disk) || 0,
    capabilities: detected,
  };
}

async function allocatedFor(nodeId, { excludeVmId = null } = {}) {
  const query = nodeId === 1
    ? { $or: [{ node_id: 1 }, { node_id: { $exists: false } }] }
    : { node_id: Number(nodeId) };
  const rows = await collections.vms.find(query).toArray();
  const totals = { cpus: 0, memory_mb: 0, disk_gb: 0, count: 0 };
  for (const row of rows) {
    if (excludeVmId && Number(row.id) === Number(excludeVmId)) continue;
    if (row.status === 'deleted') continue;
    totals.cpus += Number(row.cpus) || 0;
    totals.memory_mb += Number(row.memory) || 0;
    // Container images and writable layers live under the runtime's storage,
    // not the VM_DIR disk image reservation, so only QEMU rows consume disk.
    if (definitionFor(row.kind).runtime === 'qemu') totals.disk_gb += parseDiskGb(row.disk_size);
    totals.count += 1;
  }
  return totals;
}

async function summary(nodeId, options) {
  const capacity = await nodeCapacity(nodeId);
  const allocated = await allocatedFor(nodeId, options);
  const reserve = reserveFor(capacity.cores, capacity.memory_mb);
  return {
    ...capacity,
    allocated,
    reserve,
    usable_cores: Math.max(0, capacity.cores - reserve.cores),
    usable_memory_mb: Math.max(0, capacity.memory_mb - reserve.memory_mb),
  };
}

async function assertCapacity({ nodeId = 1, kind, cpus, memory, disk_size, excludeVmId = null }) {
  const definition = definitionFor(kind);
  const requestedCpus = Number(cpus);
  const requestedMemory = Number(memory);
  if (!Number.isFinite(requestedCpus) || requestedCpus <= 0) {
    throw Object.assign(new Error('CPU allocation must be greater than zero.'), { category: 'invalid_request' });
  }
  if (!Number.isFinite(requestedMemory) || requestedMemory < 128) {
    throw Object.assign(new Error('Memory allocation must be at least 128 MB.'), { category: 'invalid_request' });
  }
  if (!Number.isFinite(Number(nodeId))) {
    throw Object.assign(new Error('Invalid compute node.'), { category: 'invalid_request' });
  }

  const current = await summary(nodeId, { excludeVmId });
  const knownCores = Number(current.cores) > 0;
  const knownMemory = Number(current.memory_mb) > 0;
  // Containers rely on the panel knowing the node's full capacity, because the
  // overcommit factor is applied to a measured core count. QEMU nodes that have
  // not upgraded Wings still work, but only the limits they do advertise apply.
  if (definition.runtime !== 'qemu' && (!knownCores || !knownMemory)) {
    throw Object.assign(
      new Error(`Capacity for ${current.name} is unknown. Upgrade and restart Wings on that node, then retry.`),
      { category: 'capacity_unknown' },
    );
  }
  if (!knownCores && !knownMemory) {
    return {
      node_id: Number(nodeId) || 1,
      warning: `Capacity for ${current.name} is unknown because Wings has not reported host resources; admission control was skipped.`,
      allocated: current.allocated,
      requested: { cpus: requestedCpus, memory_mb: requestedMemory, disk: 0 },
    };
  }

  const cpuLimit = knownCores ? current.usable_cores * definition.cpu_overcommit : Infinity;
  const memoryLimit = knownMemory ? current.usable_memory_mb : Infinity;
  const nextCpus = current.allocated.cpus + requestedCpus;
  const nextMemory = current.allocated.memory_mb + requestedMemory;

  const failures = [];
  if (nextCpus > cpuLimit + 0.001) {
    failures.push(`CPU ${nextCpus}/${Math.floor(cpuLimit)} vCPU (${definition.label} allows ${definition.cpu_overcommit}x overcommit)`);
  }
  if (nextMemory > memoryLimit) {
    failures.push(`memory ${nextMemory}/${memoryLimit} MB`);
  }
  if (current.disk_gb > 0 && definition.runtime === 'qemu') {
    const requestedDisk = parseDiskGb(disk_size);
    if (current.allocated.disk_gb + requestedDisk > current.disk_gb * 0.95) {
      failures.push(`disk ${Math.round(current.allocated.disk_gb + requestedDisk)}/${Math.floor(current.disk_gb)} GB`);
    }
  }

  if (failures.length) {
    throw Object.assign(
      new Error(`Not enough capacity on ${current.name}: requesting ${requestedCpus} vCPU / ${requestedMemory} MB would exceed ${failures.join('; ')}. Free resources or pick another node.`),
      { category: 'capacity_exceeded', details: { node: current, requested: { cpus: requestedCpus, memory: requestedMemory } } },
    );
  }

  return {
    node_id: Number(nodeId) || 1,
    cpu_limit: cpuLimit,
    memory_limit_mb: memoryLimit,
    allocated: current.allocated,
    requested: { cpus: requestedCpus, memory_mb: requestedMemory, disk: definition.runtime === 'qemu' ? parseDiskGb(disk_size) : 0 },
  };
}

module.exports = {
  nodeCapacity,
  allocatedFor,
  summary,
  assertCapacity,
  parseDiskGb,
  reserveFor,
};