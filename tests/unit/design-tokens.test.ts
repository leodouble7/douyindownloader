import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
it('maps canonical design colors and corner tokens to renderer variables', () => {
  const design = readFileSync('DESIGN.md', 'utf8'), css = readFileSync('src/renderer/styles.css', 'utf8');
  const colors = design.split('colors:\n')[1].split('typography:')[0];
  for (const match of colors.matchAll(/  ([a-z-]+): "(#[a-f0-9]+)"/g)) expect(css).toContain(`--${match[1]}: ${match[2]}`);
  expect(css).toContain('--radius: 6px'); expect(css).toContain('--radius-sm: 3px');
});
