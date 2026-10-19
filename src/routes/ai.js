const express = require('express');
const aiService = require('../services/aiService');
const { requireAuth } = require('../middleware/auth');
const { rateLimit, userKey } = require('../middleware/rateLimit');

const sendLimit = rateLimit({ windowMs: 60 * 1000, max: 30, key: userKey, message: 'Too many assistant messages. Wait a moment before trying again.' });
const discoverLimit = rateLimit({ windowMs: 60 * 1000, max: 15, key: userKey, message: 'Too many model-discovery requests. Wait a moment before trying again.' });
const credentialTestLimit = rateLimit({ windowMs: 60 * 1000, max: 10, key: userKey, message: 'Too many connection tests. Wait a moment before trying again.' });
const credentialWriteLimit = rateLimit({ windowMs: 60 * 1000, max: 20, key: userKey, message: 'Too many credential changes. Wait a moment before trying again.' });
const router = express.Router();
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

router.use((req, res, next) => { req.headers.accept = 'application/json'; next(); }, requireAuth, (req, res, next) => {
  if (req.user?.is_impersonating) return res.status(403).json({ error: 'AI settings and conversations are unavailable during account impersonation.' });
  next();
});

function fail(res, error) {
  const setupError = String(error.message || '').includes('AI_CREDENTIALS_ENCRYPTION_KEY');
  const status = setupError ? 503 : error.status === 429 ? 429 : error.status === 402 ? 402 : 400;
  return res.status(status).json({ error: error.message || 'AI request failed.', category: setupError ? 'encryption_setup' : error.category || 'request_error' });
}

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return res.status(403).json({ error: 'Approval actions must come from the authenticated panel interface.' });
  try {
    const parsed = new URL(origin);
    if (parsed.host !== req.get('host') || !['http:', 'https:'].includes(parsed.protocol)) throw new Error('origin mismatch');
    return next();
  } catch (_) { return res.status(403).json({ error: 'Cross-origin approval requests are not allowed.' }); }
}

router.get('/providers', (req, res) => {
  res.json({ providers: Object.entries(aiService.PROVIDERS).map(([id, provider]) => ({ id, name: provider.label, models: provider.models })), tools: aiService.TOOL_DEFINITIONS.map(({ name, description, category, risk, approval_required }) => ({ name, description, category, risk, approval_required })) });
});
router.post('/providers/:provider/models', discoverLimit, express.json({ limit: '10kb' }), async (req, res) => {
  try { return res.json({ models: await aiService.discoverModels(req.params.provider, String(req.body.api_key || '').trim(), String(req.body.endpoint || '')) }); }
  catch (error) { return fail(res, error); }
});

router.get('/credentials', asyncRoute(async (req, res) => res.json({ credentials: await aiService.listCredentials(req.user.id) })));
router.post('/credentials', credentialWriteLimit, express.json({ limit: '10kb' }), async (req, res) => {
  try { return res.status(201).json({ credential: await aiService.addCredential(req.user.id, req.body) }); }
  catch (error) { return fail(res, error); }
});
router.patch('/credentials/:id', credentialWriteLimit, express.json({ limit: '4kb' }), async (req, res) => {
  try { return res.json({ credentials: await aiService.renameCredential(req.user.id, req.params.id, req.body.nickname) }); }
  catch (error) { return fail(res, error); }
});
router.post('/credentials/:id/test', credentialTestLimit, async (req, res) => {
  try { return res.json(await aiService.testCredential(req.user.id, req.params.id)); }
  catch (error) { return fail(res, error); }
});
router.post('/credentials/:id/activate', credentialWriteLimit, async (req, res) => {
  try { return res.json({ credentials: await aiService.activateCredential(req.user.id, req.params.id) }); }
  catch (error) { return fail(res, error); }
});
router.delete('/credentials/:id', credentialWriteLimit, async (req, res) => {
  try { return res.json({ credentials: await aiService.deleteCredential(req.user.id, req.params.id) }); }
  catch (error) { return fail(res, error); }
});

router.get('/tools', asyncRoute(async (req, res) => {
  const permissions = await aiService.userTools(req.user.id);
  return res.json({ tools: aiService.TOOL_DEFINITIONS.map(({ name, description, category, risk, approval_required }) => ({ name, description, category, risk, approval_required, enabled: permissions[name] === true })), permissions, lifecycle_globally_enabled: aiService.lifecycleEnabled() });
}));
router.put('/tools', express.json({ limit: '10kb' }), async (req, res) => {
  try { return res.json({ permissions: await aiService.saveTools(req.user.id, req.body.permissions || {}) }); }
  catch (error) { return fail(res, error); }
});
router.get('/history', asyncRoute(async (req, res) => res.json({ events: await aiService.recentEvents(req.user.id) })));

router.get('/conversations/:id/approvals', async (req, res) => {
  try {
    const data = await aiService.getMessages(req.user.id, req.params.id);
    return res.json({ approvals: await aiService.listApprovals(req.user, data.conversation.id) });
  } catch (error) { return fail(res, error); }
});
router.post('/approvals/:id/approve', requireSameOrigin, async (req, res) => {
  try { return res.json({ approval: await aiService.decideApproval(req.user, req.params.id, 'approve') }); }
  catch (error) { return fail(res, error); }
});
router.post('/approvals/:id/reject', requireSameOrigin, async (req, res) => {
  try { return res.json({ approval: await aiService.decideApproval(req.user, req.params.id, 'reject') }); }
  catch (error) { return fail(res, error); }
});

router.get('/conversations', asyncRoute(async (req, res) => res.json({ conversations: await aiService.conversations(req.user.id) })));
router.post('/conversations', express.json({ limit: '4kb' }), async (req, res) => {
  try { return res.status(201).json({ conversation: await aiService.createConversation(req.user.id, req.body.title, { incidentId: req.body.incident_id ?? null }) }); }
  catch (error) { return fail(res, error); }
});
router.get('/conversations/:id', async (req, res) => {
  try { return res.json(await aiService.getMessages(req.user.id, req.params.id)); }
  catch (error) { return fail(res, error); }
});
router.patch('/conversations/:id', express.json({ limit: '4kb' }), asyncRoute(async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 100);
  if (!title) return res.status(400).json({ error: 'Conversation title is required.' });
  const result = await require('../lib/db').collections.ai_conversations.updateOne({ user_id: Number(req.user.id), id: String(req.params.id) }, { $set: { title, updated_at: new Date().toISOString() } });
  if (!result.matchedCount) return res.status(404).json({ error: 'Conversation not found.' });
  return res.json({ ok: true });
}));
router.delete('/conversations/:id', asyncRoute(async (req, res) => {
  const { collections } = require('../lib/db');
  await collections.ai_approvals.updateMany({ user_id: Number(req.user.id), conversation_id: String(req.params.id), status: 'pending' }, { $set: { status: 'cancelled', updated_at: new Date().toISOString() }, $unset: { active_key: '' } });
  const result = await collections.ai_conversations.deleteOne({ user_id: Number(req.user.id), id: String(req.params.id) });
  if (!result.deletedCount) return res.status(404).json({ error: 'Conversation not found.' });
  await collections.ai_messages.deleteMany({ user_id: Number(req.user.id), conversation_id: String(req.params.id) });
  return res.json({ ok: true });
}));
router.post('/conversations/:id/messages', sendLimit, express.json({ limit: '16kb' }), async (req, res) => {
  res.set({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.flushHeaders?.();
  const emit = (payload) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(payload)}\n\n`); };
  try {
    const result = await aiService.sendMessage(req.user, req.params.id, req.body.content, req.body.context || {}, emit);
    emit({ type: 'complete', ...result });
  } catch (error) { emit({ type: 'error', error: error.message, category: error.category || 'request_error' }); }
  return res.end();
});

module.exports = router;
