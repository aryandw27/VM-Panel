const test = require('node:test');
const assert = require('node:assert/strict');
const { createVmOperationCoordinator } = require('../src/services/vmOperationCoordinator');

function fakeStore() {
  const locks = new Map();
  const operations = new Map();
  const collections = {
    vm_operations: {
      async insertOne(row) { if (operations.has(row.operation_id)) throw Object.assign(new Error('duplicate'), { code: 11000 }); operations.set(row.operation_id, structuredClone(row)); },
      async findOne(filter) { return structuredClone(operations.get(filter.operation_id) || null); },
      async updateOne(filter, update) {
        const row = operations.get(filter.operation_id);
        if (!row) return { matchedCount: 0 };
        Object.assign(row, structuredClone(update.$set || {}));
        return { matchedCount: 1 };
      },
    },
    vm_operation_locks: {
      async findOne(filter) { return structuredClone(locks.get(filter.vm_id) || null); },
      async findOneAndUpdate(filter, update) {
        let row = locks.get(filter.vm_id);
        const expired = row && row.lease_expires_at <= (filter.$or[0].lease_expires_at.$lte || new Date(0));
        const idMatches = filter.operation_id?.$exists === false ? !row?.operation_id : (!filter.operation_id || row?.operation_id === filter.operation_id);
        if (row && (!idMatches || (filter.status?.$ne === 'uncertain' && row.status === 'uncertain'))) throw Object.assign(new Error('stale lock read'), { code: 11000 });
        if (row && !expired) throw Object.assign(new Error('duplicate lock'), { code: 11000 });
        if (!row && !filter.$or.some((term) => term.lease_expires_at?.$exists === false)) throw Object.assign(new Error('no match'), { code: 11000 });
        row ||= { vm_id: filter.vm_id };
        const old = structuredClone(row);
        Object.assign(row, structuredClone(update.$set));
        if (old.operation_id) row.previous_operation_id = old.operation_id;
        locks.set(filter.vm_id, row);
        return structuredClone(row);
      },
      async updateOne(filter, update) {
        const row = locks.get(filter.vm_id);
        if (!row || row.operation_id !== filter.operation_id) return { matchedCount: 0 };
        Object.assign(row, structuredClone(update.$set || {}));
        for (const key of Object.keys(update.$unset || {})) delete row[key];
        return { matchedCount: 1 };
      },
    },
  };
  return { collections, locks, operations };
}

function setup(overrides = {}) {
  const store = fakeStore();
  const coordinator = createVmOperationCoordinator({
    collections: store.collections,
    ensureConnected: async () => {},
    inspectState: async () => 'running',
    leaseMs: 1000,
    heartbeatMs: 200,
    ...overrides,
  });
  return { ...store, coordinator };
}

test('same-VM concurrent operations are rejected by the durable lock and lock releases on finish', async () => {
  const f = setup();
  let enter;
  const entered = new Promise((resolve) => { enter = resolve; });
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const first = f.coordinator({ vmId: 12, operationId: 'op-1', action: 'start', execute: async () => { enter(); await gate; return { state: 'running' }; } });
  await entered;
  await assert.rejects(f.coordinator({ vmId: 12, operationId: 'op-2', action: 'stop', execute: async () => ({ state: 'stopped' }) }), { category: 'vm_operation_busy' });
  finish();
  assert.deepEqual(await first, { state: 'running' });
  assert.equal(f.operations.get('op-1').status, 'completed');
  assert.equal(f.locks.get(12).operation_id, undefined);
});

test('ordinary failure releases the lock, while uncertain outcomes quarantine it and are never retried', async () => {
  const f = setup();
  await assert.rejects(f.coordinator({ vmId: 3, operationId: 'op-failed', action: 'stop', execute: async () => { throw Object.assign(new Error('failed'), { category: 'qemu_failed' }); } }), { category: 'qemu_failed' });
  assert.equal(f.operations.get('op-failed').status, 'failed');
  assert.equal(f.locks.get(3).operation_id, undefined);
  await assert.rejects(f.coordinator({ vmId: 4, operationId: 'op-uncertain', action: 'restart', execute: async () => { throw Object.assign(new Error('unknown'), { category: 'operation_uncertain' }); } }), { category: 'operation_uncertain' });
  assert.equal(f.operations.get('op-uncertain').status, 'uncertain');
  assert.equal(f.locks.get(4).operation_id, 'op-uncertain');
  assert.equal(f.locks.get(4).status, 'uncertain');
  assert.equal(f.operations.size, 2);
  await assert.rejects(f.coordinator({ vmId: 4, operationId: 'op-replay', action: 'start', execute: async () => ({ state: 'running' }) }), { category: 'vm_operation_uncertain' });
  assert.equal(f.operations.get('op-replay').status, 'rejected');
});

test('expired interrupted operations are reconciled and quarantined rather than taken over', async () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const f = setup({ now: () => now, inspectState: async () => 'stopped' });
  f.locks.set(8, { vm_id: 8, operation_id: 'dead-op', lease_expires_at: new Date(now.getTime() - 1) });
  f.operations.set('dead-op', { operation_id: 'dead-op', vm_id: 8, action: 'start', status: 'running' });
  await assert.rejects(f.coordinator({ vmId: 8, operationId: 'new-op', action: 'start', execute: async () => ({ state: 'running' }) }), { category: 'vm_operation_uncertain' });
  assert.equal(f.operations.get('dead-op').status, 'uncertain');
  assert.equal(f.operations.get('dead-op').observed_state, 'stopped');
  assert.equal(f.operations.get('new-op').status, 'rejected');
  assert.equal(f.locks.get(8).operation_id, 'dead-op');
});

test('expired lock from a recorded completed operation can be safely reused', async () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const f = setup({ now: () => now });
  f.locks.set(9, { vm_id: 9, operation_id: 'done-op', lease_expires_at: new Date(now.getTime() - 1) });
  f.operations.set('done-op', { operation_id: 'done-op', vm_id: 9, action: 'start', status: 'completed' });
  const result = await f.coordinator({ vmId: 9, operationId: 'new-safe-op', action: 'stop', execute: async () => ({ state: 'stopped' }) });
  assert.equal(result.state, 'stopped');
  assert.equal(f.operations.get('new-safe-op').status, 'completed');
});

test('validation runs only after the lock is acquired and a failed validation releases it', async () => {
  const f = setup();
  let executed = false;
  await assert.rejects(f.coordinator({ vmId: 6, action: 'stop', validate: async () => { throw new Error('stale approval'); }, execute: async () => { executed = true; } }), /stale approval/);
  assert.equal(executed, false);
  assert.equal(f.locks.get(6).operation_id, undefined);
});
