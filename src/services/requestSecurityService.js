const crypto = require('crypto');
const net = require('net');
const logger = require('../lib/logger');

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  maxRequests: 120,
  windowSeconds: 60,
  punishmentSeconds: 900,
  analyticsRetentionDays: 30,
});
const CONFIG_SETTING = 'security.rate_limit';
const ANALYTICS_BUCKET_MS = 5 * 60 * 1000;
const BLOCK_CACHE_MS = 5000;
const ANALYTICS_LIMIT = 5000;
const BLOCK_LIMIT = 200;

function parseInteger(value, min, max, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new TypeError(`${field} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function normalizeIp(value) {
  const ip = String(value || '').trim();
  if (ip.startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4) return ip.slice(7);
  if (net.isIP(ip)) return ip;
  throw new TypeError('Enter a valid IPv4 or IPv6 address');
}

function getClientIp(req) {
  try {
    return normalizeIp(req.ip || req.socket?.remoteAddress);
  } catch (_) {
    return null;
  }
}

function identifyClient(userAgent = '') {
  const ua = String(userAgent).slice(0, 512);
  let browser = 'Unknown';
  if (/Edg(?:e|A|iOS)?\//i.test(ua)) browser = 'Edge';
  else if (/OPR\//i.test(ua)) browser = 'Opera';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\//i.test(ua) && !/Chromium\//i.test(ua)) browser = 'Chrome';
  else if (/Chromium\//i.test(ua)) browser = 'Chromium';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari';

  let os = 'Unknown';
  if (/Windows NT/i.test(ua)) os = 'Windows';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/(iPhone|iPad|iPod)/i.test(ua)) os = 'iOS';
  else if (/Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  return { userAgent: ua || 'Not provided', browser, os };
}

function createRequestSecurityService({
  collections,
  settings,
  ensureConnected,
  now = Date.now,
  log = logger,
}) {
  const buckets = new Map();
  const blockedIps = new Map();
  let blockCacheLoadedAt = null;
  let blockCacheRefresh = null;

  function getConfig() {
    const stored = settings.get(CONFIG_SETTING, {});
    const config = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    return {
      enabled: config.enabled !== false,
      maxRequests: parseInteger(config.maxRequests ?? DEFAULT_CONFIG.maxRequests, 1, 10000, 'Maximum requests'),
      windowSeconds: parseInteger(config.windowSeconds ?? DEFAULT_CONFIG.windowSeconds, 1, 3600, 'Window'),
      punishmentSeconds: parseInteger(config.punishmentSeconds ?? DEFAULT_CONFIG.punishmentSeconds, 1, 604800, 'Punishment duration'),
      analyticsRetentionDays: DEFAULT_CONFIG.analyticsRetentionDays,
    };
  }

  async function saveConfig(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('Rate limit settings are required');
    }
    let enabled;
    if (input.enabled === true || input.enabled === 'true' || input.enabled === '1') enabled = true;
    else if (input.enabled === false || input.enabled === 'false' || input.enabled === '0') enabled = false;
    else throw new TypeError('Automatic rate limiting must be enabled or disabled');
    const config = {
      enabled,
      maxRequests: parseInteger(input.maxRequests, 1, 10000, 'Maximum requests'),
      windowSeconds: parseInteger(input.windowSeconds, 1, 3600, 'Window'),
      punishmentSeconds: parseInteger(input.punishmentSeconds, 1, 604800, 'Punishment duration'),
      analyticsRetentionDays: DEFAULT_CONFIG.analyticsRetentionDays,
    };
    await settings.set(CONFIG_SETTING, config);
    return config;
  }

  async function refreshBlockCache() {
    const currentTime = now();
    if (blockCacheLoadedAt !== null && currentTime - blockCacheLoadedAt < BLOCK_CACHE_MS) return;
    if (blockCacheRefresh) return blockCacheRefresh;
    blockCacheRefresh = (async () => {
      await ensureConnected();
      const activeBlocks = await collections.security_ip_blocks.find({
        $or: [
          { expiresAt: null },
          { expiresAt: { $exists: false } },
          { expiresAt: { $gt: new Date(currentTime) } },
        ],
      }).toArray();
      blockedIps.clear();
      for (const block of activeBlocks) blockedIps.set(block.ip, block);
      blockCacheLoadedAt = now();
    })();
    try {
      await blockCacheRefresh;
    } finally {
      blockCacheRefresh = null;
    }
  }

  async function blockIp(value, { durationSeconds = null, reason = 'Manually blocked by an administrator', source = 'manual', blockedBy = null } = {}) {
    const ip = normalizeIp(value);
    if (durationSeconds !== null) durationSeconds = parseInteger(durationSeconds, 1, 604800, 'Block duration');
    await ensureConnected();
    const createdAt = new Date(now());
    const expiresAt = durationSeconds === null ? null : new Date(createdAt.getTime() + durationSeconds * 1000);
    const block = {
      ip,
      reason: String(reason).slice(0, 240),
      source: source === 'automatic' ? 'automatic' : 'manual',
      blockedBy: blockedBy === null ? null : String(blockedBy).slice(0, 100),
      createdAt,
      expiresAt,
    };
    await collections.security_ip_blocks.updateOne(
      { _id: ip },
      { $set: block },
      { upsert: true }
    );
    blockedIps.set(ip, { _id: ip, ...block });
    return { _id: ip, ...block };
  }

  async function unblockIp(value) {
    const ip = normalizeIp(value);
    await ensureConnected();
    const result = await collections.security_ip_blocks.deleteOne({ _id: ip });
    blockedIps.delete(ip);
    return result.deletedCount > 0;
  }

  async function checkRequest(req) {
    const ip = getClientIp(req);
    if (!ip) return { allowed: true, ip: null, config: getConfig() };
    await refreshBlockCache();
    const currentTime = now();
    const existingBlock = blockedIps.get(ip);
    if (existingBlock && (!existingBlock.expiresAt || new Date(existingBlock.expiresAt).getTime() > currentTime)) {
      return { allowed: false, ip, block: existingBlock, config: getConfig() };
    }
    if (existingBlock) blockedIps.delete(ip);

    const config = getConfig();
    if (!config.enabled) return { allowed: true, ip, config };

    let bucket = buckets.get(ip);
    if (!bucket || currentTime >= bucket.resetAt) {
      bucket = { count: 0, resetAt: currentTime + config.windowSeconds * 1000 };
      buckets.set(ip, bucket);
    }
    bucket.count += 1;
    if (buckets.size > 20000) {
      for (const [key, value] of buckets) {
        if (currentTime >= value.resetAt) buckets.delete(key);
      }
      while (buckets.size > 20000) buckets.delete(buckets.keys().next().value);
    }
    if (bucket.count <= config.maxRequests) return { allowed: true, ip, config };

    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1000));
    const block = await blockIp(ip, {
      durationSeconds: config.punishmentSeconds,
      reason: `Automatic block: exceeded ${config.maxRequests} requests per ${config.windowSeconds} seconds`,
      source: 'automatic',
    });
    buckets.delete(ip);
    return { allowed: false, ip, block, config, rateLimited: true, retryAfter };
  }

  async function recordRequest(req, { statusCode, rateLimited = false, blocked = false }) {
    const ip = getClientIp(req);
    if (!ip) return;
    await ensureConnected();
    const currentTime = now();
    const bucketStart = Math.floor(currentTime / ANALYTICS_BUCKET_MS) * ANALYTICS_BUCKET_MS;
    const client = identifyClient(req.headers?.['user-agent']);
    const id = crypto.createHash('sha256')
      .update(`${ip}\n${client.userAgent}\n${bucketStart}`)
      .digest('hex');
    const timestamp = new Date(currentTime);
    const expiresAt = new Date(currentTime + DEFAULT_CONFIG.analyticsRetentionDays * 86400000);
    await collections.security_request_analytics.updateOne(
      { _id: id },
      {
        $setOnInsert: {
          ip,
          ...client,
          bucketStart: new Date(bucketStart),
          expiresAt,
        },
        $set: {
          lastSeenAt: timestamp,
          lastMethod: String(req.method || 'GET').slice(0, 12),
          lastPath: String(req.path || '/').slice(0, 160),
          lastStatus: statusCode,
        },
        $inc: {
          requestCount: 1,
          rateLimitedCount: rateLimited ? 1 : 0,
          blockedCount: blocked ? 1 : 0,
        },
      },
      { upsert: true }
    );
  }

  async function getAnalytics() {
    await ensureConnected();
    const since = new Date(now() - 24 * 60 * 60 * 1000);
    const events = await collections.security_request_analytics
      .find({ bucketStart: { $gte: since } })
      .sort({ lastSeenAt: -1 })
      .limit(ANALYTICS_LIMIT)
      .toArray();
    const clients = new Map();
    let requests = 0;
    let rateLimited = 0;
    for (const event of events) {
      requests += event.requestCount || 0;
      rateLimited += event.rateLimitedCount || 0;
      const key = `${event.ip}\n${event.userAgent}`;
      const row = clients.get(key) || {
        ip: event.ip,
        os: event.os,
        browser: event.browser,
        userAgent: event.userAgent,
        requestCount: 0,
        rateLimitedCount: 0,
        blockedCount: 0,
        lastSeenAt: event.lastSeenAt,
        lastMethod: event.lastMethod,
        lastPath: event.lastPath,
        lastStatus: event.lastStatus,
      };
      row.requestCount += event.requestCount || 0;
      row.rateLimitedCount += event.rateLimitedCount || 0;
      row.blockedCount += event.blockedCount || 0;
      if (new Date(event.lastSeenAt) > new Date(row.lastSeenAt)) {
        row.lastSeenAt = event.lastSeenAt;
        row.lastMethod = event.lastMethod;
        row.lastPath = event.lastPath;
        row.lastStatus = event.lastStatus;
      }
      clients.set(key, row);
    }
    return {
      requests,
      rateLimited,
      uniqueIps: new Set(events.map((event) => event.ip)).size,
      clients: [...clients.values()].sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt)),
    };
  }

  async function listBlocks() {
    await ensureConnected();
    await refreshBlockCache();
    return collections.security_ip_blocks.find({
      $or: [
        { expiresAt: null },
        { expiresAt: { $exists: false } },
        { expiresAt: { $gt: new Date(now()) } },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(BLOCK_LIMIT)
      .toArray();
  }

  function middleware() {
    return async (req, res, next) => {
      let decision;
      try {
        decision = await checkRequest(req);
      } catch (error) {
        return next(error);
      }

      const isRateLimited = Boolean(decision.rateLimited);
      const isBlocked = Boolean(decision.block);
      res.once('finish', () => {
        recordRequest(req, {
          statusCode: res.statusCode,
          rateLimited: isRateLimited || res.statusCode === 429,
          blocked: isBlocked,
        }).catch((error) => log.error(`[security] failed to record request analytics: ${error.message}`));
      });

      if (decision.allowed) return next();
      if (decision.retryAfter) res.set('Retry-After', String(decision.retryAfter));
      res.set('Cache-Control', 'no-store');
      const status = decision.rateLimited ? 429 : 403;
      const message = decision.rateLimited
        ? 'Request limit exceeded. Your IP has been temporarily blocked.'
        : 'Requests from this IP address are blocked.';
      if (req.path.startsWith('/api/')) {
        return res.status(status).json({
          error: message,
          category: decision.rateLimited ? 'rate_limited' : 'ip_blocked',
          ...(decision.retryAfter ? { retry_after: decision.retryAfter } : {}),
        });
      }
      return res.status(status).send(message);
    };
  }

  return {
    getConfig,
    saveConfig,
    blockIp,
    unblockIp,
    checkRequest,
    recordRequest,
    getAnalytics,
    listBlocks,
    middleware,
    _buckets: buckets,
    _blockedIps: blockedIps,
  };
}

module.exports = {
  createRequestSecurityService,
  DEFAULT_CONFIG,
  normalizeIp,
  getClientIp,
  identifyClient,
};
