const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

function encryptionKey(value = process.env.AI_CREDENTIALS_ENCRYPTION_KEY) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('AI key storage is unavailable: configure AI_CREDENTIALS_ENCRYPTION_KEY.');
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('AI_CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  return key;
}
function encryptSecret(secret, keyValue) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(keyValue), iv);
  const ciphertext = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function decryptSecret(record, keyValue) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(keyValue), Buffer.from(record.key_iv || record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.key_tag || record.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(record.key_ciphertext || record.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
function normalizeProviderError(status, body) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body || {});
  if ([402, 403].includes(status) && /insufficient.*(credit|fund)|payment required|quota|billing|credit balance/i.test(raw)) return { category: 'provider_credits', message: 'The provider reports insufficient credits, billing setup, or quota. Review billing and usage with your selected provider.' };
  if (/context.?length|too many tokens|maximum context/i.test(raw)) return { category: 'context_length', message: 'This request exceeded the selected model’s context length. Start a new conversation or reduce the amount of context.' };
  if (/tool.?calling|function.?calling|tools.*not supported|does not support.*tools/i.test(raw)) return { category: 'unsupported_tool_calling', message: 'This model or endpoint does not support tool calling. Select a tool-capable model or disable assistant tools.' };
  if (status === 401 || status === 403) return { category: 'invalid_credentials', message: 'The provider rejected this API key. Check the key and its permissions.' };
  if (status === 402) return { category: 'provider_credits', message: 'The provider reports insufficient credits or billing setup. Review billing with your selected provider.' };
  if (status === 429) return { category: 'provider_rate_limit', message: 'The selected provider rate-limited this request or reports that its quota is exhausted. Wait or review your provider account and plan.' };
  if (status === 404) return { category: 'unsupported_model', message: 'The provider could not find this model. Choose a model available to your provider account.' };
  if (status >= 500) return { category: 'provider_outage', message: 'The provider returned a service error. Try again later.' };
  return { category: 'provider_error', message: `Provider rejected the request (HTTP ${Number(status) || 'unknown'}).` };
}
function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const p = address.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && (p[1] === 168 || p[1] === 0)) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || (p[0] === 198 && (p[1] === 18 || p[1] === 19)) || p[0] >= 224;
  }
  if (net.isIPv6(address)) {
    const ip = address.toLowerCase();
    return ip === '::' || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || /^fe[89ab]/.test(ip) || /^::ffff:(?:127\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(ip);
  }
  return true;
}
async function validateEndpoint(value) {
  let url;
  try { url = new URL(String(value || '')); } catch (_) { throw new Error('Invalid custom endpoint URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Custom endpoints must use HTTPS and cannot include credentials, query strings, or fragments.');
  if (net.isIP(url.hostname)) throw new Error('Custom endpoints must use a public DNS hostname, not an IP address.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('This custom endpoint hostname is not allowed.');
  let addresses;
  try { addresses = await dns.lookup(host, { all: true, verbatim: true }); } catch (_) { throw new Error('Custom endpoint hostname could not be resolved.'); }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('Custom endpoint resolves to a prohibited private or local network address.');
  Object.defineProperty(url, 'approvedAddress', { value: addresses[0] });
  return url;
}





function normalizeUsage(provider, usage) {
  if (!usage || typeof usage !== 'object') return null;
  const pick = (...keys) => {
    for (const key of keys) {
      if (Number.isFinite(usage[key])) return usage[key];
    }
    return null;
  };
  const input = provider === 'anthropic' ? pick('input_tokens') : pick('prompt_tokens', 'input_tokens');
  const output = provider === 'anthropic' ? pick('output_tokens') : pick('completion_tokens', 'output_tokens');
  if (input === null && output === null) return null;
  return { input_tokens: input, output_tokens: output };
}

function maskKey(key) { const value = String(key); return `${value.slice(0, Math.min(5, value.length))}••••${value.slice(-4)}`; }
function redactCredential(value, key) { return key ? String(value || '').split(String(key)).join('[redacted provider key]') : String(value || ''); }

module.exports = { encryptionKey, encryptSecret, decryptSecret, normalizeProviderError, isPrivateAddress, validateEndpoint, maskKey, redactCredential, normalizeUsage };
