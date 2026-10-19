const test = require('node:test');
const assert = require('node:assert/strict');

function loadService(env) {
  const key = require.resolve('../src/services/captchaService');
  delete require.cache[key];
  const configKey = require.resolve('../src/lib/config');
  delete require.cache[configKey];
  const saved = {};
  for (const k of ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_HOSTNAME', 'TURNSTILE_FAIL_OPEN', 'TURNSTILE_DEV_BYPASS']) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  const service = require('../src/services/captchaService');
  return { service, restore() { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } delete require.cache[key]; delete require.cache[configKey]; } };
}

function mockFetch(handler) {
  const real = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = real; };
}

test('unconfigured challenge stays out of the way', async () => {
  const { service, restore } = loadService({});
  assert.equal(service.settings().enabled, false);
  assert.deepEqual(await service.verifyToken('', '1.2.3.4'), { ok: true, skipped: true });
  assert.equal(service.frontendConfig().siteKey, '');
  restore();
});

test('missing token fails closed with guidance', async () => {
  const { service, restore } = loadService({ TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret' });
  const out = await service.verifyToken('', '1.2.3.4');
  assert.equal(out.ok, false);
  assert.equal(out.category, 'captcha_missing');
  restore();
});

test('valid token verifies against the provider endpoint', async () => {
  const { service, restore } = loadService({ TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret' });
  const seen = {};
  const unmock = mockFetch(async (url, options) => {
    seen.url = url;
    seen.body = String(options.body);
    return { json: async () => ({ success: true, hostname: 'panel.example.com' }) };
  });
  const out = await service.verifyToken('token123', '9.9.9.9');
  unmock();
  assert.equal(out.ok, true);
  assert.match(seen.url, /challenges\.cloudflare\.com/);
  assert.ok(!seen.body.includes('secret=secret') || seen.body.includes('secret='), 'secret travels server-side only in the POST body');
  restore();
});

test('invalid and replayed tokens are rejected distinctly', async () => {
  const { service, restore } = loadService({ TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret' });
  let mode = 'invalid';
  const unmock = mockFetch(async () => (mode === 'invalid'
    ? { json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) }
    : { json: async () => ({ success: false, 'error-codes': ['timeout-or-duplicate'] }) }));
  assert.equal((await service.verifyToken('bad', '')).category, 'captcha_invalid');
  mode = 'replay';
  assert.equal((await service.verifyToken('old', '')).category, 'captcha_expired');
  unmock();
  restore();
});

test('hostname mismatch is rejected', async () => {
  const { service, restore } = loadService({ TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret', TURNSTILE_HOSTNAME: 'panel.example.com' });
  const unmock = mockFetch(async () => ({ json: async () => ({ success: true, hostname: 'evil.example.com' }) }));
  const out = await service.verifyToken('token123', '');
  unmock();
  assert.equal(out.ok, false);
  assert.equal(out.category, 'captcha_invalid');
  restore();
});

test('provider outage fails closed by default and honors explicit fail-open', async () => {
  let fiber = loadService({ TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret' });
  let unmock = mockFetch(async () => { throw new Error('down'); });
  let out = await fiber.service.verifyToken('token123', '');
  unmock();
  assert.equal(out.ok, false);
  assert.equal(out.category, 'captcha_unavailable');
  fiber.restore();
  fiber = loadService({ TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret', TURNSTILE_FAIL_OPEN: '1' });
  unmock = mockFetch(async () => { throw new Error('down'); });
  out = await fiber.service.verifyToken('token123', '');
  unmock();
  assert.equal(out.ok, true);
  assert.equal(out.failOpen, true);
  fiber.restore();
});

test('development bypass is explicit and off by default', async () => {
  let fiber = loadService({ TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret' });
  let unmock = mockFetch(async () => { throw new Error('must not be called'); });
  const closed = await fiber.service.verifyToken('anything', '');
  unmock();
  assert.equal(closed.ok, false);
  fiber.restore();
  fiber = loadService({ TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret', TURNSTILE_DEV_BYPASS: '1' });
  unmock = mockFetch(async () => { throw new Error('must not be called'); });
  const open = await fiber.service.verifyToken('anything', '');
  unmock();
  assert.equal(open.ok, true);
  assert.equal(open.bypassed, true);
  fiber.restore();
});

test('verification secret never reaches templates or logs', () => {
  const fs = require('fs');
  for (const view of ['views/auth/login.ejs', 'views/auth/register.ejs']) {
    const src = fs.readFileSync(view, 'utf8');
    assert.ok(!src.includes('TURNSTILE_SECRET'), `${view} must not reference the secret`);
    assert.ok(src.includes('captcha.siteKey'), `${view} renders the public site key only`);
  }
});
