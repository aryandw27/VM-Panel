const { settings } = require('./db');

const THEMES = [
  {
    id: 'dark',
    name: 'Onyx Pure Black',
    category: 'High Contrast Dark',
    description: 'Zero-distraction AMOLED pure black with crisp borders and sky blue highlights',
    accent: '#38bdf8',
    accentGlow: 'rgba(56, 189, 248, 0.35)',
    bg: '#000000',
    cardBg: '#09090b',
    border: '#27272a',
  },
  {
    id: 'default',
    name: 'Default Slate',
    category: 'Glassmorphic',
    description: 'Balanced deep slate glass with indigo neon accents and ambient blur',
    accent: '#6366f1',
    accentGlow: 'rgba(99, 102, 241, 0.35)',
    bg: '#0b1020',
    cardBg: 'rgba(15, 23, 42, 0.65)',
    border: 'rgba(255, 255, 255, 0.08)',
  },
  {
    id: 'neon',
    name: 'Cyberpunk Neon',
    category: 'Vibrant',
    description: 'Emerald green and violet high-energy cybernetic aesthetic with intense luminescence',
    accent: '#10b981',
    accentGlow: 'rgba(16, 185, 129, 0.45)',
    bg: '#030712',
    cardBg: 'rgba(17, 24, 39, 0.8)',
    border: 'rgba(16, 185, 129, 0.25)',
  },
  {
    id: 'nord',
    name: 'Nord Frost',
    category: 'Nordic Arctic',
    description: 'Calm arctic frost aesthetic inspired by Arctic Scandinavian winter landscapes',
    accent: '#88c0d0',
    accentGlow: 'rgba(136, 192, 208, 0.35)',
    bg: '#2e3440',
    cardBg: '#3b4252',
    border: '#4c566a',
  },
  {
    id: 'dracula',
    name: 'Dracula Vampire',
    category: 'Dark Fantasy',
    description: 'Vibrant purple, pink and teal accents on deep indigo gothic canvas',
    accent: '#bd93f9',
    accentGlow: 'rgba(189, 147, 249, 0.4)',
    bg: '#1e1f29',
    cardBg: '#282a36',
    border: '#44475a',
  },
];

class ThemeEngine {
  getThemes() {
    return THEMES;
  }

  getTheme(themeId) {
    return THEMES.find(t => t.id === themeId) || THEMES[0];
  }

getActiveTheme() {
     const activeId = settings.get('panel.theme', 'dark');
     return this.getTheme(activeId);
   }

  async setActiveTheme(themeId) {
    const found = this.getTheme(themeId);
    if (!found) throw new Error(`Theme '${themeId}' not recognized`);
    await settings.set('panel.theme', found.id);
    await settings.set('panel.accent', found.accent);
    return found;
  }

  getThemeCss(themeId) {
    const t = this.getTheme(themeId);
    return `
:root[data-theme="${t.id}"] {
  --accent: ${t.accent};
  --accent-glow: ${t.accentGlow};
  --bg-main: ${t.bg};
  --bg-card: ${t.cardBg};
  --border: ${t.border};
}
`;
  }
}

module.exports = new ThemeEngine();
