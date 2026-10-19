const express = require('express');
const multer = require('multer');
const mongoManagerService = require('../services/mongoManagerService');
const activity = require('../services/activityService');
const { settings } = require('../lib/db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

const json = express.json({ limit: '50mb' });
const uploadBackup = multer({ limits: { fileSize: 50 * 1024 * 1024 } }); 


router.get('/', async (req, res, next) => {
  try {
    const status = await mongoManagerService.getStatus().catch(() => ({ connected: false }));
    res.render('admin/mongodb', {
      page: 'admin-mongodb',
      user: req.user,
      settings: settings.all(),
      status,
    });
  } catch (err) {
    next(err);
  }
});


router.get('/api/status', async (req, res) => {
  try {
    const status = await mongoManagerService.getStatus();
    res.json({ ok: true, status });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/stats', async (req, res) => {
  try {
    const stats = await mongoManagerService.getServerStats();
    res.json({ ok: true, stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


router.get('/api/databases', async (req, res) => {
  try {
    const data = await mongoManagerService.listDatabases();
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/databases/create', json, async (req, res) => {
  try {
    const result = await mongoManagerService.createDatabase(req.body.name, req.body.initialCollection);
    await activity.logActivity({ user_id: req.user.id, event: 'mongodb:db_create', details: { db: req.body.name } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/databases/drop', json, async (req, res) => {
  try {
    const result = await mongoManagerService.dropDatabase(req.body.name);
    await activity.logActivity({ user_id: req.user.id, event: 'mongodb:db_drop', details: { db: req.body.name } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/databases/:dbName/stats', async (req, res) => {
  try {
    const stats = await mongoManagerService.getDatabaseStats(req.params.dbName);
    res.json({ ok: true, stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


router.get('/api/collections', async (req, res) => {
  try {
    const collections = await mongoManagerService.listCollections(req.query.db || 'vpanel');
    res.json({ ok: true, collections });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/collections/create', json, async (req, res) => {
  try {
    const result = await mongoManagerService.createCollection(req.body.db || 'vpanel', req.body.name, req.body.options || {});
    await activity.logActivity({ user_id: req.user.id, event: 'mongodb:collection_create', details: { db: req.body.db, collection: req.body.name } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/collections/drop', json, async (req, res) => {
  try {
    const result = await mongoManagerService.dropCollection(req.body.db || 'vpanel', req.body.name);
    await activity.logActivity({ user_id: req.user.id, event: 'mongodb:collection_drop', details: { db: req.body.db, collection: req.body.name } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/collections/truncate', json, async (req, res) => {
  try {
    const result = await mongoManagerService.truncateCollection(req.body.db || 'vpanel', req.body.name);
    await activity.logActivity({ user_id: req.user.id, event: 'mongodb:collection_truncate', details: { db: req.body.db, collection: req.body.name } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


router.get('/api/documents', async (req, res) => {
  try {
    const data = await mongoManagerService.getDocuments(req.query.db || 'vpanel', req.query.collection, {
      filter: req.query.filter,
      sort: req.query.sort,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/documents/:id', async (req, res) => {
  try {
    const document = await mongoManagerService.getDocumentById(req.query.db || 'vpanel', req.query.collection, req.params.id);
    if (!document) return res.status(404).json({ ok: false, error: 'Document not found' });
    res.json({ ok: true, document });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/documents/insert', json, async (req, res) => {
  try {
    const result = await mongoManagerService.insertDocument(req.body.db || 'vpanel', req.body.collection, req.body.document);
    await activity.logActivity({ user_id: req.user.id, event: 'mongodb:document_insert', details: { db: req.body.db, collection: req.body.collection } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/documents/update', json, async (req, res) => {
  try {
    const result = await mongoManagerService.updateDocument(req.body.db || 'vpanel', req.body.collection, req.body.id, req.body.document);
    await activity.logActivity({ user_id: req.user.id, event: 'mongodb:document_update', details: { db: req.body.db, collection: req.body.collection, id: req.body.id } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/documents/delete', json, async (req, res) => {
  try {
    const result = await mongoManagerService.deleteDocument(req.body.db || 'vpanel', req.body.collection, req.body.id);
    await activity.logActivity({ user_id: req.user.id, event: 'mongodb:document_delete', details: { db: req.body.db, collection: req.body.collection, id: req.body.id } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


router.get('/api/indexes', async (req, res) => {
  try {
    const indexes = await mongoManagerService.listIndexes(req.query.db || 'vpanel', req.query.collection);
    res.json({ ok: true, indexes });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/indexes/create', json, async (req, res) => {
  try {
    const result = await mongoManagerService.createIndex(req.body.db || 'vpanel', req.body.collection, req.body.keys, req.body.options || {});
    await activity.logActivity({ user_id: req.user.id, event: 'mongodb:index_create', details: { db: req.body.db, collection: req.body.collection } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/indexes/drop', json, async (req, res) => {
  try {
    const result = await mongoManagerService.dropIndex(req.body.db || 'vpanel', req.body.collection, req.body.name);
    await activity.logActivity({ user_id: req.user.id, event: 'mongodb:index_drop', details: { db: req.body.db, collection: req.body.collection, index: req.body.name } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


router.post('/api/query', json, async (req, res) => {
  try {
    const { db = 'vpanel', collection, type = 'find', payload = {} } = req.body;
    if (!collection) return res.status(400).json({ ok: false, error: 'Collection is required' });
    const response = await mongoManagerService.runQuery(db, collection, type, payload);
    res.json(response);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


router.get('/api/backups', (req, res) => {
  try {
    const backups = mongoManagerService.listBackups();
    res.json({ ok: true, backups });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/backups/export', json, async (req, res) => {
  try {
    const result = await mongoManagerService.exportCollection(req.body.db || 'vpanel', req.body.collection);
    await activity.logActivity({ user_id: req.user.id, event: 'mongodb:backup_export', details: { db: req.body.db, collection: req.body.collection } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/backups/import', uploadBackup.single('file'), async (req, res) => {
  try {
    const dbName = req.body.db || 'vpanel';
    const collection = req.body.collection;
    const mode = req.body.mode || 'append';

    let jsonContent;
    if (req.file) {
      jsonContent = req.file.buffer.toString('utf8');
    } else if (req.body.data) {
      jsonContent = req.body.data;
    } else {
      return res.status(400).json({ ok: false, error: 'No backup file or JSON data provided' });
    }

    const result = await mongoManagerService.importCollection(dbName, collection, jsonContent, mode);
    await activity.logActivity({ user_id: req.user.id, event: 'mongodb:backup_import', details: { db: dbName, collection, count: result.importedCount } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/backups/:filename/download', (req, res) => {
  const filePath = mongoManagerService.getBackupFilePath(req.params.filename);
  if (!filePath) return res.status(404).send('Backup file not found');
  res.download(filePath, req.params.filename);
});

router.delete('/api/backups/:filename', (req, res) => {
  try {
    const result = mongoManagerService.deleteBackup(req.params.filename);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


router.get('/api/users', async (req, res) => {
  try {
    const users = await mongoManagerService.listUsers(req.query.db || 'admin');
    res.json({ ok: true, users });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/users/create', json, async (req, res) => {
  try {
    const result = await mongoManagerService.createUser(req.body.db || 'admin', req.body);
    await activity.logActivity({ user_id: req.user.id, event: 'mongodb:user_create', details: { db: req.body.db, username: req.body.username } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/users/delete', json, async (req, res) => {
  try {
    const result = await mongoManagerService.dropUser(req.body.db || 'admin', req.body.username);
    await activity.logActivity({ user_id: req.user.id, event: 'mongodb:user_delete', details: { db: req.body.db, username: req.body.username } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
