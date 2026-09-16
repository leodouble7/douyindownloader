import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DirectoryPreferences, validateRevealPath } from '../../src/main/desktop/preferences';

it('persists only a directory and rejects malformed preferences', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-prefs-'));
  try {
    const path = join(directory, 'preferences.json'); const preferences = new DirectoryPreferences(path); expect(await preferences.load()).toBe('');
    await preferences.save('/downloads'); expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ directory: '/downloads' }); expect(await preferences.load()).toBe('/downloads');
    await writeFile(path, JSON.stringify({ directory: '/downloads', url: 'secret' })); await expect(preferences.load()).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('rejects a reveal target that escapes the selected directory through a symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-reveal-')); const outside = await mkdtemp(join(tmpdir(), 'desktop-outside-'));
  try { await writeFile(join(outside, 'private'), 'private'); await symlink(outside, join(directory, 'escape'), 'dir'); await expect(validateRevealPath(join(directory, 'escape', 'private'), directory)).rejects.toThrow(); await writeFile(join(directory, 'video.mp4'), 'video'); expect(await readFile(await validateRevealPath(join(directory, 'video.mp4'), directory), 'utf8')).toBe('video'); }
  finally { await rm(directory, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
