import { afterEach, expect, it, vi } from 'vitest';
import { createReadStream, type ReadStream } from 'node:fs';
import { link, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { DownloadOptions, DownloadResult } from '../../src/main/douyin/download';
import { saveDesktopDownload } from '../../src/main/desktop/save-download';

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, createReadStream: vi.fn(original.createReadStream) };
});
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, link: vi.fn(original.link) };
});

const folders: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.mocked(link).mockReset(); vi.mocked(createReadStream).mockReset(); await Promise.all(folders.splice(0).map(path => rm(path, { force: true, recursive: true }))); });
async function destination() { const path = await mkdtemp(join(tmpdir(), 'flat-download-test-')); folders.push(path); return path; }
function fakeDownload(data: string, status: DownloadResult['status'] = 'complete') {
  return vi.fn(async (options: DownloadOptions): Promise<DownloadResult> => {
    const directory = join(options.outputDirectory, 'douyin-fixture', '.media-fixture'); await mkdir(directory, { recursive: true });
    const path = join(directory, 'video.mp4'); await writeFile(path, data);
    const reportPath = join(options.outputDirectory, 'result.json'); await writeFile(reportPath, '{}');
    return { status, outputPath: status === 'complete' ? path : undefined, reportPath, tracks: [{ path } as DownloadResult['tracks'][number]], message: '完成' };
  });
}
it('publishes a visible finished file directly in the selected directory and cleans intermediates', async () => {
  const directory = await destination(); const download = fakeDownload('finished-video');
  const result = await saveDesktopDownload({ outputDirectory: directory }, new AbortController().signal, download);
  expect(dirname(result.outputPath!)).toBe(await realpath(directory));
  expect(await readdir(directory)).toEqual([result.outputPath!.split('/').pop()]);
  expect(result.outputPath!.split('/').pop()).not.toMatch(/^\./);
  expect(await readFile(result.outputPath!, 'utf8')).toBe('finished-video');
  expect(result.reportPath).toBeUndefined();
  await expect(readdir(download.mock.calls[0][0].outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('uses numbered names without overwriting existing files or simultaneous downloads', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-16T04:00:00Z'));
  const directory = await destination();
  const first = await saveDesktopDownload({ outputDirectory: directory }, new AbortController().signal, fakeDownload('original'));
  const results = await Promise.all(['second', 'third'].map(text => saveDesktopDownload({ outputDirectory: directory }, new AbortController().signal, fakeDownload(text))));
  expect(new Set([first.outputPath, ...results.map(item => item.outputPath)]).size).toBe(3);
  expect(await readFile(first.outputPath!, 'utf8')).toBe('original');
  expect(await readdir(directory)).toHaveLength(3);
});
it('also publishes a silent video directly, with a result that can be revealed', async () => {
  const directory = await destination();
  const result = await saveDesktopDownload({ outputDirectory: directory }, new AbortController().signal, fakeDownload('silent-video', 'tracks-only'));
  expect(result.status).toBe('tracks-only'); expect(dirname(result.outputPath!)).toBe(await realpath(directory));
  expect(await readFile(result.outputPath!, 'utf8')).toBe('silent-video');
});
it('cleans internal files on failure without exposing report paths or adding destination folders', async () => {
  const directory = await destination(); let temporary = '';
  const download = async (options: DownloadOptions): Promise<DownloadResult> => {
    temporary = options.outputDirectory; const reportPath = join(temporary, 'result.json'); await writeFile(reportPath, '{}');
    throw Object.assign(new Error('网络连接中断'), { reportPath });
  };
  const failure = await saveDesktopDownload({ outputDirectory: directory }, new AbortController().signal, download).catch(error => error);
  expect(failure.message).toBe('网络连接中断'); expect(failure.reportPath).toBeUndefined(); expect(await readdir(directory)).toEqual([]);
  await expect(readdir(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('does not publish when cancellation arrives before final saving', async () => {
  const directory = await destination(); const controller = new AbortController(); const download = fakeDownload('cancelled');
  await expect(saveDesktopDownload({ outputDirectory: directory }, controller.signal, async options => {
    const result = await download(options); controller.abort(); return result;
  })).rejects.toThrow();
  expect(await readdir(directory)).toEqual([]);
});

it('supports a volume without hard links, releasing staging before copying and preserving existing files', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-16T04:00:00Z'));
  const directory = await destination();
  const first = await saveDesktopDownload({ outputDirectory: directory }, new AbortController().signal, fakeDownload('original'));
  vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error('unsupported'), { code: 'EPERM' }));
  const blocked = new PassThrough(); const realRead = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(createReadStream).mockImplementationOnce(realRead.createReadStream).mockReturnValueOnce(blocked as unknown as ReadStream);
  const saved = saveDesktopDownload({ outputDirectory: directory }, new AbortController().signal, fakeDownload('second'));
  await expect.poll(() => vi.mocked(createReadStream).mock.calls.length).toBe(3);
  expect((await readdir(directory)).filter(name => name.startsWith('.'))).toEqual([]);
  blocked.end('second');
  const result = await saved;
  expect(result.outputPath).not.toBe(first.outputPath);
  expect(await readFile(first.outputPath!, 'utf8')).toBe('original');
  expect(await readFile(result.outputPath!, 'utf8')).toBe('second');
  expect(await readdir(directory)).toHaveLength(2);
});

it.each(['staging', 'fallback'])('cancels a pending %s copy and cleans only its own unfinished file', async stage => {
  const directory = await destination(); await writeFile(join(directory, '已有视频.mp4'), 'keep');
  const blocked = new PassThrough();
  if (stage === 'fallback') {
    const realRead = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(createReadStream).mockImplementationOnce(realRead.createReadStream);
    vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error('unsupported'), { code: 'EPERM' }));
  }
  vi.mocked(createReadStream).mockReturnValueOnce(blocked as unknown as ReadStream);
  const controller = new AbortController();
  const pending = saveDesktopDownload({ outputDirectory: directory }, controller.signal, fakeDownload('interrupted'));
  const outcome = pending.catch(error => error);
  await expect.poll(() => vi.mocked(createReadStream).mock.calls.length).toBe(stage === 'fallback' ? 2 : 1);
  blocked.write('partial'); controller.abort();
  expect(await outcome).toMatchObject({ name: 'AbortError' });
  expect(blocked.destroyed).toBe(true);
  expect(await readdir(directory)).toEqual(['已有视频.mp4']);
  expect(await readFile(join(directory, '已有视频.mp4'), 'utf8')).toBe('keep');
});
