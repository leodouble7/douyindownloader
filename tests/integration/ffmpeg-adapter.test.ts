import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { renameSync, symlinkSync, writeFileSync, linkSync, unlinkSync, readdirSync } from 'node:fs';
import { chmod, copyFile, lstat, open, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, basename, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { createMediaFixtures, createWebmFixtureTracks, type MediaFixtures } from '../../lab/media';
import { createMediaAdapter, resolveMediaTools, type MediaToolEvent, type ToolPaths } from '../../src/main/media/ffmpeg-adapter';
import { runMediaProcess } from '../../src/main/media/media-process';

// Fault executables use a POSIX shebang; real media cases also run on Windows.
const posixIt = it.skipIf(process.platform === 'win32');
const executableName = (name: string) => `${name}${process.platform === 'win32' ? '.exe' : ''}`;
let fixtures: MediaFixtures;
let root: string;
let tools: ToolPaths;
let sequence = 0;
const signal = () => new AbortController().signal;
beforeAll(async () => { fixtures = await createMediaFixtures(); root = await realpath(await mkdtemp(join(tmpdir(), 'remux-tests-'))); tools = resolveMediaTools(); }, 30000);
afterAll(async () => { await fixtures?.cleanup(); if (root) await rm(root, { recursive: true, force: true }); });
async function directory() { const path = join(root, String(++sequence)); await mkdir(path); return path; }
async function script(source: string) { const path = join(await directory(), 'tool'); await writeFile(path, `#!${process.execPath}\n${source}`); await chmod(path, 0o700); return path; }
function withProbe(path: string): ToolPaths { return { ...tools, ffprobe: { path, provenance: 'system' } }; }

it('remuxes six-second fixture tracks with stream-copy parameters and commits one verified output', async () => {
  const events: MediaToolEvent[] = [];
  const adapter = createMediaAdapter({ tools, onEvent: event => events.push(event) });
  const video = await adapter.probeMedia(fixtures.videoOnly, signal());
  const audio = await adapter.probeMedia(fixtures.audioOnly, signal());
  const output = join(await directory(), 'result.mp4');
  const result = await adapter.remuxTracks(fixtures.videoOnly, fixtures.audioOnly, output, signal());
  expect(result.status).toBe('succeeded'); expect(result.outputPath).toBe(output);
  expect(result.probe.streams.map(s => s.kind)).toEqual(['video', 'audio']);
  expect(Math.abs(result.probe.durationSeconds - 6)).toBeLessThanOrEqual(0.1);
  for (const [index, original] of [video.streams[0], audio.streams[0]].entries()) {
    const { durationSeconds, ...parameters } = original;
    expect(result.probe.streams[index]).toMatchObject(parameters);
    expect(Math.abs(result.probe.streams[index].durationSeconds - durationSeconds)).toBeLessThanOrEqual(0.1);
  }
  expect(result.probe.streams.map(s => s.codec)).toEqual(['h264', 'aac']);
  expect(result.probe.streams.every(s => /^SHA256:[a-f0-9]{64}$/i.test(s.extradataHash))).toBe(true);
  const command = events.find(e => e.action === 'remux:command')!;
  const argumentsShown = command.inputSummary?.arguments as string[];
  expect(argumentsShown[argumentsShown.indexOf('-progress') + 1]).toBe('pipe:2');
  expect(argumentsShown.at(-1)).toBe('pipe:1');
  expect(command.inputSummary?.arguments).toEqual(expect.arrayContaining(['-map', '0:v:0', '1:a:0', '-c', 'copy', '-progress', 'pipe:1']));
  for (const forbidden of ['-c:v', '-c:a', 'libx264', 'libx265', 'aac', 'libvpx', 'libvpx-vp9', '-vcodec', '-acodec']) expect(command.inputSummary?.arguments).not.toContain(forbidden);
  expect(events.some(e => e.action === 'remux:progress')).toBe(true);
  expect(events.filter(e => e.action === 'remux:result' && e.status === 'succeeded')).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain(fixtures.root); expect(JSON.stringify(events)).not.toContain(root);
  expect(await readdir(join(output, '..'))).toEqual(['result.mp4']);
});
it('remuxes B-frame video with a common decode-delay offset and verifies the saved file again', async () => {
  const dir = await directory(), videoPath = join(dir, 'bframes.mp4');
  const encoded = spawnSync(tools.ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-t', '6', '-an', '-c:v', 'libx264', '-bf', '4', '-x264-params', 'b-adapt=0', '-movflags', '+faststart', videoPath]);
  expect(encoded.status, encoded.stderr.toString()).toBe(0);
  const adapter = createMediaAdapter({ tools });
  const input = await adapter.probeMedia(videoPath, signal());
  const result = await adapter.remuxTracks(videoPath, fixtures.audioOnly, join(dir, 'result.mp4'), signal());
  const reopened = await adapter.probeMedia(result.outputPath, signal());
  expect(reopened.streams.map(s => s.kind)).toEqual(['video', 'audio']);
  expect(reopened.streams[0].packetCount).toBe(input.streams[0].packetCount);
  expect(reopened.streams[0].extradataHash).toBe(input.streams[0].extradataHash);
  expect(reopened.durationSeconds).toBeCloseTo(6, 1);
});

it('refuses combined, wrong-order and incompatible-duration inputs before publication', async () => {
  const adapter = createMediaAdapter({ tools }); const output = join(await directory(), 'bad.mp4');
  for (const [v, a] of [[fixtures.video, fixtures.audioOnly], [fixtures.audioOnly, fixtures.videoOnly]]) {
    await expect(adapter.remuxTracks(v, a, output, signal())).rejects.toMatchObject({ outcome: 'inconclusive' });
  }
  expect(await readdir(join(output, '..'))).toEqual([]);
});

it('refuses symlinks and preserves colliding regular or symbolic destinations', async () => {
  const dir = await directory(); const input = join(dir, 'video.mp4'); await symlink(fixtures.videoOnly, input);
  const adapter = createMediaAdapter({ tools });
  await expect(adapter.probeMedia(input, signal())).rejects.toMatchObject({ outcome: 'inconclusive' });
  for (const symbolic of [false, true]) {
    const output = join(dir, symbolic ? 'symbol.mp4' : 'existing.mp4');
    if (symbolic) await symlink(fixtures.video, output); else await writeFile(output, 'unrelated');
    await expect(adapter.remuxTracks(fixtures.videoOnly, fixtures.audioOnly, output, signal())).rejects.toMatchObject({ outcome: 'inconclusive' });
    if (symbolic) expect((await lstat(output)).isSymbolicLink()).toBe(true); else expect(await readFile(output, 'utf8')).toBe('unrelated');
  }
  expect((await readdir(dir)).some(n => n.includes('.remux-'))).toBe(false);
});

describe.skipIf(process.platform === 'win32')('bounded untrusted tool execution', () => {
  it.each([
    ['malformed JSON', `process.stdout.write('{bad')`, 'invalid-media-json'],
    ['oversized JSON', `process.stdout.write('x'.repeat(1100000))`, 'tool-output-limit'],
    ['oversized diagnostics', `process.stderr.write('secret'.repeat(20000))`, 'tool-diagnostic-limit'],
    ['nonzero exit', `process.stderr.write('/private/secret/token'); process.exit(9)`, 'tool-exit-failed'],
    ['missing streams', `process.stdout.write(JSON.stringify({ streams: [], format: { format_name: 'mov,mp4', duration: '6' } }))`, 'unexpected-media-streams']
  ])('rejects %s without exposing raw diagnostics', async (_name, source, code) => {
    const events: MediaToolEvent[] = [];
    const adapter = createMediaAdapter({ tools: withProbe(await script(source)), onEvent: e => events.push(e) });
    await expect(adapter.probeMedia(fixtures.videoOnly, signal())).rejects.toMatchObject({ code, outcome: 'inconclusive' });
    expect(JSON.stringify(events)).not.toContain('/private/secret');
    expect(events.filter(e => e.action === 'probe:result')).toHaveLength(1);
  });
  it('times out and reaps a child that ignores SIGTERM', async () => {
    const pidPath = join(await directory(), 'pid');
    const tool = await script(`require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)`);
    const adapter = createMediaAdapter({ tools: withProbe(tool), timeoutMs: 2000, killGraceMs: 100 });
    await expect(adapter.probeMedia(fixtures.videoOnly, signal())).rejects.toMatchObject({ code: 'tool-timeout', outcome: 'inconclusive' });
    const pid = Number(await readFile(pidPath, 'utf8')); expect(() => process.kill(pid, 0)).toThrow();
  });
  it('cancels exactly once and reaps the child before resolving', async () => {
    const controller = new AbortController(); const events: MediaToolEvent[] = [];
    const pidPath = join(await directory(), 'pid');
    const tool = await script(`require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)`);
    const adapter = createMediaAdapter({ tools: withProbe(tool), killGraceMs: 100, onEvent: e => events.push(e) });
    const pending = expect(adapter.probeMedia(fixtures.videoOnly, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    for (let i = 0; i < 100; i++) { try { await readFile(pidPath); break; } catch { await new Promise(r => setTimeout(r, 10)); } }
    controller.abort(); await pending;
    expect(events.filter(e => e.status === 'cancelled')).toHaveLength(1);
    const pid = Number(await readFile(pidPath, 'utf8')); expect(() => process.kill(pid, 0)).toThrow();
  });
});

it('resolves packaged sidecars before installer and PATH, and fails closed in packaged mode', async () => {
  const resourcesPath = await directory(); const sidecars = join(resourcesPath, 'media-tools', `${process.platform}-${process.arch}`); await mkdir(sidecars, { recursive: true });
  const options = { resourcesPath, packaged: true, installerPaths: { ffmpeg: tools.ffmpeg.path, ffprobe: tools.ffprobe.path }, systemPath: '' };
  expect(() => resolveMediaTools(options)).toThrow();
  for (const name of ['ffmpeg', 'ffprobe'] as const) { const target = join(sidecars, executableName(name)); await copyFile(tools[name].path, target); await chmod(target, 0o700); }
  expect(resolveMediaTools(options).ffmpeg.provenance).toBe('packaged');
  expect(basename(resolveMediaTools(options).ffprobe.path)).toBe(executableName('ffprobe'));
  await rename(join(sidecars, executableName('ffprobe')), join(sidecars, 'actual')); await symlink(join(sidecars, 'actual'), join(sidecars, executableName('ffprobe')));
  expect(() => resolveMediaTools(options)).toThrow();
  expect(resolveMediaTools({ ...options, packaged: false }).ffprobe.provenance).toBe('installer');
});

function rawProbe(path: string) {
  return JSON.parse(spawnSync(tools.ffprobe.path, ['-v', 'error', '-count_packets', '-show_streams', '-show_format', '-show_data_hash', 'sha256', '-of', 'json', path], { encoding: 'utf8' }).stdout);
}
posixIt.each([
  ['nonfinite duration', (data: ReturnType<typeof rawProbe>) => { data.format.duration = 'Infinity'; }],
  ['unsafe duration', (data: ReturnType<typeof rawProbe>) => { data.format.duration = '9007199254740992'; }],
  ['zero time base', (data: ReturnType<typeof rawProbe>) => { data.streams[0].time_base = '1/0'; }],
  ['fractional dimension', (data: ReturnType<typeof rawProbe>) => { data.streams[0].width = 320.5; }],
  ['encryption side data', (data: ReturnType<typeof rawProbe>) => { data.streams[0].side_data_list = [{ side_data_type: 'Encryption information' }]; }],
  ['unexpected subtitle', (data: ReturnType<typeof rawProbe>) => { data.streams.push({ codec_type: 'subtitle' }); }]
])('rejects %s from ffprobe', async (_label, change) => {
  const data = rawProbe(fixtures.videoOnly); change(data);
  const probe = await script(`process.stdout.write(${JSON.stringify(JSON.stringify(data))})`);
  await expect(createMediaAdapter({ tools: withProbe(probe) }).probeMedia(fixtures.videoOnly, signal())).rejects.toMatchObject({ outcome: 'inconclusive' });
});
posixIt('rejects individually valid tracks whose durations do not match', async () => {
  const data = rawProbe(fixtures.audioOnly); data.format.duration = '3'; data.streams[0].duration = '3';
  const marker = join(await directory(), 'count'); const video = rawProbe(fixtures.videoOnly);
  const probe = await script(`const fs=require('node:fs'); const seen=fs.existsSync(${JSON.stringify(marker)}); fs.writeFileSync(${JSON.stringify(marker)}, '1'); process.stdout.write(JSON.stringify(seen ? ${JSON.stringify(data)} : ${JSON.stringify(video)}))`);
  const dir = await directory();
  await expect(createMediaAdapter({ tools: withProbe(probe) }).remuxTracks(fixtures.videoOnly, fixtures.audioOnly, join(dir, 'out.mp4'), signal())).rejects.toMatchObject({ code: 'incompatible-media-duration' });
  expect(await readdir(dir)).toEqual([]);
});
posixIt('fails final verification when a tool changes output codec parameters and removes private temp output', async () => {
  const marker = join(await directory(), 'count');
  const probe = await script(`const fs=require('node:fs'); const n=fs.existsSync(${JSON.stringify(marker)}) ? Number(fs.readFileSync(${JSON.stringify(marker)},'utf8')) : 0; fs.writeFileSync(${JSON.stringify(marker)},String(n+1)); const r=require('node:child_process').spawnSync(${JSON.stringify(tools.ffprobe.path)},process.argv.slice(2),{encoding:'utf8',input: process.argv.at(-1)==='pipe:0' ? fs.readFileSync(0) : undefined,stdio:['pipe','pipe','pipe', ...(process.argv.at(-1)==='pipe:0' ? [] : [3])]}); const data=JSON.parse(r.stdout); if(n===2)data.streams[0].width=640; process.stdout.write(JSON.stringify(data));`);
  const dir = await directory();
  await expect(createMediaAdapter({ tools: withProbe(probe) }).remuxTracks(fixtures.videoOnly, fixtures.audioOnly, join(dir, 'out.mp4'), signal())).rejects.toMatchObject({ code: 'remux-verification-failed' });
  expect(await readdir(dir)).toEqual([]);
});
it('detects an input substituted during execution despite descriptor pinning', async () => {
  const dir = await directory(); const input = join(dir, 'video.mp4'); await copyFile(fixtures.videoOnly, input);
  let replaced = false;
  const adapter = createMediaAdapter({ tools, onEvent: event => {
    if (!replaced && event.action === 'probe:command') { replaced = true; renameSync(input, join(dir, 'old.mp4')); symlinkSync(fixtures.videoOnly, input); }
  } });
  await expect(adapter.probeMedia(input, signal())).rejects.toMatchObject({ code: 'media-path-substituted' });
});
it('preserves a destination collision introduced while FFmpeg is running', async () => {
  const dir = await directory(); const output = join(dir, 'out.mp4');
  const adapter = createMediaAdapter({ tools, onEvent: event => { if (event.action === 'remux:command') writeFileSync(output, 'unrelated', { flag: 'wx' }); } });
  await expect(adapter.remuxTracks(fixtures.videoOnly, fixtures.audioOnly, output, signal())).rejects.toMatchObject({ code: 'media-output-exists' });
  expect(await readFile(output, 'utf8')).toBe('unrelated'); expect(await readdir(dir)).toEqual(['out.mp4']);
});
it('cancels during remux progress with one terminal cancellation and no partial output', async () => {
  const dir = await directory(); const controller = new AbortController(); const events: MediaToolEvent[] = [];
  const adapter = createMediaAdapter({ tools, onEvent: event => { events.push(event); if (event.action === 'remux:progress') controller.abort(); } });
  await expect(adapter.remuxTracks(fixtures.videoOnly, fixtures.audioOnly, join(dir, 'out.mp4'), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(events.filter(e => e.status === 'cancelled')).toHaveLength(1); expect(events.some(e => e.action === 'remux:result' && e.status === 'succeeded')).toBe(false);
  expect(await readdir(dir)).toEqual([]);
});
it('keeps committed success when a terminal observer cancels the run', async () => {
  const dir = await directory(); const controller = new AbortController();
  const adapter = createMediaAdapter({ tools, onEvent: e => { if (e.action === 'remux:result') controller.abort(); } });
  const result = await adapter.remuxTracks(fixtures.videoOnly, fixtures.audioOnly, join(dir, 'out.mp4'), controller.signal);
  expect(result.status).toBe('succeeded'); expect(await readdir(dir)).toEqual(['out.mp4']);
});
it('refuses nonexecutable installer candidates and chooses only verified absolute PATH tools in development', async () => {
  const dir = await directory(); const invalid = join(dir, 'invalid'); await writeFile(invalid, 'not executable');
  const bin = join(dir, executableName('ffmpeg')); await copyFile(tools.ffmpeg.path, bin); await chmod(bin, 0o700);
  const probe = join(dir, executableName('ffprobe')); await copyFile(tools.ffprobe.path, probe); await chmod(probe, 0o700);
  const resolved = resolveMediaTools({ installerPaths: { ffmpeg: invalid, ffprobe: dir }, systemPath: `.${delimiter}${dir}` });
  expect(resolved.ffmpeg).toEqual({ path: bin, provenance: 'system' }); expect(resolved.ffprobe.provenance).toBe('system');
});
posixIt('rejects an MP4 protection box even when ffprobe reports clear stream metadata', async () => {
  const dir = await directory(); const protectedPath = join(dir, 'encrypted.mp4');
  const bytes = await readFile(fixtures.videoOnly); const pssh = Buffer.alloc(32); pssh.writeUInt32BE(32); pssh.write('pssh', 4);
  await writeFile(protectedPath, Buffer.concat([bytes, pssh]));
  const probe = await script(`process.stdout.write(${JSON.stringify(JSON.stringify(rawProbe(fixtures.videoOnly)))})`);
  await expect(createMediaAdapter({ tools: withProbe(probe) }).probeMedia(protectedPath, signal())).rejects.toMatchObject({ code: 'encrypted-media-unsupported' });
});
posixIt('bounds unterminated FFmpeg progress and cleans output after process failure', async () => {
  const ffmpeg = await script(`process.stderr.write('frame='+ '9'.repeat(10000)); setInterval(()=>{},1000)`);
  const dir = await directory(); const adapter = createMediaAdapter({ tools: { ...tools, ffmpeg: { path: ffmpeg, provenance: 'system' } }, killGraceMs: 100 });
  await expect(adapter.remuxTracks(fixtures.videoOnly, fixtures.audioOnly, join(dir, 'out.mp4'), signal())).rejects.toMatchObject({ code: 'tool-output-limit' });
  expect(await readdir(dir)).toEqual([]);
});
posixIt('rejects WebM ContentEncryption metadata independently of ffprobe', async () => {
  const nested = (id: string, content: Buffer) => Buffer.concat([Buffer.from(id, 'hex'), Buffer.from([0x80 | content.length]), content]);
  const bytes = Buffer.concat([nested('1a45dfa3', Buffer.alloc(0)), nested('18538067', nested('1654ae6b', nested('ae', nested('6d80', nested('6240', nested('5035', Buffer.alloc(0)))))))]);
  const input = join(await directory(), 'encrypted.webm'); await writeFile(input, bytes);
  const data = rawProbe(fixtures.videoOnly); data.format.format_name = 'matroska,webm'; data.streams[0].codec_name = 'vp9'; delete data.streams[0].extradata_hash;
  const probe = await script(`process.stdout.write(${JSON.stringify(JSON.stringify(data))})`);
  await expect(createMediaAdapter({ tools: withProbe(probe) }).probeMedia(input, signal())).rejects.toMatchObject({ code: 'encrypted-media-unsupported' });
});
posixIt('bounds progress event amplification from an untrusted tool', async () => {
  const ffmpeg = await script(`process.stderr.write('progress=continue\\n'.repeat(2000))`);
  const dir = await directory(); const events: MediaToolEvent[] = [];
  const adapter = createMediaAdapter({ tools: { ...tools, ffmpeg: { path: ffmpeg, provenance: 'system' } }, onEvent: e => events.push(e) });
  await expect(adapter.remuxTracks(fixtures.videoOnly, fixtures.audioOnly, join(dir, 'out.mp4'), signal())).rejects.toMatchObject({ code: 'tool-output-limit' });
  expect(events.filter(e => e.action === 'remux:progress').length).toBeLessThanOrEqual(1024); expect(await readdir(dir)).toEqual([]);
});

it('gives FFmpeg only a stdout output pipe and preserves a victim substituted at the private temp leaf', async () => {
  const dir = await directory(); const victim = join(dir, 'victim'); await writeFile(victim, 'untouched'); let temporary = ''; let args: unknown;
  const adapter = createMediaAdapter({ tools, onEvent: e => {
    if (e.action === 'remux:command') {
      args = e.inputSummary?.arguments;
      temporary = join(dir, readdirSync(dir).find(name => name.startsWith('.remux-'))!);
      unlinkSync(temporary); linkSync(victim, temporary);
    }
  } });
  await expect(adapter.remuxTracks(fixtures.videoOnly, fixtures.audioOnly, join(dir, 'out.mp4'), signal())).rejects.toMatchObject({ outcome: 'inconclusive' });
  expect((args as string[]).at(-1)).toBe('pipe:1');
  expect(await readFile(victim, 'utf8')).toBe('untouched'); expect(await readFile(temporary, 'utf8')).toBe('untouched');
  expect((await lstat(temporary)).ino).toBe((await lstat(victim)).ino); expect(await readdir(dir)).not.toContain('out.mp4');
});
posixIt('reports a post-commit durability failure as inconclusive and keeps the published verified artifact', async () => {
  const dir = await directory(); const output = join(dir, 'out.mp4'); const directoryHandle = await open(dir, 'r');
  const prototype = Object.getPrototypeOf(directoryHandle) as { sync(): Promise<void>; stat(): Promise<import('node:fs').Stats> };
  const original = prototype.sync; const controller = new AbortController(); const events: MediaToolEvent[] = [];
  const mock = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: typeof prototype) {
    if ((await this.stat()).isDirectory()) { controller.abort(); throw new Error('injected durability failure'); }
    await original.call(this);
  });
  try {
    const adapter = createMediaAdapter({ tools, onEvent: e => events.push(e) });
    await expect(adapter.remuxTracks(fixtures.videoOnly, fixtures.audioOnly, output, controller.signal)).rejects.toMatchObject({ code: 'media-io-failed', outcome: 'inconclusive' });
    expect(events.filter(e => e.action === 'remux:result')).toMatchObject([{ status: 'failed', evidence: { committed: true, outcome: 'inconclusive' } }]);
    expect(await readdir(dir)).toEqual(['out.mp4']); expect((await createMediaAdapter({ tools }).probeMedia(output, signal())).streams).toHaveLength(2);
  } finally { mock.mockRestore(); await directoryHandle.close(); }
});

it('copies clear WebM VP9/Opus tracks while preserving their parameters and six-second duration', async () => {
  const tracks = await createWebmFixtureTracks(fixtures);
  const adapter = createMediaAdapter({ tools });
  const video = await adapter.probeMedia(tracks.videoOnly, signal()); const audio = await adapter.probeMedia(tracks.audioOnly, signal());
  const result = await adapter.remuxTracks(tracks.videoOnly, tracks.audioOnly, join(await directory(), 'out.webm'), signal());
  expect(result.probe.container).toBe('webm'); expect(result.probe.streams.map(s => s.codec)).toEqual(['vp9', 'opus']);
  for (const [index, original] of [video.streams[0], audio.streams[0]].entries()) {
    const { durationSeconds, ...parameters } = original;
    expect(result.probe.streams[index]).toMatchObject(parameters);
    expect(Math.abs(result.probe.streams[index].durationSeconds - durationSeconds)).toBeLessThanOrEqual(0.1);
  }
  expect(Math.abs(result.probe.durationSeconds - 6)).toBeLessThanOrEqual(0.1);
}, 15000);

posixIt.each(['timeout', 'cancel'] as const)('cleans a remux descendant tree on %s and emits one terminal result', async action => {
  const dir = await directory(); const pidFile = join(await directory(), 'descendant');
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); process.on('SIGTERM',()=>{}); process.send('ready'); setInterval(()=>{},1000)`;
  const executable = await script(`const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2,'ipc']}); child.on('message',()=>process.exit(0));`);
  const controller = new AbortController(); const events: MediaToolEvent[] = [];
  const adapter = createMediaAdapter({ tools: { ...tools, ffmpeg: { path: executable, provenance: 'system' } }, timeoutMs: 2000, killGraceMs: 100, onEvent: e => events.push(e) });
  const pending = adapter.remuxTracks(fixtures.videoOnly, fixtures.audioOnly, join(dir, 'out.mp4'), controller.signal).then(() => 'succeeded', error => error.code);
  let pid = 0;
  try {
    for (let i = 0; i < 200; i++) { try { pid = Number(await readFile(pidFile, 'utf8')); break; } catch { await new Promise(r => setTimeout(r, 10)); } }
    expect(pid).toBeGreaterThan(0); if (action === 'cancel') controller.abort();
    expect(await Promise.race([pending, new Promise(r => setTimeout(() => r('unbounded'), 4000))])).toBe(action === 'cancel' ? 'cancelled' : 'tool-timeout');
    expect(() => process.kill(pid, 0)).toThrow(); expect(await readdir(dir)).toEqual([]);
    expect(events.filter(e => e.action === 'remux:result')).toHaveLength(1);
    expect(events.filter(e => e.status === 'cancelled')).toHaveLength(action === 'cancel' ? 1 : 0);
  } finally { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* Reaped normally. */ } } }
}, 10000);

it('probes a completed fragmented file from its owned input handle over stdin', async () => {
  const handle = await open(fixtures.videoOnly, 'r');
  try {
    const json = await runMediaProcess({ executable: tools.ffprobe.path, args: ['-v', 'error', '-count_packets', '-show_streams', '-show_format', '-of', 'json', 'pipe:0'], mode: 'probe', input: { handle, size: (await handle.stat()).size }, signal: signal(), timeoutMs: 5000, killGraceMs: 100 });
    const result = JSON.parse(json); expect(result.streams[0].codec_name).toBe('h264'); expect(Number(result.streams[0].duration)).toBeCloseTo(6, 1); expect(Number(result.streams[0].nb_read_packets)).toBe(180);
  } finally { await handle.close(); }
});
