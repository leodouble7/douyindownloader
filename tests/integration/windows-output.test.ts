import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { OutputWorkspace, type RootIdentity } from '../../src/main/download/output-workspace';
const require = createRequire(import.meta.url);
const windows = it.skipIf(process.platform !== 'win32');
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'windows-output-')); cleanup.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'selected'); await mkdir(root);
  const adapter = require('../../src/main/download/windows-output.cjs') as { openWindowsRoot(path: string): RootIdentity & { close(): void } };
  const identity = adapter.openWindowsRoot(root); cleanup.push(async () => identity.close());
  const id = randomUUID(); const worker = await OutputWorkspace.create(identity, id, false); cleanup.push(() => worker.dispose());
  return { base, root, id, identity, worker };
}
windows('native Windows actor anchors handles across junction substitution, flushes bytes, and publishes without clobbering', async () => {
  const { base, root, id, worker } = await fixture();
  await worker.openFile('track.part', true); await worker.write(Buffer.from('ordered bytes'), 0);
  const identity = await worker.stat(); await worker.sync();
  expect((await worker.read(0, 13)).toString()).toBe('ordered bytes');
  const original = join(root, `.download-${id}`), moved = join(root, 'moved'), outside = join(base, 'outside');
  await mkdir(outside);
  // Windows denies moving a directory containing an open file without DELETE sharing.
  await expect(rename(original, moved)).rejects.toThrow();
  await worker.closeFile();
  await rename(original, moved); await symlink(outside, original, 'junction');
  const reopened = await worker.openFile('track.part');
  expect({ dev: reopened.dev, ino: reopened.ino }).toEqual({ dev: identity.dev, ino: identity.ino });
  await worker.write(Buffer.from('!'), 13); await worker.sync(); await worker.closeFile();
  await worker.saveManifest({ state: 'publishing', identity });
  await writeFile(join(moved, 'unrelated.mp4'), 'unrelated');
  await expect(worker.publish('unrelated.mp4', identity, new AbortController().signal)).rejects.toThrow();
  await worker.publish('media.mp4', identity, new AbortController().signal);
  await worker.removePart(identity); await worker.saveManifest({ state: 'complete' }); await worker.cleanupManifest();
  expect(await readdir(outside)).toEqual([]);
  expect(await readFile(join(moved, 'media.mp4'), 'utf8')).toBe('ordered bytes!');
  expect(await readFile(join(moved, 'unrelated.mp4'), 'utf8')).toBe('unrelated');
  // Recovery reads use the retained directory handle, including after the old pathname changes.
  expect(await worker.readManifest()).toEqual({ state: 'complete' });
  const final = await worker.openFile('media.mp4');
  expect(final.ino).toBe(identity.ino); expect((await worker.read(0, 14)).toString()).toBe('ordered bytes!');
  await worker.closeFile();
  expect(await worker.durability()).toBe('write-through-file-flush');
});
windows.each(['publishing', 'linked', 'unlinked', 'cleaned'])('native Windows actor recovers %s publication state', async stage => {
  const { worker, id, identity: root } = await fixture();
  await worker.openFile('track.part', true); await worker.write(Buffer.from('bytes'), 0); const identity = await worker.stat(); await worker.sync(); await worker.closeFile();
  const receipt = { state: 'publishing', identity, sha256: createHash('sha256').update('bytes').digest('hex'), length: 5 };
  await worker.saveManifest(receipt);
  if (stage !== 'publishing') await worker.publish('media.mp4', identity, new AbortController().signal);
  if (stage === 'unlinked' || stage === 'cleaned') await worker.removePart(identity);
  if (stage === 'cleaned') { await worker.saveManifest({ ...receipt, state: 'complete' }); await worker.cleanupManifest(); }
  await worker.dispose();
  const recovered = await OutputWorkspace.create(root, id, true); cleanup.push(() => recovered.dispose());
  const final = await recovered.statEntry('media.mp4');
  const opened = await recovered.openFile(final ? 'media.mp4' : 'track.part');
  expect({ dev: opened.dev, ino: opened.ino }).toEqual({ dev: identity.dev, ino: identity.ino });
  expect(createHash('sha256').update(await recovered.read(0, 5)).digest('hex')).toBe(receipt.sha256);
  await recovered.closeFile();
  if (!final) await recovered.publish('media.mp4', identity, new AbortController().signal);
  await recovered.saveManifest({ ...receipt, state: 'complete' }); await recovered.removePart(identity); await recovered.cleanupManifest();
  expect(await recovered.statEntry('track.part')).toBeNull();
  expect(await recovered.readManifest()).toEqual({ ...receipt, state: 'complete' });
});
windows('native Windows actor rejects junction roots and cancellation before publication', async () => {
  const { base, root, worker } = await fixture();
  const alias = join(base, 'alias'); await symlink(root, alias, 'junction');
  const adapter = require('../../src/main/download/windows-output.cjs');
  expect(() => adapter.openWindowsRoot(alias)).toThrow('unsafe-reparse-point');
  await worker.openFile('track.part', true); const identity = await worker.stat(); await worker.sync(); await worker.closeFile();
  const controller = new AbortController(); controller.abort();
  await expect(worker.publish('media.mp4', identity, controller.signal)).rejects.toThrow();
  expect(await worker.statEntry('media.mp4')).toBeNull();
});

windows.each([1, 2, 150])('native Windows rename and link support aligned variable-length names of %s characters', async length => {
  const { root, identity } = await fixture();
  const { constants } = await import('node:fs');
  const adapter = require('../../src/main/download/windows-output.cjs');
  const store = await adapter.createWindowsStorage(root, identity, randomUUID(), false);
  cleanup.push(async () => { await store.directory.close(); await store.root.close(); });
  const source = await store.fs.open('source', constants.O_CREAT); await source.writeFile('bytes'); await source.sync(); await source.close();
  const renamed = 'a'.repeat(length), linked = 'b'.repeat(length);
  await store.fs.rename('source', renamed);
  const info = await store.fs.lstat(renamed);
  await store.fs.link(renamed, linked, info);
  const final = await store.fs.open(linked, 0);
  expect(await final.readFile('utf8')).toBe('bytes'); expect((await final.stat()).ino).toBe(info.ino);
  await final.close();
});
windows('native actor publishes the sanitized one-character filename', async () => {
  const { worker } = await fixture();
  const { safeFilename } = require('../../src/main/download/output-names.cjs');
  await worker.openFile('track.part', true); await worker.write(Buffer.from('one'), 0); const identity = await worker.stat(); await worker.sync(); await worker.closeFile();
  await worker.publish(safeFilename('x.'), identity, new AbortController().signal);
  const opened = await worker.openFile('x'); expect(opened.ino).toBe(identity.ino); expect((await worker.read(0, 3)).toString()).toBe('one'); await worker.closeFile();
});
