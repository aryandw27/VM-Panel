const axios = require('axios');
const { initDb, closeDb, collections } = require('../src/lib/db');
const authService = require('../src/services/authService');

const BASE_WEB = 'http://127.0.0.1:3001';

async function run() {
  console.log('======================================================');
  console.log('       TESTING MONGODB MANAGEMENT STUDIO MODULE        ');
  console.log('======================================================');

  await initDb();
  const adminUser = await collections.users.findOne({ $or: [{ role: 'admin' }, { root_admin: 1 }] });
  if (!adminUser) {
    console.error('FAIL: Admin user not found');
    process.exit(1);
  }

  const token = authService.signToken(adminUser);
  const authHeaders = {
    Authorization: 'Bearer ' + token,
    Cookie: 'token=' + token,
  };

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${message}`);
      failed++;
    }
  }

  try {
    
    console.log('\n>>> 1. UI Route Tests');
    const viewRes = await axios.get(`${BASE_WEB}/admin/mongodb`, { headers: authHeaders });
    assert(viewRes.status === 200, 'GET /admin/mongodb returns HTTP 200');
    assert(viewRes.data.includes('MongoDB Management Studio'), 'HTML contains "MongoDB Management Studio"');
    assert(viewRes.data.includes('Query Console'), 'HTML contains "Query Console"');
    assert(viewRes.data.includes('Database Breakdown'), 'HTML contains "Database Breakdown"');

    
    console.log('\n>>> 2. Telemetry & Server Stats APIs');
    const statusRes = await axios.get(`${BASE_WEB}/admin/mongodb/api/status`, { headers: authHeaders });
    assert(statusRes.status === 200 && statusRes.data.ok === true, 'GET /admin/mongodb/api/status returns ok: true');
    assert(statusRes.data.status.connected === true, 'MongoDB connection status is CONNECTED');
    assert(!!statusRes.data.status.version, `MongoDB version detected: ${statusRes.data.status.version}`);

    const statsRes = await axios.get(`${BASE_WEB}/admin/mongodb/api/stats`, { headers: authHeaders });
    assert(statsRes.status === 200 && statsRes.data.ok === true, 'GET /admin/mongodb/api/stats returns ok: true');
    assert(statsRes.data.stats.mem && statsRes.data.stats.mem.resident > 0, `Memory resident reported: ${statsRes.data.stats.mem?.resident} MB`);
    assert(statsRes.data.stats.connections && statsRes.data.stats.connections.current >= 1, `Active connections reported: ${statsRes.data.stats.connections?.current}`);

    
    console.log('\n>>> 3. Database Management APIs');
    const dbListRes = await axios.get(`${BASE_WEB}/admin/mongodb/api/databases`, { headers: authHeaders });
    assert(dbListRes.status === 200 && dbListRes.data.ok === true, 'GET /admin/mongodb/api/databases returns databases');
    const dbNames = (dbListRes.data.databases || []).map(d => d.name);
    assert(dbNames.includes('vpanel'), 'Database list includes "vpanel"');

    
    console.log('\n>>> 4. Collection Lifecycle & Document Tests');
    const testColl = 'studio_test_' + Date.now();
    const createCollRes = await axios.post(`${BASE_WEB}/admin/mongodb/api/collections/create`, {
      db: 'vpanel',
      name: testColl
    }, { headers: authHeaders });
    assert(createCollRes.status === 200 && createCollRes.data.ok === true, `Create collection '${testColl}'`);

    
    const insertRes = await axios.post(`${BASE_WEB}/admin/mongodb/api/documents/insert`, {
      db: 'vpanel',
      collection: testColl,
      document: { name: 'Studio Test Item', role: 'admin', active: true, score: 99 }
    }, { headers: authHeaders });
    assert(insertRes.status === 200 && insertRes.data.ok === true, `Insert document: ${insertRes.data.insertedId}`);
    const docId = insertRes.data.insertedId;

    
    const getDocsRes = await axios.get(`${BASE_WEB}/admin/mongodb/api/documents?db=vpanel&collection=${testColl}`, { headers: authHeaders });
    assert(getDocsRes.status === 200 && getDocsRes.data.total === 1, 'GET /admin/mongodb/api/documents returned 1 document');
    assert(getDocsRes.data.documents[0].name === 'Studio Test Item', 'Document name matches');

    
    const updateRes = await axios.post(`${BASE_WEB}/admin/mongodb/api/documents/update`, {
      db: 'vpanel',
      collection: testColl,
      id: docId,
      document: { name: 'Studio Test Updated', score: 100 }
    }, { headers: authHeaders });
    assert(updateRes.status === 200 && updateRes.data.ok === true, 'Update document succeeded');

    
    console.log('\n>>> 5. Query Console APIs');
    const queryFindRes = await axios.post(`${BASE_WEB}/admin/mongodb/api/query`, {
      db: 'vpanel',
      collection: testColl,
      type: 'find',
      payload: { filter: { score: 100 } }
    }, { headers: authHeaders });
    assert(queryFindRes.status === 200 && queryFindRes.data.ok === true, `Query find executed in ${queryFindRes.data.durationMs} ms`);
    assert(Array.isArray(queryFindRes.data.result) && queryFindRes.data.result.length === 1, 'Query find returned updated item');

    const countRes = await axios.post(`${BASE_WEB}/admin/mongodb/api/query`, {
      db: 'vpanel',
      collection: testColl,
      type: 'countDocuments',
      payload: { filter: {} }
    }, { headers: authHeaders });
    assert(countRes.status === 200 && countRes.data.result.count === 1, 'Query countDocuments returned 1');

    
    console.log('\n>>> 6. Index Manager APIs');
    const createIndexRes = await axios.post(`${BASE_WEB}/admin/mongodb/api/indexes/create`, {
      db: 'vpanel',
      collection: testColl,
      keys: { score: 1 },
      options: { unique: false }
    }, { headers: authHeaders });
    assert(createIndexRes.status === 200 && createIndexRes.data.ok === true, `Created index: ${createIndexRes.data.indexName}`);

    const listIdxRes = await axios.get(`${BASE_WEB}/admin/mongodb/api/indexes?db=vpanel&collection=${testColl}`, { headers: authHeaders });
    const idxNames = (listIdxRes.data.indexes || []).map(i => i.name);
    assert(idxNames.includes('score_1'), 'Index "score_1" exists in collection');

    
    console.log('\n>>> 7. Backup & Export APIs');
    const exportRes = await axios.post(`${BASE_WEB}/admin/mongodb/api/backups/export`, {
      db: 'vpanel',
      collection: testColl
    }, { headers: authHeaders });
    assert(exportRes.status === 200 && exportRes.data.ok === true, `Exported collection to: ${exportRes.data.filename}`);

    const backupListRes = await axios.get(`${BASE_WEB}/admin/mongodb/api/backups`, { headers: authHeaders });
    const backupFiles = (backupListRes.data.backups || []).map(b => b.filename);
    assert(backupFiles.includes(exportRes.data.filename), 'Exported file listed in backups');

    
    console.log('\n>>> 8. Import / Restore APIs');
    const importColl = 'studio_restore_' + Date.now();
    const importRes = await axios.post(`${BASE_WEB}/admin/mongodb/api/backups/import`, {
      db: 'vpanel',
      collection: importColl,
      mode: 'append',
      data: JSON.stringify([
        { title: 'Restored Item 1', active: true },
        { title: 'Restored Item 2', active: false }
      ])
    }, { headers: authHeaders });
    assert(importRes.status === 200 && importRes.data.ok === true, 'Import documents via JSON data payload');
    assert(importRes.data.importedCount === 2, 'Imported 2 documents');

    
    await axios.post(`${BASE_WEB}/admin/mongodb/api/collections/drop`, {
      db: 'vpanel',
      name: importColl
    }, { headers: authHeaders });

    
    console.log('\n>>> 9. Database Users APIs');
    const listUsersRes = await axios.get(`${BASE_WEB}/admin/mongodb/api/users?db=admin`, { headers: authHeaders });
    assert(listUsersRes.status === 200 && listUsersRes.data.ok === true, 'GET /admin/mongodb/api/users returns ok: true');
    const userNames = (listUsersRes.data.users || []).map(u => u.user);
    assert(userNames.includes('admin'), 'Users list in "admin" includes "admin" user');

    const testMongoUser = 'testuser_' + Date.now();
    const createUserRes = await axios.post(`${BASE_WEB}/admin/mongodb/api/users/create`, {
      db: 'vpanel',
      username: testMongoUser,
      password: 'StrongPassword123!',
      roles: [{ role: 'readWrite', db: 'vpanel' }]
    }, { headers: authHeaders });
    assert(createUserRes.status === 200 && createUserRes.data.ok === true, `Created DB user '${testMongoUser}'`);

    const dropUserRes = await axios.post(`${BASE_WEB}/admin/mongodb/api/users/delete`, {
      db: 'vpanel',
      username: testMongoUser
    }, { headers: authHeaders });
    assert(dropUserRes.status === 200 && dropUserRes.data.ok === true, `Dropped DB user '${testMongoUser}'`);

    
    await axios.post(`${BASE_WEB}/admin/mongodb/api/collections/drop`, {
      db: 'vpanel',
      name: testColl
    }, { headers: authHeaders });

    await axios.delete(`${BASE_WEB}/admin/mongodb/api/backups/${encodeURIComponent(exportRes.data.filename)}`, { headers: authHeaders });

    console.log('\n======================================================');
    console.log(`  MONGODB STUDIO TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('======================================================');

    await closeDb();
    if (failed > 0) process.exit(1);
  } catch (err) {
    console.error('Test error:', err.response ? err.response.data : err.message);
    await closeDb().catch(() => {});
    process.exit(1);
  }
}

run();
