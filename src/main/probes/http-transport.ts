import type { NetworkPolicy } from './address-policy';
import { openPinnedResponse, normalizedHeaders, replayHeaders, prohibitedResource, allowedRedirect, redirectHeaders, type OpenResponse } from './http-request';
import { recognizableMedia } from './media-bytes';
import { StreamingEncryptionClassifier } from '../download/streaming-encryption';
import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import type { MediaTrack, ProbeOutcome } from '../../shared/contracts';
import type { RunOrchestrator, EphemeralRequest } from '../runs/run-orchestrator';
import { redactHeaders, redactUrl } from '../security/redact';
import { eligibleTrack, planProbes, SHORT_PROBE_BYTES, type ProbePlan } from './probe-planner';

export type TransportOutcome = 'http' | 'dns' | 'tls' | 'timeout' | 'parser' | 'network' | 'cancelled' | 'limitation';
export interface HttpEvidence {
  outcome: ProbeOutcome;
  transportOutcome: TransportOutcome;
  status?: number;
  responseMimeType?: string;
  contentRange?: string;
  contentLength?: number;
  bytesReceived: number;
  durationMs: number;
  sampleSha256?: string;
  intentionallySampled?: boolean;
  serverRangeCapped?: boolean;
  baselineAccess?: boolean;
  /** Structural bytes recognized locally, or exact non-head range linked to this source's recognized head. */
  mediaEvidence?: 'structural' | 'linked-range';
  requestDiff: Record<string, unknown>;
  redirects: { status: number; sanitizedUrl: string; followed: boolean }[];
  limitations: string[];
  conclusion: string;
  responses?: HttpEvidence[];
}
export interface DownloadGrant {
  track: MediaTrack;
  sourceRequestId: string;
  totalBytes?: number;
  /** Raw validators are main-process memory only; manifests store a digest. */
  etag?: string;
  lastModified?: string;
}
interface TransportOptions {
  context: RunOrchestrator;
  runId: string;
  track: MediaTrack;
  timeoutMs?: number;
  maxExpiryWaitMs?: number;
  downloadInactivityMs?: number;
  maxConcurrency?: number;
  networkPolicy?: NetworkPolicy;
}
interface ResponseSample { status: number; headers: Record<string, string>; sample: Buffer; bytes: number; durationMs: number; intentionallySampled: boolean; failure?: TransportOutcome }
const pools = new WeakMap<RunOrchestrator, Map<string, Pool>>();

/** A server HTTP test, independent of Chromium's cookies, CORS, cache and service workers. */
export class HttpTransport {
  private readonly track: MediaTrack;
  private readonly pool: Pool;
  private readonly shortSuccess = new Set<string>();
  private readonly recognizedSources = new Set<string>();
  private readonly downloadEvidence = new Map<string, DownloadGrant>();
  constructor(private readonly options: TransportOptions) {
    this.track = structuredClone(options.track);
    options.context.getAbortSignal(options.runId).addEventListener('abort', () => { this.downloadEvidence.clear(); this.recognizedSources.clear(); this.shortSuccess.clear(); }, { once: true });
    let runs = pools.get(options.context);
    if (!runs) { runs = new Map(); pools.set(options.context, runs); }
    let pool = runs.get(options.runId);
    if (!pool) {
      pool = new Pool(Math.min(clamp(options.maxConcurrency, 4, 1, 4), clamp(options.context.getDownloadSettings(options.runId).maxConcurrency, 4, 1, 4))); runs.set(options.runId, pool);
      options.context.getAbortSignal(options.runId).addEventListener('abort', () => runs!.delete(options.runId), { once: true });
    }
    this.pool = pool;
  }

  async execute(plan: ProbePlan, signal: AbortSignal): Promise<HttpEvidence> {
    const start = performance.now();
    let combined: AbortSignal;
    try { combined = AbortSignal.any([signal, this.options.context.getAbortSignal(this.options.runId)]); }
    catch { return limitation('Active request context is unavailable'); }
    if (combined.aborted) return failure('cancelled');
    if (this.track.encrypted) return { ...limitation('Encryption detected; no decryption or bypass attempted'), outcome: 'encrypted' };
    if (!eligibleTrack(this.track)) return limitation('Selected media lifecycle is incomplete or ineligible');
    const mode = this.options.context.getMode(this.options.runId);
    const template = planProbes(this.track, mode).find(item => item.id === plan.id);
    if (!template || plan.trackId !== this.track.id || !this.track.sourceRequestIds.includes(plan.sourceRequestId)) return limitation('Probe is outside the selected mode or observed track');
    // Keep the selected immutable incarnation; canonicalize only mutation/cap/scope metadata.
    const canonical = { ...template, sourceRequestId: plan.sourceRequestId };
    if (canonical.id === 'range-full' && !this.shortSuccess.has(canonical.sourceRequestId)) return limitation('Full Range requires a successful short target-byte probe');
    const raw = this.options.context.resolveRequest(this.options.runId, plan.sourceRequestId);
    if (!raw || raw.id !== plan.sourceRequestId || raw.method !== 'GET' || redactUrl(raw.url) !== this.track.sanitizedUrl) return limitation('Observed GET template is unavailable or no longer matches this track');
    if (prohibitedResource(new URL(raw.url))) return limitation('Key or license resources are outside media probe scope');
    if (canonical.id === 'expiry-replay') {
      const expiry = observedExpiry(raw.url);
      if (expiry === undefined) return limitation('Observed expiry cannot be interpreted; expiry replay skipped');
      const delay = Math.max(0, expiry - Date.now() + 25);
      if (delay > clamp(this.options.maxExpiryWaitMs, 5000, 0, 5000)) return limitation('Observed expiry exceeds the bounded wait; expiry replay skipped');
      try { await wait(delay, undefined, { signal: combined }); } catch { return failure('cancelled'); }
    }
    const count = canonical.id === 'range-concurrent' ? this.pool.limit : 1;
    const responses = await Promise.all(Array.from({ length: count }, (_, index) => this.pool.withSlot(combined, () => this.replay(raw, canonical, index, combined))));
    const primary = responses[0];
    const result: HttpEvidence = count === 1 ? primary : {
      ...primary,
      outcome: responses.every(item => item.outcome === 'accessible') ? 'accessible' : responses.every(item => item.outcome === 'denied') ? 'denied' : responses.some(item => item.outcome === 'encrypted') ? 'encrypted' : 'inconclusive',
      bytesReceived: responses.reduce((sum, item) => sum + item.bytesReceived, 0), responses,
      conclusion: responses.every(item => item.outcome === 'accessible') ? 'Concurrent bounded target bytes accessible; this does not verify full playback' : 'Concurrent probes have mixed or unavailable evidence; inspect each response'
    };
    result.durationMs = Math.round(performance.now() - start);
    result.limitations.push(...canonical.limitations);
    if (result.outcome === 'accessible' && canonical.id !== 'range-full') this.shortSuccess.add(raw.id);
    return result;
  }

  /** Successful bounded evidence is kept inside this transport, keyed by full immutable source reference. */
  authorizeDownload(context: RunOrchestrator, runId: string, sourceRequestId: string): DownloadGrant {
    if (context !== this.options.context || runId !== this.options.runId || !context.isActive(runId)) throw new Error('fresh-capture-required');
    const settings = context.getDownloadSettings(runId);
    if (context.getAbortSignal(runId).aborted || settings.mode !== 'full-download' || settings.authorizationConfirmed !== true || !eligibleTrack(this.track)) throw new Error('unauthorized');
    const raw = context.resolveRequest(runId, sourceRequestId);
    if (!raw) throw new Error('fresh-capture-required');
    if (raw.method !== 'GET' || !this.track.sourceRequestIds.includes(sourceRequestId) || redactUrl(raw.url) !== this.track.sanitizedUrl || prohibitedResource(new URL(raw.url))) throw new Error('ineligible');
    const evidence = this.downloadEvidence.get(sourceRequestId);
    if (!evidence) throw new Error('bounded-evidence-required');
    return structuredClone(evidence);
  }

  async openDownloadRange(context: RunOrchestrator, runId: string, sourceRequestId: string, range: string, ifRange: string | undefined, signal: AbortSignal): Promise<OpenResponse> {
    this.authorizeDownload(context, runId, sourceRequestId);
    const release = await this.pool.acquire(signal);
    try {
      this.authorizeDownload(context, runId, sourceRequestId);
      const raw = context.resolveRequest(runId, sourceRequestId)!;
      let url = new URL(raw.url);
      let headers: Record<string, string> = { ...replayHeaders(raw.requestHeaders ?? {}), range, 'accept-encoding': 'identity', ...(ifRange ? { 'if-range': ifRange } : {}) };
      const allowed = new Set(this.track.sourceRequestIds.map(id => context.resolveRequest(runId, id)?.url));
      for (let hops = 0;; hops++) {
        signal.throwIfAborted();
        const opened = await openPinnedResponse(url, headers, signal, clamp(this.options.timeoutMs, 10000, 10, 30000), this.options.networkPolicy ?? {}, { bodyInactivityMs: clamp(this.options.downloadInactivityMs ?? this.options.timeoutMs, 10000, 10, 30000) });
        if (![301, 302, 303, 307, 308].includes(opened.response.statusCode ?? 0)) {
          opened.response.once('close', release);
          return { response: opened.response, progress: opened.progress, close: () => { opened.close(); release(); } };
        }
        const location = opened.response.headers.location;
        opened.close();
        let next: URL;
        try { next = new URL(location ?? '', url); } catch { throw new Error('unsafe-redirect'); }
        if (!location || !allowedRedirect(next, allowed, hops)) throw new Error('unsafe-redirect');
        headers = redirectHeaders(headers, url, next);
        url = next;
      }
    } catch (error) { release(); throw error; }
  }

  private async replay(raw: EphemeralRequest, plan: ProbePlan, index: number, signal: AbortSignal): Promise<HttpEvidence> {
    let url = new URL(raw.url);
    const original = lowerHeaders(raw.requestHeaders ?? {});
    let requestHeaders = replayHeaders(original);
    const omit = ({ 'without-cookie': 'cookie', 'without-referer': 'referer', 'without-origin': 'origin' } as Record<string, string>)[plan.id];
    if (omit) delete requestHeaders[omit];
    if (plan.id === 'without-query') url.search = '';
    const total = this.track.byteLength;
    if (plan.id === 'range-middle' && (!total || !Number.isSafeInteger(total))) return limitation('Observed total length unavailable; middle range skipped');
    let range = `bytes=0-${SHORT_PROBE_BYTES - 1}`;
    if (plan.id === 'range-middle') { const start = Math.floor(total! / 2); range = `bytes=${start}-${start + SHORT_PROBE_BYTES - 1}`; }
    if (plan.id === 'range-tail') range = `bytes=-${SHORT_PROBE_BYTES}`;
    if (plan.id === 'range-full') range = 'bytes=0-';
    if (plan.id === 'range-concurrent') { const start = index * SHORT_PROBE_BYTES; range = `bytes=${start}-${start + SHORT_PROBE_BYTES - 1}`; }
    requestHeaders.range = range;
    requestHeaders['accept-encoding'] = 'identity';
    const requestDiff: Record<string, unknown> = {
      beforeHeaders: safeHeaders(original), afterHeaders: safeHeaders(requestHeaders),
      omittedHeaderNames: Object.keys(original).filter(name => !(name in requestHeaders)),
      changedHeaderNames: Object.keys(requestHeaders).filter(name => requestHeaders[name] !== original[name]),
      query: plan.id === 'without-query' ? 'all observed query fields omitted' : 'observed query unchanged',
      range
    };
    const redirects: HttpEvidence['redirects'] = [];
    const limitations: string[] = [];
    if (plan.id === 'range-full') limitations.push('Full Range requested by explicit mode; response evidence remains byte-bounded and is not a completed download');
    // Redirect allowlist is only the selected representation's observed source references.
    const allowed = new Set(this.track.sourceRequestIds.map(id => this.options.context.resolveRequest(this.options.runId, id)?.url).filter(Boolean));
    for (;;) {
      if (signal.aborted) return { ...failure('cancelled'), requestDiff, redirects };
      const response = await sampleResponse(url, requestHeaders, signal, clamp(this.options.timeoutMs, 10000, 10, 30000), this.options.networkPolicy ?? {});
      const mime = response.headers['content-type']?.split(';')[0].trim().toLowerCase();
      const contentRange = response.headers['content-range'];
      const contentLength = numeric(response.headers['content-length']);
      const evidence: HttpEvidence = {
        outcome: 'inconclusive', transportOutcome: response.failure ?? 'http', status: response.status || undefined,
        responseMimeType: safeMime(mime), contentRange: validRange(contentRange) ? contentRange : undefined, contentLength,
        bytesReceived: response.bytes, durationMs: response.durationMs, intentionallySampled: response.intentionallySampled,
        sampleSha256: response.bytes ? createHash('sha256').update(response.sample).digest('hex') : undefined,
        requestDiff, redirects, limitations, conclusion: 'Response does not establish target-media access'
      };
      if (response.failure) { evidence.conclusion = response.failure === 'limitation' ? 'Connection address policy blocked this destination; access control is inconclusive' : 'Transport failed; access control is inconclusive'; return evidence; }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        let next: URL;
        try { next = new URL(response.headers.location, url); } catch { return { ...evidence, transportOutcome: 'parser', conclusion: 'Redirect location could not be parsed' }; }
        const followed = allowedRedirect(next, allowed, redirects.length);
        redirects.push({ status: response.status, sanitizedUrl: safeUrl(next), followed });
        if (!followed) return { ...evidence, transportOutcome: 'limitation', conclusion: 'Redirect blocked by observed-resource allowlist or five-redirect limit', limitations: [...limitations, 'Unobserved redirect resources are never fetched'] };
        if (next.origin !== url.origin) {
          requestHeaders = redirectHeaders(requestHeaders, url, next);
          limitations.push('Cross-origin redirect: all observed credentials and headers stripped');
        }
        url = next; continue;
      }
      if (response.status === 401 || response.status === 403) return { ...evidence, outcome: 'denied', conclusion: 'Target server explicitly denied this request; other mutations may differ' };
      const classifier = new StreamingEncryptionClassifier();
      try { classifier.push(response.sample); classifier.finish(); } catch { return { ...evidence, transportOutcome: 'parser', conclusion: 'Media structure is inconsistent; access is inconclusive' }; }
      const encrypted = Object.entries(response.headers).some(([name, value]) => /encrypted|drm|content-protection/i.test(name) && value !== 'false') || classifier.encrypted;
      if (encrypted) return { ...evidence, outcome: 'encrypted', conclusion: 'Encryption detected; payload was not decrypted and playback was not verified' };
      const textPrefix = response.sample.subarray(0, 100).toString('utf8').trimStart();
      const structural = recognizableMedia(response.sample);
      const targetMime = /^(video|audio)\//.test(mime ?? '') || mime === 'application/octet-stream';
      const rangeEvidence = response.status === 206 ? validateRange(contentRange, response, range) : undefined;
      if (response.status === 206 && !rangeEvidence) return { ...evidence, transportOutcome: 'parser', conclusion: 'Partial response range or body length is inconsistent; target access is inconclusive' };
      evidence.serverRangeCapped = rangeEvidence?.capped ?? false;
      if (rangeEvidence?.capped) evidence.limitations.push('Server returned a smaller valid interval than requested');
      if (response.status === 200 && (['range-middle', 'range-tail', 'range-full'].includes(plan.id) || (plan.id === 'range-concurrent' && index > 0))) return { ...evidence, baselineAccess: recognizableMedia(response.sample), conclusion: 'Server ignored Range; a media prefix may establish baseline access only' };
      const atHead = response.status === 200 || /^bytes 0-/.test(contentRange ?? '');
      const verifiedBytes = structural || (!atHead && this.recognizedSources.has(raw.id) && response.status === 206);
      if ((response.status === 200 || response.status === 206) && targetMime && verifiedBytes && response.bytes > 0 && !/^(<|\{|\[)/.test(textPrefix)) {
        if (plan.id === 'baseline' || plan.id === 'range-head') {
          const total = response.status === 206 ? Number(contentRange?.split('/')[1]) : contentLength;
          this.downloadEvidence.set(raw.id, { track: structuredClone(this.track), sourceRequestId: raw.id,
            totalBytes: Number.isSafeInteger(total) && total! > 0 ? total : undefined,
            etag: response.headers.etag, lastModified: response.headers['last-modified'] });
        }
        if (structural && atHead) this.recognizedSources.add(raw.id);
        return { ...evidence, mediaEvidence: structural ? 'structural' : 'linked-range', outcome: 'accessible', conclusion: 'Target media bytes accessible with this request; bounded sampling does not verify full playback' };
      }
      return evidence;
    }
  }
}

async function sampleResponse(url: URL, headers: Record<string, string>, signal: AbortSignal, timeoutMs: number, policy: NetworkPolicy): Promise<ResponseSample> {
  const start = performance.now();
  let opened: OpenResponse | undefined;
  let bytes = 0; const chunks: Buffer[] = []; let intentionallySampled = false; let failure: TransportOutcome | undefined;
  try {
    opened = await openPinnedResponse(url, headers, signal, timeoutMs, policy);
    const incoming = opened.response;
    if (![301, 302, 303, 307, 308].includes(incoming.statusCode ?? 0)) {
      const normalized = normalizedHeaders(incoming);
      const partial = normalized['content-range']?.match(/^bytes (\d+)-(\d+)\/\d+$/);
      const expected = numeric(normalized['content-length']) ?? (partial ? Number(partial[2]) - Number(partial[1]) + 1 : undefined);
      for await (const data of incoming) {
        const chunk = Buffer.from(data);
        const selected = chunk.subarray(0, SHORT_PROBE_BYTES - bytes);
        chunks.push(Buffer.from(selected)); bytes += selected.length;
        if (bytes >= SHORT_PROBE_BYTES) {
          if (expected === undefined || expected > SHORT_PROBE_BYTES) { intentionallySampled = true; break; }
          if (chunk.length > selected.length) { failure = 'parser'; break; }
        }
      }
    }
  } catch (error) { failure = signal.aborted ? 'cancelled' : errorKind(error); }
  finally { opened?.close(); }
  return { status: opened?.response.statusCode ?? 0, headers: opened ? normalizedHeaders(opened.response) : {}, sample: Buffer.concat(chunks), bytes,
    intentionallySampled, failure, durationMs: Math.round(performance.now() - start) };
}
class Pool {
  private active = 0;
  private waiters = new Set<() => void>();
  constructor(readonly limit: number) {}
  async acquire(signal: AbortSignal): Promise<() => void> {
    while (this.active >= this.limit && !signal.aborted) await new Promise<void>(resolve => {
      const ready = () => { signal.removeEventListener('abort', ready); this.waiters.delete(ready); resolve(); };
      this.waiters.add(ready); signal.addEventListener('abort', ready, { once: true });
      if (signal.aborted) ready();
    });
    signal.throwIfAborted();
    this.active++;
    let released = false;
    return () => { if (released) return; released = true; this.active--; for (const ready of [...this.waiters]) ready(); };
  }
  async withSlot(signal: AbortSignal, work: () => Promise<HttpEvidence>): Promise<HttpEvidence> {
    let release: (() => void) | undefined;
    try { release = await this.acquire(signal); return await work(); } catch { return failure(signal.aborted ? 'cancelled' : 'network'); }
    finally { release?.(); }
  }
}
function limitation(reason: string): HttpEvidence { return { outcome: 'inconclusive', transportOutcome: 'limitation', bytesReceived: 0, durationMs: 0, requestDiff: {}, redirects: [], limitations: [reason], conclusion: reason }; }
function failure(kind: TransportOutcome): HttpEvidence { return { ...limitation(kind === 'cancelled' ? 'Probe cancelled; access control is inconclusive' : 'Transport failed; access control is inconclusive'), transportOutcome: kind }; }
function clamp(value: number | undefined, fallback: number, minimum: number, maximum: number): number { return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value!))) : fallback; }
function lowerHeaders(headers: Record<string, string>): Record<string, string> { return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])); }
function safeHeaders(headers: Record<string, string>): Record<string, string> {
  // Persist names/presence for arbitrary headers; keep only useful safe protocol fields.
  return redactHeaders(Object.fromEntries(Object.entries(headers).slice(0, 128).map(([name, value]) => [name, /^(range|accept-encoding|accept|origin|referer)$/.test(name) ? value.slice(0, 2048) : '[REDACTED]'])));
}
function safeUrl(url: URL): string { return ['http:', 'https:'].includes(url.protocol) ? redactUrl(url.href).slice(0, 2048) : '[unsupported redirect scheme]'; }
function safeMime(mime: string | undefined): string | undefined { return mime && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ? mime.slice(0, 128) : undefined; }
function numeric(value: string | undefined): number | undefined { return value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined; }
function validRange(value: string | undefined): boolean { return /^bytes \d+-\d+\/(\d+|\*)$/.test(value ?? ''); }
function validateRange(value: string | undefined, response: ResponseSample, requested: string): { capped: boolean } | undefined {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  const request = requested.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || !request || (!request[1] && !request[2])) return undefined;
  const [start, end, total] = match.slice(1).map(Number);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) return undefined;
  const requestedStart = request[1] ? Number(request[1]) : Math.max(0, total - Number(request[2]));
  const requestedEnd = request[1] && request[2] ? Math.min(Number(request[2]), total - 1) : total - 1;
  if (![requestedStart, requestedEnd].every(Number.isSafeInteger) || start !== requestedStart || end > requestedEnd) return undefined;
  const length = end - start + 1;
  if ('content-length' in response.headers && numeric(response.headers['content-length']) !== length) return undefined;
  if (response.bytes !== Math.min(length, SHORT_PROBE_BYTES) || response.intentionallySampled !== (length > SHORT_PROBE_BYTES)) return undefined;
  return { capped: end < requestedEnd };
}
function observedExpiry(url: string): number | undefined {
  for (const [name, value] of new URL(url).searchParams) if (/^(expires|expiry|exp)$/i.test(name) && /^\d+$/.test(value)) { const n = Number(value); if (Number.isSafeInteger(n) && n > 0) return n < 1e12 ? n * 1000 : n; }
  return undefined;
}
function errorKind(error: unknown): TransportOutcome {
  const code = (error as NodeJS.ErrnoException)?.code ?? '';
  if (code === 'ERR_ADDRESS_POLICY') return 'limitation';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'dns';
  if (/CERT|TLS|SSL|DEPTH_ZERO|SELF_SIGNED/.test(code)) return 'tls';
  if (/HPE_|INVALID/.test(code)) return 'parser';
  if (/TIMEDOUT/.test(code)) return 'timeout';
  return 'network';
}
