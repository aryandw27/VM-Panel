const os = require('os');
const logger = require('../lib/logger');
const { collections, ensureConnected, getNextId } = require('../lib/db');

class NetworkService {
  async initDefaults() {
    await ensureConnected();

    
    await collections.ip_pools.updateOne(
      { id: 1 },
      {
        $setOnInsert: {
          id: 1,
          name: 'Default VM Subnet',
          subnet: '10.10.0.0/24',
          gateway: '10.10.0.1',
          netmask: '255.255.255.0',
          dns: '1.1.1.1, 8.8.8.8',
          range_start: '10.10.0.10',
          range_end: '10.10.0.250',
          dhcp_enabled: true,
          bridge: 'br0',
          created_at: new Date().toISOString(),
        }
      },
      { upsert: true }
    );

    
    const defaultRules = [
      {
        id: 1,
        name: 'Allow SSH Traffic',
        direction: 'inbound',
        action: 'ALLOW',
        protocol: 'TCP',
        source: '0.0.0.0/0',
        port: '22',
        target_vm: 'all',
        active: true,
        created_at: new Date().toISOString(),
      },
      {
        id: 2,
        name: 'Allow HTTP & HTTPS Web',
        direction: 'inbound',
        action: 'ALLOW',
        protocol: 'TCP',
        source: '0.0.0.0/0',
        port: '80, 443',
        target_vm: 'all',
        active: true,
        created_at: new Date().toISOString(),
      },
      {
        id: 3,
        name: 'Allow ICMP Ping (Echo)',
        direction: 'inbound',
        action: 'ALLOW',
        protocol: 'ICMP',
        source: '0.0.0.0/0',
        port: 'ANY',
        target_vm: 'all',
        active: true,
        created_at: new Date().toISOString(),
      },
    ];
    for (const r of defaultRules) {
      await collections.firewall_rules.updateOne(
        { id: r.id },
        { $setOnInsert: r },
        { upsert: true }
      );
    }
  }

  async getInterfaces() {
    const raw = os.networkInterfaces();
    const ifaces = [];

    for (const [name, addrs] of Object.entries(raw)) {
      const ipv4 = addrs.find(a => a.family === 'IPv4');
      const isBridge = name.startsWith('br') || name.startsWith('virbr') || name.startsWith('docker');
      ifaces.push({
        name,
        type: isBridge ? 'Bridge' : name === 'lo' ? 'Loopback' : 'Physical / Virtual',
        ip: ipv4 ? ipv4.address : 'Unassigned',
        netmask: ipv4 ? ipv4.netmask : '-',
        mac: addrs[0]?.mac || '-',
        internal: addrs[0]?.internal || false,
        status: 'UP',
      });
    }

    return ifaces;
  }

  async listIpPools() {
    await ensureConnected();
    await this.initDefaults();
    const pools = await collections.ip_pools.find({}).toArray();
    const vms = await collections.vms.find({}).toArray();

    return pools.map(p => {
      
      const allocatedCount = vms.length;
      const totalCapacity = 240;
      return {
        ...p,
        totalCapacity,
        allocatedCount,
        freeCount: Math.max(0, totalCapacity - allocatedCount),
        utilizationPercent: Math.min(100, Math.round((allocatedCount / totalCapacity) * 100)),
      };
    });
  }

  async createIpPool(data) {
    await ensureConnected();
    const id = await getNextId('ip_pools');
    const doc = {
      id,
      name: data.name || `Subnet ${id}`,
      subnet: data.subnet || '192.168.100.0/24',
      gateway: data.gateway || '192.168.100.1',
      netmask: data.netmask || '255.255.255.0',
      dns: data.dns || '1.1.1.1, 8.8.8.8',
      range_start: data.range_start || '192.168.100.10',
      range_end: data.range_end || '192.168.100.250',
      dhcp_enabled: Boolean(data.dhcp_enabled !== false),
      bridge: data.bridge || 'br0',
      created_at: new Date().toISOString(),
    };
    await collections.ip_pools.insertOne(doc);
    return doc;
  }

  async deleteIpPool(poolId) {
    await ensureConnected();
    const id = Number(poolId);
    await collections.ip_pools.deleteOne({ id });
    return { ok: true, deletedId: id };
  }

  async listPortForwards() {
    await ensureConnected();
    const forwards = await collections.port_forwards.find({}).toArray();
    return forwards;
  }

  async createPortForward(data) {
    await ensureConnected();
    const id = await getNextId('port_forwards');
    const doc = {
      id,
      name: data.name || `Forward rule ${id}`,
      host_port: Number(data.host_port),
      vm_id: Number(data.vm_id) || null,
      vm_ip: data.vm_ip || '10.10.0.5',
      vm_port: Number(data.vm_port),
      protocol: (data.protocol || 'TCP').toUpperCase(),
      status: 'active',
      created_at: new Date().toISOString(),
    };
    await collections.port_forwards.insertOne(doc);
    return doc;
  }

  async deletePortForward(id) {
    await ensureConnected();
    await collections.port_forwards.deleteOne({ id: Number(id) });
    return { ok: true, deletedId: Number(id) };
  }

  async listFirewallRules() {
    await ensureConnected();
    await this.initDefaults();
    const rules = await collections.firewall_rules.find({}).toArray();
    return rules;
  }

  async createFirewallRule(data) {
    await ensureConnected();
    const id = await getNextId('firewall_rules');
    const doc = {
      id,
      name: data.name || `Rule ${id}`,
      direction: data.direction || 'inbound',
      action: (data.action || 'ALLOW').toUpperCase(),
      protocol: (data.protocol || 'TCP').toUpperCase(),
      source: data.source || '0.0.0.0/0',
      port: data.port || 'ANY',
      target_vm: data.target_vm || 'all',
      active: true,
      created_at: new Date().toISOString(),
    };
    await collections.firewall_rules.insertOne(doc);
    return doc;
  }

  async toggleFirewallRule(id, active) {
    await ensureConnected();
    await collections.firewall_rules.updateOne(
      { id: Number(id) },
      { $set: { active: Boolean(active) } }
    );
    return { ok: true, id: Number(id), active: Boolean(active) };
  }

  async deleteFirewallRule(id) {
    await ensureConnected();
    await collections.firewall_rules.deleteOne({ id: Number(id) });
    return { ok: true, deletedId: Number(id) };
  }
}

module.exports = new NetworkService();
