const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const design = readFileSync(join(root, 'DESIGN.md'), 'utf8');
const css = readFileSync(join(root, 'src/renderer/styles.css'), 'utf8');
const colors = design.match(/^colors:\n([\s\S]*?)^typography:/m)?.[1];
assert.ok(colors, 'DESIGN.md must define concrete colors');
for (const [, key, value] of colors.matchAll(/^  ([\w-]+): "(#[a-f\d]+)"/gm)) {
  assert.ok(css.includes(`--color-${key}: ${value};`), `Color drift: ${key}`);
}
for (const [, key, value] of design.matchAll(/^  (control|panel): "([\d]+px)"/gm)) {
  assert.ok(css.includes(`--radius-${key}: ${value};`), `Radius drift: ${key}`);
}
assert.ok(css.includes('prefers-reduced-motion'), 'Reduced motion missing');
assert.ok(css.includes('scrollbar-color:'), 'Global scrollbar style missing');
process.stdout.write('Design tokens and runtime styles match.\n');
