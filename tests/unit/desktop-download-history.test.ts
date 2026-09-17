import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DownloadHistory } from '../../src/main/desktop/download-history';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'download-history-')); roots.push(root);
  const file = join(root, 'history.json');
  return { root, file, history: new DownloadHistory(file) };
}
const metadata = { workId: '123456789', author: '作者', title: '旅行' };
it('persists allowlisted metadata, survives restart and serializes simultaneous recordings with pagination', async () => {
  const { root, file, history } = await fixture();
  const paths = [join(root, 'a.mp4'), join(root, 'b.mp4')];
  await Promise.all(paths.map(path => writeFile(path, 'media')));
  await Promise.all(paths.map(path => history.record({ ...metadata, cookie: 'secret', url: 'https://private' } as typeof metadata, path)));
  const page = await new DownloadHistory(file).list(0, 1);
  expect(page.total).toBe(2); expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ ...metadata, outputPath: paths[1], directory: root, available: true });
  expect((await history.list(1, 1)).items[0].outputPath).toBe(paths[0]);
  expect((await history.get(page.items[0].id))?.outputPath).toBe(paths[1]);
  expect(await readFile(file, 'utf8')).not.toMatch(/secret|private|cookie|url/);
  expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
});
it('retains missing files in history but excludes missing, empty and non-file paths from duplicate checks', async () => {
  const { root, history } = await fixture(); const path = join(root, 'a.mp4');
  await writeFile(path, 'media'); await history.record(metadata, path);
  expect((await history.find(metadata.workId))?.outputPath).toBe(path);
  await rm(path);
  expect(await history.find(metadata.workId)).toBeUndefined();
  expect((await history.list()).items[0].available).toBe(false);
  await writeFile(path, ''); expect(await history.find(metadata.workId)).toBeUndefined();
  await expect(history.record(metadata, path)).rejects.toThrow();
  await rm(path); await mkdir(path); expect(await history.find(metadata.workId)).toBeUndefined();
  await expect(history.record(metadata, path)).rejects.toThrow();
});
it('recovers from malformed JSON and filters corrupt records without trusting extra fields', async () => {
  const { root, file } = await fixture(); await writeFile(file, '{bad');
  expect((await new DownloadHistory(file).list()).items).toEqual([]);
  const path = join(root, 'a.mp4'); await writeFile(path, 'media');
  const history = new DownloadHistory(file); await history.record(metadata, path);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  stored.items.push({ workId: '123', outputPath: '../escape.mp4' });
  stored.items[0].cookie = 'secret'; stored.items[0].directory = 'untrusted';
  await writeFile(file, JSON.stringify(stored));
  expect((await new DownloadHistory(file).list()).items).toHaveLength(1);
  expect((await new DownloadHistory(file).list()).items[0].directory).toBe(root);
});
it('caps old records and safely bounds pagination while allowing recording after a rejected attempt', async () => {
  const { root, file, history } = await fixture();
  await writeFile(file, JSON.stringify({ version: 1, items: Array.from({ length: 1001 }, (_, index) => ({
    ...metadata, id: randomUUID(), completedAt: '2026-01-01T00:00:00.000Z', outputPath: join(root, `${index}.mp4`),
  })) }));
  expect((await history.list(-10, 500)).items).toHaveLength(100);
  expect((await history.list()).total).toBe(1000);
  expect((await history.list(1000)).items).toEqual([]);
  await expect(history.record(metadata, join(root, 'missing.mp4'))).rejects.toThrow();
  const path = join(root, 'new.mp4'); await writeFile(path, 'media'); await history.record(metadata, path);
  expect((await history.list()).total).toBe(1000);
  expect((await history.list()).items[0].outputPath).toBe(path);
  await history.record(metadata, path);
  expect((await history.list()).total).toBe(1000);
});
