import type { CaptureObservation, MediaAsset, MediaTrack, MediaTrackKind, MseMetadata } from '../../shared/contracts';

interface Buffer { realm: string; mediaRealm: string; runId: string; targetId: string; sessionId?: string; frameId?: string; mime: string; end?: number; }
interface Candidate { key: string; baseKind: MediaTrackKind; track: MediaTrack; runId: string; targetId: string; sessionId?: string; frameId?: string; content?: string; realms: Set<string>; requests: Map<string, boolean>; timestamp?: number; }

/** Stateful, sanitized-only correlation. Relationships are explicit; timing alone never pairs assets. */
export class MediaCorrelator {
  private readonly candidates = new Map<string, Candidate>(); private readonly requestKeys = new Map<string, string>(); private readonly buffers = new Map<string, Buffer>(); private readonly lifecycleState = new Map<string, 'pending' | 'finished' | 'failed'>(); private readonly successfulResponses = new Map<string, boolean>();
  ingest(observation: CaptureObservation): MediaAsset[] {
    if (observation.kind === 'mse') this.mse(observation, observation.metadata);
    if (observation.kind === 'network') { const id = requestIdentity(observation); if (observation.stage === 'failed') { this.lifecycleState.set(id, 'failed'); this.failed(observation); } else if (observation.stage === 'finished') { if (this.lifecycleState.get(id) !== 'failed') this.lifecycleState.set(id, 'finished'); this.finished(observation); } else if (observation.stage === 'response' || observation.stage === 'redirect') { if (!this.lifecycleState.has(id)) this.lifecycleState.set(id, 'pending'); this.response(observation); } }
    this.recompute(); return this.assets();
  }
  private response(observation: Extract<CaptureObservation, { kind: 'network' }>): void {
    const request = observation.request, baseKind = classify(request.sanitizedUrl, request.mimeType); if (!candidateKind(baseKind, request.mimeType, request.sanitizedUrl)) return;
    const key = `${request.runId}|${observation.targetId}|${observation.sessionId ?? ''}|${observation.frameId ?? ''}|${canonical(request.sanitizedUrl)}|${baseKind}|${quality(request.sanitizedUrl) ?? ''}`; const encrypted = encryption(request.sanitizedUrl, request.mimeType, request.sanitizedResponseHeaders); const state = this.lifecycleState.get(requestIdentity(observation)) ?? 'pending';
    const successfulResponse = request.status === undefined || request.status < 400;
    this.successfulResponses.set(requestIdentity(observation), successfulResponse);
    let candidate = this.candidates.get(key);
    if (!candidate) { const ok = state === 'finished' && successfulResponse; const track: MediaTrack = { id: `track-${hash(key)}`, assetId: '', kind: baseKind, sourceRequestIds: [request.id], sanitizedUrl: request.sanitizedUrl as MediaTrack['sanitizedUrl'], mimeType: request.mimeType, byteLength: fullLength(request.contentRange) ?? request.contentLength, detectionReasons: reasons(observation, baseKind), encrypted, eligible: ok, incomplete: !ok }; candidate = { key, baseKind, track, runId: request.runId, targetId: observation.targetId, sessionId: observation.sessionId, frameId: observation.frameId, content: contentId(request.sanitizedUrl), realms: new Set(), requests: new Map([[request.id, ok]]), timestamp: observation.timestamp }; this.candidates.set(key, candidate); }
    else { unique(candidate.track.sourceRequestIds, request.id); uniqueMany(candidate.track.detectionReasons, reasons(observation, candidate.baseKind)); candidate.track.byteLength = Math.max(candidate.track.byteLength ?? 0, fullLength(request.contentRange) ?? request.contentLength ?? 0) || undefined; candidate.track.encrypted ||= encrypted; candidate.requests.set(request.id, state === 'finished' && successfulResponse); }
    if (state === 'failed') unique(candidate.track.detectionReasons, 'Network lifecycle failed or was cancelled; this request is incomplete and not auto-selectable');
    if (encrypted) unique(candidate.track.detectionReasons, 'DRM or encryption indicator observed; payload is not classified as playable'); this.requestKeys.set(requestIdentity(observation), key); this.lifecycle(candidate);
  }
  private failed(observation: Extract<CaptureObservation, { kind: 'network' }>): void { const candidate = this.candidates.get(this.requestKeys.get(requestIdentity(observation)) ?? ''); if (!candidate) return; candidate.requests.set(observation.request.id, false); unique(candidate.track.detectionReasons, 'Network lifecycle failed or was cancelled; this request is incomplete and not auto-selectable'); this.lifecycle(candidate); }
  private finished(observation: Extract<CaptureObservation, { kind: 'network' }>): void { const candidate = this.candidates.get(this.requestKeys.get(requestIdentity(observation)) ?? ''); if (!candidate) return; candidate.requests.set(observation.request.id, this.lifecycleState.get(requestIdentity(observation)) === 'finished' && this.successfulResponses.get(requestIdentity(observation)) === true && (observation.request.status ?? 0) < 400); this.lifecycle(candidate); }
  private lifecycle(candidate: Candidate): void { const successful = [...candidate.requests.values()].some(Boolean); candidate.track.eligible = successful; candidate.track.incomplete = [...candidate.requests.values()].some((value) => !value) || !successful; }
  private mse(observation: Extract<CaptureObservation, { kind: 'mse' }>, metadata: MseMetadata): void { if (metadata.type === 'object-url') return; const realm = realmKey(observation, metadata); const previous = this.buffers.get(realm); if (metadata.type === 'source-buffer') { this.buffers.set(realm, { realm, mediaRealm: mediaRealmKey(observation, metadata), runId: observation.runId, targetId: observation.targetId, sessionId: observation.sessionId, frameId: observation.frameId, mime: metadata.mimeType, end: previous?.end }); return; } const buffer = previous ?? { realm, mediaRealm: mediaRealmKey(observation, metadata), runId: observation.runId, targetId: observation.targetId, sessionId: observation.sessionId, frameId: observation.frameId, mime: '' }; buffer.end = Math.max(buffer.end ?? 0, ...metadata.buffered.map((range) => range[1])); this.buffers.set(realm, buffer); }
  private recompute(): void {
    const candidates = [...this.candidates.values()];
    const buffers = [...this.buffers.values()].filter((buffer) => bufferKind(buffer.mime) !== 'unknown');
    const matches = new Map(buffers.map((buffer) => [buffer, candidates.filter((candidate) =>
      sameCapture(candidate, buffer) && compatible(candidate.baseKind, bufferKind(buffer.mime)))]));
    for (const candidate of candidates) {
      // MSE evidence is derived, and must disappear when later observations make a match ambiguous.
      candidate.track.kind = candidate.baseKind;
      delete candidate.track.codecs;
      delete candidate.track.durationSeconds;
      candidate.track.detectionReasons = candidate.track.detectionReasons.filter((reason) => !reason.startsWith('MSE SourceBuffer'));
      candidate.realms.clear();
      const compatibleBuffers = buffers.filter((buffer) => matches.get(buffer)?.includes(candidate));
      // Network has no stable execution context. Require uniqueness in both directions, so
      // colliding SourceBuffer IDs across contexts (or multiple compatible buffers) cannot pair it.
      if (compatibleBuffers.length === 1) {
        const buffer = compatibleBuffers[0];
        if (matches.get(buffer)?.length === 1) {
          candidate.realms.add(buffer.mediaRealm);
          if (candidate.baseKind === 'muxed') candidate.track.kind = bufferKind(buffer.mime);
          const codec = codecs(buffer.mime);
          if (codec) candidate.track.codecs = codec;
          if (buffer.end !== undefined) candidate.track.durationSeconds = buffer.end;
          unique(candidate.track.detectionReasons, `MSE SourceBuffer MIME confirms ${buffer.mime.split(';', 1)[0]}`);
        }
      }
      candidate.track.confidence = confidence(candidate.track);
    }
  }
  private assets(): MediaAsset[] { const all = [...this.candidates.values()]; const parents = all.map((_, index) => index); const find = (x: number): number => parents[x] === x ? x : (parents[x] = find(parents[x])); const join = (a: number, b: number) => { a = find(a); b = find(b); if (a !== b) parents[b] = a; };
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (related(all[i], all[j])) join(i, j);
    const groups = new Map<number, Candidate[]>(); all.forEach((candidate, index) => { const root = find(index), group = groups.get(root) ?? []; group.push(candidate); groups.set(root, group); }); return [...groups.values()].map((group) => asset(group)).sort((a, b) => a.id.localeCompare(b.id)); }
}
function asset(candidates: Candidate[]): MediaAsset { const key = candidates.map((candidate) => candidate.key).sort().join('|'), id = `asset-${hash(key)}`; const tracks = candidates.map((candidate) => ({ ...candidate.track, assetId: id, sourceRequestIds: [...candidate.track.sourceRequestIds].sort(), detectionReasons: [...candidate.track.detectionReasons].sort() })).sort(order); const selected = choose(tracks); const split = selected.some((track) => track.kind === 'video') && selected.some((track) => track.kind === 'audio'); const identity = candidates[0]; return { id, runId: identity.runId, sourceRequestIds: [...new Set(tracks.flatMap((track) => track.sourceRequestIds))].sort(), trackIds: tracks.map((track) => track.id), tracks, selectedTrackIds: selected.map((track) => track.id), confidence: Math.min(0.98, Math.round((tracks.reduce((total, track) => total + (track.confidence ?? 0), 0) / Math.max(tracks.length, 1) + (split ? .15 : 0)) * 100) / 100), detectionReasons: split ? ['Candidates share explicit MSE realm or stable content identity on one capture identity'] : ['No pairing relationship was observed; alternatives remain separate'], encrypted: tracks.some((track) => track.encrypted) || undefined, detectedAt: new Date((Math.min(...candidates.map((candidate) => candidate.timestamp ?? 0))) * 1000).toISOString() }; }
function related(a: Candidate, b: Candidate): boolean { if (a.runId !== b.runId) return false; if ([...a.realms].some((realm) => b.realms.has(realm))) return true; return Boolean(a.content && a.content === b.content && a.targetId === b.targetId && a.sessionId === b.sessionId && a.frameId === b.frameId); }
function sameCapture(candidate: Candidate, buffer: Buffer): boolean { return candidate.runId === buffer.runId && candidate.targetId === buffer.targetId && candidate.sessionId === buffer.sessionId && candidate.frameId === buffer.frameId; }
function requestIdentity(observation: Extract<CaptureObservation, { kind: 'network' }>): string { return JSON.stringify([observation.runId, observation.targetId, observation.sessionId ?? '', observation.frameId ?? '', observation.request.id]); }
function classify(url: string, mime?: string): MediaTrackKind { const lower = url.toLowerCase(); if (/m3u8|mpegurl|dash\+xml|\.mpd(?:[?#]|$)/.test(`${lower} ${mime ?? ''}`)) return 'manifest'; if (mime?.startsWith('audio/') || /audio|\.m4a|mp4a|opus/.test(lower)) return 'audio'; if (mime?.startsWith('video/')) return /video|hvc|hev|avc|vp9|av01|quality=|resolution=/.test(lower) ? 'video' : 'muxed'; return 'unknown'; }
function candidateKind(kind: MediaTrackKind, mime: string | undefined, url: string): boolean { return kind !== 'unknown' || /\.(mp4|m4s|m4a|webm|ts)(?:[?#]|$)/i.test(url) || /^(video|audio)\//.test(mime ?? ''); }
function bufferKind(mime: string): MediaTrackKind { return mime.toLowerCase().startsWith('video/') ? 'video' : mime.toLowerCase().startsWith('audio/') ? 'audio' : 'unknown'; }
function compatible(track: MediaTrackKind, buffer: MediaTrackKind): boolean { return track === 'muxed' || track === buffer; }
function realmKey(observation: Extract<CaptureObservation, { kind: 'mse' }>, metadata: Exclude<MseMetadata, { type: 'object-url' }>): string { return JSON.stringify([observation.runId, observation.targetId, observation.sessionId ?? '', observation.frameId ?? '', observation.executionContextId ?? '', metadata.objectId, metadata.sourceBufferId]); }
function mediaRealmKey(observation: Extract<CaptureObservation, { kind: 'mse' }>, metadata: Exclude<MseMetadata, { type: 'object-url' }>): string { return JSON.stringify([observation.runId, observation.targetId, observation.sessionId ?? '', observation.frameId ?? '', observation.executionContextId ?? '', metadata.objectId]); }
function contentId(url: string): string | undefined { const parsed = new URL(url); return parsed.searchParams.get('media_id') ?? parsed.searchParams.get('content_id') ?? parsed.searchParams.get('asset_id') ?? undefined; }
function canonical(url: string): string { const parsed = new URL(url); parsed.hash = ''; return parsed.toString(); }
function quality(url: string): string | undefined { const parsed = new URL(url); return parsed.searchParams.get('quality') ?? parsed.searchParams.get('bitrate') ?? undefined; }
function fullLength(range?: string): number | undefined { const match = range?.match(/\/(\d+)$/); return match ? Number(match[1]) : undefined; }
function encryption(url: string, mime?: string, headers?: Record<string, string>): boolean { return /drm|protection|widevine|playready|fairplay|cenc|encrypted|license/i.test(`${url} ${mime ?? ''} ${JSON.stringify(headers ?? {})}`); }
function reasons(observation: Extract<CaptureObservation, { kind: 'network' }>, kind: MediaTrackKind): string[] { const result = [`MIME type ${observation.request.mimeType ?? 'unknown'} identifies a ${kind} track`]; if (observation.request.status === 206) result.push('HTTP 206 Range response is part of the same representation'); if (observation.targetType === 'worker') result.push(`Observed from worker target ${observation.targetId} (session ${observation.sessionId ?? 'root'})`); return result; }
function codecs(mime: string): string | undefined { return mime.match(/codecs\s*=\s*"?([^";]+)/i)?.[1]?.trim(); }
function confidence(track: MediaTrack): number { return Math.min(.95, .35 + (track.mimeType ? .2 : 0) + (track.byteLength ? .1 : 0) + (track.detectionReasons.some((reason) => reason.startsWith('MSE SourceBuffer')) ? .25 : 0) + (track.eligible === false ? -.35 : 0)); }
function choose(tracks: MediaTrack[]): MediaTrack[] { const valid = tracks.filter((track) => track.eligible !== false); const best = (kind: MediaTrackKind) => [...valid.filter((track) => track.kind === kind)].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))[0]; const video = best('video'), audio = best('audio'); if (video || audio) return [video, audio].filter((track): track is MediaTrack => Boolean(track)); const muxed = best('muxed'); return muxed ? [muxed] : []; }
function score(track: MediaTrack): number { return (track.height ?? 0) * 1e7 + (track.bitrate ?? 0) + (track.byteLength ?? 0); }
function order(a: MediaTrack, b: MediaTrack): number { const rank: Record<MediaTrackKind, number> = { video: 0, audio: 1, muxed: 2, manifest: 3, unknown: 4 }; return rank[a.kind] - rank[b.kind] || a.id.localeCompare(b.id); }
function unique(values: string[], value: string): void { if (!values.includes(value)) values.push(value); }
function uniqueMany(values: string[], additions: string[]): void { additions.forEach((value) => unique(values, value)); }
function hash(value: string): string { let out = 2166136261; for (let i = 0; i < value.length; i++) out = Math.imul(out ^ value.charCodeAt(i), 16777619); return (out >>> 0).toString(36); }
