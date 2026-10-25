const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('../lib/config');
const { collections, getNextId } = require('../lib/db');
const vmService = require('./vmService');
const wingsGateway = require('./wingsGateway');
const logger = require('../lib/logger');
const { Client: SshClient } = require('ssh2');

let lastCpuTimes = null;
let lastNetSample = null;
const historyBuffer = {
  maxPoints: 30,
  labels: [],
  cpu: [],
  memory: [],
  net_rx: [],
  net_tx: [],
};

function getCpuStats() {
  const cpus = os.cpus();
  const corePcts = [];
  let totalAll = 0;
  let idleAll = 0;

  const currentTimes = cpus.map((c) => {
    let idle = c.times.idle;
    let total = 0;
    for (const t in c.times) total += c.times[t];
    return { idle, total };
  });

  if (lastCpuTimes && lastCpuTimes.length === currentTimes.length) {
    for (let i = 0; i < currentTimes.length; i++) {
      const tDiff = currentTimes[i].total - lastCpuTimes[i].total;
      const iDiff = currentTimes[i].idle - lastCpuTimes[i].idle;
      const pct = tDiff > 0 ? 100 - Math.round((100 * iDiff) / tDiff) : 0;
      corePcts.push(Math.max(0, Math.min(100, pct)));
      totalAll += tDiff;
      idleAll += iDiff;
    }
  } else {
    for (let i = 0; i < currentTimes.length; i++) {
      corePcts.push(Math.round(Math.random() * 10 + 5));
    }
  }

  lastCpuTimes = currentTimes;
  const overallPct = totalAll > 0 ? 100 - Math.round((100 * idleAll) / totalAll) : (corePcts.reduce((a, b) => a + b, 0) / (corePcts.length || 1));
  return {
    overall: Math.max(0, Math.min(100, Math.round(overallPct))),
    cores: corePcts,
  };
}

function getNetStats() {
  let rxBytes = 0;
  let txBytes = 0;
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').trim().split('\n');
    for (let i = 2; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      const iface = parts[0].replace(':', '');
      if (iface === 'lo') continue;
      rxBytes += parseInt(parts[1], 10) || 0;
      txBytes += parseInt(parts[9], 10) || 0;
    }
  } catch (_) {}

  const now = Date.now();
  let rxKbps = 0;
  let txKbps = 0;

  if (lastNetSample) {
    const timeDeltaSec = (now - lastNetSample.time) / 1000;
    if (timeDeltaSec > 0) {
      rxKbps = Math.max(0, Math.round(((rxBytes - lastNetSample.rxBytes) / 1024) / timeDeltaSec));
      txKbps = Math.max(0, Math.round(((txBytes - lastNetSample.txBytes) / 1024) / timeDeltaSec));
    }
  }

  lastNetSample = { time: now, rxBytes, txBytes };
  return {
    rx_bytes: rxBytes,
    tx_bytes: txBytes,
    rx_kbps: rxKbps,
    tx_kbps: txKbps,
  };
}

function getSwapStats() {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const totalMatch = meminfo.match(/SwapTotal:\s+(\d+)\s+kB/);
    const freeMatch = meminfo.match(/SwapFree:\s+(\d+)\s+kB/);
    if (totalMatch && freeMatch) {
      const totalKb = parseInt(totalMatch[1], 10);
      const freeKb = parseInt(freeMatch[1], 10);
      const usedKb = totalKb - freeKb;
      return {
        total_mb: Math.round(totalKb / 1024),
        used_mb: Math.round(usedKb / 1024),
        free_mb: Math.round(freeKb / 1024),
        percent: totalKb > 0 ? Math.round((usedKb / totalKb) * 100) : 0,
      };
    }
  } catch (_) {}
  return { total_mb: 0, used_mb: 0, free_mb: 0, percent: 0 };
}

function pushHistoryPoint(cpuPct, memPct, rxKbps, txKbps) {
  const timeStr = new Date().toTimeString().split(' ')[0];
  historyBuffer.labels.push(timeStr);
  historyBuffer.cpu.push(cpuPct);
  historyBuffer.memory.push(memPct);
  historyBuffer.net_rx.push(rxKbps);
  historyBuffer.net_tx.push(txKbps);

  if (historyBuffer.labels.length > historyBuffer.maxPoints) {
    historyBuffer.labels.shift();
    historyBuffer.cpu.shift();
    historyBuffer.memory.shift();
    historyBuffer.net_rx.shift();
    historyBuffer.net_tx.shift();
  }
}

function offlineNodeStats(node, id) {
  return {
    id: Number(id),
    name: (node && node.name) || `Node ${id}`,
    hostname: (node && node.fqdn) || '',
    status: 'offline',
    location: 'Wings compute node',
    ip: (node && (node.ssh_ip || node.fqdn)) || '',
    fqdn: (node && node.fqdn) || '',
    uptime_seconds: 0,
    process_uptime: 0,
    os: null,
    cpu: { model: 'Wings node offline', cores_count: 0, percent: 0, per_core: [], load_avg: ['0.00', '0.00', '0.00'] },
    memory: { total_mb: 0, used_mb: 0, free_mb: 0, percent: 0 },
    swap: { total_mb: 0, used_mb: 0, free_mb: 0, percent: 0 },
    disk: { total_bytes: 0, used_bytes: 0, free_bytes: 0, total_gb: '0', used_gb: '0', free_gb: '0', percent: 0 },
    network: { rx_bytes: 0, tx_bytes: 0, rx_kbps: 0, tx_kbps: 0 },
    hypervisor: { qemu_installed: false, qemu_version: 'Unknown', kvm_support: false, cloud_init: false },
    vms: { total: 0, running: 0, stopped: 0, allocated_memory_mb: 0, allocated_cpus: 0, active_top_vms: [] },
    history: { labels: [], cpu: [], memory: [], net_rx: [], net_tx: [] },
    updated_at: new Date().toISOString(),
  };
}

async function getNodeLiveStats(nodeId = 1) {
  const requestedId = Number(nodeId) || 1;

  // Nodes other than the panel host are fully described by their Wings daemon; never
  // report the panel's own hardware as if it belonged to a remote node.
  if (requestedId !== 1) {
    const node = await collections.nodes.findOne({ id: requestedId }).catch(() => null);
    if (!node) return offlineNodeStats(null, requestedId);
    const remote = await wingsGateway.getNodeStats(requestedId);
    if (!remote) return offlineNodeStats(node, requestedId);
    return {
      ...offlineNodeStats(node, requestedId),
      ...remote,
      id: requestedId,
      name: node.name || `Node ${requestedId}`,
      status: 'online',
      fqdn: node.fqdn || remote.hostname || '',
      ip: node.ssh_ip || node.fqdn || remote.ip || '',
      updated_at: new Date().toISOString(),
    };
  }

  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPct = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0;

  let diskInfo = {
    total_bytes: 0,
    used_bytes: 0,
    free_bytes: 0,
    total_gb: '0',
    used_gb: '0',
    free_gb: '0',
    percent: 0,
  };

  try {
    const rootPath = path.parse(process.cwd()).root || (os.platform() === 'win32' ? 'C:\\' : '/');
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync(rootPath);
      const total = Number(s.bsize) * Number(s.blocks);
      const free = Number(s.bsize) * Number(s.bfree);
      const used = Math.max(0, total - free);
      diskInfo = {
        total_bytes: total,
        used_bytes: used,
        free_bytes: free,
        total_gb: (total / (1024 ** 3)).toFixed(1),
        used_gb: (used / (1024 ** 3)).toFixed(1),
        free_gb: (free / (1024 ** 3)).toFixed(1),
        percent: total > 0 ? Math.round((used / total) * 100) : 0,
      };
    } else {
      const dfOut = execSync('df -B1 /', { encoding: 'utf8' }).trim().split('\n')[1].split(/\s+/);
      const total = parseInt(dfOut[1], 10) || 0;
      const used = parseInt(dfOut[2], 10) || 0;
      const free = parseInt(dfOut[3], 10) || 0;
      diskInfo = {
        total_bytes: total,
        used_bytes: used,
        free_bytes: free,
        total_gb: (total / (1024 ** 3)).toFixed(1),
        used_gb: (used / (1024 ** 3)).toFixed(1),
        free_gb: (free / (1024 ** 3)).toFixed(1),
        percent: total > 0 ? Math.round((used / total) * 100) : 0,
      };
    }
  } catch (_) {}

  let qemuVer = 'QEMU Installed';
  try {
    qemuVer = execSync('qemu-system-x86_64 --version', { encoding: 'utf8' }).trim().split('\n')[0];
  } catch (_) {}

  const load = os.loadavg();
  const cpuStats = getCpuStats();
  const netStats = getNetStats();
  const swapStats = getSwapStats();

  pushHistoryPoint(cpuStats.overall, memPct, netStats.rx_kbps, netStats.tx_kbps);

  let rawVms = [];
  try {
    if (collections && collections.vms && typeof collections.vms.find === 'function') {
      rawVms = await collections.vms.find().toArray();
    }
  } catch (_) {}
  const allVms = (rawVms || []).map(vmService.serializeVm);
  const runningVms = allVms.filter((v) => vmService.isRunning(v));

  let totalAllocatedMem = 0;
  let totalAllocatedCpus = 0;
  const vmUsages = [];

  for (const v of allVms) {
    totalAllocatedMem += parseInt(v.memory, 10) || 0;
    totalAllocatedCpus += parseInt(v.cpus, 10) || 1;
    if (vmService.isRunning(v)) {
      vmUsages.push({
        id: v.id,
        name: v.name,
        cpu_percent: vmService.cpuUsage(v),
        memory_mb: Math.round(vmService.memUsage(v) / 1024 / 1024),
        memory_alloc: v.memory,
        disk_size: v.disk_size,
      });
    }
  }

  let nodeName = 'Local Cluster / Node 1';
  let nodeFqdn = 'localhost';
  try {
    const nodeDoc = await collections.nodes?.findOne({ id: Number(nodeId) });
    if (nodeDoc) {
      nodeName = nodeDoc.name || nodeName;
      nodeFqdn = nodeDoc.fqdn || nodeFqdn;
    }
  } catch (_) {}

  return {
    id: Number(nodeId),
    name: nodeName,
    hostname: os.hostname(),
    status: 'online',
    location: 'Local Cluster / Primary Datacenter',
    ip: '127.0.0.1',
    fqdn: nodeFqdn,
    uptime_seconds: Math.floor(os.uptime()),
    process_uptime: Math.floor(process.uptime()),
    os: {
      type: os.type(),
      release: os.release(),
      arch: os.arch(),
      platform: os.platform(),
    },
    cpu: {
      model: cpus[0] ? cpus[0].model : 'x86_64 Processor',
      cores_count: cpus.length,
      percent: cpuStats.overall,
      per_core: cpuStats.cores,
      load_avg: [load[0].toFixed(2), load[1].toFixed(2), load[2].toFixed(2)],
    },
    memory: {
      total_mb: Math.round(totalMem / 1024 / 1024),
      used_mb: Math.round(usedMem / 1024 / 1024),
      free_mb: Math.round(freeMem / 1024 / 1024),
      percent: memPct,
    },
    swap: swapStats,
    disk: diskInfo,
    network: netStats,
    hypervisor: {
      qemu_installed: true,
      qemu_version: qemuVer,
      kvm_support: vmService.hasKvm(),
      cloud_init: true,
    },
    vms: {
      total: allVms.length,
      running: runningVms.length,
      stopped: allVms.length - runningVms.length,
      allocated_memory_mb: totalAllocatedMem,
      allocated_cpus: totalAllocatedCpus,
      active_top_vms: vmUsages.sort((a, b) => b.cpu_percent - a.cpu_percent),
    },
    history: {
      labels: [...historyBuffer.labels],
      cpu: [...historyBuffer.cpu],
      memory: [...historyBuffer.memory],
      net_rx: [...historyBuffer.net_rx],
      net_tx: [...historyBuffer.net_tx],
    },
    updated_at: new Date().toISOString(),
  };
}



async function ensureDefaults() {
  if (!collections.locations) return;

  
  const locCount = await collections.locations.countDocuments();
  if (locCount === 0) {
    await collections.locations.insertOne({
      id: 1,
      short: 'local',
      long: 'Local Cluster / Primary Datacenter',
      created_at: new Date().toISOString(),
    });
  }

  
  const nodeCount = await collections.nodes.countDocuments();
  if (nodeCount === 0) {
    const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
    const defaultNode = {
      id: 1,
      name: 'Local Cluster / Node 1',
      description: 'Primary virtualization hypervisor node and compute host.',
      location_id: 1,
      public: 1,
      fqdn: 'localhost',
      scheme: 'http',
      behind_proxy: 0,
      maintenance_mode: 0,
      memory: totalMemMb || 16384,
      memory_overallocate: 0,
      disk: 102400, 
      disk_overallocate: 0,
      daemonListen: 8080,
      daemonSFTP: 2022,
      daemonBase: config.vmsDir || path.join(config.root, 'vms'),
      token_id: 'vpanel_node_1',
      token: 'vpanel_sec_' + Math.random().toString(36).substring(2, 12),
      server_limit: null,
      app_name: 'SiliconHost VM Panel',
      sort_order: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await collections.nodes.insertOne(defaultNode);

    
    const allocCount = await collections.node_allocations.countDocuments({ node_id: 1 });
    if (allocCount === 0) {
      const initialAllocations = [];
      for (let p = 25501; p <= 25510; p++) {
        initialAllocations.push({
          id: p - 25500,
          node_id: 1,
          ip: '127.0.0.1',
          ip_alias: '',
          port: p,
          server_id: p === 25501 ? 1 : null,
          created_at: new Date().toISOString(),
        });
      }
      await collections.node_allocations.insertMany(initialAllocations);
    }
  }
}

async function listLocations() {
  await ensureDefaults();
  return collections.locations.find().sort({ id: 1 }).toArray();
}

async function createLocation(short, long) {
  const id = await getNextId('locations');
  const loc = {
    id,
    short: String(short).trim(),
    long: String(long || short).trim(),
    created_at: new Date().toISOString(),
  };
  await collections.locations.insertOne(loc);
  return loc;
}

async function listNodes(filterQuery = '') {
  await ensureDefaults();
  const q = String(filterQuery || '').toLowerCase().trim();
  const rawNodes = await collections.nodes.find().sort({ sort_order: 1, id: 1 }).toArray();
  const locations = await collections.locations.find().toArray();
  const locMap = new Map(locations.map(l => [l.id, l]));

  const rawVms = await collections.vms.find().toArray();

  const results = [];
  for (const n of rawNodes) {
    const loc = locMap.get(n.location_id) || { short: 'local', long: 'Local Cluster' };
    const nodeVms = rawVms.filter(v => (v.node_id === n.id) || (!v.node_id && n.id === 1));

    let allocatedMem = 0;
    let allocatedDisk = 0;
    nodeVms.forEach(v => {
      allocatedMem += parseInt(v.memory, 10) || 0;
      allocatedDisk += parseInt(v.disk_size, 10) || 0;
    });

    const item = {
      ...n,
      location: loc,
      servers_count: nodeVms.length,
      allocated_memory: allocatedMem,
      allocated_disk: allocatedDisk,
      wings: wingsGateway.describe(n.id),
    };

    if (q) {
      const match = item.name.toLowerCase().includes(q) ||
                    item.fqdn.toLowerCase().includes(q) ||
                    loc.short.toLowerCase().includes(q) ||
                    loc.long.toLowerCase().includes(q);
      if (!match) continue;
    }

    results.push(item);
  }

  return results;
}

async function getNode(id) {
  await ensureDefaults();
  const node = await collections.nodes.findOne({ id: Number(id) });
  if (!node) return null;

  const loc = await collections.locations.findOne({ id: node.location_id }) || {
    short: 'local',
    long: 'Local Cluster / Primary Datacenter'
  };

  const rawVms = await collections.vms.find().toArray();
  const nodeVms = rawVms.filter(v => (v.node_id === node.id) || (!v.node_id && node.id === 1))
                        .map(vmService.serializeVm);

  const allocations = await collections.node_allocations.find({ node_id: node.id }).sort({ port: 1 }).toArray();

  
  const vmMap = new Map(rawVms.map(v => [v.id, v]));
  allocations.forEach(a => {
    if (a.server_id && vmMap.has(a.server_id)) {
      a.server = vmMap.get(a.server_id);
    } else {
      a.server = null;
    }
  });

  let allocatedMem = 0;
  let allocatedDisk = 0;
  nodeVms.forEach(v => {
    allocatedMem += parseInt(v.memory, 10) || 0;
    allocatedDisk += parseInt(v.disk_size, 10) || 0;
  });

  return {
    ...node,
    location: loc,
    servers: nodeVms,
    servers_count: nodeVms.length,
    allocated_memory: allocatedMem,
    allocated_disk: allocatedDisk,
    allocations,
    wings: wingsGateway.describe(node.id),
  };
}

async function createNode(data) {
  await ensureDefaults();
  const id = await getNextId('nodes');
  const totalMem = parseInt(data.memory, 10) || Math.round(os.totalmem() / 1024 / 1024);
  const totalDisk = parseInt(data.disk, 10) || 102400;

  const node = {
    id,
    name: String(data.name || `Node ${id}`).trim(),
    description: String(data.description || '').trim(),
    location_id: parseInt(data.location_id, 10) || 1,
    public: data.public === '0' || data.public === 0 ? 0 : 1,
    fqdn: String(data.fqdn || 'localhost').trim(),
    scheme: data.scheme === 'https' ? 'https' : 'http',
    behind_proxy: data.behind_proxy === '1' || data.behind_proxy === 1 ? 1 : 0,
    maintenance_mode: 0,
    memory: totalMem,
    memory_overallocate: parseInt(data.memory_overallocate, 10) || 0,
    disk: totalDisk,
    disk_overallocate: parseInt(data.disk_overallocate, 10) || 0,
    daemonListen: parseInt(data.daemonListen, 10) || 8080,
    daemonSFTP: parseInt(data.daemonSFTP, 10) || 2022,
    daemonBase: String(data.daemonBase || config.vmsDir || '/workspaces/vm/vpanel-pro/vms').trim(),
    token_id: `vpanel_node_${id}`,
    token: `vpanel_sec_${Math.random().toString(36).substring(2, 12)}`,
    server_limit: data.server_limit ? parseInt(data.server_limit, 10) : null,
    app_name: String(data.app_name || 'SiliconHost VM Panel').trim(),
    wings_enabled: id === 1 ? 0 : 1,
    ssh_ip: String(data.ssh_ip || data.fqdn || '').trim(),
    ssh_user: String(data.ssh_user || 'root').trim(),
    ssh_port: parseInt(data.ssh_port, 10) || 22,
    ssh_password: data.ssh_password ? String(data.ssh_password) : '',
    wings_online: 0,
    wings_version: '',
    wings_last_seen_at: null,
    sort_order: id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await collections.nodes.insertOne(node);

  
  if (data.initial_ip && data.initial_ports) {
    await createAllocations(id, {
      ip: data.initial_ip,
      ports: data.initial_ports,
      ip_alias: data.initial_alias || '',
    });
  }

  return node;
}

async function updateNode(id, data) {
  const node = await collections.nodes.findOne({ id: Number(id) });
  if (!node) throw new Error('Node not found');

  const updates = {
    updated_at: new Date().toISOString(),
  };

  if (data.name !== undefined) updates.name = String(data.name).trim();
  if (data.app_name !== undefined) updates.app_name = String(data.app_name).trim();
  if (data.description !== undefined) updates.description = String(data.description).trim();
  if (data.location_id !== undefined) updates.location_id = parseInt(data.location_id, 10);
  if (data.public !== undefined) updates.public = (data.public === '1' || data.public === 1) ? 1 : 0;
  if (data.server_limit !== undefined) updates.server_limit = data.server_limit ? parseInt(data.server_limit, 10) : null;
  if (data.fqdn !== undefined) updates.fqdn = String(data.fqdn).trim();
  if (data.scheme !== undefined) updates.scheme = data.scheme === 'https' ? 'https' : 'http';
  if (data.behind_proxy !== undefined) updates.behind_proxy = (data.behind_proxy === '1' || data.behind_proxy === 1) ? 1 : 0;
  if (data.maintenance_mode !== undefined) updates.maintenance_mode = (data.maintenance_mode === '1' || data.maintenance_mode === 1) ? 1 : 0;
  if (data.memory !== undefined) updates.memory = parseInt(data.memory, 10);
  if (data.memory_overallocate !== undefined) updates.memory_overallocate = parseInt(data.memory_overallocate, 10);
  if (data.disk !== undefined) updates.disk = parseInt(data.disk, 10);
  if (data.disk_overallocate !== undefined) updates.disk_overallocate = parseInt(data.disk_overallocate, 10);
  if (data.daemonListen !== undefined) updates.daemonListen = parseInt(data.daemonListen, 10);
  if (data.daemonSFTP !== undefined) updates.daemonSFTP = parseInt(data.daemonSFTP, 10);
  if (data.daemonBase !== undefined) updates.daemonBase = String(data.daemonBase).trim();
  if (data.ssh_ip !== undefined) updates.ssh_ip = String(data.ssh_ip || '').trim();
  if (data.ssh_user !== undefined) updates.ssh_user = String(data.ssh_user || '').trim();
  if (data.ssh_port !== undefined) updates.ssh_port = parseInt(data.ssh_port, 10) || 22;
  if (data.ssh_password !== undefined) updates.ssh_password = String(data.ssh_password || '');

  await collections.nodes.updateOne({ id: Number(id) }, { $set: updates });
  return getNode(id);
}

async function deleteNode(id, force = false) {
  const numId = Number(id);
  const vmsOnNode = await collections.vms.countDocuments({
    $or: [{ node_id: numId }, { node_id: null, $expr: { $eq: [numId, 1] } }],
  });

  if (vmsOnNode > 0 && !force) {
    throw new Error(`Cannot delete node: It currently has ${vmsOnNode} virtual machine(s) installed. Transfer or delete servers first.`);
  }

  await collections.nodes.deleteOne({ id: numId });
  await collections.node_allocations.deleteMany({ node_id: numId });
  return true;
}



async function listAllocations(nodeId) {
  const numId = Number(nodeId);
  const allocations = await collections.node_allocations.find({ node_id: numId }).sort({ port: 1 }).toArray();
  const vms = await collections.vms.find().toArray();
  const vmMap = new Map(vms.map(v => [v.id, v]));

  return allocations.map(a => ({
    ...a,
    server: a.server_id ? vmMap.get(a.server_id) : null,
  }));
}

async function createAllocations(nodeId, { ip, ports, ip_alias = '' }) {
  const numId = Number(nodeId);
  const ipClean = String(ip || '127.0.0.1').trim();
  const aliasClean = String(ip_alias || '').trim();

  
  const portList = new Set();
  const rawParts = String(ports || '').split(',');

  for (const part of rawParts) {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      const [start, end] = trimmed.split('-').map(p => parseInt(p, 10));
      if (!isNaN(start) && !isNaN(end)) {
        const min = Math.min(start, end);
        const max = Math.max(start, end);
        for (let p = min; p <= max && p <= 65535; p++) {
          if (p > 0) portList.add(p);
        }
      }
    } else {
      const p = parseInt(trimmed, 10);
      if (!isNaN(p) && p > 0 && p <= 65535) portList.add(p);
    }
  }

  if (portList.size === 0) throw new Error('No valid ports provided for allocation');

  let added = 0;
  for (const port of Array.from(portList).sort((a, b) => a - b)) {
    const exists = await collections.node_allocations.findOne({ node_id: numId, ip: ipClean, port });
    if (!exists) {
      const id = await getNextId('node_allocations');
      await collections.node_allocations.insertOne({
        id,
        node_id: numId,
        ip: ipClean,
        ip_alias: aliasClean,
        port,
        server_id: null,
        created_at: new Date().toISOString(),
      });
      added++;
    }
  }

  return { added, total: portList.size };
}

async function deleteAllocations(nodeId, allocIds) {
  const numId = Number(nodeId);
  const ids = Array.isArray(allocIds) ? allocIds.map(Number) : [Number(allocIds)];

  const res = await collections.node_allocations.deleteMany({
    node_id: numId,
    id: { $in: ids },
    server_id: null, 
  });

  return res.deletedCount || 0;
}

async function updateAllocationAlias(nodeId, allocId, alias) {
  await collections.node_allocations.updateOne(
    { node_id: Number(nodeId), id: Number(allocId) },
    { $set: { ip_alias: String(alias || '').trim() } }
  );
  return true;
}



function yamlString(value) {
  return '"' + String(value === undefined || value === null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ') + '"';
}

function generateNodeConfigYaml(node, panelUrl = config.panelUrl) {
  const n = node || {};
  return `# SiliconHost Wings Daemon Configuration - generated by the panel
panel:
  url: ${yamlString(panelUrl)}
  api_key: ${yamlString(n.token)}

node:
  id: ${Number(n.id) || 1}
  name: ${yamlString(n.name)}

vps:
  ip: ${yamlString(n.ssh_ip || n.fqdn || '')}
  ssh_user: ${yamlString(n.ssh_user || 'root')}
  ssh_port: ${parseInt(n.ssh_port, 10) || 22}
  ssh_password: ${yamlString(n.ssh_password || '')}

storage:
  vm_dir: "/var/lib/wings/vms"
  images_dir: "/var/lib/wings/images"

ssh:
  port: 22
  user: "root"
  key_path: "/root/.ssh/id_rsa"

logging:
  level: "info"
  file: "/var/log/wings/wings.log"
`;
}

function generateWingsConfigScript(node, panelUrl = config.panelUrl) {
  const n = node || {};
  const target = String(panelUrl || config.panelUrl).replace(/\/+$/, '');
  const yaml = generateNodeConfigYaml(n, target);

  return `#!/usr/bin/env bash
# SiliconHost Wings configuration for node "${String(n.name || n.id || '').replace(/[\r\n]/g, ' ')}" (#${Number(n.id) || 1})
# Paste this whole script on the Wings VPS as root.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run this script as root: sudo bash"
  exit 1
fi

WINGS_DIR="/opt/siliconhost-wings"
PANEL_URL=${yamlString(target)}
NODE_ID="${Number(n.id) || 1}"

mkdir -p "$WINGS_DIR/config" /var/lib/wings/vms /var/lib/wings/images /var/log/wings

cat > "$WINGS_DIR/config/wings.yml" <<'WINGS_YAML'
${yaml}WINGS_YAML
chmod 600 "$WINGS_DIR/config/wings.yml"

cat > "$WINGS_DIR/config/.env" <<'WINGS_ENV'
WINGS_CONFIG=/opt/siliconhost-wings/config/wings.yml
NODE_ENV=production
WINGS_ENV

if systemctl list-unit-files 2>/dev/null | grep -q '^wings.service'; then
  systemctl daemon-reload
  systemctl enable wings >/dev/null 2>&1 || true
  systemctl restart wings
  sleep 3
  if systemctl is-active --quiet wings; then
    echo "[OK] Wings is running and connecting to $PANEL_URL"
    echo "[OK] Node ID: $NODE_ID"
  else
    echo "[ERR] Wings did not start. Recent logs:"
    journalctl -u wings -n 40 --no-pager || true
    exit 1
  fi
else
  echo "[OK] Configuration written to $WINGS_DIR/config/wings.yml"
  echo "[INFO] Wings is not installed on this server yet."
  echo "[INFO] Run the panel installer and choose 6 (Install Wings), then paste this script again."
fi
`;
}

function generateDeployToken(node, panelUrl = config.panelUrl) {
  const token = (node && node.token) || '';
  const nodeId = (node && node.id) || 1;
  const base = String(panelUrl || config.panelUrl).replace(/\/+$/, '');
  const command = `curl -fsSL "${base}/api/wings/config/${nodeId}?token=${encodeURIComponent(token)}" | sudo bash`;
  return { token, node: nodeId, command };
}

function runNodeCommand(node, command, { timeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!node || !node.ssh_ip || !node.ssh_user) {
      return reject(new Error('Node SSH access is not configured. Set the node IP, username and password in the panel first.'));
    }

    let settled = false;
    const conn = new SshClient();
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch (_) {}
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(`SSH command on node ${node.id} timed out after ${timeout} ms`)), timeout);
    if (typeof timer.unref === 'function') timer.unref();

    conn.on('ready', () => {
      conn.exec(command, (error, stream) => {
        if (error) return finish(error);
        let stdout = '';
        let stderr = '';
        stream.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
        stream.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
        stream.on('close', (code) => finish(null, { code, stdout, stderr }));
      });
    });
    conn.on('error', (error) => finish(error));
    conn.on('close', () => finish(new Error('SSH connection closed before the command finished')));

    const connectOptions = {
      host: node.ssh_ip,
      port: parseInt(node.ssh_port, 10) || 22,
      username: node.ssh_user,
      readyTimeout: 10000,
      keepaliveInterval: 5000,
    };
    if (node.ssh_password) connectOptions.password = String(node.ssh_password);
    else if (node.ssh_key_path && fs.existsSync(node.ssh_key_path)) connectOptions.privateKey = fs.readFileSync(node.ssh_key_path);
    else return finish(new Error('Node SSH access needs a password or an accessible private key.'));

    conn.connect(connectOptions);
  });
}

async function controlNodeWings(nodeId, action) {
  const node = await collections.nodes.findOne({ id: Number(nodeId) });
  if (!node) throw new Error('Node not found');

  const normalized = String(action || '').toLowerCase();
  if (normalized === 'status') {
    const res = await runNodeCommand(node, 'systemctl is-active wings || true');
    return { active: res.stdout.trim(), node_id: node.id };
  }
  if (!['start', 'stop', 'restart'].includes(normalized)) {
    throw new Error(`Unsupported Wings action "${action}"`);
  }

  const res = await runNodeCommand(node, `systemctl ${normalized} wings`);
  if (res.code !== 0) {
    throw new Error(`systemctl ${normalized} wings failed: ${(res.stderr || res.stdout || '').trim() || 'unknown error'}`);
  }
  return { action: normalized, node_id: node.id, output: res.stdout.trim() };
}



async function massUpdateAppName(nodeIds, appName) {
  const ids = Array.isArray(nodeIds) ? nodeIds.map(Number) : [];
  if (!ids.length) return 0;
  const res = await collections.nodes.updateMany(
    { id: { $in: ids } },
    { $set: { app_name: String(appName || 'SiliconHost VM Panel').trim(), updated_at: new Date().toISOString() } }
  );
  return res.modifiedCount || 0;
}

async function massWingsControl(nodeIds, action) {
  const ids = Array.isArray(nodeIds) ? nodeIds.map(Number) : [];
  const results = {};
  for (const id of ids) {
    try {
      const result = await controlNodeWings(id, action);
      results[id] = { success: true, action, ...result };
    } catch (error) {
      results[id] = { success: false, action, message: error.message };
    }
  }
  return results;
}

async function getNodeLogs(nodeId, source = 'wings') {
  const node = await collections.nodes.findOne({ id: Number(nodeId) }).catch(() => null);

  if (node && Number(node.id) !== 1 && node.ssh_ip && node.ssh_user) {
    const command = source === 'qemu'
      ? 'journalctl -u wings -n 150 --no-pager | grep -i -E "qemu|vm" || journalctl -u wings -n 150 --no-pager'
      : (source === 'syslog' ? 'journalctl -n 150 --no-pager' : 'journalctl -u wings -n 150 --no-pager');
    try {
      const res = await runNodeCommand(node, command, { timeout: 20000 });
      const text = (res.stdout || res.stderr || '').trim();
      return text ? text.split(/\r?\n/).slice(-150) : ['[wings] No log output was returned by the node.'];
    } catch (error) {
      return [`[wings] Could not read logs from the node over SSH: ${error.message}`];
    }
  }

  try {
    let logPath = '';
    if (source === 'wings') {
      logPath = path.join(config.root, 'storage/logs/pm2-out.log');
    } else if (source === 'syslog') {
      logPath = '/var/log/syslog';
    } else if (source === 'qemu') {
      logPath = path.join(config.root, 'storage/logs/pm2-error.log');
    }

    if (logPath && fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf8');
      return content.trim().split('\n').slice(-100);
    }
  } catch (_) {}

  const now = new Date().toISOString();
  return [
    `[${now}] [INFO] [wings-agent] No local Wings process is installed on the panel host`,
    `[${now}] [INFO] [hypervisor] Enable Wings for remote nodes, or manage local VMs directly on node 1`,
  ];
}

module.exports = {
  getNodeLiveStats,
  ensureDefaults,
  listNodes,
  getNode,
  createNode,
  updateNode,
  deleteNode,
  listLocations,
  createLocation,
  listAllocations,
  createAllocations,
  deleteAllocations,
  updateAllocationAlias,
  generateNodeConfigYaml,
  generateWingsConfigScript,
  generateDeployToken,
  controlNodeWings,
  massUpdateAppName,
  massWingsControl,
  getNodeLogs,
  runNodeCommand,
};
