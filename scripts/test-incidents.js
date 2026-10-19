const test = require('node:test');
const assert = require('node:assert/strict');
const { createIncidentService, classifyVmState } = require('../src/services/incidentService');

function makeCollections() {
  const docs = new Map();
  let seq = 0;
  const match = (row, filter) => Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && ('$in' in value)) return value.$in.includes(row[key]);
    if (value && typeof value === 'object' && ('$gte' in value)) return row[key] >= value.$gte;
    return row[key] === value;
  });
  const cursor = (rows) => ({
    sort(spec) {
      if (spec && typeof spec === 'object') {
        const [[key, dir]] = Object.entries(spec);
        rows = rows.slice().sort((a, b) => (dir === -1 ? (b[key] > a[key] ? 1 : -1) : (a[key] > b[key] ? 1 : -1)));
      }
      return this;
    },
    limit(n) { this._n = n; return this; },
    skip(n) { this._s = n; return this; },
    async toArray() {
      let out = rows.slice();
      if (this._s) out = out.slice(this._s);
      if (this._n !== undefined) out = out.slice(0, this._n);
      return structuredClone(out);
    },
  });
  return {
    docs,
    incidents: {
      async findOne(filter) { return structuredClone([...docs.values()].find((r) => match(r, filter)) || null); },
      async insertOne(row) { docs.set(row.id, structuredClone(row)); },
      find(filter) { return cursor([...docs.values()].filter((r) => match(r, filter))); },
      async countDocuments(filter) { return [...docs.values()].filter((r) => match(r, filter)).length; },
      async updateOne(filter, update) {
        const row = [...docs.values()].find((r) => match(r, filter));
        if (!row) return { matchedCount: 0 };
        Object.assign(row, structuredClone(update.$set || {}));
        for (const k of Object.keys(update.$unset || {})) delete row[k];
        if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) row[k] = (row[k] || 0) + v;
        return { matchedCount: 1 };
      },
    },
    vms: { find() { return cursor([]); } },
    vm_operations: { find() { return cursor([]); } },
    __seq: () => ++seq,
  };
}

function makeService() {
  const collections = makeCollections();
  let seq = 1000;
  const service = createIncidentService({ collections, ensureConnected: async () => {}, vmService: null, getNextId: async () => ++seq });
  return { service, collections };
}

test('unexpected stops open incidents; planned stops do not', () => {
  assert.deepEqual(classifyVmState({ vmId: 1, actualRunning: false, dbStatus: 'running', lastOp: null }).action, 'open');
  const plannedStop = { action: 'stop', status: 'completed', actor_id: 9, updated_at: new Date().toISOString() };
  assert.deepEqual(classifyVmState({ vmId: 1, actualRunning: false, dbStatus: 'running', lastOp: plannedStop }).action, 'none');
  assert.deepEqual(classifyVmState({ vmId: 1, actualRunning: true, dbStatus: 'running', lastOp: null }).action, 'none');
  assert.deepEqual(classifyVmState({ vmId: 1, actualRunning: false, dbStatus: 'stopped', lastOp: plannedStop }).action, 'resolve');
  assert.deepEqual(classifyVmState({ vmId: 1, actualRunning: true, dbStatus: 'stopped', lastOp: null }).action, 'open');
});

test('repeated signals update one incident instead of duplicating', async () => {
  const { service, collections } = makeService();
  const base = { ownerId: 9, resourceType: 'vm', resourceId: 7, resourceName: 'web', category: 'unexpected_stop', severity: 'high' };
  const first = await service.reportIncident(base);
  const second = await service.reportIncident({ ...base, evidence: { attempt: 2 } });
  assert.equal(first.id, second.id);
  assert.equal(second.occurrence_count, 2);
  assert.equal(collections.docs.size, 1);
});

test('ownership is enforced on read and resolve', async () => {
  const { service } = makeService();
  const row = await service.reportIncident({ ownerId: 9, resourceType: 'vm', resourceId: 7, category: 'unexpected_stop' });
  await assert.rejects(service.getIncident({ id: 10 }, row.id), /not found/);
  await assert.rejects(service.resolveIncident({ id: 10 }, row.id, { summary: 'x', verified: { state: 'stopped', checked_at: new Date().toISOString() } }), /not found/);
  const admin = await service.getIncident({ id: 1, role: 'admin' }, row.id);
  assert.equal(admin.id, row.id);
});

test('resolution requires verified evidence and frees the dedupe key', async () => {
  const { service } = makeService();
  const row = await service.reportIncident({ ownerId: 9, resourceType: 'vm', resourceId: 7, category: 'unexpected_stop' });
  await assert.rejects(service.resolveIncident({ id: 9 }, row.id, { summary: 'trust me' }), /verified recovery evidence/);
  await assert.rejects(service.setStatus({ id: 9 }, row.id, 'resolved'), /verified resolution path/);
  const done = await service.resolveIncident({ id: 9 }, row.id, { summary: 'Rebooted, health check green.', verified: { state: 'running', checked_at: new Date().toISOString(), source: 'health-check' } });
  assert.equal(done.status, 'resolved');
  assert.ok(done.resolved_at);
  
  const again = await service.reportIncident({ ownerId: 9, resourceType: 'vm', resourceId: 7, category: 'unexpected_stop' });
  assert.notEqual(again.id, row.id);
});

test('recovery attempts accumulate and move detection forward', async () => {
  const { service } = makeService();
  const row = await service.reportIncident({ ownerId: 9, resourceType: 'vm', resourceId: 7, category: 'schedule_failure' });
  const updated = await service.addRecoveryAttempt({ id: 9 }, row.id, { action: 'reran backup job', outcome: 'success', detail: 'ok' });
  assert.equal(updated.status, 'recovering');
  assert.equal(updated.recovery_attempts.length, 1);
  await service.setStatus({ id: 9 }, row.id, 'acknowledged');
  const acked = await service.getIncident({ id: 9 }, row.id);
  assert.equal(acked.status, 'acknowledged');
});

test('listing filters, paginates, and isolates owners', async () => {
  const { service } = makeService();
  await service.reportIncident({ ownerId: 9, resourceType: 'vm', resourceId: 1, category: 'unexpected_stop', severity: 'critical' });
  await service.reportIncident({ ownerId: 9, resourceType: 'vm', resourceId: 2, category: 'unexpected_stop', severity: 'low' });
  await service.reportIncident({ ownerId: 10, resourceType: 'vm', resourceId: 3, category: 'unexpected_stop' });
  const all = await service.listIncidents({ id: 9 }, { status: 'active' });
  assert.equal(all.total, 2);
  const crit = await service.listIncidents({ id: 9 }, { status: 'active', severity: 'critical' });
  assert.equal(crit.total, 1);
  const page = await service.listIncidents({ id: 9 }, { status: 'active', limit: 1, offset: 1 });
  assert.equal(page.incidents.length, 1);
  const other = await service.listIncidents({ id: 10 }, { status: 'active' });
  assert.equal(other.total, 1);
});
