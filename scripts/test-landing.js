const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const ejs = require('ejs');

const src = fs.readFileSync('views/landing.ejs', 'utf8');

test('landing template compiles', () => {
  ejs.compile(src, { filename: 'views/landing.ejs' });
});

test('dark-to-light junction is a deliberate overlap, not a hard cut', () => {
  assert.match(src, /section#about \{[^}]*margin-top: -2rem/s);
  assert.match(src, /section#about \{[^}]*border-radius: 2rem 2rem 0 0/s);
  assert.match(src, /linear-gradient\(to bottom, #eceae7 0, #f6f5f3 7rem, #ffffff 15rem\)/);
});

test('wordmark removed so it cannot overlap or overflow', () => {
  assert.ok(!src.includes('footer-watermark'), 'no watermark element or styles remain');
  const footerHtml = src.slice(src.indexOf('<footer class="site-footer">'));
  assert.ok(!footerHtml.includes('SILICONHOST'), 'no giant wordmark inside the footer');
});

test('footer regions: compact CTA strip, distributed grid, legal bar', () => {
  assert.match(src, /\.footer-cta-h2 \{[\s\S]*?font-size: 1\.5rem/);
  assert.match(src, /align-items: center;[\s\S]*?justify-content: space-between/);
  assert.match(src, /grid-template-columns: 2fr 1fr 1fr 1fr/);
  assert.match(src, /gap: clamp\(2rem, 4vw, 3\.5rem\)/);
});

test('adaptive performance controller precedes effects and gates loops', () => {
  const perfIdx = src.indexOf('const perfMode');
  const starIdx = src.indexOf('initStarfieldCloseHero');
  assert.ok(perfIdx > 0 && perfIdx < starIdx, 'perf mode defined before starfield init');
  assert.match(src, /prefers-reduced-motion: reduce/);
  assert.match(src, /perfMode === 'minimal'\) return/);
  assert.match(src, /IntersectionObserver/);
  assert.match(src, /visibilitychange/);
  assert.match(src, /document\.documentElement\.dataset\.perf = perfMode/);
});

test('background video stays subtle and layered behind content', () => {
  const css = fs.readFileSync('public/css/panel.css', 'utf8');
  assert.match(css, /\.bg-layer video \{[\s\S]*?object-position: center 25%/);
  assert.match(css, /\.bg-layer video \{[\s\S]*?filter: brightness\(0\.6\) saturate\(0\.85\)/);
  assert.match(css, /\.bg-layer \{[\s\S]*?z-index: -2/);
  assert.match(css, /\.bg-overlay \{[\s\S]*?z-index: -1/);
});

test('footer links and structure intact', () => {
  for (const s of ['Deploy Server', 'High-Compute VPS', 'Client Area / Login', 'Global Datacenters',
    'Privacy Policy', 'Terms of Service', 'SILICONHOST', 'footer-cols', 'footer-legal-bar']) {
    assert.ok(src.includes(s), `footer keeps: ${s}`);
  }
});
