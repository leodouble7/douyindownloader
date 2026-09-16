import { beforeAll, afterAll, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { capturePage } from '../../src/main/douyin/capture-page';
import { downloadMedia } from '../../src/main/douyin/download';
import { selectMedia } from '../../src/main/douyin/options';
import { createMediaFixtures, type MediaFixtures } from '../../lab/media';

let fixtures: MediaFixtures, origin: string, directory: string;
const server = createServer();
beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build-douyin.cjs'], { cwd: resolve('.') });
  fixtures = await createMediaFixtures(); directory = await mkdtemp(join(tmpdir(), 'douyin-capture-'));
  const video = await readFile(fixtures.videoOnly), audio = await readFile(fixtures.audioOnly);
  server.on('request', (req, res) => {
    if (req.url === '/watch') {
      res.setHeader('content-type', 'text/html');
      res.end(`<video id="player" autoplay muted></video><script>
        const ms = new MediaSource(); player.src = URL.createObjectURL(ms);
        ms.addEventListener('sourceopen', async () => {
          const vb = ms.addSourceBuffer('video/mp4; codecs="avc1.42c01e"');
          const ab = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
          const v = await fetch('/media-video-avc1/?media_id=one&sign=fixture-sign');
          vb.appendBuffer(await v.arrayBuffer());
          const a = await fetch('/media-audio-mp4a/?media_id=one');
          ab.appendBuffer(await a.arrayBuffer());
        });</script>`); return;
    }
    const isAudio = req.url?.startsWith('/media-audio'), body = isAudio ? audio : video;
    const start = Number(req.headers.range?.match(/bytes=(\d+)/)?.[1] ?? 0);
    const end = Math.min(body.length - 1, Number(req.headers.range?.match(/-(\d+)$/)?.[1] ?? body.length - 1));
    res.writeHead(req.headers.range ? 206 : 200, { 'Content-Type': isAudio ? 'audio/mp4' : 'video/mp4', 'Content-Length': end - start + 1,
      ...(req.headers.range ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}), ETag: '"fixture"' });
    res.end(body.subarray(start, end + 1));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fixtures?.cleanup(); await rm(directory, { recursive: true, force: true }); });
it('captures actual MSE requests in Electron and downloads them through the Node pipeline', async () => {
  const controller = new AbortController();
  const captured = await capturePage({ pageUrl: `${origin}/watch`, observeSeconds: 3, show: false }, controller.signal);
  expect(captured.summary.mse).toBeGreaterThan(0);
  const tracks = selectMedia(captured.assets);
  expect(tracks.map(t => t.kind)).toEqual(['video', 'audio']);
  expect(captured.requests.some(r => r.url.includes('fixture-sign'))).toBe(true);
  const result = await downloadMedia({ outputDirectory: directory, captured: { runId: captured.runId, tracks, requests: captured.requests }, networkPolicy: { labLoopback: [{ origin, address: '127.0.0.1' }] } }, controller.signal);
  expect(result.status).toBe('complete');
  expect(result.probe!.streams.map(s => s.codec)).toEqual(['h264', 'aac']);
}, 25000);
