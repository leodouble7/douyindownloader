import { describe, expect, it, vi } from 'vitest';
import { CdpCapture } from '../../src/main/browser/cdp-capture';
import type { DebuggerPort, CdpMessage } from '../../src/main/browser/debugger-port';
import type { CaptureObservation } from '../../src/shared/contracts';
import type { EmitRunEventInput } from '../../src/main/runs/run-orchestrator';

class FakePort implements DebuggerPort {
  commands: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  listener?: (message: CdpMessage) => void;
  detached = false;
  detachListener?: (reason: string) => void;
  onDetach(listener: (reason: string) => void): () => void { this.detachListener = listener; return () => { if (this.detachListener === listener) this.detachListener = undefined; }; }
  attach(): void { /* external debugger boundary */ }
  detach(): void { this.detached = true; }
  onMessage(listener: (message: CdpMessage) => void): () => void { this.listener = listener; return () => { this.listener = undefined; }; }
  async send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
    this.commands.push({ method, params, sessionId });
    if (method === 'Media.enable' && sessionId) throw new Error('unsupported domain');
    return {};
  }
  emit(method: string, params: Record<string, unknown>, sessionId?: string): void { this.listener?.({ method, params, sessionId }); }
}

function setup() {
  const port = new FakePort();
  const observations: CaptureObservation[] = [];
  const events: EmitRunEventInput[] = [];
  const capture = new CdpCapture({ runId: 'run', port, emit: (event) => { events.push(event); }, observe: (item) => { observations.push(item); } });
  return { port, observations, events, capture };
}

describe('CDP capture boundary', () => {
  it('preserves request correlation, redirects, ranges, cache and timing without credential leaks', async () => {
    const { port, observations, capture } = setup();
    await capture.start({ targetId: 'page', type: 'page' });
    port.emit('Network.requestWillBeSent', { requestId: 'req', frameId: 'frame', type: 'Media', timestamp: 1, initiator: { type: 'script', url: 'https://site.test/app?token=secret' }, request: { url: 'https://user:pass@site.test/v?token=secret', method: 'GET', headers: { Range: 'bytes=0-99', Cookie: 'session=secret' } } });
    port.emit('Network.requestWillBeSent', { requestId: 'req', frameId: 'frame', timestamp: 2, redirectResponse: { status: 302, url: 'https://site.test/v?token=secret', headers: { Location: 'https://site.test/f?token=secret' } }, request: { url: 'https://site.test/f?token=secret', method: 'GET', headers: { Range: 'bytes=0-99' } } });
    port.emit('Network.responseReceived', { requestId: 'req', timestamp: 3, response: { status: 206, mimeType: 'video/mp4', fromDiskCache: true, fromServiceWorker: true, encodedDataLength: 100, headers: { 'Content-Length': '100', 'Content-Range': 'bytes 0-99/400', 'Set-Cookie': 'secret' }, timing: { requestTime: 2, receiveHeadersEnd: 12 } } });
    port.emit('Network.loadingFinished', { requestId: 'req', timestamp: 4, encodedDataLength: 123 });
    const network = observations.filter((item) => item.kind === 'network');
    expect(network.map((item) => item.stage)).toEqual(['request', 'redirect', 'request', 'response', 'finished']);
    expect(network[0]).toMatchObject({ requestId: 'req', frameId: 'frame', targetId: 'page', targetType: 'page', request: { sanitizedRequestHeaders: { Range: 'bytes=0-99', Cookie: '[REDACTED]' } }, initiator: { type: 'script', url: 'https://site.test/app?token=%5BREDACTED%5D' } });
    expect(network[3]).toMatchObject({ request: { status: 206, mimeType: 'video/mp4', contentLength: 100, contentRange: 'bytes 0-99/400' }, fromDiskCache: true, fromServiceWorker: true, timing: { requestTime: 2, receiveHeadersEnd: 12 } });
    expect(network[4]).toMatchObject({ encodedDataLength: 123, timestamp: 4 });
    expect(JSON.stringify(observations)).not.toMatch(/secret|user:pass/);
    await capture.stop();
  });

  it('attaches flattened worker sessions, tolerates unsupported domains and scopes duplicate request IDs', async () => {
    const { port, observations, events, capture } = setup();
    await capture.start({ targetId: 'page', type: 'page' });
    port.emit('Target.attachedToTarget', { sessionId: 'worker-session', targetInfo: { targetId: 'worker', type: 'worker', url: 'https://site.test/worker?token=secret' } });
    await capture.flush();
    port.emit('Network.requestWillBeSent', { requestId: 'same', request: { url: 'https://site.test/worker-media', method: 'GET', headers: {} } }, 'worker-session');
    port.emit('Network.requestWillBeSent', { requestId: 'same', request: { url: 'https://site.test/page-media', method: 'GET', headers: {} } });
    port.emit('Network.loadingFailed', { requestId: 'same', errorText: 'net::ERR_FAILED', canceled: false }, 'worker-session');
    expect(observations.find((item) => item.kind === 'network' && item.stage === 'failed')).toMatchObject({ sessionId: 'worker-session', targetType: 'worker', request: { sanitizedUrl: 'https://site.test/worker-media' }, failure: 'net::ERR_FAILED' });
    expect(port.commands).toContainEqual({ method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId: undefined });
    expect(port.commands).toContainEqual({ method: 'Network.enable', params: {}, sessionId: 'worker-session' });
    expect(events.some((event) => event.status === 'warning' && event.action.endsWith(':failed'))).toBe(true);
    await capture.stop();
    const count = observations.length;
    port.emit('Network.loadingFinished', { requestId: 'same' });
    expect(observations).toHaveLength(count);
    expect(port.detached).toBe(true);
    expect(JSON.stringify(observations)).not.toContain('secret');
  });

  it('validates the untrusted Runtime binding and drops payloads, unknown fields and oversized records', async () => {
    const { capture, port, observations } = setup();
    await capture.start({ targetId: 'page', type: 'page' });
    port.emit('Runtime.executionContextCreated', { context: { id: 7, auxData: { frameId: 'frame' } } });
    const payload = { type: 'append', objectId: 'mse-1', sourceBufferId: 'buffer-2', byteLength: 42, timestamp: 12, buffered: [[0, 1]], bytes: [1, 2, 3], key: 'secret' };
    port.emit('Runtime.bindingCalled', { name: '__mslEmit', executionContextId: 7, payload: JSON.stringify(payload) });
    port.emit('Runtime.bindingCalled', { name: '__mslEmit', payload: '{broken' });
    port.emit('Runtime.bindingCalled', { name: '__mslEmit', payload: JSON.stringify({ ...payload, byteLength: -1 }) });
    port.emit('Runtime.bindingCalled', { name: '__mslEmit', payload: 'x'.repeat(17000) });
    const mse = observations.filter((item) => item.kind === 'mse');
    expect(mse).toHaveLength(1);
    expect(mse[0]).toMatchObject({ frameId: 'frame', executionContextId: 7, metadata: { type: 'append', byteLength: 42, buffered: [[0, 1]] } });
    expect(JSON.stringify(mse)).not.toMatch(/secret|bytes/);
    await capture.stop();
  });
});

it('redacts lab sig aliases in every observation and event boundary', async () => {
  const { port, capture, observations, events } = setup();
  await capture.start({ targetId: 'page', type: 'page', url: 'https://site.test/?sig=labsecret' });
  port.emit('Network.requestWillBeSent', { requestId: 'signed', initiator: { url: 'https://site.test/?sig=labsecret' }, request: { url: 'https://site.test/v?sig=labsecret', method: 'GET', headers: { Referer: 'https://site.test/?sig=labsecret' } } });
  expect(JSON.stringify({ observations, events })).not.toContain('labsecret');
  await capture.stop();
});

it('clears prior run request and execution-context state on stop and detached targets', async () => {
  const { port, capture, observations } = setup();
  await capture.start({ targetId: 'page', type: 'page' });
  port.emit('Target.attachedToTarget', { sessionId: 'shared', targetInfo: { targetId: 'shared-target', type: 'shared_worker' } });
  await capture.flush();
  port.emit('Network.requestWillBeSent', { requestId: 'old', request: { url: 'https://site.test/old', method: 'GET', headers: {} } }, 'shared');
  port.emit('Target.detachedFromTarget', { sessionId: 'shared' });
  port.emit('Network.loadingFinished', { requestId: 'old' }, 'shared');
  await capture.stop();
  await capture.start({ targetId: 'new-page', type: 'page' });
  port.emit('Network.loadingFinished', { requestId: 'old' });
  expect(observations.some((item) => item.kind === 'network' && item.stage === 'finished')).toBe(false);
  expect(observations.some((item) => item.kind === 'target' && item.targetType === 'shared_worker' && item.stage === 'detached')).toBe(true);
  await capture.stop();
});

it('records the actual root CDP identity returned by the debugger', async () => {
  const { port, capture, observations } = setup();
  const send = port.send.bind(port);
  port.send = async (method, params, sessionId) => method === 'Target.getTargetInfo' ? { targetInfo: { targetId: 'actual-cdp-page', type: 'page' } } : send(method, params, sessionId);
  await capture.start({ targetId: 'numeric-webcontents', type: 'page' });
  expect(observations[0]).toMatchObject({ targetId: 'actual-cdp-page' });
  await capture.stop();
});

it('discovers shared workers only in the active target browser context', async () => {
  const { port, capture } = setup();
  const send = port.send.bind(port);
  port.send = async (method, params, sessionId) => method === 'Target.getTargetInfo' ? { targetInfo: { targetId: 'page', type: 'page', browserContextId: 'ours' } } : send(method, params, sessionId);
  await capture.start({ targetId: 'page', type: 'page' });
  port.emit('Target.targetCreated', { targetInfo: { targetId: 'ours-worker', type: 'shared_worker', browserContextId: 'ours' } });
  port.emit('Target.targetCreated', { targetInfo: { targetId: 'other-worker', type: 'shared_worker', browserContextId: 'other' } });
  await capture.flush();
  expect(port.commands.filter((item) => item.method === 'Target.attachToTarget').map((item) => item.params.targetId)).toEqual(['ours-worker']);
  await capture.stop();
});


it('bounds unresponsive CDP commands and records incomplete capture without a security conclusion', async () => {
  vi.useFakeTimers();
  const { port, capture, events } = setup();
  const send = port.send.bind(port);
  port.send = (method, params, sessionId) => method === 'Network.enable' ? new Promise(() => undefined) : send(method, params, sessionId);
  try {
    const starting = capture.start({ targetId: 'page', type: 'page' });
    await vi.advanceTimersByTimeAsync(5001);
    expect(events.some((event) => event.action === 'cdp-Network.enable:failed' && event.status === 'warning')).toBe(true);
    await starting;
    await capture.stop();
    expect(events.every((event) => event.conclusion === undefined)).toBe(true);
    expectCommandAuditPairs(events);
  } finally { vi.useRealTimers(); }
});

it('retains memory-cache evidence without mislabeling it as disk cache', async () => {
  const { port, capture, observations } = setup();
  await capture.start({ targetId: 'page', type: 'page' });
  port.emit('Network.requestWillBeSent', { requestId: 'cached', request: { url: 'https://site.test/video', method: 'GET', headers: {} } });
  port.emit('Network.requestServedFromCache', { requestId: 'cached' });
  port.emit('Network.responseReceived', { requestId: 'cached', response: { status: 200, mimeType: 'video/mp4', fromDiskCache: false, headers: {} } });
  expect(observations.at(-1)).toMatchObject({ kind: 'network', stage: 'response', fromCache: true, fromDiskCache: false });
  await capture.stop();
});

it.each([
  ['/video?ToKeN=token-secret&SiG=signature-secret&quality=720', '/video?ToKeN=%5BREDACTED%5D&SiG=%5BREDACTED%5D&quality=720'],
  ['../video?SIGNATURE=signature-secret&token=token-secret', '../video?SIGNATURE=%5BREDACTED%5D&token=%5BREDACTED%5D'],
  ['?sIg=signature-secret&TOKEN=token-secret', '?sIg=%5BREDACTED%5D&TOKEN=%5BREDACTED%5D'],
  ['//user:password@cdn.test/video?token=token-secret', '//cdn.test/video?token=%5BREDACTED%5D']
])('redacts relative redirect and content-location headers before observations or events: %s', async (reference, expected) => {
  const { port, capture, observations, events } = setup();
  await capture.start({ targetId: 'page', type: 'page' });
  port.emit('Network.requestWillBeSent', { requestId: 'redirect', request: { url: 'https://site.test/player/start', method: 'GET', headers: {} } });
  port.emit('Network.requestWillBeSent', {
    requestId: 'redirect',
    redirectResponse: { status: 302, headers: { lOcAtIoN: reference } },
    request: { url: 'https://site.test/player/video', method: 'GET', headers: {} }
  });
  port.emit('Network.responseReceived', { requestId: 'redirect', response: { status: 200, headers: { 'cOnTeNt-LoCaTiOn': reference } } });
  const redirects = observations.filter((item) => item.kind === 'network' && item.stage === 'redirect');
  const responses = observations.filter((item) => item.kind === 'network' && item.stage === 'response');
  expect(redirects[0]).toMatchObject({ request: { sanitizedResponseHeaders: { lOcAtIoN: expected } } });
  expect(responses[0]).toMatchObject({ request: { sanitizedResponseHeaders: { 'cOnTeNt-LoCaTiOn': expected } } });
  expect(JSON.stringify({ observations, events })).not.toMatch(/token-secret|signature-secret|user:password/);
  await capture.stop();
});


it('isolates reopened capture B from a delayed root result and queued callbacks from A', async () => {
  const { port, capture, observations, events } = setup();
  const send = port.send.bind(port);
  let resolveOldRoot!: (value: Record<string, unknown>) => void;
  const oldRoot = new Promise<Record<string, unknown>>((resolve) => { resolveOldRoot = resolve; });
  let roots = 0;
  port.send = async (method, params, sessionId) => {
    const result = await send(method, params, sessionId);
    if (method !== 'Target.getTargetInfo') return result;
    return ++roots === 1 ? oldRoot : { targetInfo: { targetId: 'root-B', type: 'page', browserContextId: 'context-B' } };
  };
  const startingA = capture.start({ targetId: 'fallback-A', type: 'page' });
  const oldMessage = port.listener;
  const oldDetach = port.detachListener;
  await capture.stop();
  expect(port.listener).toBeUndefined();
  expect(port.detachListener).toBeUndefined();
  await capture.start({ targetId: 'fallback-B', type: 'page' });
  const commandCount = port.commands.length;
  resolveOldRoot({ targetInfo: { targetId: 'root-A', type: 'page', browserContextId: 'context-A' } });
  await startingA;
  await capture.flush();
  expect(port.commands).toHaveLength(commandCount);
  oldMessage?.({ method: 'Network.requestWillBeSent', params: { requestId: 'stale', request: { url: 'https://site.test/stale', method: 'GET', headers: {} } } });
  oldDetach?.('stale detach callback');
  port.emit('Target.attachedToTarget', { sessionId: 'session-B', targetInfo: { targetId: 'worker-B', type: 'worker' } });
  await capture.flush();
  port.emit('Network.requestWillBeSent', { requestId: 'new-root', request: { url: 'https://site.test/root-B', method: 'GET', headers: {} } });
  port.emit('Network.requestWillBeSent', { requestId: 'new-worker', request: { url: 'https://site.test/worker-B', method: 'GET', headers: {} } }, 'session-B');
  expect(observations.find((item) => item.kind === 'network' && item.requestId === 'new-root')).toMatchObject({ targetId: 'root-B' });
  expect(observations.find((item) => item.kind === 'network' && item.requestId === 'new-worker')).toMatchObject({ targetId: 'worker-B', sessionId: 'session-B' });
  expect(observations.some((item) => item.kind === 'network' && item.requestId === 'stale')).toBe(false);
  expect(observations.some((item) => item.targetId === 'root-A')).toBe(false);
  await capture.stop();
  expectCommandAuditPairs(events);
  expect(port.listener).toBeUndefined();
  expect(port.detachListener).toBeUndefined();
});

it('cancels an unresolved startup command, drains startup and pairs every command audit exactly once', async () => {
  vi.useFakeTimers();
  const { port, capture, events } = setup();
  const send = port.send.bind(port);
  port.send = (method, params, sessionId) => method === 'Target.getTargetInfo' ? new Promise(() => undefined) : send(method, params, sessionId);
  let startupSettled = false;
  let stopSettled = false;
  try {
    const startup = capture.start({ targetId: 'page', type: 'page' }).then(() => { startupSettled = true; });
    const stopping = capture.stop().then(() => { stopSettled = true; });
    await vi.advanceTimersByTimeAsync(1);
    expect(stopSettled).toBe(true);
    expect(startupSettled).toBe(true);
    await Promise.all([startup, stopping, capture.flush()]);
    expect(vi.getTimerCount()).toBe(0);
    expectCommandAuditPairs(events);
    expect(events.filter((event) => event.action === 'cdp-Target.getTargetInfo:cancelled')).toHaveLength(1);
    expect(events.find((event) => event.action === 'cdp-Target.getTargetInfo:cancelled')).toMatchObject({ status: 'cancelled' });
  } finally { await vi.runAllTimersAsync(); vi.useRealTimers(); }
});

it('drains child commands during rapid close/reopen and ignores late transport rejection', async () => {
  vi.useFakeTimers();
  const { port, capture, events, observations } = setup();
  const send = port.send.bind(port);
  let rejectOldCommand!: (reason: Error) => void;
  const oldCommand = new Promise<Record<string, unknown>>((_resolve, reject) => { rejectOldCommand = reject; });
  port.send = (method, params, sessionId) => method === 'Network.enable' && sessionId === 'old-session' ? oldCommand : send(method, params, sessionId);
  try {
    await capture.start({ targetId: 'page-A', type: 'page' });
    port.emit('Target.attachedToTarget', { sessionId: 'old-session', targetInfo: { targetId: 'old-worker', type: 'worker' } });
    await vi.advanceTimersByTimeAsync(1);
    let stopped = false;
    const stopping = capture.stop().then(() => { stopped = true; });
    const reopening = capture.start({ targetId: 'page-B', type: 'page' });
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(true);
    await Promise.all([stopping, reopening, capture.flush()]);
    const count = port.commands.length;
    rejectOldCommand(new Error('late obsolete transport failure'));
    await vi.advanceTimersByTimeAsync(1);
    expect(port.commands).toHaveLength(count);
    port.emit('Network.requestWillBeSent', { requestId: 'B', request: { url: 'https://site.test/new', method: 'GET', headers: {} } });
    expect(observations.at(-1)).toMatchObject({ kind: 'network', targetId: 'page-B', requestId: 'B' });
    await capture.stop();
    expect(port.listener).toBeUndefined();
    expect(port.detachListener).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expectCommandAuditPairs(events);
    expect(events.filter((event) => event.action === 'cdp-Network.enable:cancelled' && event.evidence?.targetSession === 'old-session')).toHaveLength(1);
  } finally { await vi.runAllTimersAsync(); vi.useRealTimers(); }
});

function expectCommandAuditPairs(events: EmitRunEventInput[]): void {
  const commands = events.filter((event) => event.action.startsWith('cdp-'));
  const before = commands.filter((event) => event.action.endsWith(':before'));
  const terminal = commands.filter((event) => /:(after|failed|cancelled)$/.test(event.action));
  expect(terminal).toHaveLength(before.length);
  expect(new Set(before.map((event) => event.evidence?.commandId)).size).toBe(before.length);
  for (const event of before) {
    const matches = terminal.filter((item) => item.evidence?.commandId === event.evidence?.commandId);
    expect(matches).toHaveLength(1);
    expect(matches[0].action.slice(0, matches[0].action.lastIndexOf(':'))).toBe(event.action.slice(0, -7));
    expect(matches[0].evidence?.captureGeneration).toBe(event.evidence?.captureGeneration);
  }
}

it('sends raw replay templates only through the optional main-process callback', async () => {
  const port = new FakePort(); const raw: unknown[] = []; const publicData: unknown[] = [];
  const capture = new CdpCapture({ runId: 'run', port, emit: e => publicData.push(e), observe: e => publicData.push(e), rememberRequest: request => raw.push(request) });
  await capture.start({ targetId: 'page', type: 'page' });
  port.emit('Network.requestWillBeSent', { requestId: '42', request: { url: 'https://example.test/v?sig=secret-marker', method: 'GET', headers: { Cookie: 'secret-marker' } } });
  expect(raw).toEqual([expect.objectContaining({ id: expect.any(String), sourceIdentity: expect.objectContaining({ runId: 'run', targetId: 'page', requestId: '42' }), url: 'https://example.test/v?sig=secret-marker', requestHeaders: { Cookie: 'secret-marker' } })]);
  expect(JSON.stringify(publicData)).not.toContain('secret-marker');
  await capture.stop();
  port.emit('Network.requestWillBeSent', { requestId: '43', request: { url: 'https://example.test/v', method: 'GET' } });
  expect(raw).toHaveLength(1);
});

it('versions reused CDP request IDs across frames and redirects without changing old source references', async () => {
  const port = new FakePort(); const raw: import('../../src/main/runs/run-orchestrator').EphemeralRequest[] = []; const observed: CaptureObservation[] = [];
  const capture = new CdpCapture({ runId: 'run', port, emit: () => undefined, observe: e => observed.push(e), rememberRequest: request => raw.push(request) });
  await capture.start({ targetId: 'page', type: 'page' });
  for (const [index, frameId] of ['frame1', 'frame2', 'frame2'].entries()) port.emit('Network.requestWillBeSent', { requestId: '42', frameId, request: { url: `https://example.test/v?token=secret-${index}`, method: 'GET' }, ...(index === 2 ? { redirectResponse: { status: 302 } } : {}) });
  expect(new Set(raw.map(r => r.id)).size).toBe(3);
  expect(raw[0].sourceIdentity).toMatchObject({ runId: 'run', targetId: 'page', sessionId: '', frameId: 'frame1', requestId: '42' });
  expect(raw[2].sourceIdentity?.version).toBeGreaterThan(raw[1].sourceIdentity!.version);
  expect(observed.filter(o => o.kind === 'network' && o.stage === 'request').map(o => o.kind === 'network' && o.request.id)).toEqual(raw.map(r => r.id));
  expect(JSON.stringify(observed)).not.toContain('secret-');
  await capture.stop();
});

it('does not reuse request versions across separate capture instances in one run', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const port = new FakePort();
    const capture = new CdpCapture({ runId: 'run', port, emit: () => undefined, observe: () => undefined, rememberRequest: r => ids.push(r.id) });
    await capture.start({ targetId: 'page', type: 'page' });
    port.emit('Network.requestWillBeSent', { requestId: '42', frameId: 'frame', request: { url: `https://example.test/v?token=secret-${i}`, method: 'GET' } });
    await capture.stop();
  }
  expect(new Set(ids).size).toBe(2);
});
