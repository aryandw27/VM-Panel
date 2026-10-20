const themes = [
  {
    id: 'light-neumorphism',
    name: 'Light',
    mode: 'light',
    description: 'A clean light workspace with restrained blue accents, balanced surfaces, and clear status colors.',
    colors: ['#f7f8fa', '#ffffff', '#4c73c9', '#28313d'],
  },
  {
    id: 'dark-neumorphism',
    name: 'Dark',
    mode: 'dark',
    description: 'A refined charcoal workspace with restrained SiliconHost blue, clear hierarchy, and quiet surfaces.',
    colors: ['#0c0e12', '#11151b', '#83a7ff', '#e8ebf0'],
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
