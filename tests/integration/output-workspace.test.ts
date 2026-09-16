import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rename, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { OutputWorkspace } from '../../src/main/download/output-workspace';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'anchored-output-'));
  const root = join(base, 'selected'); await mkdir(root);
  const info = await stat(root);
  const id = randomUUID();
  const worker = await OutputWorkspace.create({ path: root, dev: String(info.dev), ino: String(info.ino) }, id, false);
  cleanup.push(() => rm(base, { recursive: true, force: true }), () => worker.dispose());
  return { base, root, id, worker };
}
it('anchors relative writes, manifests, publication and cleanup to cwd after directory substitution', async () => {
  const { base, root, id, worker } = await fixture();
  await worker.openFile('track.part', true);
  await worker.write(Buffer.from('original bytes'), 0);
  const expected = await worker.stat();
  const artifact = join(root, `.download-${id}`);
  const moved = join(root, 'moved'); const outside = join(base, 'outside'); await mkdir(outside);
  await rename(artifact, moved); await symlink(outside, artifact);
  await worker.write(Buffer.from('!'), 14);
  await worker.sync(); await worker.closeFile();
  await worker.saveManifest({ state: 'publishing', filename: 'media.mp4' });
  await worker.publish('media.mp4', expected, new AbortController().signal);
  await worker.removePart(expected);
  await worker.saveManifest({ state: 'complete', filename: 'media.mp4' });
  await worker.cleanupManifest();
  expect(await readdir(outside)).toEqual([]);
  expect(await readFile(join(moved, 'media.mp4'), 'utf8')).toBe('original bytes!');
  expect(await worker.readManifest()).toEqual({ state: 'complete', filename: 'media.mp4' });
});
it('rejects a substituted root before creating any artifact files', async () => {
  const { base, root, worker } = await fixture();
  const identity = await stat(root);
  const moved = join(base, 'moved-root'); const outside = join(base, 'outside'); await mkdir(outside);
  await rename(root, moved); await symlink(outside, root);
  await expect(OutputWorkspace.create({ path: root, dev: String(identity.dev), ino: String(identity.ino) }, randomUUID(), false)).rejects.toThrow();
  expect(await readdir(outside)).toEqual([]);
  await worker.saveManifest({ state: 'partial' });
  expect(await readdir(outside)).toEqual([]);
});
it('recovers the last checksummed slot when the newest slot is torn', async () => {
  const { root, id, worker } = await fixture();
  await worker.saveManifest({ state: 'partial', completed: 1024 });
  await worker.saveManifest({ state: 'partial', completed: 2048 });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(root, `.download-${id}`, 'resume.0.json'), '{torn');
  expect(await worker.readManifest()).toEqual({ state: 'partial', completed: 1024 });
  await worker.saveManifest({ state: 'partial', completed: 3072 });
  expect(await worker.readManifest()).toEqual({ state: 'partial', completed: 3072 });
});
it('fails before creating files when directory fsync is unsupported', async () => {
  const base = await mkdtemp(join(tmpdir(), 'durability-test-'));
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'selected'); await mkdir(root);
  const { writeFile } = await import('node:fs/promises');
  const preload = join(base, 'unsupported.cjs');
  await writeFile(preload, `const fs = require('node:fs/promises'); const original = fs.open; fs.open = async (...args) => { const file = await original(...args); if ((await file.stat()).isDirectory()) file.sync = async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); }; return file; };`);
  const { fork } = await import('node:child_process');
  const info = await stat(root);
  await expect(OutputWorkspace.create({ path: root, dev: String(info.dev), ino: String(info.ino) }, randomUUID(), false, options => {
    const child = fork(options.modulePath, [], { cwd: options.cwd, execArgv: ['--require', preload], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' });
    return { send: message => { child.send(message as object); }, onMessage: callback => { child.on('message', callback); }, onExit: callback => { child.once('exit', callback); }, terminate: () => { child.kill(); } };
  })).rejects.toThrow('directory-durability-unsupported');
  expect(await readdir(root)).toEqual([]);
});
