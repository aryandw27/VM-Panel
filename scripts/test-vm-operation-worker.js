const { MongoClient } = require('mongodb');
const { createVmOperationCoordinator } = require('../src/services/vmOperationCoordinator');

async function main() {
  const uri = process.env.AI_VM_TEST_DB_URI;
  if (!uri) throw new Error('AI_VM_TEST_DB_URI is required.');
  const [mode, vmArg, action, operationId] = process.argv.slice(2);
  const vmId = Number(vmArg);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  const db = client.db();
  const collections = {
    vm_operations: db.collection('vm_operations'),
    vm_operation_locks: db.collection('vm_operation_locks'),
  };
  const run = createVmOperationCoordinator({
    collections,
    ensureConnected: async () => {},
    inspectState: async () => 'stopped',
    leaseMs: mode === 'crash' ? 300 : 5000,
    heartbeatMs: 1000,
  });
  try {
    await run({
      vmId, operationId, actorId: 1, action,
      execute: async () => {
        if (mode === 'crash') {
          process.send?.({ type: 'inside_execute' });
          process.exit(42);
        }
        await collections.vm_operations.insertOne({ operation_id: `exec:${operationId}`, vm_id: vmId, action, status: 'execute_entered' });
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { state: action === 'stop' ? 'stopped' : 'running' };
      },
    });
    process.send?.({ type: 'result', result: 'executed' });
  } catch (error) {
    process.send?.({ type: 'result', category: error.category || 'error' });
  } finally {
    await client.close().catch(() => {});
    if (process.connected) process.disconnect();
  }
}

main().catch((error) => { process.send?.({ type: 'worker_error', message: error.message }); process.exitCode = 1; });
