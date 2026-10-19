const themes = [
  {
    id: 'light-neumorphism',
    name: 'Light',
    mode: 'light',
    description: 'A crisp white workspace with tactile controls and clear blue, red, green, and yellow actions.',
    colors: ['#ffffff', '#ffffff', '#2563eb', '#263244'],
  },
  {
    id: 'dark-neumorphism',
    name: 'Dark',
    mode: 'dark',
    description: 'A deep charcoal workspace with raised surfaces, soft highlights, and crisp action colors.',
    colors: ['#0b0f14', '#141a22', '#60a5fa', '#e8edf4'],
  },
];

const byId = new Map(themes.map((theme) => [theme.id, Object.freeze(theme)]));
const legacyThemeModes = new Map([
  ['default', 'dark'],
  ['midnight', 'dark'],
  ['amoled-black', 'dark'],
  ['cyberpunk', 'dark'],
  ['ocean', 'dark'],
  ['forest', 'dark'],
  ['sunset', 'dark'],
  ['arctic-light', 'light'],
  ['minimal-light', 'light'],
  ['soft-neumorphism', 'light'],
]);

function isThemeId(id) {
  return typeof id === 'string' && byId.has(id);
}

function getTheme(id) {
  const theme = byId.get(id);
  if (theme) return theme;
  return byId.get(legacyThemeModes.get(id) === 'light' ? 'light-neumorphism' : 'dark-neumorphism');
}

function getThemes() {
  return themes.map((theme) => ({ ...theme }));
}

module.exports = { getTheme, getThemes, isThemeId };
