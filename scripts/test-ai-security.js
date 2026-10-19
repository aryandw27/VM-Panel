const test = require('node:test');
const assert = require('node:assert/strict');
const { encryptionKey, encryptSecret, decryptSecret, normalizeProviderError, isPrivateAddress, validateEndpoint, redactCredential } = require('../src/services/aiSecurity');

const key = Buffer.alloc(32, 7).toString('base64');

test('credential encryption uses authenticated encryption and never stores plaintext', () => {
  const secret = 'provider-key-test-DoNotStorePlaintext';
  const encrypted = encryptSecret(secret, key);
  assert.equal(decryptSecret(encrypted, key), secret);
  assert.equal(JSON.stringify(encrypted).includes(secret), false);
  assert.notEqual(encryptSecret(secret, key).iv, encrypted.iv);
  assert.throws(() => decryptSecret({ ...encrypted, tag: Buffer.alloc(16).toString('base64') }, key));
});

test('credential encryption rejects missing and incorrectly sized keys', () => {
  assert.throws(() => encryptionKey(''), /AI_CREDENTIALS_ENCRYPTION_KEY/);
  assert.throws(() => encryptionKey(Buffer.alloc(15).toString('base64')), /32 bytes/);
});

test('provider errors are categorized without reflecting provider response contents', () => {
  assert.equal(normalizeProviderError(401, {}).category, 'invalid_credentials');
  assert.equal(normalizeProviderError(429, {}).category, 'provider_rate_limit');
  assert.equal(normalizeProviderError(402, {}).category, 'provider_credits');
  const secret = 'never-echo-this-secret';
  assert.equal(normalizeProviderError(500, { error: { message: secret } }).message.includes(secret), false);
});

test('a saved provider key is redacted from assistant output', () => {
  assert.equal(redactCredential('echo provider-key-test-DoNotStorePlaintext now', 'provider-key-test-DoNotStorePlaintext'), 'echo [redacted provider key] now');
});

test('custom endpoint policy rejects insecure protocols, local names, and IP literals', async () => {
  await assert.rejects(validateEndpoint('http://example.com/v1'), /HTTPS/);
  await assert.rejects(validateEndpoint('https://localhost/v1'), /not allowed/);
  await assert.rejects(validateEndpoint('https://127.0.0.1/v1'), /IP address/);
});

test('private and local address ranges are blocked', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.8', '169.254.169.254', '::1', 'fd00::1']) assert.equal(isPrivateAddress(address), true, address);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
});
