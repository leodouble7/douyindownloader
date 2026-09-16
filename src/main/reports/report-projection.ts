import { buildFindings, supportedProbes, verifiedDownload, verifiedMedia } from './finding-engine';
import type { ReportRun } from './report-run';
export const probeNames = ['baseline', 'without-cookie', 'without-query', 'without-referer', 'without-origin', 'range-head', 'range-middle', 'range-tail', 'range-full', 'range-concurrent', 'expiry-replay', 'forged-referer', 'alternate-referer'] as const;
const headerNames = ['cookie', 'authorization', 'referer', 'origin', 'range', 'accept', 'accept-encoding', 'host', 'connection', 'content-length', 'transfer-encoding', 'if-range', 'if-none-match', 'if-modified-since'] as const;
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const number = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
const decimal = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
const choose = <T extends string>(v: unknown, choices: readonly T[]): T | undefined => typeof v === 'string' && choices.includes(v as T) ? v as T : undefined;
const exact = (v: unknown, pattern: RegExp) => typeof v === 'string' && v.length <= 128 && pattern.test(v) ? v : undefined;
const hash = (v: unknown) => exact(v, /^(?:SHA256:)?[a-f0-9]{64}$/i);
const range = (v: unknown) => exact(v, /^bytes=(?:\d+-\d*|-\d+)$/);
const contentRange = (v: unknown) => exact(v, /^bytes \d+-\d+\/\d+$/);
const mime = (v: unknown) => exact(v, /^(?:video|audio|application|text)\/[a-z0-9.+-]{1,64}$/);
const codec = (v: unknown) => exact(v, /^(?:h264|hevc|av1|vp8|vp9|aac|mp3|alac|ac3|eac3|opus|vorbis|mpeg4|avc1(?:\.[a-fA-F0-9]+)?|mp4a(?:\.\d+)*)(?:[, ]+(?:avc1|mp4a)(?:\.[a-fA-F0-9]+)*)?$/);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = <T extends { id: string }>(items: T[]): T[] => [...items].sort((a, b) => compare(a.id, b.id));
function aliases(prefix: string, ids: string[]) { return new Map([...new Set(ids)].sort(compare).map((id, i) => [id, `${prefix}-${String(i + 1).padStart(3, '0')}`])); }
function presence(value: unknown) { const record = object(value); return Object.fromEntries(headerNames.map(name => [name, Object.hasOwn(record, name)])); }
function mediaProbe(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const p = object(value);
  return { container: choose(p.container, ['mp4', 'webm']), durationSeconds: decimal(p.durationSeconds), streams: Array.isArray(p.streams) ? p.streams.slice(0, 16).map(value => {
    const s = object(value);
    return { kind: choose(s.kind, ['video', 'audio']), codec: codec(s.codec), codecTag: choose(s.codecTag, ['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'mp4a', 'mp3', 'ac-3', 'ec-3', 'Opus', '[0][0][0][0]']), profile: choose(s.profile, ['High', 'Main', 'Baseline', 'Constrained Baseline', 'LC', 'HE-AAC', 'Profile 0', 'Profile 1', 'unknown']),
      level: number(s.level), timeBase: exact(s.timeBase, /^[1-9]\d*\/[1-9]\d*$/), durationSeconds: decimal(s.durationSeconds), packetCount: number(s.packetCount), extradataHash: hash(s.extradataHash), width: number(s.width), height: number(s.height), sampleRate: number(s.sampleRate), channels: number(s.channels) };
  }) : [] };
}
function safeEvidence(value: unknown, name?: unknown, depth = 0): Record<string, unknown> {
  if (depth > 4) return {};
  const e = object(value), d = object(e.requestDiff), redirects = Array.isArray(e.redirects) ? e.redirects.map(object) : [];
  return {
    outcome: choose(e.outcome, ['accessible', 'denied', 'encrypted', 'inconclusive']), transportOutcome: choose(e.transportOutcome, ['http', 'dns', 'tls', 'timeout', 'parser', 'network', 'cancelled', 'limitation']),
    status: number(e.status), responseMimeType: mime(e.responseMimeType), contentRange: contentRange(e.contentRange), contentLength: number(e.contentLength), bytesReceived: number(e.bytesReceived), durationMs: decimal(e.durationMs),
    probe: mediaProbe(e.probe), mediaEvidence: choose(e.mediaEvidence, ['structural', 'linked-range']),
    sampleSha256: hash(e.sampleSha256), sha256: hash(e.sha256), completedBytes: number(e.completedBytes), totalBytes: number(e.totalBytes),
    intentionallySampled: typeof e.intentionallySampled === 'boolean' ? e.intentionallySampled : undefined, encrypted: e.encrypted === true, committed: e.committed === true,
    request: { mutation: choose(name, probeNames), range: range(d.range), queryOmitted: d.query === 'all observed query fields omitted' ? true : d.query === 'observed query unchanged' ? false : undefined,
      omittedHeaderNames: Array.isArray(d.omittedHeaderNames) ? headerNames.filter(n => d.omittedHeaderNames && (d.omittedHeaderNames as unknown[]).includes(n)) : [],
      changedHeaderNames: Array.isArray(d.changedHeaderNames) ? headerNames.filter(n => d.changedHeaderNames && (d.changedHeaderNames as unknown[]).includes(n)) : [], beforePresence: presence(d.beforeHeaders), afterPresence: presence(d.afterHeaders), redirectCount: redirects.length, redirectStatuses: redirects.map(r => number(r.status)).filter(n => n !== undefined) },
    responses: Array.isArray(e.responses) ? e.responses.slice(0, 4).map(r => safeEvidence(r, name, depth + 1)) : undefined,
    interval: e.interval ? { start: number(object(e.interval).start), end: number(object(e.interval).end) } : undefined,
    code: choose(e.code, ['timeout', 'cancelled', 'tool-unavailable', 'integrity-mismatch', 'publication-recovery-required', 'invalid-resume', 'premature-eof', 'insufficient-space'])
  };
}
const purposes: Record<ReportRun['events'][number]['phase'], string> = { browser: '观察授权播放页面', capture: '记录页面、iframe、Worker 与 MSE 可见行为', correlate: '关联已观察媒体资产与轨道', probe: '验证有界媒体请求的访问条件', download: '下载并校验连续媒体字节', ffmpeg: '复制媒体流并验证封装结果', verify: '验证媒体结构和轨道参数', report: '生成脱敏证据报告' };
const conclusions: Record<ReportRun['events'][number]['status'], string> = { queued: '动作已排队', running: '动作执行中', succeeded: '动作返回成功，结论需结合关联证据', denied: '观察到请求拒绝', warning: '证据受限，无法直接判定', failed: '动作失败，无法据此证明防护有效', cancelled: '动作取消，相关测试无法判定' };
export function reportProjection(run: ReportRun, clean: (s: string) => string, location: (s: string) => { origin: string; path: string }) {
  const requestIds = aliases('request', [...run.requests.map(r => r.id), ...run.tracks.flatMap(t => t.sourceRequestIds)]), trackIds = aliases('track', run.tracks.map(t => t.id)), assetIds = aliases('asset', run.assets.map(a => a.id));
  const eventIds = aliases('event', run.events.map(e => e.id)), probeIds = aliases('probe', run.probes.map(p => p.id)), downloadIds = aliases('download', run.downloads.map(d => d.id)), verificationIds = aliases('verification', run.mediaVerifications.map(v => v.id));
  const links = (ids: string[]) => ids.flatMap(id => eventIds.has(id) ? [eventIds.get(id)!] : []).sort(compare);
  const tracksFor = (ids: string[]) => ids.flatMap(id => trackIds.has(id) ? [trackIds.get(id)!] : []);
  const inputsFor = (v: ReportRun['mediaVerifications'][number]) => v.inputs?.map(i => ({ trackId: trackIds.get(i.trackId) ?? 'unlinked-track', requestId: requestIds.get(i.sourceRequestId) ?? 'unlinked-request', downloadId: i.downloadId ? downloadIds.get(i.downloadId) : undefined, probe: mediaProbe(i.probe) }));
  const valid = new Set(supportedProbes(run).map(p => p.id));
  const findings = buildFindings(run).map((f, i) => ({ ...f, id: `finding-${String(i + 1).padStart(3, '0')}`, runId: 'run-001', evidenceEventIds: links(f.evidenceEventIds) }));
  const tracks = sorted(run.tracks).map(t => ({ id: trackIds.get(t.id)!, kind: t.kind, location: location(t.sanitizedUrl), mimeType: mime(t.mimeType), codecs: codec(t.codecs), byteLength: t.byteLength, width: t.width, height: t.height, bitrate: t.bitrate, durationSeconds: t.durationSeconds, encrypted: t.encrypted, incomplete: t.incomplete, detectionReasonCount: t.detectionReasons.length }));
  const events = [...run.events].sort((a, b) => a.sequence - b.sequence || compare(a.id, b.id)).map(e => {
    const [name, stage] = e.action.split(':'); const mutation = choose(name, probeNames);
    const action = mutation && ['queued', 'before', 'after', 'failed', 'cancelled'].includes(stage) ? `${mutation}:${stage}` : /^(?:download|remux|probe):(?:queued|before|progress|after|failed|cancelled|result|command)$/.test(e.action) ? e.action : `${e.phase}:observation`;
    return { id: eventIds.get(e.id)!, sequence: e.sequence, timestamp: e.timestamp, phase: e.phase, action, purpose: purposes[e.phase], status: e.status, conclusion: conclusions[e.status], inputSummary: { inputs: (() => { const v = run.mediaVerifications.find(v => v.evidenceEventIds.includes(e.id) && verifiedMedia(run, v)); return v ? inputsFor(v) : undefined; })() }, evidence: safeEvidence(e.evidence, mutation) };
  });
  const probes = sorted(run.probes).map(p => ({ id: probeIds.get(p.id)!, trackId: trackIds.get(p.trackId) ?? 'unlinked-track', name: choose(p.name, probeNames) ?? 'unrecognized-probe', outcome: p.outcome, status: p.status, bytesReceived: p.bytesReceived, contentRange: contentRange(p.contentRange), durationMs: p.durationMs, evidenceEventIds: valid.has(p.id) ? links(p.evidenceEventIds) : [], evidenceVerified: valid.has(p.id), evidence: safeEvidence(p.evidence, p.name) }));
  const downloads = sorted(run.downloads).map(d => ({ id: downloadIds.get(d.id)!, trackIds: tracksFor(d.trackIds), evidenceEventIds: verifiedDownload(run, d) ? links(d.evidenceEventIds) : [], byteLength: d.byteLength, sha256: hash(d.sha256), intervals: [...d.intervals].sort((a, b) => a.start - b.start), completed: d.completed, verified: verifiedDownload(run, d) }));
  const mediaVerifications = sorted(run.mediaVerifications).map(v => ({ id: verificationIds.get(v.id)!, trackIds: tracksFor(v.trackIds), evidenceEventIds: verifiedMedia(run, v) ? links(v.evidenceEventIds) : [], operation: v.operation, status: v.status, verified: verifiedMedia(run, v), inputs: verifiedMedia(run, v) ? inputsFor(v) : undefined, probe: mediaProbe(v.probe) }));
  return { version: 2, runId: 'run-001', mode: run.mode, authorizationConfirmed: run.authorizationConfirmed, startedAt: run.startedAt, completedAt: run.completedAt,
    target: location(`${run.target.sanitizedOrigin.replace(/\/$/, '')}/${run.target.sanitizedPath.replace(/^\//, '')}`),
    requests: sorted(run.requests).map(r => ({ id: requestIds.get(r.id)!, location: location(r.sanitizedUrl), method: choose(r.method, ['GET', 'HEAD', 'POST']) ?? 'other', status: r.status, mimeType: mime(r.mimeType), contentLength: r.contentLength, receivedAt: r.receivedAt.length <= 40 && Number.isFinite(Date.parse(r.receivedAt)) && /^\d{4}-\d\d-\d\dT[\d:.+-]+Z?$/.test(r.receivedAt) ? r.receivedAt : undefined })),
    assets: sorted(run.assets).map(a => ({ id: assetIds.get(a.id)!, title: `视频资产 ${assetIds.get(a.id)!.split('-')[1]}`, trackIds: tracksFor(a.trackIds), selectedTrackIds: tracksFor(a.selectedTrackIds), confidence: a.confidence, encrypted: a.encrypted })), tracks, events, probes, downloads, mediaVerifications, findings,
    limitations: [...(run.limitations.length ? ['本次运行记录了捕获或测试限制，原始诊断文本不对外导出。'] : []), ...(!run.authorizationConfirmed ? ['未记录授权确认。'] : []), ...(run.probes.some(p => !valid.has(p.id)) ? ['存在缺失、陈旧、矛盾或不匹配的探针证据，已排除相关结论。'] : [])],
    prioritizedFixes: findings.map(f => ({ severity: f.severity, findingId: f.id, recommendation: f.recommendation })) };
}
