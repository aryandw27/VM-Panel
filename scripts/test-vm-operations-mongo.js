const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { fork } = require('child_process');
const path = require('path');
const { MongoClient } = require('mongodb');
const { createVmOperationCoordinator } = require('../src/services/vmOperationCoordinator');

function isolatedUri() {
  const raw = process.env.AI_VM_TEST_MONGO_URI;
  if (!raw) throw new Error('Set AI_VM_TEST_MONGO_URI to the isolated local MongoDB test service.');
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Mongo concurrency tests require a loopback-only MongoDB server.');
  const dbName = `vpanel_ai_validation_${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
  url.pathname = `/${dbName}`;
  return url.toString();
}

function launch(uri, mode, vmId, action, operationId) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'test-vm-operation-worker.js'), [mode, String(vmId), action, operationId], {
      env: { ...process.env, AI_VM_TEST_DB_URI: uri },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let response;
    child.on('message', (message) => {
      if (message.type === 'inside_execute') response = message;
      else if (message.type === 'result' || message.type === 'worker_error') response = message;
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, response }));
  });
}

test('Mongo-backed locks serialize competing actions across independent Node processes', async (t) => {
  const uri = isolatedUri();
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  t.after(async () => { await client.db().dropDatabase(); await client.close(); });
  const db = client.db();
  await Promise.all([
    db.collection('vm_operation_locks').createIndex({ vm_id: 1 }, { unique: true }),
    db.collection('vm_operations').createIndex({ operation_id: 1 }, { unique: true }),
  ]);

  const pairs = [
    ['start', 'stop'], ['stop', 'restart'], ['start', 'backup_create'],
    ['stop', 'backup_restore'], ['restart', 'resize'], ['stop', 'delete'],
    ['start', 'update'], ['stop', 'transfer_owner'],
  ];
  for (let i = 0; i < pairs.length; i += 1) {
    const vmId = i + 1;
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const results = await Promise.all([
      launch(uri, 'normal', vmId, pairs[i][0], ids[0]),
      launch(uri, 'normal', vmId, pairs[i][1], ids[1]),
    ]);
    assert.equal(results.filter((r) => r.response?.result === 'executed').length, 1, `pair ${pairs[i].join(' vs ')}`);
    assert.equal(results.filter((r) => r.response?.category === 'vm_operation_busy').length, 1, `pair ${pairs[i].join(' vs ')}`);
    assert.equal(await db.collection('vm_operations').countDocuments({ vm_id: vmId, status: 'completed' }), 1);
    assert.equal(await db.collection('vm_operations').countDocuments({ vm_id: vmId, status: 'rejected' }), 1);
    assert.equal(await db.collection('vm_operations').countDocuments({ vm_id: vmId, status: 'execute_entered' }), 1);
  }
});

test('a crashed worker leaves a recoverable record that is quarantined, not taken over', async (t) => {
  const uri = isolatedUri();
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  t.after(async () => { await client.db().dropDatabase(); await client.close(); });
  const db = client.db();
  await Promise.all([
    db.collection('vm_operation_locks').createIndex({ vm_id: 1 }, { unique: true }),
    db.collection('vm_operations').createIndex({ operation_id: 1 }, { unique: true }),
  ]);
  const operationId = crypto.randomUUID();
  const child = await launch(uri, 'crash', 99, 'restart', operationId);
  assert.equal(child.code, 42);
  assert.equal(child.response?.type, 'inside_execute');
  await db.collection('vm_operation_locks').updateOne({ vm_id: 99, operation_id: operationId }, { $set: { lease_expires_at: new Date(Date.now() - 1) } });
  const run = createVmOperationCoordinator({
    collections: { vm_operations: db.collection('vm_operations'), vm_operation_locks: db.collection('vm_operation_locks') },
    ensureConnected: async () => {}, inspectState: async () => 'running',
  });
  let executed = false;
  await assert.rejects(run({ vmId: 99, operationId: crypto.randomUUID(), action: 'stop', execute: async () => { executed = true; } }), { category: 'vm_operation_uncertain' });
  assert.equal(executed, false);
  assert.equal((await db.collection('vm_operations').findOne({ operation_id: operationId })).status, 'uncertain');
  assert.equal((await db.collection('vm_operation_locks').findOne({ vm_id: 99 })).status, 'uncertain');
});
