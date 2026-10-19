const config = require('../lib/config');
const logger = require('../lib/logger');

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';








function settings() {
  const t = config.turnstile || {};
  return {
    enabled: Boolean(t.siteKey && t.secretKey),
    siteKey: t.siteKey || '',
    hostname: t.hostname || '',
    failOpen: t.failOpen === true,
    devBypass: t.devBypass === true,
  };
}

function frontendConfig() {
  const t = settings();
  return { enabled: t.enabled, siteKey: t.enabled ? t.siteKey : '' };
}

async function verifyToken(token, ip = '') {
  const t = settings();
  if (!t.enabled) return { ok: true, skipped: true };
  if (t.devBypass) {
    logger.warn('[captcha] development bypass active; do not enable in production.');
    return { ok: true, bypassed: true };
  }
  if (!token || typeof token !== 'string') {
    return { ok: false, category: 'captcha_missing', message: 'Complete the anti-bot challenge and try again.' };
  }
  let data;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetch(VERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: config.turnstile.secretKey, response: token, remoteip: String(ip || '') }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    data = await response.json().catch(() => ({}));
  } catch (_) {
    if (t.failOpen) {
      logger.warn('[captcha] provider unreachable; fail-open recovery policy applied.');
      return { ok: true, failOpen: true };
    }
    return { ok: false, category: 'captcha_unavailable', message: 'The anti-bot check is temporarily unreachable. Wait a moment and try again.' };
  }
  if (data && data.success === true) {
    if (t.hostname && data.hostname && String(data.hostname).toLowerCase() !== t.hostname.toLowerCase()) {
      return { ok: false, category: 'captcha_invalid', message: 'The anti-bot challenge could not be verified. Try again.' };
    }
    return { ok: true };
  }
  const codes = Array.isArray(data && data['error-codes']) ? data['error-codes'] : [];
  if (codes.includes('timeout-or-duplicate')) {
    return { ok: false, category: 'captcha_expired', message: 'The anti-bot challenge expired. Complete it again.' };
  }
  return { ok: false, category: 'captcha_invalid', message: 'The anti-bot challenge could not be verified. Try again.' };
}

module.exports = { settings, frontendConfig, verifyToken, VERIFY_URL };
