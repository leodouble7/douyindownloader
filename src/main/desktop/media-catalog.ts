import type { MediaAsset, MediaTrack } from '../../shared/contracts';
import type { DownloadCandidate, DownloadMode, DownloadSelection } from '../../shared/desktop';
import { eligibleTrack } from '../probes/probe-planner';

export interface CatalogEntry { candidate: DownloadCandidate; tracks: MediaTrack[] }
export interface CatalogJob { label: string; selection: DownloadSelection; tracks: MediaTrack[] }

interface Observation {
  asset: MediaAsset;
  assetIndex: number;
  track: MediaTrack;
  scope: string;
  content?: string;
  resourceKeys: string[];
}
interface Representation { track: MediaTrack; observations: number; preferred: boolean }

/** Only candidate is safe for IPC. Tracks retain exact source references in main-process memory. */
export function buildMediaCatalog(assets: MediaAsset[]): CatalogEntry[] {
  const observations: Observation[] = [];
  assets.forEach((asset, assetIndex) => {
    if (asset.encrypted) return;
    for (const track of asset.tracks.filter(eligibleTrack)) {
      const scope = captureScope(asset.runId, track.sourceRequestIds);
      observations.push({ asset, assetIndex, track, scope, content: contentIdentity(track.sanitizedUrl), resourceKeys: resourceIdentities(track, scope) });
    }
  });

  const groups = connected(observations.map(item => [
    `asset:${item.assetIndex}`,
    ...(item.content ? [`content:${JSON.stringify([item.scope, item.content])}`] : []),
    ...item.resourceKeys
  ]));
  const catalog: CatalogEntry[] = [];
  for (const [groupIndex, members] of groups.entries()) {
    const items = members.map(index => observations[index]);
    const resources = connected(items.map(item => item.resourceKeys));
    const representations = resources.map(indices => mergeRepresentation(indices.map(index => items[index])));
    const assetRepresentations = new Map<number, Set<number>>();
    resources.forEach((indices, resourceIndex) => indices.forEach(index => {
      const assetIndex = items[index].assetIndex;
      const members = assetRepresentations.get(assetIndex) ?? new Set<number>();
      members.add(resourceIndex); assetRepresentations.set(assetIndex, members);
    }));
    const confirmed = items.some(item => item.content) || [...assetRepresentations.values()].some(members => members.size > 1);
    const groupKey = `group-${groupIndex + 1}`;
    const groupLabel = `${confirmed ? '作品' : '待确认资源'} ${groupIndex + 1}`;
    const audio = representations.filter(item => item.track.kind === 'audio').sort(preferredAudio)[0];
    const visual = representations.filter(item => item.track.kind === 'video' || item.track.kind === 'muxed');
    const variants = visual.length ? visual : representations;
    let countedAudio = false;
    for (const [variantIndex, primary] of variants.entries()) {
      const pair = primary.track.kind === 'video' && audio ? audio : undefined;
      // A shared audio representation can appear in several variants but is deduplicated only once.
      const duplicateCount = primary.observations - 1 + (pair && !countedAudio ? pair.observations - 1 : 0);
      if (pair) countedAudio = true;
      const tracks = [primary.track, ...(pair ? [pair.track] : [])];
      const metadata = displayMetadata(primary.track);
      const total = tracks.every(track => positiveInteger(track.byteLength) !== undefined)
        ? tracks.reduce((sum, track) => sum + track.byteLength!, 0) : undefined;
      catalog.push({
        candidate: {
          index: catalog.length + 1, kind: pair ? 'pair' : primary.track.kind as DownloadCandidate['kind'],
          ...metadata, byteLength: positiveInteger(total), groupKey, groupLabel, grouping: confirmed ? 'confirmed' : 'unconfirmed',
          variantLabel: variantLabel(primary.track, variantIndex + 1),
          duplicateCount
        },
        tracks
      });
    }
  }
  for (const entry of catalog) {
    if (entry.candidate.kind !== 'video') continue;
    entry.candidate.audioOptions = catalog.filter(audio => audio.candidate.kind === 'audio' &&
      audio.candidate.groupKey !== entry.candidate.groupKey &&
      (entry.candidate.grouping === 'unconfirmed' || audio.candidate.grouping === 'unconfirmed'))
      .map(audio => audio.candidate.index);
  }
  return catalog;
}

/** Revalidates the entire request before queue construction; nothing is silently discarded. */
export function selectCatalogJobs(catalog: CatalogEntry[], selections: DownloadSelection[], mode: DownloadMode): CatalogJob[] {
  if ((mode !== 'single' && mode !== 'batch') || !Array.isArray(selections) || selections.length < 1 || selections.length > 100 || (mode === 'single' && selections.length !== 1)) {
    throw new Error('单个下载请选择一项资源；批量下载请选择 1 到 100 项资源。');
  }
  const selectedGroups = new Set<string>();
  const lookup = (index: unknown): CatalogEntry => {
    if (!Number.isSafeInteger(index) || Number(index) < 1) throw new Error('请选择当前列表中的有效资源。');
    const entry = catalog.find(item => item.candidate.index === index);
    if (!entry || !entry.tracks.length || entry.tracks.length > 2 || !entry.tracks.every(eligibleTrack)) throw new Error('所选资源已无效，请重新解析。');
    return entry;
  };
  const reserve = (entry: CatalogEntry) => {
    const key = entry.candidate.groupKey ?? `candidate-${entry.candidate.index}`;
    if (selectedGroups.has(key)) throw new Error('每个资源组只能选择一个版本，不能重复选择。');
    selectedGroups.add(key);
  };
  return Array.from(selections, selection => {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection) || !Object.hasOwn(selection, 'candidateIndex') || Object.keys(selection).some(key => key !== 'candidateIndex' && key !== 'audioIndex')) {
      throw new Error('资源选择格式无效。');
    }
    const entry = lookup(selection.candidateIndex);
    reserve(entry);
    const tracks = [...entry.tracks];
    if (Object.hasOwn(selection, 'audioIndex')) {
      const audio = lookup(selection.audioIndex);
      if (entry.candidate.kind !== 'video' || tracks.length !== 1 || tracks[0].kind !== 'video' || audio.candidate.kind !== 'audio' || audio.tracks.length !== 1 || audio.tracks[0].kind !== 'audio' || !entry.candidate.audioOptions?.includes(audio.candidate.index)) {
        throw new Error('只能为单独视频选择列表中允许的音频。');
      }
      reserve(audio);
      tracks.push(audio.tracks[0]);
    }
    if (tracks.length === 2 && (tracks[0].kind !== 'video' || tracks[1].kind !== 'audio')) throw new Error('音视频组合无效，请重新选择。');
    return { label: `${entry.candidate.groupLabel ?? '资源'} · ${entry.candidate.variantLabel ?? `版本 ${entry.candidate.index}`}`, selection: { ...selection }, tracks };
  });
}

/** Connected components preserve first appearance and support transitive explicit relationships. */
function connected(keys: string[][]): number[][] {
  const parent = keys.map((_, index) => index);
  const root = (index: number): number => parent[index] === index ? index : (parent[index] = root(parent[index]));
  const owners = new Map<string, number>();
  keys.forEach((identities, index) => {
    for (const identity of identities) {
      const previous = owners.get(identity);
      if (previous === undefined) owners.set(identity, index);
      else parent[root(index)] = root(previous);
    }
  });
  const groups = new Map<number, number[]>();
  keys.forEach((_, index) => { const key = root(index); const members = groups.get(key) ?? []; members.push(index); groups.set(key, members); });
  return [...groups.values()];
}

function mergeRepresentation(items: Observation[]): Representation {
  const first = items[0].track;
  const track = { ...first, sourceRequestIds: [...new Set(items.flatMap(item => item.track.sourceRequestIds))], detectionReasons: [...new Set(items.flatMap(item => item.track.detectionReasons))] };
  return { track, observations: items.length, preferred: items.some(item => item.asset.selectedTrackIds.includes(item.track.id)) };
}

function resourceIdentities(track: MediaTrack, scope: string): string[] {
  let url: URL | undefined;
  try {
    url = new URL(track.sanitizedUrl); url.hash = '';
  } catch { /* Resource IDs still work when an observation has no parseable URL. */ }
  // IDs are supporting evidence, not an override for contradictory representation metadata.
  // Exact metadata agreement is deliberately conservative when captures enrich metadata later.
  const prefix = JSON.stringify([scope, track.kind, url?.href ?? track.sanitizedUrl, track.width, track.height, track.bitrate, track.byteLength, track.durationSeconds, track.codecs, track.mimeType]);
  const keys = [`track:${prefix}:${track.id}`, ...track.sourceRequestIds.map(id => `request:${prefix}:${id}`)];
  // A redacted credential can conceal a different resource. Such URLs are not equality evidence.
  if (url && !url.username && !url.password && ![...url.searchParams.values()].some(value => value.includes('[REDACTED]'))) keys.push(`url:${prefix}`);
  return keys;
}

function captureScope(runId: string, references: string[]): string {
  const scopes = new Set<string>();
  for (const reference of references) {
    try {
      const value: unknown = JSON.parse(reference);
      if (Array.isArray(value) && value.length === 6 && value.slice(0, 5).every(part => typeof part === 'string') && Number.isSafeInteger(value[5])) {
        scopes.add(JSON.stringify(value.slice(0, 4)));
      }
    } catch { /* Older captures have opaque request IDs scoped to their run. */ }
  }
  return JSON.stringify([runId, [...scopes].sort()]);
}

function contentIdentity(value: string): string | undefined {
  try {
    const url = new URL(value);
    const douyin = /^(?:[\w-]+\.)*douyinvod\.com$/i.test(url.hostname);
    for (const key of ['media_id', 'content_id', 'asset_id', ...(douyin ? ['video_id'] : [])]) {
      const values = url.searchParams.getAll(key);
      if (values.length === 1 && /^[\w.-]{1,512}$/.test(values[0])) return JSON.stringify([douyin ? 'douyinvod.com' : url.hostname, key, values[0]]);
    }
  } catch { /* No explicit identity, so the resource remains unconfirmed. */ }
  return undefined;
}

function preferredAudio(a: Representation, b: Representation): number {
  return Number(b.preferred) - Number(a.preferred) || (positiveNumber(b.track.bitrate) ?? 0) - (positiveNumber(a.track.bitrate) ?? 0) || (positiveInteger(b.track.byteLength) ?? 0) - (positiveInteger(a.track.byteLength) ?? 0);
}
function positiveNumber(value?: number): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined; }
function positiveInteger(value?: number): number | undefined { return Number.isSafeInteger(value) && value! > 0 ? value : undefined; }
function safeCodecs(value?: string): string | undefined {
  return value && value.length <= 160 && /^(?:avc[13]|hev1|hvc1|vp0?[89]|av01|mp4a|opus|vorbis|aac|flac|ac-3|ec-3)(?:\.[a-zA-Z0-9]+)*(?:\s*,\s*(?:avc[13]|hev1|hvc1|vp0?[89]|av01|mp4a|opus|vorbis|aac|flac|ac-3|ec-3)(?:\.[a-zA-Z0-9]+)*)*$/.test(value) ? value : undefined;
}
function displayMetadata(track: MediaTrack): Partial<DownloadCandidate> {
  return { width: positiveInteger(track.width), height: positiveInteger(track.height), durationSeconds: positiveNumber(track.durationSeconds), codecs: safeCodecs(track.codecs) };
}
function variantLabel(track: MediaTrack, index: number): string {
  if (track.kind === 'audio') return `音频 ${index}`;
  const width = positiveInteger(track.width), height = positiveInteger(track.height), bitrate = positiveNumber(track.bitrate);
  const quality = width && height ? `${width} × ${height}` : height ? `${height}p` : '清晰度未知';
  return `版本 ${index} · ${quality}${bitrate ? ` · ${Math.round(bitrate / 1000)} kbps` : ''}`;
}
