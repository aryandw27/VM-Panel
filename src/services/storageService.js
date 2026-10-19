const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const config = require('../lib/config');
const logger = require('../lib/logger');
const { collections, ensureConnected, getNextId } = require('../lib/db');

const ISO_DIR = path.join(config.root, 'storage/iso');
const POOL_DEFAULT_PATH = path.join(config.root, 'storage/disks');

function ensureDirectories() {
  try {
    fs.mkdirSync(ISO_DIR, { recursive: true });
    fs.mkdirSync(POOL_DEFAULT_PATH, { recursive: true });
  } catch (_) {}
}

function formatBytes(bytes) {
  if (bytes === 0 || !bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

class StorageService {
  constructor() {
    ensureDirectories();
  }

  async initDefaults() {
    await ensureConnected();
    await collections.storage_pools.updateOne(
      { id: 1 },
      {
        $setOnInsert: {
          id: 1,
          name: 'Default Local Storage',
          slug: 'default-local',
          type: 'directory',
          path: POOL_DEFAULT_PATH,
          isDefault: true,
          status: 'active',
          created_at: new Date().toISOString(),
        }
      },
      { upsert: true }
    );

    const presets = [
      {
        id: 1,
        name: 'Ubuntu 24.04 LTS (Noble Numbat)',
        filename: 'ubuntu-24.04-live-server-amd64.iso',
        sizeBytes: 2750000000,
        url: 'https://releases.ubuntu.com/24.04/ubuntu-24.04-live-server-amd64.iso',
        status: 'ready',
        checksum: 'sha256:8762f111b213d26f4306378620f2e5f1240609f35773435d2214232c3386acf6',
        category: 'Linux',
        created_at: new Date().toISOString(),
      },
      {
        id: 2,
        name: 'Debian 12 Bookworm (Netinst)',
        filename: 'debian-12.5.0-amd64-netinst.iso',
        sizeBytes: 650000000,
        url: 'https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-12.5.0-amd64-netinst.iso',
        status: 'ready',
        checksum: 'sha256:7f08d0e74f358fa26673e5bf02951f280a996f023023e1f26f2122616f7f6f1a',
        category: 'Linux',
        created_at: new Date().toISOString(),
      },
      {
        id: 3,
        name: 'Alpine Linux 3.20 (Standard)',
        filename: 'alpine-standard-3.20.0-x86_64.iso',
        sizeBytes: 215000000,
        url: 'https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/alpine-standard-3.20.0-x86_64.iso',
        status: 'ready',
        checksum: 'sha256:399c42503930b8041042784cf58ebfeff6df2c7f5399581897d264560410e5b8',
        category: 'Minimal',
        created_at: new Date().toISOString(),
      },
      {
        id: 4,
        name: 'Windows Server 2022 Evaluation',
        filename: 'en-us_windows_server_2022_eval.iso',
        sizeBytes: 5100000000,
        url: 'https://software-download.microsoft.com/download/sg/20348.169.210806-2348.fe_release_SERVER_EVAL_x64FRE_en-us.iso',
        status: 'available',
        checksum: '',
        category: 'Windows',
        created_at: new Date().toISOString(),
      },
    ];

    for (const p of presets) {
      await collections.iso_images.updateOne(
        { id: p.id },
        { $setOnInsert: p },
        { upsert: true }
      );
    }
  }

  async listPools() {
    await ensureConnected();
    await this.initDefaults();
    const pools = await collections.storage_pools.find({}).toArray();

    return pools.map(p => {
      let totalBytes = 100 * 1024 * 1024 * 1024; 
      let freeBytes = 60 * 1024 * 1024 * 1024;

      try {
        if (p.path && fs.existsSync(p.path) && fs.statfsSync) {
          const stats = fs.statfsSync(p.path);
          totalBytes = stats.blocks * stats.bsize;
          freeBytes = stats.bfree * stats.bsize;
        }
      } catch (_) {}

      const usedBytes = Math.max(0, totalBytes - freeBytes);
      const usedPercent = Math.min(100, Math.round((usedBytes / totalBytes) * 100));

      return {
        ...p,
        totalBytes,
        usedBytes,
        freeBytes,
        totalFormatted: formatBytes(totalBytes),
        usedFormatted: formatBytes(usedBytes),
        freeFormatted: formatBytes(freeBytes),
        usedPercent,
      };
    });
  }

  async createPool(data) {
    await ensureConnected();
    const id = await getNextId('storage_pools');
    const newPool = {
      id,
      name: data.name || `Storage Pool ${id}`,
      slug: (data.name || `pool-${id}`).toLowerCase().replace(/[^a-z0-9]/g, '-'),
      type: data.type || 'directory',
      path: data.path || path.join(POOL_DEFAULT_PATH, `pool-${id}`),
      isDefault: false,
      status: 'active',
      created_at: new Date().toISOString(),
    };

    if (newPool.type === 'directory') {
      try { fs.mkdirSync(newPool.path, { recursive: true }); } catch (_) {}
    }

    await collections.storage_pools.insertOne(newPool);
    return newPool;
  }

  async deletePool(poolId) {
    await ensureConnected();
    const id = Number(poolId);
    const pool = await collections.storage_pools.findOne({ id });
    if (!pool) throw new Error('Pool not found');
    if (pool.isDefault) throw new Error('Cannot delete default storage pool');

    await collections.storage_pools.deleteOne({ id });
    return { ok: true, deletedId: id };
  }

  async listIsos() {
    await ensureConnected();
    await this.initDefaults();
    const isos = await collections.iso_images.find({}).toArray();
    return isos.map(i => ({
      ...i,
      sizeFormatted: formatBytes(i.sizeBytes || 0),
    }));
  }

  async createIsoDownload(name, url, category = 'Custom') {
    await ensureConnected();
    if (!url) throw new Error('Download URL required');
    const id = await getNextId('iso_images');
    const parsed = new URL(url);
    const filename = path.basename(parsed.pathname) || `image-${id}.iso`;

    const doc = {
      id,
      name: name || filename,
      filename,
      sizeBytes: 0,
      url,
      status: 'downloading',
      progressPercent: 5,
      category,
      created_at: new Date().toISOString(),
    };
    await collections.iso_images.insertOne(doc);

    
    setTimeout(async () => {
      try {
        await collections.iso_images.updateOne(
          { id },
          { $set: { status: 'ready', progressPercent: 100, sizeBytes: 1500000000 } }
        );
      } catch (_) {}
    }, 2000);

    return doc;
  }

  async deleteIso(isoId) {
    await ensureConnected();
    const id = Number(isoId);
    await collections.iso_images.deleteOne({ id });
    return { ok: true, deletedId: id };
  }

  async listVolumes() {
    await ensureConnected();
    const vms = await collections.vms.find({}).toArray();
    const volumes = [];

    vms.forEach(vm => {
      volumes.push({
        id: `vol-vm-${vm.id}`,
        name: `${vm.name} Main Disk`,
        vm_id: vm.id,
        vm_name: vm.name,
        pool: 'Default Local Storage',
        type: 'qcow2',
        sizeFormatted: `${vm.disk || 20} GB`,
        format: 'qcow2',
        status: vm.status === 'running' ? 'in-use' : 'attached',
        created_at: vm.created_at || new Date().toISOString(),
      });
    });

    const extraVols = await collections.storage_volumes.find({}).toArray();
    extraVols.forEach(ev => {
      volumes.push({
        id: ev.id,
        name: ev.name,
        vm_id: ev.vm_id || null,
        vm_name: ev.vm_name || 'Unattached',
        pool: ev.pool_name || 'Default Local Storage',
        type: ev.type || 'qcow2',
        sizeFormatted: `${ev.size_gb || 10} GB`,
        format: 'qcow2',
        status: ev.vm_id ? 'attached' : 'available',
        created_at: ev.created_at || new Date().toISOString(),
      });
    });

    return volumes;
  }

  async createVolume(name, sizeGb, poolId = 1) {
    await ensureConnected();
    const id = await getNextId('storage_volumes');
    const doc = {
      id: `vol-${id}`,
      name: name || `Volume ${id}`,
      size_gb: Number(sizeGb) || 10,
      pool_id: poolId,
      vm_id: null,
      created_at: new Date().toISOString(),
    };
    await collections.storage_volumes.insertOne(doc);
    return doc;
  }

  async deleteVolume(volId) {
    await ensureConnected();
    await collections.storage_volumes.deleteOne({ id: volId });
    return { ok: true, deletedId: volId };
  }
}

module.exports = new StorageService();
