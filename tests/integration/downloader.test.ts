import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startLabServer, type LabServer } from '../../lab/server';
import { LAB_SECRET } from '../../lab/scenarios';
import { signMediaRequest } from '../../src/main/security/signature';
import { createSanitizedCapturedUrl } from '../../src/main/security/redact';
import { EventRepository } from '../../src/main/runs/event-repository';
import { RunOrchestrator } from '../../src/main/runs/run-orchestrator';
import { createSourceRequestReference, type MediaTrack, type RunMode } from '../../src/shared/contracts';
import { planProbes } from '../../src/main/probes/probe-planner';
import { HttpTransport } from '../../src/main/probes/http-transport';
import { OutputWorkspace } from '../../src/main/download/output-workspace';
import { Downloader } from '../../src/main/download/downloader';
let lab: LabServer;
const cleanups: (() => void | Promise<void>)[] = [];
beforeAll(async () => { lab = await startLabServer(); });
afterAll(async () => { await lab?.close(); });
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(url: string, options: { mode?: RunMode; authorized?: boolean; headers?: Record<string, string>; maxBytes?: number; maxChunkBytes?: number; timeoutMs?: number; track?: Partial<MediaTrack> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'download-test-'));
  const repository = new EventRepository(':memory:');
  const context = new RunOrchestrator(repository);
  const input = { targetUrl: url, outputDirectory: directory, mode: options.mode ?? 'full-download', maxConcurrency: 99, authorizationConfirmed: options.authorized ?? true };
  const runId = context.start(input);
  const identity = { runId, targetId: 'page', sessionId: 'session', frameId: 'frame', requestId: 'request', version: 1 };
  const sourceRequestId = createSourceRequestReference(identity);
  context.rememberRequest(runId, { id: sourceRequestId, sourceIdentity: identity, url, method: 'GET', requestHeaders: options.headers });
  const track: MediaTrack = { id: 'video', assetId: 'asset', kind: 'video', sourceRequestIds: [sourceRequestId], sanitizedUrl: createSanitizedCapturedUrl(url), detectionReasons: [], eligible: true, ...options.track };
  const transport = new HttpTransport({ context, runId, track, timeoutMs: options.timeoutMs ?? 1000, networkPolicy: { labLoopback: [{ origin: new URL(url).origin, address: '127.0.0.1' }] } });
  const downloader = new Downloader({ context, runId, transport, maxBytes: options.maxBytes, maxChunkBytes: options.maxChunkBytes, retryDelayMs: 1 });
  cleanups.push(async () => { context.dispose(); repository.close(); await rm(directory, { recursive: true, force: true }); });
  const probe = () => transport.execute(planProbes(track, input.mode)[0], new AbortController().signal);
  const download = (signal = new AbortController().signal, extra = {}) => downloader.download({ sourceRequestId, filename: '../../video.mp4', ...extra }, signal);
  return { directory, repository, context, runId, sourceRequestId, transport, downloader, download, probe, input, track };
}
async function server(handler: RequestListener) {
  const instance = createServer(handler);
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { instance.closeAllConnections(); await new Promise<void>(resolve => instance.close(() => resolve())); });
  return `http://127.0.0.1:${(instance.address() as AddressInfo).port}/video`;
}
const body = Buffer.concat([Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex'), Buffer.alloc(10000, 7)]);
function respond(req: Parameters<RequestListener>[0], res: Parameters<RequestListener>[1], cap = body.length, etag = '"v1"') {
  const start = Number(req.headers.range?.match(/bytes=(\d+)/)?.[1] ?? 0);
  const requestedEnd = Number(req.headers.range?.match(/-(\d+)$/)?.[1] ?? body.length - 1);
  const end = Math.min(body.length - 1, start + cap - 1, requestedEnd);
  res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1, ETag: etag });
  res.end(body.subarray(start, end + 1));
}
it.each(['open-range', 'range-capped', 'signed-url', 'session-bound'])('completes real lab %s with verified hash and clean events', async scenario => {
  const expires = Math.floor(Date.now() / 1000) + 60;
  const sig = signMediaRequest({ mediaId: 'video.mp4', expires, sessionId: scenario === 'session-bound' ? 'lab-session' : undefined }, LAB_SECRET);
  const state = await setup(`${lab.baseUrl}/${scenario}/video.mp4?expires=${expires}&sig=${sig}${scenario === 'session-bound' ? '&sessionId=lab-session' : ''}`, { headers: { Cookie: 'lab_session=lab-session', Authorization: 'Bearer secret-marker' } });
  expect((await state.probe()).outcome).toBe('accessible');
  const artifact = await state.download();
  const bytes = await readFile(artifact.path);
  expect(bytes.length).toBe(artifact.byteLength);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
  expect(artifact.path.startsWith(`${await realpath(state.directory)}/`)).toBe(true);
  expect(artifact.path).not.toContain('.part');
  const events = state.repository.list(state.runId).filter(e => e.phase === 'download');
  expect(events.slice(0, 2).map(e => e.action)).toEqual(['download:queued', 'download:before']);
  expect(events.at(-1)?.status).toBe('succeeded');
  expect(events.at(-1)?.evidence).toMatchObject({ sha256: artifact.sha256, totalBytes: artifact.byteLength });
  expect(events[0].inputSummary).toMatchObject({ maxConcurrency: 4, activeWorkers: 1 });
  expect(JSON.stringify(events)).not.toMatch(new RegExp(`secret-marker|${sig}|lab_session=lab-session`));
// The 1 KiB capped scenario durably flushes every interval; allow parallel-suite disk contention.
}, 15_000);
it('uses a single full interval for an uncapped server and exact actual endpoints for caps', async () => {
  for (const cap of [body.length, 1024]) {
    const ranges: string[] = [];
    const url = await server((req, res) => { ranges.push(req.headers.range!); respond(req, res, cap); });
    const state = await setup(url); await state.probe(); ranges.length = 0;
    const artifact = await state.download();
    expect(await readFile(artifact.path)).toEqual(body);
    expect(ranges[0]).toBe(`bytes=0-${body.length - 1}`);
    if (cap === body.length) expect(ranges).toHaveLength(1);
    else expect(ranges[1]).toBe(`bytes=1024-${body.length - 1}`);
  }
});
it('independently rejects mode, authorization, missing evidence, exact-source mismatch, and ineligible tracks before retrieval', async () => {
  let calls = 0;
  const url = await server((req, res) => { calls++; respond(req, res); });
  for (const options of [{ mode: 'standard' as const }, { authorized: false }, { track: { encrypted: true } }, { track: { incomplete: true } }]) {
    const state = await setup(url, options);
    if (!options.track) await state.probe();
    const previous = calls;
    state.input.mode = 'full-download'; state.input.authorizationConfirmed = true;
    await expect(state.download()).rejects.toMatchObject({ outcome: 'inconclusive' });
    expect(calls).toBe(previous);
  }
  const state = await setup(url);
  await expect(state.download()).rejects.toMatchObject({ outcome: 'inconclusive' });
  await state.probe();
  await expect(state.download(undefined, { sourceRequestId: state.sourceRequestId.replace('request', 'other') })).rejects.toMatchObject({ outcome: 'inconclusive' });
});
it('rejects the real stale-validator representation after its bounded evidence', async () => {
  const isolated = await startLabServer(); cleanups.push(() => isolated.close());
  const state = await setup(`${isolated.baseUrl}/stale-validator/video.mp4`);
  await state.probe();
  await expect(state.download()).rejects.toMatchObject({ outcome: 'inconclusive', code: 'stale' });
});
it.each(['gap', 'overlap', 'wrong-total', 'oversized', 'ignored', 'short-body', 'changed-etag'])('rejects %s without publishing a final artifact', async fault => {
  let count = 0;
  const url = await server((req, res) => {
    count++;
    if (count <= 2) { respond(req, res, 1024); return; }
    if (fault === 'changed-etag') { respond(req, res, 1024, '"v2"'); return; }
    if (fault === 'ignored') { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length, ETag: '"v1"' }); res.end(body); return; }
    const start = fault === 'gap' ? 1025 : fault === 'overlap' ? 1023 : 1024;
    const end = fault === 'oversized' ? body.length : 2047;
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${fault === 'wrong-total' ? body.length + 1 : body.length}`, ETag: '"v1"' });
    res.end(body.subarray(start, fault === 'short-body' ? 1200 : end + 1));
  });
  const state = await setup(url); await state.probe();
  await expect(state.download()).rejects.toMatchObject({ outcome: 'inconclusive' });
  const events = state.repository.list(state.runId).filter(e => e.phase === 'download');
  expect(events.at(-1)?.action).toBe('download:failed');
  expect(JSON.stringify(events)).not.toContain('"status":"succeeded"');
  const folders = await readdir(state.directory);
  for (const folder of folders) expect((await readdir(join(state.directory, folder))).some(name => name.endsWith('.mp4'))).toBe(false);
});
it('keeps denial distinct from transport failure after prior successful access', async () => {
  let count = 0;
  const url = await server((req, res) => { if (++count === 1) respond(req, res); else { res.writeHead(403); res.end('denied token=secret-marker'); } });
  const state = await setup(url); await state.probe();
  await expect(state.download()).rejects.toMatchObject({ outcome: 'denied' });
  expect(state.repository.list(state.runId).at(-1)?.status).toBe('denied');
});
it('enforces byte limits before a full request', async () => {
  let calls = 0;
  const url = await server((req, res) => { calls++; respond(req, res); });
  const state = await setup(url, { maxBytes: 100 }); await state.probe();
  await expect(state.download()).rejects.toMatchObject({ code: 'limit' });
  expect(calls).toBe(1);
});
it('cancels after a complete interval and resumes from the continuous prefix with no secret manifest', async () => {
  const ranges: string[] = [];
  const url = await server((req, res) => { ranges.push(req.headers.range!); respond(req, res, 1024, '"secret-marker"'); });
  const state = await setup(`${url}?token=secret-marker`, { headers: { Cookie: 'session=secret-marker', Authorization: 'Bearer secret-marker' } });
  await state.probe();
  const controller = new AbortController();
  const originalEmit = state.context.emit.bind(state.context);
  state.context.emit = input => { const event = originalEmit(input); if (input.action === 'download:progress') controller.abort(); return event; };
  let resumeId = '';
  try { await state.download(controller.signal); } catch (error) { resumeId = (error as { resumeId: string }).resumeId; }
  expect(resumeId).toMatch(/^[a-f0-9-]{36}$/);
  const folder = join(state.directory, `.download-${resumeId}`);
  const manifest = JSON.stringify(await readResume(folder));
  expect(manifest).not.toContain('secret-marker');
  expect(JSON.parse(manifest)).toMatchObject({ completed: [{ start: 0, end: 1023 }], state: 'partial' });
  state.context.emit = originalEmit;
  ranges.length = 0;
  const artifact = await state.download(undefined, { resumeId });
  expect(ranges[0]).toBe(`bytes=1024-${body.length - 1}`);
  expect(await readFile(artifact.path)).toEqual(body);
  expect((await stat(artifact.path)).size).toBe(body.length);
});
it('requires fresh capture after restart and refuses symlink partials', async () => {
  const url = await server((req, res) => respond(req, res, 1024));
  const state = await setup(url); await state.probe();
  const controller = new AbortController();
  const emit = state.context.emit.bind(state.context);
  state.context.emit = input => { const event = emit(input); if (input.action === 'download:progress') controller.abort(); return event; };
  let resumeId = '';
  try { await state.download(controller.signal); } catch (error) { resumeId = (error as { resumeId: string }).resumeId; }
  state.context.emit = emit;
  const partial = join(state.directory, `.download-${resumeId}`, 'track.part');
  await rm(partial); const unrelated = join(state.directory, 'unrelated'); await writeFile(unrelated, 'keep'); await symlink(unrelated, partial);
  await expect(state.download(undefined, { resumeId })).rejects.toMatchObject({ outcome: 'inconclusive' });
  expect(await readFile(unrelated, 'utf8')).toBe('keep');
  state.context.complete(state.runId);
  await expect(state.download(undefined, { resumeId })).rejects.toMatchObject({ code: 'fresh-capture-required' });
});

it('bounds simultaneous full-download jobs within an active run', async () => {
  let active = 0, maximum = 0, calls = 0;
  const url = await server((req, res) => {
    calls++; active++; maximum = Math.max(maximum, active);
    res.on('close', () => { active--; });
    if (calls === 1) respond(req, res);
    else setTimeout(() => respond(req, res), 40);
  });
  const state = await setup(url); await state.probe();
  const artifacts = await Promise.all(Array.from({ length: 7 }, () => state.download()));
  expect(artifacts).toHaveLength(7);
  expect(maximum).toBeLessThanOrEqual(4);
});
it('cancels a run during a hanging response and stores exactly one terminal event before context release', async () => {
  let requested!: () => void; const ready = new Promise<void>(resolve => { requested = resolve; }); let calls = 0;
  const url = await server((req, res) => { if (++calls === 1) respond(req, res); else requested(); });
  const state = await setup(url); await state.probe();
  const pending = state.download();
  await ready; state.context.cancel(state.runId);
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  const terminal = state.repository.list(state.runId).filter(e => e.phase === 'download' && ['download:after', 'download:failed', 'download:cancelled'].includes(e.action));
  expect(terminal.map(e => e.action)).toEqual(['download:cancelled']);
});
it('retries transient failure without combining uncommitted bytes or exceeding the retry budget', async () => {
  let calls = 0;
  const url = await server((req, res) => { calls++; if (calls === 2) { res.destroy(); } else respond(req, res); });
  const state = await setup(url); await state.probe();
  expect(await readFile((await state.download()).path)).toEqual(body);
  expect(calls).toBe(3);
  let failures = 0;
  const failing = await server((req, res) => { if (++failures === 1) respond(req, res); else res.destroy(); });
  const denied = await setup(failing); await denied.probe();
  await expect(denied.download()).rejects.toMatchObject({ outcome: 'inconclusive' });
  expect(failures).toBe(4);
});
it('refuses to concatenate capped responses without a usable representation validator', async () => {
  let calls = 0;
  const url = await server((req, res) => {
    calls++; const start = Number(req.headers.range?.match(/bytes=(\d+)/)?.[1] ?? 0);
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${start + 1023}/${body.length}` }); res.end(body.subarray(start, start + 1024));
  });
  const state = await setup(url); await state.probe();
  await expect(state.download()).rejects.toMatchObject({ code: 'validator-required' });
  expect(calls).toBe(2);
});
it('blocks a redirect introduced after bounded evidence without contacting the new resource', async () => {
  let unexpected = 0;
  const target = await server((_req, res) => { unexpected++; res.end('secret'); });
  let calls = 0;
  const origin = await server((req, res) => { if (++calls === 1) respond(req, res); else { res.writeHead(302, { Location: `${target}?token=secret-marker` }); res.end(); } });
  const state = await setup(origin); await state.probe();
  await expect(state.download()).rejects.toMatchObject({ outcome: 'inconclusive' });
  expect(unexpected).toBe(0);
  expect(JSON.stringify(state.repository.list(state.runId))).not.toContain('secret-marker');
});
it('does not publish a substituted partial-file symlink or overwrite an unrelated final filename', async () => {
  for (const attack of ['partial-symlink', 'existing-final']) {
    const url = await server((req, res) => respond(req, res));
    const state = await setup(url); await state.probe();
    const unrelated = join(state.directory, 'unrelated'); await writeFile(unrelated, 'keep');
    let tampered = false;
    const emit = state.context.emit.bind(state.context);
    // Use the real local filesystem at the validated interval boundary.
    const { unlinkSync, symlinkSync, writeFileSync } = await import('node:fs');
    state.context.emit = input => {
      const event = emit(input);
      if (!tampered && input.action === 'download:progress') {
        tampered = true;
        const directory = join(state.directory, `.download-${input.relatedIds![0]}`);
        if (attack === 'partial-symlink') { unlinkSync(join(directory, 'track.part')); symlinkSync(unrelated, join(directory, 'track.part')); }
        else writeFileSync(join(directory, 'video.mp4'), 'existing');
      }
      return event;
    };
    await expect(state.download(undefined, { filename: 'video.mp4' })).rejects.toMatchObject({ outcome: 'inconclusive' });
    expect(await readFile(unrelated, 'utf8')).toBe('keep');
    if (attack === 'existing-final') {
      const directory = (await readdir(state.directory)).find(name => name.startsWith('.download-'))!;
      expect(await readFile(join(state.directory, directory, 'video.mp4'), 'utf8')).toBe('existing');
    }
  }
});
it('does not transfer evidence between full source references whose sanitized URLs collide', async () => {
  let requests = 0;
  const url = await server((req, res) => { requests++; respond(req, res); });
  const state = await setup(`${url}?token=first-secret`);
  const identity = { runId: state.runId, targetId: 'page', sessionId: 'session', frameId: 'frame', requestId: 'request', version: 2 };
  const second = createSourceRequestReference(identity);
  state.context.rememberRequest(state.runId, { id: second, sourceIdentity: identity, url: `${url}?token=second-secret`, method: 'GET' });
  const track = { ...state.track, sourceRequestIds: [state.sourceRequestId, second] };
  const transport = new HttpTransport({ context: state.context, runId: state.runId, track, networkPolicy: { labLoopback: [{ origin: new URL(url).origin, address: '127.0.0.1' }] } });
  await transport.execute(planProbes(track, 'full-download')[0], new AbortController().signal);
  const downloader = new Downloader({ context: state.context, runId: state.runId, transport });
  await expect(downloader.download({ sourceRequestId: second }, new AbortController().signal)).rejects.toMatchObject({ code: 'bounded-evidence-required' });
  expect(requests).toBe(1);
});

it('allows a healthy streaming body to exceed the header deadline but bounds stalled bodies', async () => {
  let count = 0;
  const url = await server((req, res) => {
    if (++count === 1) { respond(req, res); return; }
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes 0-${body.length - 1}/${body.length}`, 'Content-Length': body.length, ETag: '"v1"' });
    res.flushHeaders(); let offset = 0;
    const timer = setInterval(() => { res.write(body.subarray(offset, offset + 1024)); offset += 1024; if (offset >= body.length) { clearInterval(timer); res.end(); } }, 20);
    res.on('close', () => clearInterval(timer));
  });
  const state = await setup(url, { timeoutMs: 60 }); await state.probe();
  expect(await readFile((await state.download()).path)).toEqual(body);
  expect(count).toBe(2);
});

async function readResume(folder: string) {
  const records = [];
  for (const file of await readdir(folder)) if (/^resume\.[01]\.json$/.test(file)) records.push(JSON.parse(await readFile(join(folder, file), 'utf8')));
  records.sort((a, b) => b.sequence - a.sequence);
  return JSON.parse(records[0].payload);
}
it.each(['close', 'pre-link', 'post-link'])('gives cancellation exactly one terminal outcome at %s', async boundary => {
  const state = await setup(await server((req, res) => respond(req, res))); await state.probe();
  const controller = new AbortController();
  if (boundary === 'close') {
    const original = OutputWorkspace.prototype.closeFile;
    vi.spyOn(OutputWorkspace.prototype, 'closeFile').mockImplementation(async function (this: OutputWorkspace) { await original.call(this); controller.abort(); });
  } else {
    const original = OutputWorkspace.prototype.publish;
    vi.spyOn(OutputWorkspace.prototype, 'publish').mockImplementation(async function (this: OutputWorkspace, ...args) {
      if (boundary === 'pre-link') controller.abort();
      await original.apply(this, args);
      if (boundary === 'post-link') controller.abort();
    });
  }
  if (boundary === 'post-link') expect(await readFile((await state.download(controller.signal)).path)).toEqual(body);
  else await expect(state.download(controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
  const events = state.repository.list(state.runId).filter(e => e.phase === 'download' && ['succeeded', 'cancelled', 'failed'].includes(e.status));
  expect(events.map(e => e.status)).toEqual([boundary === 'post-link' ? 'succeeded' : 'cancelled']);
});
it.each(['publishing-state', 'link', 'part-unlink', 'manifest-cleanup'])('recovers idempotently after an interruption at %s', async boundary => {
  const state = await setup(await server((req, res) => respond(req, res))); await state.probe();
  let injected = false;
  if (boundary === 'publishing-state') {
    const original = OutputWorkspace.prototype.saveManifest;
    vi.spyOn(OutputWorkspace.prototype, 'saveManifest').mockImplementation(async function (this: OutputWorkspace, payload) {
      await original.call(this, payload);
      if (!injected && (payload as { state: string }).state === 'publishing') { injected = true; throw new Error('simulated-worker-interruption'); }
    });
  } else {
    const method = boundary === 'link' ? 'publish' : boundary === 'part-unlink' ? 'removePart' : 'cleanupManifest';
    const original = OutputWorkspace.prototype[method];
    vi.spyOn(OutputWorkspace.prototype, method).mockImplementation(async function (this: OutputWorkspace, ...args: unknown[]) {
      await (original as (...args: unknown[]) => Promise<void>).apply(this, args);
      if (!injected) { injected = true; throw new Error('simulated-worker-interruption'); }
    });
  }
  let resumeId = '';
  try { await state.download(); } catch (error) { resumeId = (error as { resumeId: string }).resumeId; }
  expect(injected).toBe(true); expect(resumeId).toMatch(/^[a-f0-9-]{36}$/);
  vi.restoreAllMocks();
  const artifact = await state.download(undefined, { resumeId });
  expect(await readFile(artifact.path)).toEqual(body);
  const receipt = await readResume(join(state.directory, `.download-${resumeId}`));
  expect(receipt).toMatchObject({ state: 'complete', sha256: artifact.sha256, totalBytes: body.length });
  expect(await readdir(join(state.directory, `.download-${resumeId}`))).not.toContain('track.part');
  expect((await state.download(undefined, { resumeId })).sha256).toBe(artifact.sha256);
});
it('bounds a stalled body with the inactivity timeout and bounded retries', async () => {
  let count = 0;
  const url = await server((req, res) => {
    if (++count === 1) { respond(req, res); return; }
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes 0-${body.length - 1}/${body.length}`, 'Content-Length': body.length, ETag: '"v1"' });
    res.flushHeaders();
  });
  const state = await setup(url, { timeoutMs: 30 }); await state.probe();
  await expect(state.download()).rejects.toMatchObject({ outcome: 'inconclusive' });
  expect(count).toBe(4);
});
it('rejects a structural encryption box split across two capped ranges after the bounded probe', async () => {
  const box = (type: string, payload: Buffer) => { const header = Buffer.alloc(8); header.writeUInt32BE(payload.length + 8); header.write(type, 4); return Buffer.concat([header, payload]); };
  const media = Buffer.concat([body.subarray(0, 24), box('free', Buffer.alloc(8154)), box('pssh', Buffer.alloc(24))]);
  const ranges: string[] = [];
  const url = await server((req, res) => {
    ranges.push(req.headers.range!);
    const start = Number(req.headers.range?.match(/bytes=(\d+)/)?.[1] ?? 0);
    const end = Math.min(media.length - 1, start + 4095);
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${media.length}`, ETag: '"v1"' }); res.end(media.subarray(start, end + 1));
  });
  const state = await setup(url); expect((await state.probe()).outcome).toBe('accessible');
  await expect(state.download()).rejects.toMatchObject({ code: 'encrypted' });
  expect(ranges.at(-1)).toMatch(/^bytes=8192-/);
});
it('restores detector and hash state after a partially streamed response is retried', async () => {
  let calls = 0;
  const url = await server((req, res) => {
    if (++calls !== 2) { respond(req, res); return; }
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes 0-${body.length - 1}/${body.length}`, 'Content-Length': body.length, ETag: '"v1"' });
    res.write(Buffer.concat([body.subarray(0, 24), Buffer.from([0, 0, 0, 32, 0x70, 0x73])]));
    setTimeout(() => res.destroy(), 15);
  });
  const state = await setup(url); await state.probe();
  expect(await readFile((await state.download()).path)).toEqual(body);
  expect(calls).toBe(3);
});
it.each(['transfer', 'manifest', 'publication', 'rollback'])('cannot escape the original directory identity during %s substitution', async boundary => {
  let calls = 0;
  const url = await server((req, res) => {
    if (boundary === 'rollback' && ++calls === 2) {
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes 0-${body.length - 1}/${body.length}`, 'Content-Length': body.length, ETag: '"v1"' });
      res.write(body.subarray(0, 100)); setTimeout(() => res.destroy(), 15);
    } else respond(req, res);
  });
  const state = await setup(url); await state.probe();
  const outside = await mkdtemp(join(tmpdir(), 'download-outside-')); cleanups.push(() => rm(outside, { recursive: true, force: true }));
  let swapped = false;
  const swap = async () => {
    if (swapped) return; swapped = true;
    const name = (await readdir(state.directory)).find(name => name.startsWith('.download-'))!;
    const { rename } = await import('node:fs/promises');
    await rename(join(state.directory, name), join(state.directory, `moved-${name}`)); await symlink(outside, join(state.directory, name));
  };
  if (boundary === 'manifest') {
    const original = OutputWorkspace.prototype.saveManifest;
    vi.spyOn(OutputWorkspace.prototype, 'saveManifest').mockImplementation(async function (this: OutputWorkspace, payload) {
      if ((payload as { completed: unknown[] }).completed.length) await swap();
      await original.call(this, payload);
    });
  } else {
    const method = boundary === 'transfer' ? 'write' : boundary === 'rollback' ? 'truncate' : 'publish';
    const original = OutputWorkspace.prototype[method];
    vi.spyOn(OutputWorkspace.prototype, method).mockImplementation(async function (this: OutputWorkspace, ...args: unknown[]) {
      await swap(); await (original as (...args: unknown[]) => Promise<void>).apply(this, args);
    });
  }
  expect(await readFile((await state.download()).path)).toEqual(body);
  expect(swapped).toBe(true); expect(await readdir(outside)).toEqual([]);
});
it('fails inconclusively before writing when no anchored worker launcher is available', async () => {
  const state = await setup(await server((req, res) => respond(req, res))); await state.probe();
  const downloader = new Downloader({ context: state.context, runId: state.runId, transport: state.transport, outputWorkerLauncher: () => { throw new Error('unsupported-runtime'); } });
  await expect(downloader.download({ sourceRequestId: state.sourceRequestId }, new AbortController().signal)).rejects.toMatchObject({ outcome: 'inconclusive' });
  expect(await readdir(state.directory)).toEqual([]);
});
it('retains one successful terminal when the run is cancelled after the atomic link', async () => {
  const state = await setup(await server((req, res) => respond(req, res))); await state.probe();
  const original = OutputWorkspace.prototype.publish;
  vi.spyOn(OutputWorkspace.prototype, 'publish').mockImplementation(async function (this: OutputWorkspace, ...args) {
    await original.apply(this, args); state.context.cancel(state.runId);
  });
  expect(await readFile((await state.download()).path)).toEqual(body);
  const terminal = state.repository.list(state.runId).filter(e => e.phase === 'download' && ['succeeded', 'cancelled', 'failed'].includes(e.status));
  expect(terminal.map(e => e.status)).toEqual(['succeeded']);
});
it('never adopts an unrelated final inode during publication recovery', async () => {
  const state = await setup(await server((req, res) => respond(req, res))); await state.probe();
  const original = OutputWorkspace.prototype.publish;
  vi.spyOn(OutputWorkspace.prototype, 'publish').mockImplementation(async function (this: OutputWorkspace, ...args) {
    await original.apply(this, args); throw new Error('interrupted');
  });
  let resumeId = '';
  try { await state.download(undefined, { filename: 'video.mp4' }); } catch (error) { resumeId = (error as { resumeId: string }).resumeId; }
  vi.restoreAllMocks();
  const final = join(state.directory, `.download-${resumeId}`, 'video.mp4');
  await rm(final); await writeFile(final, body);
  await expect(state.download(undefined, { resumeId })).rejects.toMatchObject({ code: 'unrelated-final' });
  expect(await readFile(final)).toEqual(body);
});
it('preserves the committed artifact if actor shutdown fails after durable cleanup', async () => {
  const state = await setup(await server((req, res) => respond(req, res))); await state.probe();
  vi.spyOn(OutputWorkspace.prototype, 'dispose').mockImplementation(async function (this: OutputWorkspace) {
    this.interrupt(); throw new Error('actor-already-exited');
  });
  expect(await readFile((await state.download()).path)).toEqual(body);
  const terminal = state.repository.list(state.runId).filter(e => e.phase === 'download' && ['succeeded', 'cancelled', 'failed'].includes(e.status));
  expect(terminal.map(e => e.status)).toEqual(['succeeded']);
});
it.each(['final', 'part'])('rejects a same-byte replacement opened after the %s identity check without rewriting its receipt', async kind => {
  const state = await setup(await server((req, res) => respond(req, res))); await state.probe();
  let resumeId: string;
  if (kind === 'final') resumeId = (await state.download(undefined, { filename: 'video.mp4' })).id;
  else {
    const controller = new AbortController(); const emit = state.context.emit.bind(state.context);
    state.context.emit = input => { const event = emit(input); if (input.action === 'download:progress') controller.abort(); return event; };
    try { await state.download(controller.signal, { filename: 'video.mp4' }); throw new Error('expected cancellation'); }
    catch (error) { resumeId = (error as { resumeId: string }).resumeId; }
    state.context.emit = emit;
  }
  const folder = join(state.directory, `.download-${resumeId!}`);
  const before = await readResume(folder);
  const original = OutputWorkspace.prototype.openFile; let replaced = false;
  vi.spyOn(OutputWorkspace.prototype, 'openFile').mockImplementation(async function (this: OutputWorkspace, name, create) {
    if (!create && name === (kind === 'final' ? 'video.mp4' : 'track.part')) {
      const path = join(folder, name), bytes = await readFile(path);
      const { rename } = await import('node:fs/promises');
      await rename(path, join(folder, 'original-inode'));
      await writeFile(path, bytes); replaced = true;
    }
    return original.call(this, name, create);
  });
  await expect(state.download(undefined, { resumeId: resumeId! })).rejects.toMatchObject({ outcome: 'inconclusive' });
  expect(replaced).toBe(true);
  expect(await readResume(folder)).toEqual(before);
});
it.each([['x', 'x'], ['video.', 'video'], ['video....', 'video'], ['CON.', 'track.mp4'], ['LPT1.mp4', 'track.mp4']])('sanitizes filename %s consistently before transfer and publishes %s', async (filename, expected) => {
  const url = await server((req, res) => respond(req, res));
  const state = await setup(url); await state.probe();
  const artifact = await state.download(undefined, { filename });
  expect(artifact.path.split(/[\\/]/).at(-1)).toBe(expected);
  expect(await readFile(artifact.path)).toEqual(body);
});
it.each([
  Buffer.from('<!DOCTYPE MPD [<?note [ ] >'),
  Buffer.concat([Buffer.from('<MPD '), Buffer.from([0xc0, 0xaf]), Buffer.from('="x"/>')]),
  Buffer.from('<MPD>')
])('keeps ambiguous XML probe evidence inconclusive and refuses the full download gate', async bytes => {
  let calls = 0;
  const url = await server((_req, res) => { calls++; res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length, ETag: '"v1"' }); res.end(bytes); });
  const state = await setup(url);
  expect(await state.probe()).toMatchObject({ outcome: 'inconclusive', transportOutcome: 'parser' });
  const previous = calls;
  await expect(state.download()).rejects.toMatchObject({ outcome: 'inconclusive' });
  expect(calls).toBe(previous);
});

it('reports bounded in-flight bytes before an HTTP range completes without claiming them as committed', async () => {
  let slow = false; let release: (() => void) | undefined;
  const url = await server((req, res) => {
    if (!slow) { respond(req, res); return; }
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes 0-${body.length - 1}/${body.length}`, 'Content-Length': body.length, ETag: '"v1"' });
    res.write(body.subarray(0, 1024)); release = () => res.end(body.subarray(1024));
  });
  const state = await setup(url, { timeoutMs: 5000 }); await state.probe(); slow = true;
  const task = state.download();
  try {
    await expect.poll(() => state.repository.list(state.runId).find(e => e.action === 'download:receiving' && e.evidence?.receivedBytes === 1024), { timeout: 1500 }).toMatchObject({ evidence: { completedBytes: 0, receivedBytes: 1024, totalBytes: body.length } });
  } finally { release?.(); await task; }
  const progress = state.repository.list(state.runId).filter(e => e.action === 'download:receiving');
  expect(progress.length).toBeLessThan(10); expect(await readFile((await task).path)).toEqual(body);
});
