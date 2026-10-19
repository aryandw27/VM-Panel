





const buckets = new Map();

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now >= bucket.reset) buckets.delete(key);
  }
  if (buckets.size > 20000) {
    const oldest = [...buckets.keys()].slice(0, buckets.size - 20000);
    for (const key of oldest) buckets.delete(key);
  }
}, 60 * 1000);
if (typeof sweeper.unref === 'function') sweeper.unref();

function userKey(req) {
  const id = req.user && Number.isSafeInteger(Number(req.user.id)) ? Number(req.user.id) : null;
  return id ? `user:${id}` : `ip:${req.ip}`;
}

function ipKey(req) {
  return `ip:${req.ip}`;
}

function rateLimit({ windowMs = 60 * 1000, max = 30, key = userKey, message = 'Too many requests. Wait a moment before trying again.', onLimit } = {}) {
  return (req, res, next) => {
    let bucketKey;
    try {
      bucketKey = key(req);
    } catch (_) {
      return next();
    }
    const now = Date.now();
    let bucket = buckets.get(bucketKey);
    if (!bucket || now >= bucket.reset) {
      bucket = { count: 0, reset: now + windowMs };
      buckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.reset - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      if (typeof onLimit === 'function') return onLimit(req, res, retryAfter);
      return res.status(429).json({ error: message, category: 'rate_limited', retry_after: retryAfter });
    }
    next();
  };
}

module.exports = { rateLimit, userKey, ipKey, _buckets: buckets };
