import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { createMediaFixtures } from '../../lab/media';

it('captures and downloads paired media inside Electron while preserving the host window and cleaning cancelled capture', async () => {
  await mkdir('out', { recursive: true }); const runnerDirectory = await mkdtemp(resolve('out/desktop-backend-'));
  const directory = await mkdtemp(join(tmpdir(), 'desktop-backend-')); const fixtures = await createMediaFixtures();
  const video = await readFile(fixtures.videoOnly); const audio = await readFile(fixtures.audioOnly);
  const server = createServer((request, response) => {
    if (request.url === '/hang') { response.setHeader('Content-Type', 'text/html'); response.end('<script>setTimeout(() => { while (true) {} }, 500)</script>'); return; }
    if (request.url === '/watch') { response.setHeader('Content-Type', 'text/html'); response.end(`<video id="player" width="640" height="360"></video><script>const ms = new MediaSource(); player.src = URL.createObjectURL(ms); ms.addEventListener('sourceopen', async () => { const vb = ms.addSourceBuffer('video/mp4; codecs="avc1.42c01e"'); const ab = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"'); const load = async () => { vb.appendBuffer(await (await fetch('/video-avc1?media_id=fixture')).arrayBuffer()); ab.appendBuffer(await (await fetch('/audio-mp4a?media_id=fixture')).arrayBuffer()); }; if (player.paused) player.addEventListener('play', load, { once: true }); else load(); });</script>`); return; }
    const body = request.url!.startsWith('/audio') ? audio : video; const start = Number(request.headers.range?.match(/bytes=(\d+)/)?.[1] ?? 0); const end = Math.min(body.length - 1, Number(request.headers.range?.match(/-(\d+)$/)?.[1] ?? body.length - 1));
    response.writeHead(request.headers.range ? 206 : 200, { 'Content-Type': body === audio ? 'audio/mp4' : 'video/mp4', 'Content-Length': end - start + 1, ...(request.headers.range ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}), ETag: '"desktop-fixture"' }); response.end(body.subarray(start, end + 1));
  });
  try {
    await new Promise<void>((r, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', r); }); const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const runner = join(runnerDirectory, 'runner.cjs'); const output = join(directory, 'result.json');
    await build({ entryPoints: ['tests/helpers/desktop-backend-runner.ts'], outfile: runner, platform: 'node', format: 'cjs', bundle: true, external: ['electron', 'better-sqlite3'], define: { 'import.meta.url': 'importMetaUrl' }, banner: { js: 'const importMetaUrl = require("node:url").pathToFileURL(__filename).href;' }, logLevel: 'silent' });
    await copyFile('src/main/download/output-names.cjs', join(runnerDirectory, 'output-names.cjs'));
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_PATH: resolve('node_modules') }; delete env.ELECTRON_RUN_AS_NODE;
    await promisify(execFile)(createRequire(import.meta.url)('electron') as string, [runner, origin, directory, output, resolve('src/main/download/output-worker.cjs')], { env, timeout: 30000 });
    const result = JSON.parse(await readFile(output, 'utf8')); expect(result.error).toBeUndefined(); expect(result).toMatchObject({ hostSurvivedCapture: true, hostSurvivedCancellation: true, cancellation: 'AbortError', summaryReadStarted: true, hungCancellation: 'AbortError', hostSurvivedHungCancellation: true, result: { status: 'complete' } });
    expect(result.hungCancellationMs).toBeLessThan(2000);
    expect(result).toMatchObject({ captureWindowHidden: true, captureAudioMuted: true });
    expect(result.result.probe.streams.map((s: { kind: string }) => s.kind)).toEqual(['video', 'audio']);
    expect(dirname(result.result.outputPath)).toBe(await realpath(directory));
    expect(basename(result.result.outputPath)).toMatch(/^视频_.*\.mp4$/);
    expect((await readdir(directory)).sort()).toEqual(['result.json', basename(result.result.outputPath)].sort());
    expect(result.result.reportPath).toBeUndefined();
    const ffprobe = createRequire(import.meta.url)('@ffprobe-installer/ffprobe') as { path: string };
    const { stdout } = await promisify(execFile)(ffprobe.path, ['-v', 'error', '-show_streams', '-of', 'json', result.result.outputPath]);
    expect(JSON.parse(stdout).streams.map((stream: { codec_type: string }) => stream.codec_type)).toEqual(['video', 'audio']);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await fixtures.cleanup(); await rm(directory, { force: true, recursive: true }); await rm(runnerDirectory, { force: true, recursive: true }); }
}, 40000);
