const test = require('node:test');
const assert = require('node:assert/strict');
const { getTheme, getThemes, isThemeId } = require('../src/lib/builtInThemes');
const { saveThemePreference } = require('../src/services/themePreferences');

test('registry exposes exactly the Light and Dark SiliconHost themes', () => {
  const all = getThemes();
  assert.equal(all.length, 2);
  assert.equal(new Set(all.map((theme) => theme.id)).size, all.length);
  assert.deepEqual(all.map(({ name, mode }) => ({ name, mode })), [
    { name: 'Light', mode: 'light' },
    { name: 'Dark', mode: 'dark' },
  ]);
  assert.ok(isThemeId('light-neumorphism'));
  assert.ok(isThemeId('dark-neumorphism'));
  assert.equal(isThemeId('soft-neumorphism'), false);
  assert.equal(getTheme('soft-neumorphism').id, 'light-neumorphism');
  assert.equal(getTheme('midnight').id, 'dark-neumorphism');
  assert.equal(getTheme('retired-theme').id, 'dark-neumorphism');
});

test('preference persistence validates ID and scopes update to the authenticated user ID', async () => {
  const calls = [];
  const users = { updateOne: async (...args) => { calls.push(args); return { matchedCount: 1 }; } };
  assert.equal(await saveThemePreference(users, 42, 'dark-neumorphism'), 'dark-neumorphism');
  assert.deepEqual(calls[0][0], { id: 42 });
  assert.equal(calls[0][1].$set.theme, 'dark-neumorphism');
  assert.ok(calls[0][1].$set.updated_at);
  await assert.rejects(saveThemePreference(users, 42, 'url(https://invalid)'), /Unsupported theme/);
  await assert.rejects(saveThemePreference(users, 'not-a-user', 'dark-neumorphism'), /Invalid user/);
  assert.equal(calls.length, 1);
});

test('preference save reports deleted or missing users', async () => {
  const users = { updateOne: async () => ({ matchedCount: 0 }) };
  await assert.rejects(saveThemePreference(users, 42, 'light-neumorphism'), /User not found/);
});
