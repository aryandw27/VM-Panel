const { isThemeId } = require('../lib/builtInThemes');



async function saveThemePreference(users, userId, themeId) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('Invalid user');
  if (!isThemeId(themeId)) throw new TypeError('Unsupported theme');
  const result = await users.updateOne({ id }, { $set: { theme: themeId, updated_at: new Date().toISOString() } });
  if (!result.matchedCount) throw new Error('User not found');
  return themeId;
}

module.exports = { saveThemePreference };
