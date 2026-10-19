const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequestSecurityService, identifyClient } = require('../src/services/requestSecurityService');

function createFixture(startTime = 1_000_000) {
  let currentTime = startTime;
  const configStore = new Map();
  const blocks = new Map();
  const analytics = new Map();
  const settings = {
    get(key, fallback) { return configStore.has(key) ? configStore.get(key) : fallback; },
    async set(key, value) { configStore.set(key, value); },
  };
  const makeCursor = (documents) => ({
    sort() { return this; },
    limit(count) { this.documents = this.documents.slice(0, count); return this; },
    async toArray() { return this.documents; },
    documents,
  });
  const collections = {
    security_ip_blocks: {
      find() { return makeCursor([...blocks.values()].filter((block) => !block.expiresAt || block.expiresAt > new Date(currentTime))); },
      async updateOne(filter, update) { blocks.set(filter._id, { _id: filter._id, ...update.$set }); },
      async deleteOne(filter) { return { deletedCount: blocks.delete(filter._id) ? 1 : 0 }; },
      findAll() { return makeCursor([...blocks.values()]); },
    },
    security_request_analytics: {
      async updateOne(filter, update) {
        const current = analytics.get(filter._id) || { _id: filter._id, ...update.$setOnInsert };
        Object.assign(current, update.$set);
        for (const [key, value] of Object.entries(update.$inc)) current[key] = (current[key] || 0) + value;
        analytics.set(filter._id, current);
      },
      find() { return makeCursor([...analytics.values()].filter((event) => event.bucketStart >= new Date(currentTime - 86400000))); },
    },
  };
  const service = createRequestSecurityService({
    collections,
    settings,
    ensureConnected: async () => {},
    now: () => currentTime,
    log: { error() {} },
  });
  return {
    service,
    blocks,
    analytics,
    advance(milliseconds) { currentTime += milliseconds; },
    now() { return currentTime; },
  };
}

const request = (ip, userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123.0 Safari/537.36') => ({
  ip,
  method: 'GET',
  path: '/admin/security',
  headers: { 'user-agent': userAgent },
});

test('rate limit settings validate bounds and persist', async () => {
  const { service } = createFixture();
  assert.equal(service.getConfig().maxRequests, 120);
  const saved = await service.saveConfig({
    enabled: false,
    maxRequests: '45',
    windowSeconds: '90',
    punishmentSeconds: '300',
  });
  assert.deepEqual(saved, {
    enabled: false,
    maxRequests: 45,
    windowSeconds: 90,
    punishmentSeconds: 300,
    analyticsRetentionDays: 30,
  });
  assert.equal(service.getConfig().enabled, false);
  await assert.rejects(service.saveConfig({ maxRequests: 45, windowSeconds: 90, punishmentSeconds: 300 }), /enabled or disabled/);
  await assert.rejects(service.saveConfig({ enabled: true, maxRequests: 0, windowSeconds: 60, punishmentSeconds: 60 }), /Maximum requests/);
  await assert.rejects(service.saveConfig({ enabled: true, maxRequests: 10, windowSeconds: 3601, punishmentSeconds: 60 }), /Window/);
});

test('repeated requests automatically block an IP until the punishment expires', async () => {
  const { service, blocks, advance } = createFixture();
  await service.saveConfig({ enabled: true, maxRequests: 2, windowSeconds: 60, punishmentSeconds: 30 });
  assert.equal((await service.checkRequest(request('203.0.113.10'))).allowed, true);
  assert.equal((await service.checkRequest(request('203.0.113.10'))).allowed, true);
  const limited = await service.checkRequest(request('203.0.113.10'));
  assert.equal(limited.allowed, false);
  assert.equal(limited.rateLimited, true);
  assert.equal(limited.block.source, 'automatic');
  assert.equal(blocks.size, 1);
  assert.equal((await service.checkRequest(request('203.0.113.10'))).allowed, false);
  advance(31_000);
  assert.equal((await service.checkRequest(request('203.0.113.10'))).allowed, true);
});

test('manual blocks require valid IPs and can be explicitly removed', async () => {
  const { service, blocks } = createFixture();
  await assert.rejects(service.blockIp('attacker.invalid'), /valid IPv4 or IPv6/);
  await service.blockIp('2001:db8::1', { reason: 'Manual investigation' });
  assert.equal((await service.checkRequest(request('2001:db8::1'))).allowed, false);
  assert.equal(await service.unblockIp('2001:db8::1'), true);
  assert.equal(blocks.size, 0);
  assert.equal((await service.checkRequest(request('2001:db8::1'))).allowed, true);
});

test('middleware returns 429 with Retry-After and records the blocked request', async () => {
  const { service, analytics } = createFixture();
  await service.saveConfig({ enabled: true, maxRequests: 1, windowSeconds: 60, punishmentSeconds: 30 });
  const middleware = service.middleware();
  const response = () => ({
    statusCode: 200,
    headers: {},
    set(name, value) { this.headers[name] = String(value); return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    once(event, listener) { this.finishListener = listener; },
    finish() { this.finishListener?.(); },
  });
  const firstResponse = response();
  let firstPassed = false;
  await middleware(request('198.51.100.30'), firstResponse, () => { firstPassed = true; });
  assert.equal(firstPassed, true);
  firstResponse.finish();

  const limitedResponse = response();
  let limitedPassed = false;
  await middleware({ ...request('198.51.100.30'), path: '/api/example' }, limitedResponse, () => { limitedPassed = true; });
  assert.equal(limitedPassed, false);
  assert.equal(limitedResponse.statusCode, 429);
  assert.equal(limitedResponse.body.category, 'rate_limited');
  assert.ok(Number(limitedResponse.headers['Retry-After']) >= 1);
  limitedResponse.finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal([...analytics.values()].reduce((count, event) => count + event.rateLimitedCount, 0), 1);
});

test('analytics aggregate request counts and identify browser and operating system', async () => {
  const { service, advance } = createFixture();
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123.0 Safari/537.36';
  assert.deepEqual(identifyClient(ua), { userAgent: ua, browser: 'Chrome', os: 'Windows' });
  await service.recordRequest(request('198.51.100.22', ua), { statusCode: 200 });
  await service.recordRequest(request('198.51.100.22', ua), { statusCode: 429, rateLimited: true });
  advance(6 * 60 * 1000);
  await service.recordRequest(request('198.51.100.22', ua), { statusCode: 200 });
  const result = await service.getAnalytics();
  assert.equal(result.requests, 3);
  assert.equal(result.rateLimited, 1);
  assert.equal(result.uniqueIps, 1);
  assert.equal(result.clients.length, 1);
  assert.equal(result.clients[0].browser, 'Chrome');
  assert.equal(result.clients[0].os, 'Windows');
  assert.equal(result.clients[0].requestCount, 3);
});
