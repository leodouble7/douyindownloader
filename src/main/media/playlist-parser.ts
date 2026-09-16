import { XMLParser } from 'fast-xml-parser';
import { createSanitizedMediaUrl, type MediaTrackKind, type SanitizedMediaUrl } from '../../shared/contracts';

const MAX_CHARS = 1_000_000, MAX_HLS = 10_000;
export const DASH_OUTPUT_BUDGET = 128;
const SENSITIVE = /token|signature|^sig$|policy|credential|key|session|authorization|cookie/i;
export interface PlaylistEncryption { encrypted: boolean; method?: string; keyFormat?: string; }
export interface ByteRange { length: number; offset?: number; }
export interface HlsVariant { sanitizedUrl: SanitizedMediaUrl; bandwidth?: number; codecs?: string; width?: number; height?: number; audioGroupId?: string; }
export interface HlsAlternateAudio { sanitizedUrl: SanitizedMediaUrl; groupId?: string; name?: string; codecs?: string; }
export interface HlsSegment { sanitizedUrl: SanitizedMediaUrl; durationSeconds?: number; byteRange?: ByteRange; initializationSegmentUrl?: SanitizedMediaUrl; initializationByteRange?: ByteRange; }
export interface HlsPlaylist { type: 'master' | 'media'; variants: HlsVariant[]; alternateAudio: HlsAlternateAudio[]; initializationSegmentUrl?: SanitizedMediaUrl; segments: HlsSegment[]; encryption: PlaylistEncryption; }
export interface DashTimelineEntry { t?: number; d: number; r?: number; }
export interface DashAddressing { timescale?: number; duration?: number; startNumber?: number; presentationTimeOffset?: number; }
export interface DashSegmentList { id: string; segmentUrls: SanitizedMediaUrl[]; initializationUrl?: SanitizedMediaUrl; }
export interface DashSegmentTimeline { id: string; entries: DashTimelineEntry[]; }
export interface DashRepresentation { id: string; kind: MediaTrackKind; mimeType?: string; codecs?: string; bandwidth?: number; width?: number; height?: number; initializationUrl?: SanitizedMediaUrl; mediaUrlTemplate?: SanitizedMediaUrl; segmentUrls: SanitizedMediaUrl[]; segmentListId?: string; segmentTimelineId?: string; addressing?: DashAddressing; encrypted: boolean; }
export interface DashManifest { representations: DashRepresentation[]; segmentLists: DashSegmentList[]; segmentTimelines: DashSegmentTimeline[]; encrypted: boolean; truncated: boolean; outputBudget: number; outputBudgetUsed: number; }

export function parseHls(text: string, baseUrl: string): HlsPlaylist {
  const variants: HlsVariant[] = [], alternateAudio: HlsAlternateAudio[] = [], segments: HlsSegment[] = [];
  let encryption: PlaylistEncryption = { encrypted: false }, variant: Record<string, string> | undefined, duration: number | undefined, pendingRange: string | undefined, lastUrl: SanitizedMediaUrl | undefined, lastEnd: number | undefined, mapUrl: SanitizedMediaUrl | undefined, mapRange: ByteRange | undefined, lastMapUrl: SanitizedMediaUrl | undefined, lastMapEnd: number | undefined;
  for (const raw of text.slice(0, MAX_CHARS).split(/\r?\n/, MAX_HLS * 4)) {
    const line = raw.trim(); if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) { variant = attrs(line.slice(18)); continue; }
    if (line.startsWith('#EXT-X-MEDIA:')) { const x = attrs(line.slice(13)), url = x.TYPE?.toUpperCase() === 'AUDIO' && x.URI ? safeUrl(x.URI, baseUrl) : undefined; if (url && alternateAudio.length < MAX_HLS) alternateAudio.push({ sanitizedUrl: url, groupId: x['GROUP-ID'], name: x.NAME, codecs: x.CODECS }); continue; }
    if (line.startsWith('#EXT-X-MAP:')) { const x = attrs(line.slice(11)); mapUrl = x.URI ? safeUrl(x.URI, baseUrl) : undefined; mapRange = scopedRange(x.BYTERANGE, mapUrl, lastMapUrl, lastMapEnd); if (mapUrl && mapRange?.offset !== undefined) { lastMapUrl = mapUrl; lastMapEnd = mapRange.offset + mapRange.length; } else { lastMapUrl = undefined; lastMapEnd = undefined; } continue; }
    if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) { const x = attrs(line.slice(line.indexOf(':') + 1)), method = x.METHOD?.toUpperCase(); if (method && method !== 'NONE') encryption = { encrypted: true, method, keyFormat: x.KEYFORMAT }; continue; }
    if (line.startsWith('#EXT-X-BYTERANGE:')) { pendingRange = line.slice(17); continue; }
    if (line.startsWith('#EXTINF:')) { const n = Number(line.slice(8).split(',', 1)[0]); duration = Number.isFinite(n) && n >= 0 ? n : undefined; continue; }
    if (line.startsWith('#')) continue;
    const url = safeUrl(line, baseUrl);
    if (variant) { const r = resolution(variant.RESOLUTION); if (url && variants.length < MAX_HLS) variants.push({ sanitizedUrl: url, bandwidth: finite(variant.BANDWIDTH), codecs: variant.CODECS, width: r?.[0], height: r?.[1], audioGroupId: variant.AUDIO }); variant = undefined; continue; }
    const range = scopedRange(pendingRange, url, lastUrl, lastEnd); if (url && segments.length < MAX_HLS) segments.push({ sanitizedUrl: url, durationSeconds: duration, byteRange: range, initializationSegmentUrl: mapUrl, initializationByteRange: mapRange });
    if (url && range?.offset !== undefined) { lastUrl = url; lastEnd = range.offset + range.length; } else { lastUrl = undefined; lastEnd = undefined; } pendingRange = undefined; duration = undefined;
  }
  return { type: variants.length ? 'master' : 'media', variants, alternateAudio, initializationSegmentUrl: mapUrl, segments, encryption };
}

interface Template { initialization?: string; media?: string; addressing: DashAddressing; timeline?: DashTimelineEntry[]; }
interface Scope { base: string; mime?: string; codecs?: string; width?: number; height?: number; encrypted: boolean; template?: Template; listNode?: Record<string, unknown>; }
class Budget {
  used = 0;
  truncated = false;
  readonly lists = new Map<string, DashSegmentList>();
  readonly timelines = new Map<string, DashSegmentTimeline>();
  readonly limit: number;
  constructor(limit = DASH_OUTPUT_BUDGET) { this.limit = boundedLimit(limit, DASH_OUTPUT_BUDGET); }
  take(): boolean {
    if (this.used >= this.limit) { this.truncated = true; return false; }
    this.used++;
    return true;
  }
}

/** Pure MPD parser. Each representation, registry object, timeline entry and emitted URL consumes one output item. */
export function parseDash(xml: string, baseUrl: string, options: { maxOutputItems?: number; maxScanNodes?: number } = {}): DashManifest {
  const budget = new Budget(options.maxOutputItems);
  const finish = (representations: DashRepresentation[], encrypted = false): DashManifest => ({
    representations, segmentLists: [...budget.lists.values()], segmentTimelines: [...budget.timelines.values()],
    encrypted, truncated: budget.truncated, outputBudget: budget.limit, outputBudgetUsed: budget.used
  });
  // Unexamined input is not evidence of clear media.
  if (xml.length > MAX_CHARS) { budget.truncated = true; return finish([], true); }
  let parsed: Record<string, unknown>;
  try {
    parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', trimValues: true, removeNSPrefix: true }).parse(xml) as Record<string, unknown>;
  } catch { budget.truncated = true; return finish([], true); }
  const mpd = obj(parsed.MPD);
  if (!mpd) return finish([]);
  const classification = scanProtection(mpd, boundedLimit(options.maxScanNodes, 100_000));
  if (!classification.complete) budget.truncated = true;
  const reps: DashRepresentation[] = [], root = makeScope(mpd, { base: baseUrl, encrypted: false });
  for (const period of many(mpd.Period)) collect(obj(period), root, reps, budget);
  return finish(reps, classification.encrypted);
}

/** Iterative and independent of output retention: later protection declarations cannot be hidden by truncation. */
function scanProtection(root: Record<string, unknown>, limit: number): { encrypted: boolean; complete: boolean } {
  const pending: unknown[] = [root];
  let visited = 0;
  while (pending.length) {
    if (visited++ >= limit) return { encrypted: true, complete: false };
    const node = pending.pop();
    if (Array.isArray(node)) { for (const child of node) if (child && typeof child === 'object') pending.push(child); continue; }
    const record = obj(node);
    if (!record) continue;
    if (protectedNode(record)) return { encrypted: true, complete: true };
    for (const child of Object.values(record)) if (child && typeof child === 'object') pending.push(child);
  }
  return { encrypted: false, complete: true };
}

function collect(node: Record<string, unknown> | undefined, parent: Scope, reps: DashRepresentation[], budget: Budget): void {
  if (!node) return;
  const current = makeScope(node, parent);
  for (const adaptation of many(node.AdaptationSet)) {
    const set = obj(adaptation);
    if (!set) continue;
    const scope = makeScope(set, current);
    for (const representation of many(set.Representation)) addRep(obj(representation), scope, reps, budget);
  }
  for (const representation of many(node.Representation)) addRep(obj(representation), current, reps, budget);
}

function addRep(node: Record<string, unknown> | undefined, parent: Scope, reps: DashRepresentation[], budget: Budget): void {
  if (!node || !budget.take()) return;
  const current = makeScope(node, parent), id = str(node['@_id']) ?? `representation-${reps.length + 1}`, template = current.template;
  const timeline = template?.timeline ? registerTimeline(template.timeline, budget) : undefined;
  // Resolve lazily at the descendant's effective base, including inherited AdaptationSet BaseURL changes.
  const list = current.listNode ? registerList(current.listNode, current.base, budget) : undefined;
  const initializationUrl = template?.initialization ? safeUrl(template.initialization.replaceAll('$RepresentationID$', id), current.base) : list?.initializationUrl;
  const mediaUrlTemplate = template?.media ? safeUrl(template.media, current.base) : node.BaseURL ? safeUrl('', current.base) : undefined;
  reps.push({
    id, kind: kind(current.mime, current.codecs), mimeType: current.mime, codecs: current.codecs,
    bandwidth: finite(node['@_bandwidth']), width: current.width, height: current.height,
    initializationUrl: initializationUrl && budget.take() ? initializationUrl : undefined,
    mediaUrlTemplate: mediaUrlTemplate && budget.take() ? mediaUrlTemplate : undefined,
    // All list/timeline payloads live in registries; IDs are emitted only after registration succeeds.
    segmentUrls: [], segmentListId: list?.id, segmentTimelineId: timeline?.id,
    addressing: template?.addressing, encrypted: current.encrypted
  });
}

function makeScope(node: Record<string, unknown>, parent: Partial<Scope>): Scope {
  return {
    base: base(node, parent.base ?? ''), mime: str(node['@_mimeType']) ?? parent.mime,
    codecs: str(node['@_codecs']) ?? parent.codecs, width: finite(node['@_width']) ?? parent.width,
    height: finite(node['@_height']) ?? parent.height, encrypted: Boolean(parent.encrypted) || protectedNode(node),
    template: merge(parent.template, parseTemplate(element(node.SegmentTemplate))),
    listNode: element(node.SegmentList) ?? parent.listNode
  };
}

function parseTemplate(node: Record<string, unknown> | undefined): Template | undefined {
  if (!node) return undefined;
  const timeline: DashTimelineEntry[] = [];
  for (const item of many(obj(node.SegmentTimeline)?.S)) {
    const x = obj(item), d = finite(x?.['@_d']);
    if (d !== undefined) timeline.push({ t: finite(x?.['@_t']), d, r: signed(x?.['@_r']) });
  }
  return {
    initialization: str(node['@_initialization']), media: str(node['@_media']),
    addressing: { timescale: finite(node['@_timescale']), duration: finite(node['@_duration']), startNumber: finite(node['@_startNumber']), presentationTimeOffset: finite(node['@_presentationTimeOffset']) },
    timeline: node.SegmentTimeline !== undefined ? timeline : undefined
  };
}
function merge(parent: Template | undefined, child: Template | undefined): Template | undefined {
  if (!parent) return child;
  if (!child) return parent;
  return { initialization: child.initialization ?? parent.initialization, media: child.media ?? parent.media, addressing: { ...parent.addressing, ...defined(child.addressing) }, timeline: child.timeline ?? parent.timeline };
}

function registerTimeline(entries: DashTimelineEntry[], budget: Budget): DashSegmentTimeline | undefined {
  const key = JSON.stringify(entries), cached = budget.timelines.get(key);
  if (cached) return cached;
  if (!budget.take()) return undefined;
  const timeline: DashSegmentTimeline = { id: `segment-timeline-${budget.timelines.size + 1}`, entries: [] };
  for (const entry of entries) { if (!budget.take()) break; timeline.entries.push(entry); }
  budget.timelines.set(key, timeline);
  return timeline;
}

function registerList(node: Record<string, unknown>, baseUrl: string, budget: Budget): DashSegmentList | undefined {
  const key = `${baseUrl}|${JSON.stringify(node)}`, cached = budget.lists.get(key);
  if (cached) return cached;
  if (!budget.take()) return undefined;
  const result: DashSegmentList = { id: `segment-list-${budget.lists.size + 1}`, segmentUrls: [] };
  const init = str(obj(node.Initialization)?.['@_sourceURL']), initializationUrl = init ? safeUrl(init, baseUrl) : undefined;
  if (initializationUrl && budget.take()) result.initializationUrl = initializationUrl;
  for (const item of many(node.SegmentURL)) {
    const media = str(obj(item)?.['@_media']), url = media ? safeUrl(media, baseUrl) : undefined;
    if (url) { if (!budget.take()) break; result.segmentUrls.push(url); }
  }
  budget.lists.set(key, result);
  return result;
}
function boundedLimit(value: number | undefined, fallback: number): number { return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.min(MAX_CHARS, Math.floor(value))) : fallback; }
function element(value: unknown): Record<string, unknown> | undefined { return value === undefined ? undefined : obj(value) ?? {}; }
function protectedNode(node: Record<string, unknown>): boolean { return many(node.ContentProtection).length > 0; }
function base(node: Record<string, unknown>, parent: string): string { const value = text(node.BaseURL); if (!value) return parent; try { const url = new URL(value, parent); return /^https?:$/.test(url.protocol) ? url.toString() : parent; } catch { return parent; } }
function attrs(input: string): Record<string, string> { const out: Record<string, string> = {}; for (const m of input.matchAll(/([A-Z0-9-]+)=((?:"[^"]*")|(?:[^,]*))/gi)) out[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, ''); return out; }
function scopedRange(value: string | undefined, url: SanitizedMediaUrl | undefined, priorUrl: SanitizedMediaUrl | undefined, priorEnd: number | undefined): ByteRange | undefined { const m = value?.trim().match(/^(\d+)(?:@(\d+))?$/); if (!m) return undefined; return { length: Number(m[1]), offset: m[2] === undefined ? (url && url === priorUrl ? priorEnd : undefined) : Number(m[2]) }; }
function safeUrl(value: string, parent: string): SanitizedMediaUrl | undefined { try { const url = new URL(value.trim(), parent); url.username = ''; url.password = ''; for (const name of new Set(url.searchParams.keys())) if (SENSITIVE.test(name)) url.searchParams.set(name, '[REDACTED]'); return createSanitizedMediaUrl(url.toString()); } catch { return undefined; } }
function resolution(value?: string): [number, number] | undefined { const m = value?.match(/^(\d+)x(\d+)$/i); return m ? [Number(m[1]), Number(m[2])] : undefined; }
function finite(value: unknown): number | undefined { const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN; return Number.isFinite(n) && n >= 0 ? n : undefined; }
function signed(value: unknown): number | undefined { const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN; return Number.isFinite(n) ? n : undefined; }
function obj(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function many(value: unknown): unknown[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function str(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined; }
function text(value: unknown): string | undefined { return str(value) ?? str(obj(value)?.['#text']); }
function defined<T extends object>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T; }
function kind(mime?: string, codecs?: string): MediaTrackKind { return mime?.startsWith('video/') || /^(avc|hev|hvc|vp|av01)/i.test(codecs ?? '') ? 'video' : mime?.startsWith('audio/') || /^(mp4a|opus|ac-3|ec-3)/i.test(codecs ?? '') ? 'audio' : 'unknown'; }
