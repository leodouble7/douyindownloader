import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const load = () => require('../../src/main/download/windows-output.cjs');
function native() {
  const root = {}, directory = {}, file = {};
  const info = { dev: '1', ino: '2', size: 4, nlink: 1, isFile: true, reparse: false };
  return { root, directory, file, info, api: {
    openRoot: vi.fn(() => root), open: vi.fn((_root, _name, kind) => kind === 'directory' ? directory : file),
    stat: vi.fn(() => info), close: vi.fn(), flush: vi.fn(() => 'write-through-file-flush'),
    capabilities: vi.fn(() => ({ filesystem: 'NTFS', hardLinks: true, stableIds: true, durability: 'write-through-file-flush' })),
    path: vi.fn(() => 'C:\\original'), read: vi.fn(() => Buffer.from('data')), write: vi.fn(() => 4),
    truncate: vi.fn(), rename: vi.fn(), link: vi.fn(), remove: vi.fn(), freeBytes: vi.fn(() => '1234')
  } };
}
it('Windows storage uses opened directory and source handles for every mutation', async () => {
  const n = native();
  const store = await load().createWindowsStorage('C:\\selected', { dev: '1', ino: '2' }, 'id', false, n.api);
  const handle = await store.fs.open('track.part', 0);
  await handle.write(Buffer.from('data'), 0, 4, 0); await handle.sync(); await handle.close();
  await store.fs.rename('tmp', 'resume.0.json');
  await store.fs.link('track.part', 'media.mp4', n.info);
  await store.fs.unlink('track.part', n.info);
  expect(n.api.open).toHaveBeenCalledWith(n.root, '.download-id', 'directory', true);
  expect(n.api.link).toHaveBeenCalledWith(n.file, n.directory, 'media.mp4');
  expect(n.api.rename).toHaveBeenCalledWith(n.file, n.directory, 'resume.0.json');
  expect(n.api.remove).toHaveBeenCalledWith(n.file);
  await expect(store.fs.open('../escape', 0)).rejects.toThrow('unsafe-basename');
});
it('Windows rejects reparse handles, unsupported filesystems and mismatched opened source identity', async () => {
  const n = native();
  n.api.capabilities.mockReturnValue({ filesystem: 'FAT', hardLinks: false, stableIds: false, durability: 'write-through-file-flush' });
  await expect(load().createWindowsStorage('C:\\selected', { dev: '1', ino: '2' }, 'id', false, n.api)).rejects.toThrow('unsupported-filesystem');
  expect(n.api.open).not.toHaveBeenCalled();
  n.api.capabilities.mockReturnValue({ filesystem: 'NTFS', hardLinks: true, stableIds: true, durability: 'write-through-file-flush' });
  n.info.reparse = true;
  await expect(load().createWindowsStorage('C:\\selected', { dev: '1', ino: '2' }, 'id', false, n.api)).rejects.toThrow('unsafe-reparse-point');
  n.info.reparse = false;
  const store = await load().createWindowsStorage('C:\\selected', { dev: '1', ino: '2' }, 'id', false, n.api);
  await expect(store.fs.link('track.part', 'media.mp4', { dev: '1', ino: 'different' })).rejects.toThrow('unsafe-file-identity');
  expect(n.api.link).not.toHaveBeenCalled();
});
it('Windows reports atomic visibility before source-handle teardown can fail', async () => {
  const n = native();
  const store = await load().createWindowsStorage('C:\\selected', { dev: '1', ino: '2' }, 'id', false, n.api);
  const committed = vi.fn();
  n.api.close.mockImplementation(handle => { if (handle === n.file) { expect(committed).toHaveBeenCalledOnce(); throw new Error('close-fault'); } });
  await expect(store.fs.link('track.part', 'media.mp4', n.info, committed)).rejects.toThrow('close-fault');
  expect(committed).toHaveBeenCalledOnce();
});
it.each(['x', 'video.', 'video....', 'CON.', 'LPT1.mp4', '.'])('shares filename sanitization and basename validation for %s', value => {
  const { basename, safeFilename } = require('../../src/main/download/output-names.cjs');
  expect(() => basename(safeFilename(value))).not.toThrow();
  if (value.endsWith('.') || value === 'LPT1.mp4') expect(() => basename(value)).toThrow('unsafe-basename');
});
