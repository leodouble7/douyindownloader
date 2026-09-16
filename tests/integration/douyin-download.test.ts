import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createMediaFixtures, type MediaFixtures } from '../../lab/media';
import { downloadMedia } from '../../src/main/douyin/download';
import { probeMedia } from '../../src/main/media/ffmpeg-adapter';

let fixtures: MediaFixtures, directory: string, origin: string;
const server = createServer();
const hits: string[] = [];
beforeAll(async () => {
  fixtures = await createMediaFixtures(); directory = await mkdtemp(join(tmpdir(), 'douyin-download-'));
  const media = new Map(await Promise.all([
    ['/video', fixtures.videoOnly], ['/audio', fixtures.audioOnly], ['/muxed', fixtures.video]
  ].map(async ([url, path]) => [url, await readFile(path)] as const)));
  // A valid, large MP4 with a trailing free box; ffprobe still verifies the real streams.
  const padding = Buffer.alloc(8 * 1024 ** 2); padding.writeUInt32BE(padding.length, 0); padding.write('free', 4);
  media.set('/varying-range-cache', Buffer.concat([media.get('/muxed')!, padding]));
  server.on('request', (req, res) => {
    hits.push(req.url!);
    if (req.url === '/denied' || req.headers.referer !== 'https://www.douyin.com/') { res.writeHead(403); res.end('denied'); return; }
    const body = media.get(new URL(req.url!, 'http://localhost').pathname);
    if (!body) { res.writeHead(404); res.end(); return; }
    const start = Number(req.headers.range?.match(/bytes=(\d+)/)?.[1] ?? 0);
    const varyingCache = req.url === '/varying-range-cache';
    const end = Math.min(body.length - 1, Number(req.headers.range?.match(/-(\d+)$/)?.[1] ?? body.length - 1), varyingCache ? body.length - 1 : start + 32767);
    res.writeHead(206, { 'Content-Type': req.url!.startsWith('/audio') ? 'audio/mp4' : 'video/mp4', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${body.length}`, ETag: varyingCache && start > 0 ? '"other-range-cache"' : '"fixture-v1"' });
    res.end(body.subarray(start, end + 1));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fixtures?.cleanup(); await rm(directory, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;
const options = (name: string) => ({ outputDirectory: join(directory, name), referer: 'https://www.douyin.com/', networkPolicy: { labLoopback: [{ origin, address: '127.0.0.1' }] } });

it('downloads capped Range video/audio, preserves bytes and produces verified H264/AAC video', async () => {
  const result = await downloadMedia({ ...options('split'), videoUrl: `${origin}/video?sign=secret-sign`, audioUrl: `${origin}/audio` }, signal());
  expect(result.status).toBe('complete');
  expect(await readFile(result.tracks[0].path)).toEqual(await readFile(fixtures.videoOnly));
  expect(await readFile(result.tracks[1].path)).toEqual(await readFile(fixtures.audioOnly));
  const output = await probeMedia(result.outputPath!, signal());
  expect(output.streams.map(s => [s.kind, s.codec])).toEqual([['video', 'h264'], ['audio', 'aac']]);
  expect(output.durationSeconds).toBeCloseTo(6, 1);
  expect(await readFile(result.reportPath, 'utf8')).not.toContain('secret-sign');
});
it('recognizes an already muxed input and downloads audio independently', async () => {
  const result = await downloadMedia({ ...options('muxed'), videoUrl: `${origin}/muxed` }, signal());
  expect(await readFile(result.outputPath!)).toEqual(await readFile(fixtures.video));
  const audio = await downloadMedia({ ...options('audio'), audioUrl: `${origin}/audio` }, signal());
  expect(audio.probe!.streams.map(s => s.kind)).toEqual(['audio']);
});
it('keeps an already muxed video when a separate audio candidate was also selected', async () => {
  const result = await downloadMedia({ ...options('muxed-with-audio'), videoUrl: `${origin}/muxed`, audioUrl: `${origin}/audio` }, signal());
  expect(result.status).toBe('complete');
  expect(result.outputPath).toBe(result.tracks[0].path);
  expect(await readFile(result.outputPath!)).toEqual(await readFile(fixtures.video));
  expect(await readFile(result.tracks[1].path)).toEqual(await readFile(fixtures.audioOnly));
  expect(result.probe!.streams.map(s => s.kind).sort()).toEqual(['audio', 'video']);
});
it('downloads a large video in one continuous response when CDN validators differ by range', async () => {
  const result = await downloadMedia({ ...options('varying-cache'), videoUrl: `${origin}/varying-range-cache` }, signal());
  const saved = await readFile(result.outputPath!);
  const original = await readFile(fixtures.video);
  expect(result.status).toBe('complete');
  expect(saved.length).toBe(original.length + 8 * 1024 ** 2);
  expect(saved.subarray(0, original.length)).toEqual(original);
  expect(saved.subarray(original.length + 8).every(byte => byte === 0)).toBe(true);
  expect(result.probe!.streams.map(s => s.kind).sort()).toEqual(['audio', 'video']);
});
it('does not label a silent video-only input as a completed merged video', async () => {
  const result = await downloadMedia({ ...options('silent'), videoUrl: `${origin}/video` }, signal());
  expect(result.status).toBe('tracks-only');
  expect(result.outputPath).toBeUndefined();
  expect(result.tracks).toHaveLength(1);
});
it('rejects denied, oversized and cancelled downloads without publishing output', async () => {
  await expect(downloadMedia({ ...options('denied'), videoUrl: `${origin}/denied` }, signal())).rejects.toThrow();
  await expect(downloadMedia({ ...options('large'), videoUrl: `${origin}/video`, maxBytes: 100 }, signal())).rejects.toThrow();
  const controller = new AbortController(); controller.abort(); const count = hits.length;
  await expect(downloadMedia({ ...options('cancelled'), videoUrl: `${origin}/video` }, controller.signal)).rejects.toThrow();
  expect(hits.length).toBe(count);
  expect(await readdir(join(directory, 'denied'))).not.toContain('video.mp4');
});
it('writes a failure report retaining a successfully downloaded video when the audio is denied', async () => {
  let reportPath: string | undefined;
  try { await downloadMedia({ ...options('partial-failure'), videoUrl: `${origin}/video`, audioUrl: `${origin}/denied` }, signal()); }
  catch (error) { reportPath = (error as Error & { reportPath?: string }).reportPath; }
  expect(reportPath).toBeTypeOf('string');
  const report = JSON.parse(await readFile(reportPath!, 'utf8'));
  expect(report.status).toBe('failed');
  expect(report.tracks).toHaveLength(1);
  expect(await readFile(report.tracks[0].path)).toEqual(await readFile(fixtures.videoOnly));
  expect(report.outputPath).toBeUndefined();
});
