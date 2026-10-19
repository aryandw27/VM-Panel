const { collections, settings } = require('../lib/db');
const vmService = require('./vmService');

function parseDiskToGb(diskSize) {
  if (!diskSize) return 20;
  const match = String(diskSize).match(/^(\d+)(.*)$/);
  if (!match) return 20;
  const num = parseInt(match[1], 10);
  const unit = (match[2] || '').trim().toUpperCase();
  if (unit === 'G' || unit === 'GB' || !unit) return num;
  if (unit === 'M' || unit === 'MB') return num / 1024;
  if (unit === 'T' || unit === 'TB') return num * 1024;
  return num;
}

function getColor(percent) {
  if (percent < 70) return 'green';
  if (percent < 90) return 'yellow';
  return 'red';
}

async function getUserQuota(userId) {
  const uid = Number(userId);
  let q = await collections.quotas.findOne({ user_id: uid });
  const defaultCpu = parseInt(settings.get('user.default_cpu_cores') || '8', 10);
  const defaultRam = parseInt(settings.get('user.default_ram_mb') || '8192', 10);
  const defaultDisk = parseInt(settings.get('user.default_disk_gb') || '100', 10);
  const defaultBandwidth = parseInt(settings.get('user.default_bandwidth_gb') || '1000', 10);
  const defaultIpv4 = parseInt(settings.get('user.default_ipv4') || '2', 10);
  const defaultSnapshots = parseInt(settings.get('user.default_snapshots') || '5', 10);
  const defaultBackups = parseInt(settings.get('user.default_backups') || '10', 10);

  return {
    user_id: uid,
    cpu_cores: q && q.cpu_cores !== undefined ? Number(q.cpu_cores) : defaultCpu,
    ram_mb: q && q.ram_mb !== undefined ? Number(q.ram_mb) : defaultRam,
    disk_gb: q && q.disk_gb !== undefined ? Number(q.disk_gb) : defaultDisk,
    bandwidth_gb: q && q.bandwidth_gb !== undefined ? Number(q.bandwidth_gb) : defaultBandwidth,
    ipv4: q && q.ipv4 !== undefined ? Number(q.ipv4) : defaultIpv4,
    snapshots: q && q.snapshots !== undefined ? Number(q.snapshots) : defaultSnapshots,
    backups: q && q.backups !== undefined ? Number(q.backups) : defaultBackups,
  };
}

async function updateUserQuota(userId, fields) {
  const uid = Number(userId);
  const updateDoc = {
    user_id: uid,
    updated_at: new Date()
  };
  if (fields.cpu_cores !== undefined) updateDoc.cpu_cores = Math.max(1, parseInt(fields.cpu_cores, 10));
  if (fields.ram_mb !== undefined) updateDoc.ram_mb = Math.max(256, parseInt(fields.ram_mb, 10));
  if (fields.disk_gb !== undefined) updateDoc.disk_gb = Math.max(5, parseInt(fields.disk_gb, 10));
  if (fields.bandwidth_gb !== undefined) updateDoc.bandwidth_gb = Math.max(0, parseInt(fields.bandwidth_gb, 10));
  if (fields.ipv4 !== undefined) updateDoc.ipv4 = Math.max(0, parseInt(fields.ipv4, 10));
  if (fields.snapshots !== undefined) updateDoc.snapshots = Math.max(0, parseInt(fields.snapshots, 10));
  if (fields.backups !== undefined) updateDoc.backups = Math.max(0, parseInt(fields.backups, 10));

  await collections.quotas.updateOne(
    { user_id: uid },
    { $set: updateDoc },
    { upsert: true }
  );
  return getUserQuota(uid);
}

async function getUserResourceData(userId) {
  const uid = Number(userId);
  const quota = await getUserQuota(uid);
  const vms = await collections.vms.find({ owner_id: uid }).toArray();
  const vmIds = vms.map(v => Number(v.id));

  let cpuAlloc = 0;
  let cpuUsed = 0;
  let ramAllocMb = 0;
  let ramUsedMb = 0;
  let diskAllocGb = 0;
  let diskUsedGb = 0;

  for (const vm of vms) {
    const stats = vmService.liveStats(vm);
    const cores = Number(vm.cpus || 1);
    const memMb = Number(vm.memory || 1024);
    const dGb = parseDiskToGb(vm.disk_size);

    cpuAlloc += cores;
    ramAllocMb += memMb;
    diskAllocGb += dGb;

    const cPercent = (stats.cpu && stats.cpu.percent) || 0;
    cpuUsed += (cPercent / 100) * cores;

    const mUsed = (stats.memory && stats.memory.used_mb) || 0;
    ramUsedMb += mUsed;

    const dActualMb = (stats.disk && stats.disk.actual_mb) || 0;
    diskUsedGb += dActualMb / 1024;
  }

  const backupsCount = vmIds.length ? await collections.backups.countDocuments({ vm_id: { $in: vmIds } }) : 0;
  const ipv4Used = vms.length; 

  
  const limitCpu = quota.cpu_cores;
  const limitRamGb = quota.ram_mb / 1024;
  const limitDiskGb = quota.disk_gb;
  const limitBwGb = quota.bandwidth_gb;
  const limitIpv4 = quota.ipv4;
  const limitSnapshots = quota.snapshots;
  const limitBackups = quota.backups;

  
  const cpuPercent = limitCpu ? Math.min(100, (cpuUsed / limitCpu) * 100) : 0;
  const ramPercent = limitRamGb ? Math.min(100, ((ramUsedMb / 1024) / limitRamGb) * 100) : 0;
  const diskPercent = limitDiskGb ? Math.min(100, (diskUsedGb / limitDiskGb) * 100) : 0;
  const bwPercent = 0;
  const ipv4Percent = limitIpv4 ? Math.min(100, (ipv4Used / limitIpv4) * 100) : 0;
  const snapshotsPercent = 0;
  const backupsPercent = limitBackups ? Math.min(100, (backupsCount / limitBackups) * 100) : 0;

  const resources = {
    cpu: {
      allocated: limitCpu,
      used: Number(cpuUsed.toFixed(1)),
      vmAllocated: cpuAlloc,
      percent: Number(cpuPercent.toFixed(1)),
      color: getColor(cpuPercent),
      unit: 'Cores'
    },
    ram: {
      allocated: Number(limitRamGb.toFixed(1)),
      allocatedMb: quota.ram_mb,
      used: Number((ramUsedMb / 1024).toFixed(2)),
      vmAllocated: Number((ramAllocMb / 1024).toFixed(1)),
      percent: Number(ramPercent.toFixed(1)),
      color: getColor(ramPercent),
      unit: 'GB'
    },
    disk: {
      allocated: limitDiskGb,
      used: Number(diskUsedGb.toFixed(2)),
      vmAllocated: diskAllocGb,
      percent: Number(diskPercent.toFixed(1)),
      color: getColor(diskPercent),
      unit: 'GB'
    },
    bandwidth: {
      allocated: limitBwGb,
      used: 0,
      percent: 0,
      color: 'green',
      unit: 'GB'
    },
    ipv4: {
      allocated: limitIpv4,
      used: ipv4Used,
      percent: Number(ipv4Percent.toFixed(1)),
      color: getColor(ipv4Percent),
      unit: 'IPs'
    },
    snapshots: {
      allocated: limitSnapshots,
      used: 0,
      percent: 0,
      color: 'green',
      unit: 'Snapshots'
    },
    backups: {
      allocated: limitBackups,
      used: backupsCount,
      percent: Number(backupsPercent.toFixed(1)),
      color: getColor(backupsPercent),
      unit: 'Backups'
    }
  };

  return { quota, vms, resources };
}

module.exports = {
  getUserQuota,
  updateUserQuota,
  getUserResourceData
};
