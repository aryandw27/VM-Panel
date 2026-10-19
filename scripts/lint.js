#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ejs = require('ejs');

const root = path.resolve(__dirname, '..');
const jsRoots = ['src', 'scripts', 'public/js'];
const jsFiles = [];
const ejsFiles = [];
function walk(dir, accept, output) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, accept, output);
    else if (accept(file)) output.push(file);
  }
}
for (const dir of jsRoots) walk(path.join(root, dir), (file) => file.endsWith('.js'), jsFiles);
walk(path.join(root, 'views'), (file) => file.endsWith('.ejs'), ejsFiles);

try {
  for (const file of jsFiles) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  for (const file of ejsFiles) ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file });
  console.log(`Static checks passed: ${jsFiles.length} JavaScript files and ${ejsFiles.length} EJS templates.`);
} catch (error) {
  process.stderr.write(error.stderr || error.stack || String(error));
  process.exitCode = 1;
}
