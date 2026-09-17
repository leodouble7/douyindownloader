const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const design = require('./design-tokens.json');
const css = readFileSync(join(root, 'src/renderer/styles.css'), 'utf8');
assert.ok(Object.keys(design.colors).length, 'Design tokens must define concrete colors');
for (const [key, value] of Object.entries(design.colors)) {
  assert.ok(css.includes(`--color-${key}: ${value};`), `Color drift: ${key}`);
}
for (const [key, value] of Object.entries(design.rounded)) {
  assert.ok(css.includes(`--radius-${key}: ${value};`), `Radius drift: ${key}`);
}
assert.ok(css.includes('prefers-reduced-motion'), 'Reduced motion missing');
assert.ok(css.includes('scrollbar-color:'), 'Global scrollbar style missing');
process.stdout.write('Design tokens and runtime styles match.\n');
