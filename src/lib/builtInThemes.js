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
    description: 'A true #000000 background with charcoal surfaces, restrained SiliconHost blue, and clear hierarchy.',
    colors: ['#000000', '#11151b', '#83a7ff', '#e8ebf0'],
  },
  {
    id: 'amoled-black',
    name: 'AMOLED Black',
    mode: 'dark',
    description: 'Pure AMOLED #000000 with deep near-black surfaces, crisp #22272e borders, and a sky-blue accent.',
    colors: ['#000000', '#050607', '#8ab4ff', '#ffffff'],
  },
];

const byId = new Map(themes.map((theme) => [theme.id, Object.freeze(theme)]));
const legacyThemeModes = new Map([
  ['default', 'dark'],
  ['midnight', 'dark'],
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
