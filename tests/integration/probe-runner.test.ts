import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startLabServer, type LabServer } from '../../lab/server';
import { LAB_SECRET } from '../../lab/scenarios';
import { signMediaRequest } from '../../src/main/security/signature';
import { createSanitizedCapturedUrl } from '../../src/main/security/redact';
import { EventRepository } from '../../src/main/runs/event-repository';
import { RunOrchestrator } from '../../src/main/runs/run-orchestrator';
import { createSourceRequestReference, type MediaTrack, type ProbeResult, type RunMode } from '../../src/shared/contracts';
import { planProbes, SHORT_PROBE_BYTES } from '../../src/main/probes/probe-planner';
import { HttpTransport } from '../../src/main/probes/http-transport';
import { ProbeRunner } from '../../src/main/probes/probe-runner';
let lab: LabServer;
const cleanups: (() => void | Promise<void>)[] = [];
beforeAll(async () => { lab = await startLabServer(); });
afterAll(async () => { await lab?.close(); });
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function setup(url: string, headers: Record<string, string> = {}, mode: RunMode = 'standard', options: { timeoutMs?: number; maxExpiryWaitMs?: number; maxConcurrency?: number } = {}) {
  const repository = new EventRepository(':memory:');
  const context = new RunOrchestrator(repository);
  const runId = context.start({ targetUrl: lab.baseUrl, outputDirectory: '/tmp', mode, maxConcurrency: 4, authorizationConfirmed: true });
  const sourceIdentity = { runId, targetId: 'page', sessionId: 'worker', frameId: 'frame', requestId: '42', version: 1 };
  const id = createSourceRequestReference(sourceIdentity);
  context.rememberRequest(runId, { id, sourceIdentity, url, method: 'GET', requestHeaders: headers });
  const track: MediaTrack = { id: 'track', assetId: 'asset', kind: 'video', sourceRequestIds: [id], sanitizedUrl: createSanitizedCapturedUrl(url), mimeType: 'video/mp4', byteLength: 100000, detectionReasons: [], eligible: true };
  const transport = new HttpTransport({ context, runId, track, networkPolicy: { labLoopback: [{ origin: new URL(url).origin, address: '127.0.0.1' }] }, ...options });
  const runner = new ProbeRunner({ context, runId, transport });
  cleanups.push(() => { context.dispose(); repository.close(); });
  return { context, repository, runId, track, transport, runner };
}
async function collect(iterable: AsyncIterable<ProbeResult>): Promise<ProbeResult[]> { const results: ProbeResult[] = []; for await (const item of iterable) results.push(item); return results; }
async function server(handler: RequestListener): Promise<{ base: string; server: Server }> {
  const instance = createServer(handler); await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { instance.closeAllConnections(); await new Promise<void>(resolve => instance.close(() => resolve())); });
  return { base: `http://127.0.0.1:${(instance.address() as AddressInfo).port}`, server: instance };
}
describe('server access evidence', () => {
  it.each(['open-range', 'referer-only', 'signed-url', 'session-bound', 'range-capped'])('runs a bounded matrix on %s and preserves evidence', async scenario => {
    const expires = Math.floor(Date.now() / 1000) + 60;
    const sig = signMediaRequest({ mediaId: 'video.mp4', expires, sessionId: scenario === 'session-bound' ? 'lab-session' : undefined }, LAB_SECRET);
    const url = `${lab.baseUrl}/${scenario}/video.mp4?expires=${expires}&sig=${sig}${scenario === 'session-bound' ? '&sessionId=lab-session' : ''}`;
    const state = setup(url, { Cookie: 'lab_session=lab-session', Authorization: 'Bearer secret-marker', Referer: `${lab.baseUrl}/${scenario}/watch`, Origin: lab.baseUrl });
    const results = await collect(state.runner.run(state.track, planProbes(state.track, 'standard'), new AbortController().signal));
    expect(results.find(r => r.name === 'baseline')?.outcome).toBe('accessible');
    for (const result of results) expect(result.bytesReceived ?? 0).toBeLessThanOrEqual(SHORT_PROBE_BYTES * 4);
    if (scenario === 'referer-only') expect(results.find(r => r.name === 'without-referer')).toMatchObject({ outcome: 'denied', status: 403 });
    if (scenario === 'signed-url' || scenario === 'session-bound') expect(results.find(r => r.name === 'without-query')?.outcome).toBe('denied');
    if (scenario === 'session-bound') expect(results.find(r => r.name === 'without-cookie')?.outcome).toBe('denied');
    if (scenario === 'range-capped') expect(results.find(r => r.name === 'range-head')).toMatchObject({ outcome: 'accessible', bytesReceived: 1024, contentRange: expect.stringMatching(/^bytes 0-1023\//) });
    const events = state.repository.list(state.runId).filter(e => e.phase === 'probe');
    for (const result of results) expect(events.filter(e => e.relatedIds.includes(result.id)).map(e => e.status)).toEqual(['queued', 'running', result.outcome === 'denied' ? 'denied' : result.outcome === 'accessible' ? 'succeeded' : 'warning']);
    expect(JSON.stringify({ results, events })).not.toMatch(new RegExp(`secret-marker|${sig}|lab_session=lab-session`));
  });
  it('replays an observed short-lived signature after expiry and bounds long/unknown expiry', async () => {
    const expires = Math.floor(Date.now() / 1000) + 1;
    const sig = signMediaRequest({ mediaId: 'video.mp4', expires }, LAB_SECRET);
    const state = setup(`${lab.baseUrl}/signed-url/video.mp4?expires=${expires}&sig=${sig}`, {}, 'standard', { maxExpiryWaitMs: 2000 });
    const plan = planProbes(state.track, 'standard').find(p => p.id === 'expiry-replay')!;
    const result = await state.transport.execute(plan, new AbortController().signal);
    expect(result).toMatchObject({ status: 403, outcome: 'denied' });

  });
  it('prevents forged full retrieval in standard/observe modes and requires short success in full-download', async () => {
    for (const mode of ['observe', 'standard', 'full-download'] as const) {
      const state = setup(`${lab.baseUrl}/open-range/video.mp4`, {}, mode);
      const full = planProbes(state.track, 'full-download').find(p => p.id === 'range-full')!;
      expect((await state.transport.execute(full, new AbortController().signal)).outcome).toBe('inconclusive');
      if (mode === 'full-download') {
        await state.transport.execute(planProbes(state.track, mode)[0], new AbortController().signal);
        expect((await state.transport.execute(full, new AbortController().signal)).outcome).toBe('accessible');
      }
    }
  });
  it('stops a server ignoring Range at the byte cap and rejects HTML pretending to be media', async () => {
    const local = await server((_req, res) => { res.setHeader('Content-Type', 'video/mp4'); res.end(Buffer.concat([Buffer.from('<!doctype html>login'), Buffer.alloc(1000000)])); });
    const state = setup(`${local.base}/video`);
    const evidence = await state.transport.execute(planProbes(state.track, 'standard')[0], new AbortController().signal);
    expect(evidence.bytesReceived).toBe(SHORT_PROBE_BYTES);
    expect(evidence.outcome).toBe('inconclusive');
    expect(JSON.stringify(evidence)).not.toContain('doctype');
  });
  it('blocks unobserved redirect targets and strips credentials on observed cross-origin redirects', async () => {
    let received: Record<string, unknown> | undefined;
    const target = await server((req, res) => { received = req.headers; res.setHeader('Content-Type', 'video/mp4'); res.end(validMp4); });
    const origin = await server((_req, res) => { res.writeHead(302, { Location: `${target.base}/video?token=secret-marker` }); res.end(); });
    const state = setup(`${origin.base}/video`, { Cookie: 'session=secret-marker', Authorization: 'Bearer secret-marker', 'X-Api-Key': 'secret-marker', Referer: `${origin.base}/watch?token=secret-marker` });
    const plan = planProbes(state.track, 'standard')[0];
    expect((await state.transport.execute(plan, new AbortController().signal)).outcome).toBe('inconclusive');
    expect(received).toBeUndefined();
    const redirectIdentity = { runId: state.runId, targetId: 'page', sessionId: 'worker', frameId: 'frame', requestId: '43', version: 1 };
    const redirectId = createSourceRequestReference(redirectIdentity);
    state.context.rememberRequest(state.runId, { id: redirectId, sourceIdentity: redirectIdentity, url: `${target.base}/video?token=secret-marker`, method: 'GET' });
    // Only selected-track observed references can authorize a redirect.
    state.track.sourceRequestIds.push(redirectId);
    const allowed = new HttpTransport({ context: state.context, runId: state.runId, track: state.track, networkPolicy: { labLoopback: [origin.base, target.base].map(origin => ({ origin, address: '127.0.0.1' })) } });
    const evidence = await allowed.execute(plan, new AbortController().signal);
    expect(evidence.outcome).toBe('accessible');
    expect(received).not.toHaveProperty('cookie'); expect(received).not.toHaveProperty('authorization'); expect(received).not.toHaveProperty('x-api-key'); expect(received).not.toHaveProperty('referer');
    expect(JSON.stringify(evidence)).not.toContain('secret-marker');
  });
  it('classifies transport failures/cancellation as inconclusive and emits one terminal event', async () => {
    const local = await server((_req, _res) => {});
    const state = setup(`${local.base}/video`, {}, 'standard', { timeoutMs: 30 });
    const plans = planProbes(state.track, 'standard').slice(0, 1);
    expect((await collect(state.runner.run(state.track, plans, new AbortController().signal)))[0]).toMatchObject({ outcome: 'inconclusive', evidence: { transportOutcome: 'timeout' } });
    const controller = new AbortController(); controller.abort();
    const results = await collect(state.runner.run(state.track, plans, controller.signal));
    expect(results[0]).toMatchObject({ outcome: 'inconclusive', evidence: { transportOutcome: 'cancelled' } });
    expect(state.repository.list(state.runId).filter(e => e.relatedIds.includes(results[0].id)).map(e => e.status)).toEqual(['queued', 'running', 'cancelled']);
  });
  it('hard-caps concurrent requests at four and cancels an abandoned iterator', async () => {
    let active = 0, max = 0;
    const local = await server((_req, res) => { active++; max = Math.max(max, active); res.on('close', () => { active--; }); setTimeout(() => { const start = Number(_req.headers.range?.match(/bytes=(\d+)/)?.[1] ?? 0); res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${start + validMp4.length - 1}/100000` }); res.end(validMp4); }, 30); });
    const state = setup(`${local.base}/video`, {}, 'standard', { maxConcurrency: 99 });
    const concurrent = planProbes(state.track, 'standard').find(p => p.id === 'range-concurrent')!;
    const result = await state.transport.execute(concurrent, new AbortController().signal);
    expect(result.outcome).toBe('accessible'); expect(max).toBe(4); expect(active).toBe(0);
    const iterator = state.runner.run(state.track, planProbes(state.track, 'standard'), new AbortController().signal)[Symbol.asyncIterator]();
    await iterator.next(); await iterator.return?.();
    expect(active).toBe(0);
  });
  it('recognizes encrypted response evidence without claiming bypass', async () => {
    const state = setup(`${lab.baseUrl}/encrypted-placeholder/segment-000.m4s`);
    expect((await state.transport.execute(planProbes(state.track, 'standard')[0], new AbortController().signal)).outcome).toBe('encrypted');
  });
  it('uses only selected sources and refuses incomplete/encrypted tracks', async () => {
    const state = setup(`${lab.baseUrl}/open-range/video.mp4`);
    const plan = planProbes(state.track, 'standard')[0];
    expect((await state.transport.execute({ ...plan, sourceRequestId: 'unknown' }, new AbortController().signal)).outcome).toBe('inconclusive');
    for (const changes of [{ incomplete: true }, { encrypted: true }, { eligible: false }]) {
      const transport = new HttpTransport({ context: state.context, runId: state.runId, track: { ...state.track, ...changes } });
      expect((await transport.execute(plan, new AbortController().signal)).outcome).not.toBe('accessible');
    }
  });
});

it('retains the cancellation terminal event when the active run is released during HTTP', async () => {
  let seen!: () => void; const requested = new Promise<void>(resolve => { seen = resolve; });
  const local = await server((_req, _res) => { seen(); });
  const state = setup(`${local.base}/video`);
  const iteration = collect(state.runner.run(state.track, planProbes(state.track, 'standard'), new AbortController().signal));
  await requested; state.context.cancel(state.runId);
  const result = await iteration;
  expect(result).toHaveLength(1);
  expect(result[0].outcome).toBe('inconclusive');
  expect(state.repository.list(state.runId).filter(e => e.relatedIds.includes(result[0].id)).map(e => e.status)).toEqual(['queued', 'running', 'cancelled']);
});

it('does not call arbitrary binary verified media', async () => {
  const local = await server((_req, res) => { res.setHeader('Content-Type', 'video/mp4'); res.end(Buffer.alloc(100, 1)); });
  const state = setup(`${local.base}/video`);
  expect((await state.transport.execute(planProbes(state.track, 'standard')[0], new AbortController().signal)).outcome).toBe('inconclusive');
});

it('replays one observed signed segment without expanding its playlist or IDs', async () => {
  const expires = Math.floor(Date.now() / 1000) + 60;
  const sig = signMediaRequest({ mediaId: 'segment-000.ts', expires, segmentId: '0' }, LAB_SECRET);
  const state = setup(`${lab.baseUrl}/segment-token/segment-000.ts?expires=${expires}&segmentId=0&sig=${sig}`);
  const results = await collect(state.runner.run(state.track, planProbes(state.track, 'standard').slice(0, 3), new AbortController().signal));
  expect(results.map(r => r.outcome)).toEqual(['accessible', 'accessible', 'denied']);
  expect(new Set(results.map(r => r.requestId)).size).toBe(1);
});

it('limits redirect loops to five followed hops and keeps all blocked outcomes inconclusive', async () => {
  let requests = 0;
  const local = await server((_req, res) => { requests++; res.writeHead(302, { Location: '/video' }); res.end(); });
  const state = setup(`${local.base}/video`);
  const evidence = await state.transport.execute(planProbes(state.track, 'standard')[0], new AbortController().signal);
  expect(requests).toBe(6); expect(evidence.redirects.filter(r => r.followed)).toHaveLength(5);
  expect(evidence.outcome).toBe('inconclusive');
});

it('reports far or unparseable expiry as limitations and cancels a short expiry wait', async () => {
  for (const expires of ['9000000000', 'unknown']) {
    const state = setup(`${lab.baseUrl}/signed-url/video.mp4?expires=${expires}&sig=secret-marker`);
    const evidence = await state.transport.execute(planProbes(state.track, 'standard').at(-1)!, new AbortController().signal);
    expect(evidence).toMatchObject({ outcome: 'inconclusive', transportOutcome: 'limitation', bytesReceived: 0 });
    expect(evidence.conclusion).toMatch(/expiry.*skipped/);
  }
  const expires = Math.floor(Date.now() / 1000) + 3;
  const state = setup(`${lab.baseUrl}/signed-url/video.mp4?expires=${expires}&sig=secret-marker`);
  const controller = new AbortController();
  const pending = state.transport.execute(planProbes(state.track, 'standard').at(-1)!, controller.signal);
  controller.abort();
  expect(await pending).toMatchObject({ outcome: 'inconclusive', transportOutcome: 'cancelled', bytesReceived: 0 });
});

it('does not fetch key or license resources even if a caller labels them video', async () => {
  let requests = 0;
  const local = await server((_req, res) => { requests++; res.end('secret-key'); });
  for (const path of ['/license', '/key', '/keys/content.bin']) {
    const state = setup(`${local.base}${path}`);
    const evidence = await state.transport.execute(planProbes(state.track, 'standard')[0], new AbortController().signal);
    expect(evidence.outcome).toBe('inconclusive');
  }
  expect(requests).toBe(0);
});

it.each([Buffer.from('Gateway unavailable'), Buffer.from('Garbage'), Buffer.from('0000ftyp'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('ID3error'), Buffer.from('OggSerror'), Buffer.alloc(600, 0x47)])('does not let error text or truncated signatures unlock full Range: %s', async body => {
  let calls = 0;
  const local = await server((_req, res) => { calls++; res.setHeader('Content-Type', 'video/mp4'); res.end(body); });
  const state = setup(`${local.base}/video`, {}, 'full-download');
  const plans = planProbes(state.track, 'full-download');
  expect((await state.transport.execute(plans[0], new AbortController().signal)).outcome).toBe('inconclusive');
  expect((await state.transport.execute(plans.find(p => p.id === 'range-full')!, new AbortController().signal)).outcome).toBe('inconclusive');
  expect(calls).toBe(1);
});

const validMp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
it.each([
  { name: 'wrong suffix start', id: 'range-tail', range: 'bytes 0-23/10000', body: validMp4 },
  { name: 'short advertised body', id: 'baseline', range: 'bytes 0-4095/10000', body: validMp4 },
  { name: 'oversized explicit interval', id: 'baseline', range: 'bytes 0-8191/10000', body: Buffer.concat([validMp4, Buffer.alloc(8168)]) },
  { name: 'wrong middle start', id: 'range-middle', range: 'bytes 0-23/100000', body: validMp4 }
])('rejects invalid Range evidence: $name', async test => {
  const local = await server((_req, res) => { res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': test.range, 'Content-Length': test.body.length }); res.end(test.body); });
  const state = setup(`${local.base}/video`);
  const evidence = await state.transport.execute(planProbes(state.track, 'standard').find(p => p.id === test.id)!, new AbortController().signal);
  expect(evidence.outcome).toBe('inconclusive'); expect(evidence.transportOutcome).toBe('parser');
});

it('does not report ignored middle, tail, or full Range as successful Range access', async () => {
  const local = await server((_req, res) => { res.setHeader('Content-Type', 'video/mp4'); res.end(validMp4); });
  const state = setup(`${local.base}/video`, {}, 'full-download');
  const plans = planProbes(state.track, 'full-download');
  expect((await state.transport.execute(plans[0], new AbortController().signal)).outcome).toBe('accessible');
  for (const id of ['range-middle', 'range-tail', 'range-full']) {
    const evidence = await state.transport.execute(plans.find(p => p.id === id)!, new AbortController().signal);
    expect(evidence.outcome).toBe('inconclusive');
    expect(evidence.baselineAccess).toBe(true);
  }
});

it('marks intentional sampling for a valid full Range and records a smaller server Range cap', async () => {
  const body = Buffer.concat([validMp4, Buffer.alloc(10000 - validMp4.length)]);
  const local = await server((req, res) => { const full = req.headers.range === 'bytes=0-'; const end = full ? 9999 : 1023; res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes 0-${end}/10000`, 'Content-Length': end + 1 }); res.end(body.subarray(0, end + 1)); });
  const state = setup(`${local.base}/video`, {}, 'full-download'); const plans = planProbes(state.track, 'full-download');
  const baseline = await state.transport.execute(plans[0], new AbortController().signal);
  expect(baseline).toMatchObject({ outcome: 'accessible', serverRangeCapped: true, bytesReceived: 1024, intentionallySampled: false });
  expect(await state.transport.execute(plans.find(p => p.id === 'range-full')!, new AbortController().signal)).toMatchObject({ outcome: 'accessible', bytesReceived: 4096, intentionallySampled: true });
});

it('production defaults and rebinding DNS cannot reach a private HTTP service', async () => {
  let calls = 0;
  const local = await server((_req, res) => { calls++; res.end(validMp4); });
  const state = setup(`${local.base}/video`);
  const production = new HttpTransport({ context: state.context, runId: state.runId, track: state.track });
  expect(await production.execute(planProbes(state.track, 'standard')[0], new AbortController().signal)).toMatchObject({ outcome: 'inconclusive', transportOutcome: 'limitation' });
  const rebound = setup(`${local.base.replace('127.0.0.1', 'public.example')}/video`);
  const transport = new HttpTransport({ context: rebound.context, runId: rebound.runId, track: rebound.track, networkPolicy: { resolveHostname: async () => [{ address: '127.0.0.1', family: 4 }] } });
  expect(await transport.execute(planProbes(rebound.track, 'standard')[0], new AbortController().signal)).toMatchObject({ outcome: 'inconclusive', transportOutcome: 'limitation' });
  expect(calls).toBe(0);
});

it('uses only the selected frame token when another frame observes the same sanitized URL', async () => {
  let requestedToken: string | null = null;
  const local = await server((req, res) => { requestedToken = new URL(req.url!, 'http://local').searchParams.get('token'); res.setHeader('Content-Type', 'video/mp4'); res.end(validMp4); });
  const state = setup(`${local.base}/video?token=selected-secret`);
  const sourceIdentity = { runId: state.runId, targetId: 'page', sessionId: 'worker', frameId: 'other-frame', requestId: '42', version: 1 };
  state.context.rememberRequest(state.runId, { id: createSourceRequestReference(sourceIdentity), sourceIdentity, url: `${local.base}/video?token=other-secret`, method: 'GET' });
  expect((await state.transport.execute(planProbes(state.track, 'standard')[0], new AbortController().signal)).outcome).toBe('accessible');
  expect(requestedToken).toBe('selected-secret');
});

it('rejects clean EOF before a chunked Content-Range is complete', async () => {
  const local = await server((_req, res) => { res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-4095/10000', 'Transfer-Encoding': 'chunked' }); res.write(validMp4); res.end(); });
  const state = setup(`${local.base}/video`);
  expect(await state.transport.execute(planProbes(state.track, 'standard')[0], new AbortController().signal)).toMatchObject({ outcome: 'inconclusive', transportOutcome: 'parser', bytesReceived: validMp4.length });
});

it('preserves DNS timeout classification in the shared streaming request path', async () => {
  const state = setup('https://download.example/video');
  const transport = new HttpTransport({ context: state.context, runId: state.runId, track: state.track, timeoutMs: 10,
    networkPolicy: { resolveHostname: async () => new Promise(() => undefined) } });
  const result = await transport.execute(planProbes(state.track, 'standard')[0], new AbortController().signal);
  expect(result).toMatchObject({ outcome: 'inconclusive', transportOutcome: 'timeout', bytesReceived: 0 });
});

it('does not classify innocent MP4 payload text as structural encryption', async () => {
  const payload = Buffer.from('ordinary payload mentions pssh cenc encv enca');
  const header = Buffer.alloc(8); header.writeUInt32BE(payload.length + 8); header.write('mdat', 4);
  const local = await server((_req, res) => { res.setHeader('Content-Type', 'video/mp4'); res.end(Buffer.concat([validMp4, header, payload])); });
  const state = setup(`${local.base}/video`);
  expect((await state.transport.execute(planProbes(state.track, 'standard')[0], new AbortController().signal)).outcome).toBe('accessible');
});
it.each([
  ['#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n' + 'x'.repeat(40000), true],
  ['<MPD><!--<ContentProtection/>--><![CDATA[<ContentProtection/>]]></MPD>', false],
  ['<MPD><cenc:ContentProtection/></MPD>', true],
  ['<!DOCTYPE MPD [<?note [ ?>]><MPD><ContentProtection/></MPD>', true],
  ['<!DOCTYPE MPD [<?note ]><ContentProtection/> ?>]><MPD/>', false],
  ['<MPD xmlns:é="urn:mpeg:dash:schema:mpd:2011"><é:ContentProtection/></MPD>', true],
  ['#EXTM3U\n#EXT-X-KEY:URI="METHOD=AES-128",METHOD=NONE\n', false]
] as const)('probe shares the downloader incremental text classification', async (text, encrypted) => {
  const { StreamingEncryptionClassifier } = await import('../../src/main/download/streaming-encryption');
  const classifier = new StreamingEncryptionClassifier();
  for (const byte of Buffer.from(text)) classifier.push(Buffer.from([byte])); classifier.finish();
  const endpoint = await server((_req, res) => { res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end(text); });
  const state = setup(`${endpoint.base}/media`);
  const evidence = await state.transport.execute(planProbes(state.track, 'standard')[0], new AbortController().signal);
  expect(classifier.encrypted).toBe(encrypted);
  expect(evidence.outcome === 'encrypted').toBe(classifier.encrypted);
});

it('persists structural media evidence for a generic head and a source-linked generic tail', async () => {
  const media = Buffer.concat([validMp4, Buffer.alloc(10000 - validMp4.length, 7)]);
  const local = await server((req, res) => {
    const suffix = req.headers.range?.startsWith('bytes=-'); const start = suffix ? 5904 : 0; const end = suffix ? 9999 : 4095;
    res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/10000`, 'Content-Length': 4096 }); res.end(media.subarray(start, end + 1));
  });
  const state = setup(`${local.base}/video`); const plans = planProbes(state.track, 'standard').filter(p => ['baseline', 'range-tail'].includes(p.id));
  const results = await collect(state.runner.run(state.track, plans, new AbortController().signal));
  expect(results[0]).toMatchObject({ outcome: 'accessible', evidence: { mediaEvidence: 'structural' } });
  expect(results[1]).toMatchObject({ outcome: 'accessible', evidence: { mediaEvidence: 'linked-range' } });
  const events = state.repository.list(state.runId).filter(e => e.phase === 'probe' && e.action.endsWith(':after'));
  expect(events.map(e => e.evidence?.mediaEvidence)).toEqual(['structural', 'linked-range']);
});

it.each(['version', 'session', 'frame'] as const)('keeps structural recognition and download grants on the exact selected %s incarnation', async collision => {
  const media = Buffer.concat([validMp4, Buffer.alloc(10000 - validMp4.length, 7)]);
  const seen: string[] = [];
  const local = await server((req, res) => {
    seen.push(String(req.headers['x-incarnation']));
    const tail = req.headers.range === 'bytes=-4096', start = tail ? 5904 : 0, end = tail ? 9999 : 4095;
    res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/10000`, 'Content-Length': 4096 }); res.end(media.subarray(start, end + 1));
  });
  const state = setup(`${local.base}/video`, { 'x-incarnation': 'A' }, 'full-download');
  const a = state.track.sourceRequestIds[0], rawA = state.context.resolveRequest(state.runId, a)!;
  const identity = { ...rawA.sourceIdentity!, ...(collision === 'version' ? { version: 2 } : collision === 'session' ? { sessionId: 'other-worker' } : { frameId: 'other-frame' }) };
  const b = createSourceRequestReference(identity);
  state.context.rememberRequest(state.runId, { ...rawA, id: b, sourceIdentity: identity, requestHeaders: { 'x-incarnation': 'B' } });
  state.track.sourceRequestIds.push(b);
  const transport = new HttpTransport({ context: state.context, runId: state.runId, track: state.track, networkPolicy: { labLoopback: [{ origin: local.base, address: '127.0.0.1' }] } });
  const plans = planProbes(state.track, 'full-download'), signal = new AbortController().signal;
  const run = (id: string, sourceRequestId: string) => transport.execute({ ...plans.find(p => p.id === id)!, sourceRequestId }, signal);
  expect(await run('baseline', b)).toMatchObject({ outcome: 'accessible', mediaEvidence: 'structural' });
  expect(transport.authorizeDownload(state.context, state.runId, b).sourceRequestId).toBe(b);
  expect(() => transport.authorizeDownload(state.context, state.runId, a)).toThrow('bounded-evidence-required');
  expect(await run('range-full', a)).toMatchObject({ outcome: 'inconclusive', transportOutcome: 'limitation' });
  expect(await run('range-tail', a)).toMatchObject({ outcome: 'inconclusive' });
  expect(await run('range-tail', b)).toMatchObject({ outcome: 'accessible', mediaEvidence: 'linked-range' });
  expect(await run('baseline', a)).toMatchObject({ outcome: 'accessible', mediaEvidence: 'structural' });
  expect(await run('range-tail', a)).toMatchObject({ outcome: 'accessible', mediaEvidence: 'linked-range' });
  expect(seen).toEqual(['B', 'A', 'B', 'A', 'A']);
  const runner = new ProbeRunner({ context: state.context, runId: state.runId, transport });
  const [result] = await collect(runner.run(state.track, [{ ...plans[0], sourceRequestId: b }], signal));
  expect(result).toMatchObject({ requestId: b, inputSummary: { sourceRequestId: b }, evidence: { mediaEvidence: 'structural' } });
  const terminal = state.repository.list(state.runId).find(e => e.relatedIds[0] === result.id && e.action === 'baseline:after')!;
  expect(terminal.relatedIds).toEqual([result.id, state.track.id, b]);
  expect(terminal.inputSummary?.sourceRequestId).toBe(b); expect(terminal.evidence?.mediaEvidence).toBe('structural');
});

it('does not transfer recognition through redirected version collisions or shared final URLs', async () => {
  const media = Buffer.concat([validMp4, Buffer.alloc(10000 - validMp4.length, 7)]);
  const local = await server((req, res) => {
    if (req.url === '/video' && req.headers['x-incarnation'] === 'B') { res.writeHead(302, { Location: '/final' }); res.end(); return; }
    const tail = req.headers.range === 'bytes=-4096', start = tail ? 5904 : 0, end = tail ? 9999 : 4095;
    res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/10000`, 'Content-Length': 4096 }); res.end(media.subarray(start, end + 1));
  });
  const state = setup(`${local.base}/video`, { 'x-incarnation': 'A' });
  const a = state.track.sourceRequestIds[0], raw = state.context.resolveRequest(state.runId, a)!;
  const bIdentity = { ...raw.sourceIdentity!, version: 2 }, b = createSourceRequestReference(bIdentity);
  state.context.rememberRequest(state.runId, { ...raw, id: b, sourceIdentity: bIdentity, requestHeaders: { 'x-incarnation': 'B' } });
  const cIdentity = { ...raw.sourceIdentity!, version: 3 }, c = createSourceRequestReference(cIdentity);
  state.context.rememberRequest(state.runId, { ...raw, id: c, sourceIdentity: cIdentity, url: `${local.base}/final` });
  state.track.sourceRequestIds.push(b, c);
  const transport = new HttpTransport({ context: state.context, runId: state.runId, track: state.track, networkPolicy: { labLoopback: [{ origin: local.base, address: '127.0.0.1' }] } });
  const plans = planProbes(state.track, 'standard'), signal = new AbortController().signal;
  const execute = (name: string, sourceRequestId: string) => transport.execute({ ...plans.find(p => p.id === name)!, sourceRequestId }, signal);
  expect(await execute('baseline', b)).toMatchObject({ outcome: 'accessible', mediaEvidence: 'structural', redirects: [{ status: 302, followed: true }] });
  expect(await execute('range-tail', a)).toMatchObject({ outcome: 'inconclusive' });
  expect(await execute('range-tail', b)).toMatchObject({ outcome: 'accessible', mediaEvidence: 'linked-range' });
  expect(await execute('range-tail', c)).toMatchObject({ outcome: 'inconclusive' });
  expect(await execute('baseline', a)).toMatchObject({ outcome: 'accessible', mediaEvidence: 'structural' });
  expect(await execute('range-tail', a)).toMatchObject({ outcome: 'accessible', mediaEvidence: 'linked-range' });
});
