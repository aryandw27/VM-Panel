const test = require('node:test');
const assert = require('node:assert/strict');
const { rateLimit, userKey, ipKey } = require('../src/middleware/rateLimit');

function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    set(k, v) { this.headers[k] = String(v); return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    render(view, vars) { this.body = { view, ...vars }; return this; },
  };
}

function run(mw, req) {
  const res = fakeRes();
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  return { res, nexted };
}

const req = (user, ip = '10.0.0.1') => ({ user, ip });

test('allows requests under the limit', () => {
  const mw = rateLimit({ windowMs: 60000, max: 3, key: () => 't1' });
  for (let i = 0; i < 3; i += 1) {
    const { res, nexted } = run(mw, req({ id: 1 }));
    assert.equal(nexted, true);
    assert.equal(res.statusCode, 200);
  }
});

test('excess requests get 429 with category and Retry-After', () => {
  const mw = rateLimit({ windowMs: 60000, max: 2, key: () => 't2' });
  run(mw, req({ id: 1 }));
  run(mw, req({ id: 1 }));
  const { res, nexted } = run(mw, req({ id: 1 }));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.category, 'rate_limited');
  assert.ok(res.body.error);
  assert.ok(Number(res.headers['Retry-After']) >= 1);
  assert.equal(res.headers['X-RateLimit-Limit'], '2');
  assert.equal(res.headers['X-RateLimit-Remaining'], '0');
});

test('different users are isolated', () => {
  const mw = rateLimit({ windowMs: 60000, max: 1, key: userKey });
  assert.equal(run(mw, req({ id: 101 })).nexted, true);
  assert.equal(run(mw, req({ id: 101 })).nexted, false);
  assert.equal(run(mw, req({ id: 102 })).nexted, true, 'other user unaffected');
});

test('unauthenticated requests fall back to IP keys', () => {
  const mw = rateLimit({ windowMs: 60000, max: 1, key: userKey });
  assert.equal(run(mw, req(null, '10.9.9.9')).nexted, true);
  assert.equal(run(mw, req(null, '10.9.9.9')).nexted, false);
  assert.equal(run(mw, req(null, '10.9.9.10')).nexted, true, 'other IP unaffected');
  assert.equal(ipKey({ ip: '10.1.2.3' }), 'ip:10.1.2.3');
});

test('window reset allows requests again', () => {
  let now = 1000000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const mw = rateLimit({ windowMs: 100, max: 1, key: () => 't5' });
    assert.equal(run(mw, req({ id: 1 })).nexted, true);
    assert.equal(run(mw, req({ id: 1 })).nexted, false);
    now += 200;
    assert.equal(run(mw, req({ id: 1 })).nexted, true, 'new window allows again');
  } finally {
    Date.now = realNow;
  }
});

test('custom onLimit handler serves HTML form flows', () => {
  const mw = rateLimit({
    windowMs: 60000, max: 1, key: () => 't6',
    onLimit: (r, res, retryAfter) => res.status(429).render('auth/login', { error: `Wait ${retryAfter}s` }),
  });
  run(mw, req(null));
  const { res, nexted } = run(mw, req(null));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.view, 'auth/login');
  assert.match(res.body.error, /Wait/);
});
