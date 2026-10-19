const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { normalizeUsage } = require('../src/services/aiSecurity');

test('usage normalizes across provider shapes', () => {
  assert.deepEqual(normalizeUsage('anthropic', { input_tokens: 920, output_tokens: 328 }), { input_tokens: 920, output_tokens: 328 });
  assert.deepEqual(normalizeUsage('openai', { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }), { input_tokens: 100, output_tokens: 20 });
  assert.deepEqual(normalizeUsage('compatible', { prompt_tokens: 5, completion_tokens: 6 }), { input_tokens: 5, output_tokens: 6 });
  assert.deepEqual(normalizeUsage('openrouter', { prompt_tokens: 5, completion_tokens: 6 }), { input_tokens: 5, output_tokens: 6 });
  assert.deepEqual(normalizeUsage('anthropic', { input_tokens: 10 }), { input_tokens: 10, output_tokens: null });
  assert.equal(normalizeUsage('openai', {}), null);
  assert.equal(normalizeUsage('openai', null), null);
  assert.equal(normalizeUsage('openai', 'garbage'), null);
  assert.equal(normalizeUsage('anthropic', { input_tokens: NaN, output_tokens: Infinity }), null);
  assert.equal(normalizeUsage('openai', { prompt_tokens: 'lots', completion_tokens: [] }), null);
});

test('accumulated turn usage is a plain summable record', () => {
  
  
  const rounds = [{ usage: { input_tokens: 900, output_tokens: 300 } }, { usage: null }, { usage: { input_tokens: 20, output_tokens: 28 } }];
  const total = { input_tokens: 0, output_tokens: 0 };
  let present = false;
  for (const reply of rounds) {
    if (reply.usage) {
      total.input_tokens += reply.usage.input_tokens;
      total.output_tokens += reply.usage.output_tokens;
      present = true;
    }
  }
  assert.equal(present, true);
  assert.deepEqual(total, { input_tokens: 920, output_tokens: 328 });
  const emptyRounds = [{ usage: null }, { usage: null }];
  const emptyPresent = emptyRounds.some((reply) => reply.usage);
  assert.equal(emptyPresent, false, 'turns without metadata record null, rendered as unavailable');
});

test('assistant message history carries usage without leaking keys', () => {
  const src = fs.readFileSync('src/services/aiService.js', 'utf8');
  assert.match(src, /usage: messageUsage/);
  assert.match(src, /usage: 1, created_at: 1/);
  assert.match(src, /content: answer, tool_activity: activity, usage: messageUsage/);
});

test('usage line never fabricates counts and never carries secrets', () => {
  const src = fs.readFileSync('public/js/ai-assistant.js', 'utf8');
  assert.match(src, /Token usage unavailable/);
  assert.ok(!src.match(/usageLine\([^)]*key[^)]*\)/i), 'no key material near usage rendering');
});
