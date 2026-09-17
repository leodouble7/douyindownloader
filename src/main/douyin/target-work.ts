import type { MediaAsset, MediaTrack } from '../../shared/contracts';
import type { EphemeralRequest } from '../runs/run-orchestrator';

export interface WorkTarget { workId?: string; status: 'matched' | 'unresolved' }
interface Representation {
  key: string; urls: string[]; kind: 'video' | 'audio' | 'muxed'; fileId?: string; audioFileId?: string;
  width?: number; height?: number; bitrate?: number; durationSeconds?: number;
}
interface Work { title: string; author?: string; representations: Representation[] }
type RecordValue = Record<string, unknown>;
const MAX_BODY = 8_000_000;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value.slice(0, 128) : [];
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 500 ? value : undefined;
const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
const id = (value: unknown): string | undefined => typeof value === 'string' && /^\d{1,24}$/.test(value) ? value : undefined;
export function isDouyinUrl(value: string): boolean {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com')); } catch { return false; }
}
function urlWorkId(value: string): string | undefined {
  if (!isDouyinUrl(value)) return;
  const url = new URL(value);
  const ids = [...url.searchParams.getAll('modal_id'), ...url.searchParams.getAll('aweme_id'), ...(url.pathname.match(/^\/video\/(\d+)\/?$/)?.slice(1) ?? [])];
  return ids.length && ids.every(value => id(value) && value === ids[0]) ? ids[0] : undefined;
}
export function resolveWorkId(original: string, final?: string): string | undefined {
  // An explicit but conflicting original ID must not be replaced by a redirected recommendation.
  if (isDouyinUrl(original)) {
    const url = new URL(original);
    if (url.searchParams.has('modal_id') || url.searchParams.has('aweme_id') || url.pathname.startsWith('/video/')) return urlWorkId(original);
  }
  return final ? urlWorkId(final) : urlWorkId(original);
}
/** Resolve an explicit search selection to its public work page before navigation. */
export function capturePageUrl(value: string): string {
  if (!isDouyinUrl(value)) return value;
  const url = new URL(value), workId = resolveWorkId(value);
  // Search pages may require login even when the selected work is publicly playable.
  if (workId && url.searchParams.has('modal_id') && /^\/(?:root\/)?search(?:\/|$)/.test(url.pathname)) {
    return `https://www.douyin.com/video/${workId}`;
  }
  return value;
}

/** Keep the first real work reached from a short link, even if the player navigates later. */
export class DouyinWorkLink {
  resolvedUrl: string;
  constructor(private readonly original: string) { this.resolvedUrl = original; }
  observe(url: string): void {
    if (!resolveWorkId(this.original, this.resolvedUrl) && resolveWorkId(this.original, url)) this.resolvedUrl = url;
  }
}
function mediaKey(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    // The player appends these cache/measurement parameters to the declared URL.
    // Keep the host, full path, signature and every other query value significant.
    url.searchParams.delete('temp'); url.searchParams.delete('testst'); url.hash = ''; url.searchParams.sort();
    return url.href;
  } catch { return; }
}
function urls(value: unknown): string[] {
  return array(value).flatMap(item => {
    const raw = typeof item === 'string' ? item : record(item).src;
    return typeof raw === 'string' && raw.length <= 16384 && mediaKey(raw) ? [raw] : [];
  });
}
function representations(value: RecordValue): Representation[] {
  const video = record(value.video), duration = positive(video.duration);
  const durationSeconds = duration ? duration / 1000 : undefined;
  const result: Representation[] = [];
  const add = (entry: RecordValue, kind: Representation['kind'], address: unknown, fallback: RecordValue = {}) => {
    const rawUrls = urls(address); if (!rawUrls.length) return;
    const fileId = text(entry.fileId ?? entry.file_id);
    result.push({ key: fileId ? `${kind}:${fileId}` : `${kind}:${mediaKey(rawUrls[0])}`, urls: rawUrls, kind, fileId,
      audioFileId: text(entry.audioFileId ?? entry.audio_file_id),
      width: positive(entry.width ?? fallback.width), height: positive(entry.height ?? fallback.height),
      bitrate: positive(entry.bitRate ?? entry.bit_rate ?? entry.bitrate), durationSeconds });
  };
  for (const raw of array(video.bitRateList ?? video.bit_rate)) {
    const entry = record(raw), address = record(entry.play_addr);
    const format = entry.videoFormat ?? entry.format;
    const rawUrls = entry.playAddr ?? address.url_list;
    // Raw APIs sometimes omit format; split tracks have an explicit media-video path.
    const split = format === 'dash' || !!(entry.audioFileId ?? entry.audio_file_id) || (format !== 'mp4' && urls(rawUrls).some(url => /\/media-video-/.test(new URL(url).pathname)));
    add(entry, split ? 'video' : 'muxed', rawUrls, address);
  }
  // Default addresses obey the same explicit split/audio relationship as variants.
  if (!result.length) {
    const address = record(video.play_addr);
    const rawUrls = video.playAddr ?? address.url_list;
    const split = (video.videoFormat ?? video.format) === 'dash' || !!(video.audioFileId ?? video.audio_file_id) || urls(rawUrls).some(url => /\/media-video-/.test(new URL(url).pathname));
    add(video, split ? 'video' : 'muxed', rawUrls, address);
  }
  for (const raw of array(video.bitRateAudioList ?? video.bit_rate_audio_list ?? video.bit_rate_audio)) {
    const entry = record(raw), address = record(entry.play_addr);
    add(entry, 'audio', entry.urlList ?? entry.url_list ?? address.url_list);
  }
  return result;
}

/** Only compact playback references survive parsing. Bodies and signed URLs never enter UI or persistence. */
export class DouyinWorkIndex {
  private readonly works = new Map<string, Work>();
  constructor(private readonly wantedId?: string) {}
  ingest(body: string, type: 'json' | 'document'): void {
    if (body.length > MAX_BODY) return;
    const parse = (raw: string) => {
      try { this.collect(JSON.parse(raw)); return true; } catch { return false; }
    };
    const encoded = (raw: string) => {
      if (parse(raw)) return;
      if (raw.trim().startsWith('%7B') || raw.trim().startsWith('%5B')) try { parse(decodeURIComponent(raw.trim())); } catch { /* Invalid URI data. */ }
    };
    if (type === 'json') { parse(body); return; }
    // Parse known JSON containers as data. Never evaluate an inline script.
    const scripts = [...body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].slice(0, 512).map(match => match[1]);
    if (!scripts.length) scripts.push(body);
    for (const script of scripts) {
      encoded(script);
      for (const match of script.matchAll(/self\.__pace_f\.push\((\[[^\n]*?\])\)\s*;?/g)) {
        try { for (const part of array(JSON.parse(match[1]))) if (typeof part === 'string') encoded(part); } catch { /* Not a supported data record. */ }
      }
    }
  }
  private collect(value: unknown): void {
    let visited = 0;
    const walk = (value: unknown, depth: number) => {
      if (!value || typeof value !== 'object' || depth > 32 || ++visited > 100000) return;
      const item = record(value), workId = id(item.awemeId ?? item.aweme_id);
      if (workId && (!this.wantedId || workId === this.wantedId) && (this.works.has(workId) || this.works.size < 256)) {
        const reps = representations(item), previous = this.works.get(workId);
        if (reps.length) {
          const merged = new Map(previous?.representations.map(rep => [JSON.stringify([rep.key, rep.audioFileId, rep.urls]), rep]));
          for (const rep of reps) if (merged.size < 256) merged.set(JSON.stringify([rep.key, rep.audioFileId, rep.urls]), rep);
          this.works.set(workId, { title: text(item.desc) ?? text(item.itemTitle) ?? previous?.title ?? '抖音作品', author: text(record(item.author).nickname) ?? previous?.author, representations: [...merged.values()] });
        }
      }
      for (const nested of Object.values(value)) walk(nested, depth + 1);
    };
    walk(value, 0);
  }
  select(original: string, final: string, assets: MediaAsset[], requests: EphemeralRequest[]): { assets: MediaAsset[]; requests: EphemeralRequest[]; target: WorkTarget; title?: string; author?: string } {
    const workId = resolveWorkId(original, final), work = workId ? this.works.get(workId) : undefined;
    const empty = { assets: [], requests: [], target: { workId, status: 'unresolved' as const } };
    if (!work || !workId) return empty;
    const requestMap = new Map(requests.map(request => [request.id, request]));
    const observations = assets.filter(asset => !asset.encrypted).flatMap(asset => asset.tracks).filter(track => track.eligible !== false && !track.incomplete && !track.encrypted);
    const observed = new Map<string, MediaTrack>();
    for (const rep of work.representations) {
      const keys = new Set(rep.urls.map(mediaKey));
      const matches = observations.flatMap(track => {
        const ids = track.sourceRequestIds.filter(id => { const request = requestMap.get(id); return request?.method === 'GET' && keys.has(mediaKey(request.url)); });
        return ids.length ? [{ track, ids }] : [];
      });
      if (!matches.length) continue;
      const previous = observed.get(rep.key), base = matches[0].track;
      observed.set(rep.key, { ...base, id: previous?.id ?? `work-${workId}-track-${observed.size + 1}`, kind: rep.kind, width: rep.width, height: rep.height, bitrate: rep.bitrate, durationSeconds: rep.durationSeconds,
        sourceRequestIds: [...new Set([...(previous?.sourceRequestIds ?? []), ...matches.flatMap(match => match.ids)])],
        confidence: 1, detectionReasons: [...base.detectionReasons, 'Exact work metadata playback URL match'] });
    }
    const result: MediaAsset[] = [], emitted = new Set<string>();
    for (const rep of work.representations) {
      if (rep.kind === 'audio' || emitted.has(rep.key)) continue;
      const visual = observed.get(rep.key); if (!visual) continue;
      let audio: MediaTrack | undefined;
      if (rep.kind === 'video') {
        if (!rep.audioFileId) continue;
        const audioReps = work.representations.filter(item => item.kind === 'audio' && item.fileId === rep.audioFileId);
        audio = audioReps.map(item => observed.get(item.key)).find(Boolean);
        if (!audio) continue;
        // Inconsistent pairing metadata is ambiguous, even when both audios were observed.
        if (work.representations.some(item => item.key === rep.key && item.audioFileId !== rep.audioFileId)) continue;
      }
      emitted.add(rep.key);
      const assetId = `work-${workId}-variant-${result.length + 1}`, tracks = [visual, ...(audio ? [audio] : [])].map(track => ({ ...track, assetId }));
      result.push({ id: assetId, runId: assets[0]?.runId ?? '', tracks, trackIds: tracks.map(track => track.id), sourceRequestIds: tracks.flatMap(track => track.sourceRequestIds), selectedTrackIds: tracks.map(track => track.id), confidence: 1, detectedAt: assets[0]?.detectedAt ?? '', detectionReasons: ['Exact work ID and declared audio file relationship'] });
    }
    if (!result.length) return { ...empty, title: work.title };
    result.sort((a, b) => (b.tracks[0].height ?? 0) - (a.tracks[0].height ?? 0) || (b.tracks[0].bitrate ?? 0) - (a.tracks[0].bitrate ?? 0));
    const ids = new Set(result.flatMap(asset => asset.sourceRequestIds));
    return { assets: result, requests: requests.filter(request => ids.has(request.id)), target: { workId, status: 'matched' }, title: work.title, author: work.author };
  }
}
