import { z } from 'zod';
import { createSourceRequestReference, type CaptureIdentity, type CaptureObservation, type CapturedRequest, type MseMetadata } from '../../shared/contracts';
import type { EmitRunEventInput, EphemeralRequest } from '../runs/run-orchestrator';
import { createSanitizedCapturedUrl, redactEvidence, redactHeaders, redactText, redactUrl } from '../security/redact';
import type { CdpMessage, DebuggerPort } from './debugger-port';
import { MSE_INSTRUMENTATION } from './mse-instrumentation';

let lastSourceVersion = 0;

export type CaptureEventSink = (event: EmitRunEventInput) => unknown;
export interface CaptureTarget { targetId: string; type: string; url?: string }
export interface CaptureOptions {
  runId: string;
  port: DebuggerPort;
  emit: CaptureEventSink;
  observe: (observation: CaptureObservation) => void;
  onError?: () => void;
  /** Main-process-only sink into the active run; never put raw templates in observations. */
  rememberRequest?: (request: EphemeralRequest) => void;
}
interface State {
  requestVersion?: number;
  identities: Map<string, CaptureIdentity>;
  requests: Map<string, Extract<CaptureObservation, { kind: 'network' }>>;
  contexts: Map<string, string>;
}
const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const headers = (value: unknown): Record<string, string> => Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
const keyFor = (session: string | undefined, id: unknown) => JSON.stringify([session ?? '', id]);
const sanitizedUrl = (value: unknown): string | undefined => {
  try { return typeof value === 'string' ? redactUrl(value) : undefined; } catch { return undefined; }
};
const idSchema = z.string().regex(/^(mse|buffer)-\d+$/).max(64);
const timestamp = z.number().finite().nonnegative();
const mseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('object-url'), objectId: idSchema, objectUrl: z.string().max(2048).regex(/^blob:/), timestamp }),
  z.object({ type: z.literal('source-buffer'), objectId: idSchema, sourceBufferId: idSchema, mimeType: z.string().max(512), timestamp }),
  z.object({ type: z.literal('append'), objectId: idSchema, sourceBufferId: idSchema, byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), timestamp, buffered: z.array(z.tuple([timestamp, timestamp])).max(64) })
]);

/** Pure transition: never stores raw CDP payloads or payload bytes. */
export function reduceCapture(state: State, message: CdpMessage, receivedAt: string): { state: State; observations: CaptureObservation[] } {
  const p = message.params;
  const session = message.sessionId ?? '';
  const identity = state.identities.get(session);
  if (!identity) return { state, observations: [] };
  const next: State = { requestVersion: state.requestVersion, identities: new Map(state.identities), requests: new Map(state.requests), contexts: new Map(state.contexts) };
  const observations: CaptureObservation[] = [];
  if (message.method === 'Runtime.executionContextCreated') {
    const context = record(p.context);
    const frame = string(record(context.auxData).frameId);
    if (frame) next.contexts.set(keyFor(session, context.id), frame);
  } else if (message.method === 'Runtime.executionContextDestroyed') {
    next.contexts.delete(keyFor(session, p.executionContextId));
  } else if (message.method === 'Runtime.executionContextsCleared') {
    for (const key of next.contexts.keys()) if (JSON.parse(key)[0] === session) next.contexts.delete(key);
  } else if (message.method === 'Target.attachedToTarget') {
    const info = record(p.targetInfo);
    const attachedSession = string(p.sessionId);
    const targetId = string(info.targetId);
    if (attachedSession && targetId) {
      const attached: CaptureIdentity = { runId: identity.runId, targetId, targetType: string(info.type) ?? 'other', sessionId: attachedSession };
      next.identities.set(attachedSession, attached);
      observations.push({ ...attached, kind: 'target', stage: 'attached', sanitizedUrl: sanitizedUrl(info.url) });
    }
  } else if (message.method === 'Target.detachedFromTarget') {
    const detachedSession = string(p.sessionId) ?? '';
    const detached = next.identities.get(detachedSession);
    if (detached) observations.push({ ...detached, kind: 'target', stage: 'detached' });
    next.identities.delete(detachedSession);
    for (const [key, item] of next.requests) if (item.sessionId === detachedSession) next.requests.delete(key);
    for (const key of next.contexts.keys()) if (JSON.parse(key)[0] === detachedSession) next.contexts.delete(key);
  } else if (message.method.startsWith('Page.frame')) {
    const frame = record(p.frame);
    const frameId = string(frame.id) ?? string(p.frameId);
    const stage = ({ 'Page.frameAttached': 'attached', 'Page.frameNavigated': 'navigated', 'Page.frameDetached': 'detached' } as const)[message.method as 'Page.frameAttached'];
    if (frameId && stage) observations.push({ ...identity, kind: 'frame', frameId, parentFrameId: string(frame.parentId) ?? string(p.parentFrameId), stage, sanitizedUrl: sanitizedUrl(frame.url) });
  } else if (message.method === 'Runtime.bindingCalled' && p.name === '__mslEmit' && typeof p.payload === 'string' && p.payload.length <= 16384) {
    try {
      const result = mseSchema.safeParse(JSON.parse(p.payload));
      if (result.success) {
        let metadata: MseMetadata = result.data;
        if (metadata.type === 'object-url') metadata = { ...metadata, objectUrl: sanitizeBlob(metadata.objectUrl) };
        if (metadata.type === 'source-buffer') metadata = { ...metadata, mimeType: redactText(metadata.mimeType) };
        observations.push({ ...identity, kind: 'mse', executionContextId: number(p.executionContextId), frameId: next.contexts.get(keyFor(session, p.executionContextId)), metadata });
      }
    } catch { /* Invalid untrusted instrumentation is ignored. */ }
  } else if (message.method.startsWith('Network.') && typeof p.requestId === 'string') {
    const key = keyFor(session, p.requestId);
    const previous = next.requests.get(key);
    if (message.method === 'Network.requestWillBeSent') {
      const request = record(p.request);
      let url: string;
      try { url = createSanitizedCapturedUrl(String(request.url)); } catch { return { state: next, observations }; }
      if (previous && p.redirectResponse) observations.push(responseObservation(previous, record(p.redirectResponse), p, 'redirect'));
      next.requestVersion = (next.requestVersion ?? 0) + 1;
      const sourceIdentity = { runId: identity.runId, targetId: identity.targetId, sessionId: message.sessionId ?? '', frameId: string(p.frameId) ?? '', requestId: p.requestId, version: next.requestVersion };
      const captured: CapturedRequest = { id: createSourceRequestReference(sourceIdentity), sourceIdentity, runId: identity.runId, sanitizedUrl: url, method: string(request.method) ?? 'GET', frameId: string(p.frameId), sessionId: message.sessionId, resourceType: string(p.type), sanitizedRequestHeaders: redactHeaders(headers(request.headers)), receivedAt };
      const observation: Extract<CaptureObservation, { kind: 'network' }> = { ...identity, frameId: captured.frameId, kind: 'network', stage: 'request', requestId: p.requestId, request: captured, timestamp: number(p.timestamp), initiator: redactEvidence(record(p.initiator)) };
      next.requests.set(key, observation);
      observations.push(observation);
    } else if (previous) {
      let observation: Extract<CaptureObservation, { kind: 'network' }> | undefined;
      if (message.method === 'Network.responseReceived') observation = responseObservation(previous, record(p.response), p, 'response');
      if (message.method === 'Network.requestServedFromCache') observation = { ...previous, stage: 'cache', fromCache: true };
      if (message.method === 'Network.loadingFinished') observation = { ...previous, stage: 'finished', timestamp: number(p.timestamp), encodedDataLength: number(p.encodedDataLength) };
      if (message.method === 'Network.loadingFailed') observation = { ...previous, stage: 'failed', timestamp: number(p.timestamp), failure: redactText(string(p.errorText) ?? 'Network request failed'), canceled: p.canceled === true };
      if (observation) {
        observations.push(observation);
        if (observation.stage === 'finished' || observation.stage === 'failed') next.requests.delete(key);
        else next.requests.set(key, observation);
      }
    }
  }
  return { state: next, observations };
}

function sanitizeBlob(value: string): string {
  // A blob URL is an opaque correlation label. Strip credentials/query from its inner URL.
  return `blob:${sanitizedUrl(value.slice(5)) ?? '[opaque]'}`;
}
function responseObservation(previous: Extract<CaptureObservation, { kind: 'network' }>, response: Record<string, unknown>, params: Record<string, unknown>, stage: 'response' | 'redirect'): Extract<CaptureObservation, { kind: 'network' }> {
  const responseHeaders = redactHeaders(headers(response.headers));
  const findHeader = (name: string) => Object.entries(responseHeaders).find(([key]) => key.toLowerCase() === name)?.[1];
  const length = findHeader('content-length');
  return {
    ...previous, stage, timestamp: number(params.timestamp), encodedDataLength: number(response.encodedDataLength),
    request: { ...previous.request, status: number(response.status), mimeType: string(response.mimeType), sanitizedResponseHeaders: responseHeaders, contentLength: length && /^\d+$/.test(length) ? Number(length) : undefined, contentRange: findHeader('content-range') },
    fromCache: previous.fromCache === true || response.fromDiskCache === true || response.fromPrefetchCache === true,
    fromDiskCache: response.fromDiskCache === true, fromServiceWorker: response.fromServiceWorker === true,
    timing: Object.fromEntries(Object.entries(record(response.timing)).filter((entry): entry is [string, number] => number(entry[1]) !== undefined))
  };
}

interface CaptureLifecycle {
  generation: number;
  controller: AbortController;
  state: State;
  pending: Set<Promise<void>>;
  firstMedia: boolean;
  browserContextId?: string;
  removeMessage?: () => void;
  removeDetach?: () => void;
}

export class CdpCapture {
  private current?: CaptureLifecycle;
  private stopping?: Promise<void>;
  private generation = 0;
  private commandSequence = 0;
  constructor(private readonly options: CaptureOptions) {}

  async start(target: CaptureTarget): Promise<void> {
    // A reopening must wait for the old transport to detach and its tracked work to drain.
    if (this.stopping) await this.stopping;
    if (this.current) throw new Error('Capture already active');
    const lifecycle: CaptureLifecycle = {
      generation: ++this.generation,
      controller: new AbortController(),
      state: { requestVersion: 0, identities: new Map(), requests: new Map(), contexts: new Map() },
      pending: new Set(),
      firstMedia: false
    };
    this.current = lifecycle;
    this.audit('debugger-attach', 'before');
    try {
      this.options.port.attach();
      lifecycle.state.identities.set('', { runId: this.options.runId, targetId: target.targetId, targetType: target.type });
      lifecycle.removeMessage = this.options.port.onMessage((message) => {
        if (!this.isCurrent(lifecycle)) return;
        try { this.handle(lifecycle, message); } catch { this.fail(lifecycle, 'capture-observation'); }
      });
      lifecycle.removeDetach = this.options.port.onDetach?.(() => this.fail(lifecycle, 'debugger-detach'));
      this.audit('debugger-attach', 'after');
      await this.track(lifecycle, this.initialize(lifecycle, target));
    } catch (error) {
      if (this.isCurrent(lifecycle)) {
        this.audit('debugger-attach', 'failed');
        await this.stop();
      }
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const lifecycle = this.current;
    if (!lifecycle) return Promise.resolve();
    // Install the close barrier before callbacks can attempt to reopen this capture.
    const stopping = Promise.resolve().then(() => this.stopLifecycle(lifecycle));
    this.stopping = stopping;
    void stopping.then(
      () => { if (this.stopping === stopping) this.stopping = undefined; },
      () => { if (this.stopping === stopping) this.stopping = undefined; }
    );
    this.audit('capture-stop', 'before');
    this.current = undefined;
    lifecycle.controller.abort();
    lifecycle.removeMessage?.(); lifecycle.removeDetach?.();
    lifecycle.removeMessage = undefined; lifecycle.removeDetach = undefined;
    lifecycle.state = { identities: new Map(), requests: new Map(), contexts: new Map() };
    lifecycle.browserContextId = undefined;
    lifecycle.firstMedia = false;
    return stopping;
  }

  async flush(): Promise<void> {
    if (this.stopping) await this.stopping;
    else if (this.current) await this.drain(this.current);
  }

  private async initialize(lifecycle: CaptureLifecycle, target: CaptureTarget): Promise<void> {
    const root = record((await this.command(lifecycle, 'Target.getTargetInfo', {}))?.targetInfo);
    if (!this.isCurrent(lifecycle)) return;
    lifecycle.browserContextId = string(root.browserContextId);
    if (typeof root.targetId === 'string') lifecycle.state.identities.set('', { runId: this.options.runId, targetId: root.targetId, targetType: string(root.type) ?? target.type });
    this.publish(lifecycle, { ...lifecycle.state.identities.get('')!, kind: 'target', stage: 'attached', sanitizedUrl: sanitizedUrl(target.url) });
    await this.enable(lifecycle);
    await this.command(lifecycle, 'Target.setDiscoverTargets', { discover: true, filter: [{ type: 'shared_worker' }] });
  }

  private async stopLifecycle(lifecycle: CaptureLifecycle): Promise<void> {
    try {
      // Even if detachment fails, cancellation has already released every command waiter.
      try { this.options.port.detach(); } finally { await this.drain(lifecycle); }
      this.audit('capture-stop', 'after');
    } catch (error) { this.audit('capture-stop', 'failed'); throw error; }
  }

  private async drain(lifecycle: CaptureLifecycle): Promise<void> {
    const failures: unknown[] = [];
    while (lifecycle.pending.size) {
      const results = await Promise.allSettled([...lifecycle.pending]);
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
    }
    if (failures.length) throw new AggregateError(failures, 'Capture work failed while draining');
  }

  private track(lifecycle: CaptureLifecycle, work: Promise<void>): Promise<void> {
    const tracked = work.finally(() => lifecycle.pending.delete(tracked));
    lifecycle.pending.add(tracked);
    return tracked;
  }

  private isCurrent(lifecycle: CaptureLifecycle): boolean {
    return this.current === lifecycle && !lifecycle.controller.signal.aborted;
  }

  private fail(lifecycle: CaptureLifecycle, action: string): void {
    if (!this.isCurrent(lifecycle)) return;
    this.audit(action, 'failed');
    void this.stop().then(() => this.options.onError?.(), () => this.options.onError?.());
  }

  private handle(lifecycle: CaptureLifecycle, message: CdpMessage): void {
    if (!this.isCurrent(lifecycle)) return;
    if (message.method === 'Target.targetCreated') {
      const info = record(message.params.targetInfo);
      if (lifecycle.browserContextId && info.browserContextId === lifecycle.browserContextId && info.type === 'shared_worker' && typeof info.targetId === 'string') {
        void this.track(lifecycle, this.command(lifecycle, 'Target.attachToTarget', { targetId: info.targetId, flatten: true }).then(() => undefined))
          .catch(() => this.fail(lifecycle, 'capture-command'));
      }
    }
    const result = reduceCapture({ ...lifecycle.state, requestVersion: lastSourceVersion }, message, new Date().toISOString());
    lastSourceVersion = result.state.requestVersion ?? lastSourceVersion;
    lifecycle.state = result.state;
    if (message.method === 'Network.requestWillBeSent' && result.observations.some(item => item.kind === 'network' && item.stage === 'request')) {
      const request = record(message.params.request);
      const observed = result.observations.find(item => item.kind === 'network' && item.stage === 'request') as Extract<CaptureObservation, { kind: 'network' }>;
      const raw: EphemeralRequest = { id: observed.request.id, sourceIdentity: observed.request.sourceIdentity, url: String(request.url), method: string(request.method) ?? 'GET', sessionId: message.sessionId, frameId: string(message.params.frameId), requestHeaders: headers(request.headers) };
      if (raw.url.length <= 16384 && JSON.stringify(raw).length <= 65536) this.options.rememberRequest?.(raw);
    }
    for (const observation of result.observations) this.publish(lifecycle, observation);
    if (message.method === 'Target.attachedToTarget' && typeof message.params.sessionId === 'string') {
      void this.track(lifecycle, this.enable(lifecycle, message.params.sessionId))
        .catch(() => this.fail(lifecycle, 'capture-command'));
    }
  }

  private publish(lifecycle: CaptureLifecycle, observation: CaptureObservation): void {
    if (!this.isCurrent(lifecycle)) return;
    const action = observation.kind === 'target' ? `target-${observation.stage}` : `capture-${observation.kind}`;
    this.audit(action, 'before');
    this.options.observe(observation);
    this.audit(action, 'after', { observation });
    if (!lifecycle.firstMedia && (observation.kind === 'mse' || (observation.kind === 'network' && /video|audio|mpegurl|dash/i.test(observation.request.mimeType ?? '')))) {
      lifecycle.firstMedia = true;
      this.audit('first-media-candidate', 'before'); this.audit('first-media-candidate', 'after');
    }
  }

  private async enable(lifecycle: CaptureLifecycle, sessionId?: string): Promise<void> {
    await this.command(lifecycle, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
    for (const domain of ['Network', 'Runtime', 'Page', 'Media']) await this.command(lifecycle, `${domain}.enable`, {}, sessionId);
    await this.command(lifecycle, 'Runtime.addBinding', { name: '__mslEmit' }, sessionId);
    await this.command(lifecycle, 'Page.addScriptToEvaluateOnNewDocument', { source: MSE_INSTRUMENTATION }, sessionId);
    await this.command(lifecycle, 'Runtime.evaluate', { expression: MSE_INSTRUMENTATION }, sessionId);
  }

  private async command(lifecycle: CaptureLifecycle, method: string, params: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown> | undefined> {
    if (!this.isCurrent(lifecycle)) return;
    const evidence = { targetSession: sessionId, captureGeneration: lifecycle.generation, commandId: ++this.commandSequence };
    this.audit(`cdp-${method}`, 'before', evidence);
    let terminalEmitted = false;
    const terminal = (stage: 'after' | 'failed' | 'cancelled') => {
      if (terminalEmitted) return;
      terminalEmitted = true;
      this.audit(`cdp-${method}`, stage, stage === 'failed'
        ? { ...evidence, limitation: 'CDP command unavailable; capture may be incomplete' }
        : evidence, stage === 'failed');
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cancelled = Symbol('cancelled');
    let onAbort: () => void = () => undefined;
    const cancellation = new Promise<typeof cancelled>((resolve) => {
      onAbort = () => resolve(cancelled);
      lifecycle.controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      if (!this.isCurrent(lifecycle)) { terminal('cancelled'); return; }
      const result = await Promise.race([
        this.options.port.send(method, params, sessionId),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('CDP command timed out')), 5000); }),
        cancellation
      ]);
      if (result === cancelled || !this.isCurrent(lifecycle)) { terminal('cancelled'); return; }
      if (result.exceptionDetails) throw new Error('Target instrumentation evaluation failed');
      terminal('after');
      return result;
    } catch {
      terminal(this.isCurrent(lifecycle) ? 'failed' : 'cancelled');
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      lifecycle.controller.signal.removeEventListener('abort', onAbort);
    }
  }

  private audit(action: string, stage: 'before' | 'after' | 'failed' | 'cancelled', evidence?: Record<string, unknown>, warning = false): void {
    this.options.emit({ runId: this.options.runId, phase: 'capture', action: `${action}:${stage}`, purpose: 'Observe authorized browser media metadata', status: stage === 'before' ? 'running' : stage === 'after' ? 'succeeded' : stage === 'cancelled' ? 'cancelled' : warning ? 'warning' : 'failed', relatedIds: [], evidence });
  }
}
