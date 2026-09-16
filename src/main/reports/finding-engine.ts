import { durationTolerance } from '../media/media-duration';
import { createHash } from 'node:crypto';
import type { Finding } from '../../shared/contracts';
import { canonical, validateRun, type ReportRun, type ReportProbe } from './report-run';
export type { ReportRun } from './report-run';
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const strings = (v: unknown) => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
const fresh = (r: ReportRun, e: ReportRun['events'][number]) => Date.parse(e.timestamp) >= Date.parse(r.startedAt) && Date.parse(e.timestamp) <= Date.parse(r.completedAt);
/** Links must identify the exact terminal probe event, source incarnation and structured evidence. */
export function supportedProbes(run: ReportRun): ReportProbe[] {
  const events = new Map(run.events.map(e => [e.id, e]));
  const byId = new Map<string, ReportProbe[]>();
  for (const p of run.probes) byId.set(p.id, [...(byId.get(p.id) ?? []), p]);
  return [...byId.values()].filter(group => group.every(p => canonical(p) === canonical(group[0]))).map(g => g[0]).filter(p => {
    const track = run.tracks.find(t => t.id === p.trackId);
    if (!track || !p.requestId || !track.sourceRequestIds.includes(p.requestId) || !p.evidenceEventIds.length) return false;
    return p.evidenceEventIds.every(id => {
      const e = events.get(id);
      return e && fresh(run, e) && e.phase === 'probe' && [`${p.name}:after`, `${p.name}:failed`, `${p.name}:cancelled`].includes(e.action)
        && ['succeeded', 'denied', 'warning', 'failed', 'cancelled'].includes(e.status)
        && e.relatedIds[0] === p.id && e.relatedIds.includes(p.trackId) && e.relatedIds.includes(p.requestId!)
        && canonical(e.evidence) === canonical(p.evidence) && canonical(e.inputSummary) === canonical(p.inputSummary)
        && p.evidence.outcome === p.outcome && p.evidence.status === p.status && p.evidence.bytesReceived === p.bytesReceived && p.evidence.contentRange === p.contentRange
        && (p.outcome !== 'accessible' || e.status === 'succeeded') && (p.outcome !== 'denied' || e.status === 'denied');
    });
  }).sort((a, b) => compare(a.trackId, b.trackId) || compare(a.name, b.name) || compare(a.id, b.id));
}
function mediaMime(p: ReportProbe): boolean {
  const mime = p.evidence.responseMimeType;
  return typeof mime === 'string' && (/^(video|audio)\//.test(mime) || mime === 'application/octet-stream') && ['structural', 'linked-range'].includes(String(p.evidence.mediaEvidence));
}
function byteRange(p: ReportProbe): { start: number; end: number; total: number } | undefined {
  if (!mediaMime(p) || p.outcome !== 'accessible' || p.status !== 206 || p.evidence.transportOutcome !== 'http' || !/^[a-f0-9]{64}$/.test(String(p.evidence.sampleSha256))) return;
  const m = p.contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/), q = String(object(p.evidence.requestDiff).range).match(/^bytes=(\d*)-(\d*)$/);
  if (!m || !q || (!q[1] && !q[2])) return;
  const [start, end, total] = m.slice(1).map(Number), desiredStart = q[1] ? Number(q[1]) : Math.max(0, total - Number(q[2])), desiredEnd = q[1] && q[2] ? Math.min(Number(q[2]), total - 1) : total - 1;
  const length = end - start + 1;
  if (![start, end, total, desiredStart, desiredEnd].every(Number.isSafeInteger) || start < 0 || end < start || total <= end || start !== desiredStart || end > desiredEnd
    || p.bytesReceived !== Math.min(length, 4096) || p.evidence.intentionallySampled !== (length > 4096) || (p.evidence.contentLength !== undefined && p.evidence.contentLength !== length)) return;
  return { start, end, total };
}
function accessible(p: ReportProbe): boolean {
  if (p.name === 'range-concurrent' && Array.isArray(p.evidence.responses)) {
    const responses = p.evidence.responses.map(object);
    return responses.length >= 2 && responses.length <= 4 && p.outcome === 'accessible'
      && p.bytesReceived === responses.reduce((sum, e) => sum + (typeof e.bytesReceived === 'number' ? e.bytesReceived : 0), 0)
      && responses.every(e => accessible({ ...p, name: 'range-head', status: e.status as number, outcome: e.outcome as ReportProbe['outcome'], bytesReceived: e.bytesReceived as number, contentRange: e.contentRange as string, evidence: e }));
  }
  return !!byteRange(p) || mediaMime(p) && p.outcome === 'accessible' && p.status === 200 && p.evidence.transportOutcome === 'http' && (p.bytesReceived ?? 0) > 0 && (p.bytesReceived ?? 0) <= 4096 && /^[a-f0-9]{64}$/.test(String(p.evidence.sampleSha256)) && p.name !== 'range-tail' && (p.evidence.intentionallySampled === true ? p.bytesReceived === 4096 && (p.evidence.contentLength === undefined || typeof p.evidence.contentLength === 'number' && p.evidence.contentLength > 4096) : p.evidence.intentionallySampled === false && (p.evidence.contentLength === undefined || p.evidence.contentLength === p.bytesReceived));
}
function structuralHead(p: ReportProbe): boolean {
  return p.evidence.mediaEvidence === 'structural' && accessible(p) && !!mutationSignature(p) && (p.status === 200 || byteRange(p)?.start === 0);
}
function recognizedHead(p: ReportProbe, probes: ReportProbe[]): ReportProbe | undefined {
  return probes.find(q => q.id !== p.id && q.requestId === p.requestId && q.trackId === p.trackId && structuralHead(q));
}
function supportedRefererAccess(p: ReportProbe, probes: ReportProbe[]): boolean {
  return supportedAccess(p, probes) && (structuralHead(p) || !!recognizedHead(p, probes));
}
function supportedAccess(p: ReportProbe, probes: ReportProbe[]): boolean {
  if (!mutationSignature(p) || !accessible(p)) return false;
  const head = structuralHead;
  if (p.name === 'range-concurrent' && Array.isArray(p.evidence.responses)) {
    const children = p.evidence.responses.map(object).map(e => ({ ...p, outcome: e.outcome as ReportProbe['outcome'], status: e.status as number, bytesReceived: e.bytesReceived as number, contentRange: e.contentRange as string, evidence: e }));
    return children.every(c => mutationSignature(c) && (c.evidence.mediaEvidence === 'structural' || byteRange(c) && byteRange(c)!.start > 0 && (children.some(head) || probes.some(q => q.id !== p.id && q.requestId === p.requestId && q.trackId === p.trackId && head(q)))));
  }
  return p.evidence.mediaEvidence === 'structural' || !!byteRange(p) && byteRange(p)!.start > 0 && probes.some(q => q.id !== p.id && q.requestId === p.requestId && q.trackId === p.trackId && head(q));
}
function accessEvidenceIds(p: ReportProbe, probes: ReportProbe[]): string[] {
  const head = structuralHead(p) ? undefined : recognizedHead(p, probes);
  return [...p.evidenceEventIds, ...(head?.evidenceEventIds ?? [])];
}
const denied = (p: ReportProbe) => p.outcome === 'denied' && [401, 403].includes(p.status ?? 0) && p.evidence.transportOutcome === 'http';
export function verifiedDownload(run: ReportRun, d: ReportRun['downloads'][number]): boolean {
  if (!d.completed || !d.byteLength || !d.evidenceEventIds.length || !d.trackIds.length || d.trackIds.some(id => !run.tracks.some(t => t.id === id && !t.encrypted && !t.incomplete))) return false;
  let next = 0; for (const i of [...d.intervals].sort((a, b) => a.start - b.start)) { if (i.start !== next || i.end < i.start) return false; next = i.end + 1; }
  return next === d.byteLength && d.evidenceEventIds.every(id => run.events.some(e => e.id === id && fresh(run, e) && e.phase === 'download' && e.action === 'download:after' && e.status === 'succeeded' && e.relatedIds.includes(d.id) && d.trackIds.every(id => run.tracks.find(t => t.id === id)?.sourceRequestIds.includes(String(e.inputSummary?.sourceRequestId))) && e.evidence?.completedBytes === d.byteLength && e.evidence?.totalBytes === d.byteLength && e.evidence?.sha256 === d.sha256));
}
function validMediaProbe(p: NonNullable<ReportRun['mediaVerifications'][number]['probe']>): boolean {
  if (!(p.durationSeconds > 0 && p.durationSeconds <= 604800)) return false;
  const allowed = p.container === 'mp4' ? { video: ['h264', 'hevc', 'av1', 'mpeg4'], audio: ['aac', 'mp3', 'alac', 'ac3', 'eac3', 'opus'] } : { video: ['vp8', 'vp9', 'av1'], audio: ['opus', 'vorbis'] };
  return p.streams.every(s => allowed[s.kind].includes(s.codec) && s.packetCount > 0 && s.durationSeconds > 0
    && Math.abs(s.durationSeconds - p.durationSeconds) <= durationTolerance(p.durationSeconds)
    && /^[1-9]\d*\/[1-9]\d*$/.test(s.timeBase) && /^(?:SHA256:)?[a-f0-9]{64}$/i.test(s.extradataHash)
    && (s.kind === 'video' ? (s.width ?? 0) > 0 && (s.height ?? 0) > 0 : (s.sampleRate ?? 0) > 0 && (s.channels ?? 0) > 0));
}
export function verifiedMedia(run: ReportRun, v: ReportRun['mediaVerifications'][number]): boolean {
  if (v.status !== 'succeeded' || !v.probe || !validMediaProbe(v.probe) || v.trackIds.length !== 2 || new Set(v.trackIds).size !== 2 || v.evidenceEventIds.length !== 1 || !v.inputs || v.inputs.length !== 2) return false;
  const tracks = v.trackIds.map(id => run.tracks.find(t => t.id === id));
  if (tracks.some(t => !t || t.encrypted || t.incomplete || t.eligible === false) || !tracks.some(t => t?.kind === 'video') || !tracks.some(t => t?.kind === 'audio')) return false;
  if (v.probe.streams.length !== 2 || !v.probe.streams.some(s => s.kind === 'video') || !v.probe.streams.some(s => s.kind === 'audio') || new Set(v.inputs.map(i => i.trackId)).size !== 2) return false;
  for (const input of v.inputs) {
    const track = tracks.find(t => t?.id === input.trackId);
    if (!track || !track.sourceRequestIds.includes(input.sourceRequestId) || !validMediaProbe(input.probe) || input.probe.container !== v.probe.container || input.probe.streams.length !== 1 || input.probe.streams[0].kind !== track.kind) return false;
    if (input.downloadId) {
      const d = run.downloads.find(d => d.id === input.downloadId);
      if (!d || d.trackIds.length !== 1 || d.trackIds[0] !== track.id || !verifiedDownload(run, d) || !d.evidenceEventIds.every(id => run.events.find(e => e.id === id)?.inputSummary?.sourceRequestId === input.sourceRequestId)) return false;
    }
    const before = input.probe.streams[0], after = v.probe.streams.find(s => s.kind === before.kind)!;
    const { durationSeconds: bd, ...bp } = before, { durationSeconds: ad, ...ap } = after;
    if (canonical(bp) !== canonical(ap) || Math.abs(bd - ad) > durationTolerance(bd) || Math.abs(bd - v.probe.durationSeconds) > durationTolerance(bd)) return false;
    if (track.durationSeconds !== undefined && Math.abs(track.durationSeconds - bd) > durationTolerance(bd)) return false;
    if (track.codecs && !track.codecs.split(/[ ,]+/).some(codec => codec === before.codec || (before.codec === 'h264' && codec.startsWith('avc1')) || (before.codec === 'aac' && codec.startsWith('mp4a')))) return false;
  }
  const related = [v.id, ...v.trackIds, ...v.inputs.flatMap(i => i.downloadId ? [i.downloadId] : [])].sort(compare);
  return v.evidenceEventIds.every(id => run.events.some(e => e.id === id && fresh(run, e) && e.phase === (v.operation === 'remux' ? 'ffmpeg' : 'verify') && e.action === `${v.operation}:result` && e.status === 'succeeded'
    && canonical(e.relatedIds.slice().sort(compare)) === canonical(related) && canonical(e.inputSummary?.inputs) === canonical(v.inputs)
    && canonical(e.evidence?.probe) === canonical(v.probe) && (v.operation !== 'remux' || e.evidence?.committed === true)));
}
const transportOnly = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'range']);
function projectedHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const entries = Object.entries(value);
  if (!entries.every(([k, v]) => k === k.toLowerCase() && typeof v === 'string')) return;
  return Object.fromEntries(entries) as Record<string, string>;
}
/** Check the actual canonical runner mutation, not a label supplied alongside a denial. */
function mutationSignature(p: ReportProbe): string | undefined {
  if (!['baseline', 'forged-referer', 'alternate-referer', ...Object.keys(controls)].includes(p.name) || p.inputSummary.mutation !== p.name || p.inputSummary.sourceRequestId !== undefined && p.inputSummary.sourceRequestId !== p.requestId || !Array.isArray(p.evidence.redirects) || p.evidence.redirects.length) return;
  const d = object(p.evidence.requestDiff), before = projectedHeaders(d.beforeHeaders), after = projectedHeaders(d.afterHeaders);
  if (!before || !after || typeof d.range !== 'string' || !/^bytes=(?:\d+-\d*|-\d+)$/.test(d.range) || after.range !== d.range || after['accept-encoding'] !== 'identity') return;
  const omitted = strings(d.omittedHeaderNames).slice().sort(compare), changed = strings(d.changedHeaderNames).slice().sort(compare);
  const actualOmitted = Object.keys(before).filter(k => !(k in after)).sort(compare), actualChanged = Object.keys(after).filter(k => after[k] !== before[k]).sort(compare);
  if (canonical(omitted) !== canonical(actualOmitted) || canonical(changed) !== canonical(actualChanged)) return;
  const mutation = ({ 'without-cookie': 'cookie', 'without-referer': 'referer', 'without-origin': 'origin' } as Record<string, string>)[p.name];
  if (d.query !== (p.name === 'without-query' ? 'all observed query fields omitted' : 'observed query unchanged')) return;
  if (mutation && (!before[mutation] || mutation in after)) return;
  const forged = ['forged-referer', 'alternate-referer'].includes(p.name);
  if (forged && (!before.referer || !after.referer || before.referer === after.referer || after.referer === '[REDACTED]')) return;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === mutation || forged && key === 'referer') continue;
    if (before[key] !== after[key] && !(transportOnly.has(key) || key.startsWith('if-') || key.startsWith('proxy-') || key.startsWith(':'))) return;
    if (key !== 'range' && key !== 'accept-encoding' && before[key] !== after[key] && key in after) return;
  }
  return canonical({ source: p.requestId, name: p.name, before, after, query: d.query, range: d.range, redirects: p.evidence.redirects ?? [] });
}
function forgedReferer(success: ReportProbe, absent: ReportProbe, probes: ReportProbe[]): boolean {
  if (!supportedRefererAccess(success, probes) || success.requestId !== absent.requestId || !mutationSignature(success) || !mutationSignature(absent)) return false;
  const s = object(success.evidence.requestDiff), a = object(absent.evidence.requestDiff);
  const after = { ...object(s.afterHeaders) }; delete after.referer;
  return canonical(s.beforeHeaders) === canonical(a.beforeHeaders) && canonical(after) === canonical(a.afterHeaders)
    && s.range === a.range && s.query === a.query && canonical(success.evidence.redirects ?? []) === canonical(absent.evidence.redirects ?? []);
}
function replayedReferer(baseline: ReportProbe, absent: ReportProbe, probes: ReportProbe[]): boolean {
  if (baseline.name !== 'baseline' || !mutationSignature(baseline) || !mutationSignature(absent) || baseline.requestId !== absent.requestId || !supportedRefererAccess(baseline, probes)) return false;
  const b = object(baseline.evidence.requestDiff), a = object(absent.evidence.requestDiff);
  const before = object(b.beforeHeaders), bh = object(b.afterHeaders), ah = object(a.afterHeaders);
  if (typeof bh.referer !== 'string' || !bh.referer || bh.referer === '[REDACTED]' || before.referer !== bh.referer || 'referer' in ah) return false;
  const without = { ...bh }; delete without.referer;
  return canonical(before) === canonical(object(a.beforeHeaders)) && canonical(without) === canonical(ah)
    && canonical(strings(a.omittedHeaderNames).slice().sort(compare)) === canonical([...strings(b.omittedHeaderNames), 'referer'].sort(compare)) && b.query === a.query && b.range === a.range
    && canonical(baseline.evidence.redirects ?? []) === canonical(absent.evidence.redirects ?? []);
}
const controls: Record<string, string> = { 'without-cookie': '移除 Cookie', 'without-query': '移除查询参数', 'without-origin': '移除 Origin', 'without-referer': '移除 Referer', 'expiry-replay': '到期后重放', 'range-concurrent': '并发 Range', 'range-head': '头部 Range', 'range-middle': '中部 Range', 'range-tail': '尾部 Range', 'range-full': '完整 Range 请求' };
export function buildFindings(input: ReportRun): Finding[] {
  const run = validateRun(input), probes = supportedProbes(run), findings: Finding[] = [];
  const add = (key: string, title: string, severity: Finding['severity'], confidence: Finding['confidence'], observedBehavior: string, practicalImpact: string, limitations: string[], recommendation: string, evidenceEventIds: string[]) => {
    const ids = [...new Set(evidenceEventIds)].sort(compare);
    if (!ids.length || ids.some(id => !run.events.some(e => e.id === id))) return;
    findings.push({ id: `finding-${createHash('sha256').update(`${run.runId}:${key}`).digest('hex').slice(0, 16)}`, runId: run.runId, title, severity, confidence, observedBehavior, practicalImpact, summary: observedBehavior, limitations: [...new Set(limitations)], recommendation, evidenceEventIds: ids });
  };
  for (const t of [...run.tracks].sort((a, b) => compare(a.id, b.id))) {
    const ps = probes.filter(p => p.trackId === t.id);
    const knownTotals = [t.byteLength, ...run.requests.filter(r => t.sourceRequestIds.includes(r.id)).map(r => r.status === 200 ? r.contentLength : /^bytes \d+-\d+\/(\d+)$/.test(r.contentRange ?? '') ? Number(r.contentRange!.split('/')[1]) : undefined)].filter((n): n is number => n !== undefined && Number.isSafeInteger(n));
    const lengthMismatch = ps.some(p => byteRange(p) && knownTotals.some(total => total !== byteRange(p)!.total));
    const limited = lengthMismatch || run.probes.some(p => p.trackId === t.id && !ps.some(valid => valid.id === p.id)) || t.incomplete || t.eligible === false || run.limitations.length > 0 || ps.some(p => strings(p.evidence.limitations).length > 0);
    const conflicts = new Set(ps.filter(p => ps.some(q => q.name === p.name && q.requestId === p.requestId && q.outcome !== p.outcome)).map(p => p.name));
    const limits = [...(lengthMismatch ? ['捕获的轨道长度与探针总长度矛盾。'] : []), ...(limited ? ['捕获或测试不完整；仅适用于已观察请求。'] : []), ...(conflicts.size ? ['重复探针存在矛盾；需重新捕获并复测。'] : [])];
    if (t.encrypted || ps.some(p => p.outcome === 'encrypted')) {
      const ids = run.events.filter(e => fresh(run, e) && e.relatedIds.includes(t.id) && (e.evidence?.encrypted === true || e.evidence?.outcome === 'encrypted')).map(e => e.id);
      add(`${t.id}:encrypted`, '检测到加密，未验证许可证策略', 'info', 'high', '媒体轨道或响应包含加密标记。', '当前工具未验证许可证签发、授权或解密后的输出。', [...limits, '加密标记不能证明 DRM 强度，也不能证明可绕过；许可证请求失败仍无法判定策略。'], '由授权团队单独审查许可证服务和终端播放策略。', ids);
    } else {
      const head = ps.find(p => p.name === 'without-query' && object(p.evidence.requestDiff).query === 'all observed query fields omitted' && supportedAccess(p, ps) && p.evidence.mediaEvidence === 'structural' && (p.status === 200 ? p.evidence.intentionallySampled === false && Number.isSafeInteger(p.evidence.contentLength) && p.evidence.contentLength === p.bytesReceived && knownTotals.every(total => total === p.evidence.contentLength) : byteRange(p)?.start === 0));
      const tail = ps.find(p => p.name === 'range-tail' && supportedAccess(p, ps) && byteRange(p) && byteRange(p)!.start > 0 && byteRange(p)!.end === byteRange(p)!.total - 1 && p.requestId === head?.requestId && (head?.status === 200 ? head.evidence.contentLength === byteRange(p)!.total : byteRange(head!)?.total === byteRange(p)!.total));
      if (head && tail && !t.incomplete && t.eligible !== false) add(`${t.id}:retrieval`, '可完整获取', 'high', limited || conflicts.size ? 'medium' : 'high', `无查询参数请求返回 ${head.bytesReceived} 字节；独立尾部 Range 返回 ${tail.contentRange}，字节数与区间一致。`, '可通过分段请求组合获取该表示的媒体字节。', [...limits, '这是基于有界头尾样本的可获取性推断；未实际验证完整下载、全部中间区间或完整播放。', '尾部请求保留原观察凭据；未证明全文件可匿名或无查询参数获取。'], '在服务端逐请求校验短期授权及资源绑定；限制批量滥用并监控异常分段访问。', [...head.evidenceEventIds, ...tail.evidenceEventIds]);
      const absent = ps.find(p => p.name === 'without-referer' && denied(p) && strings(object(p.evidence.requestDiff).omittedHeaderNames).includes('referer'));
      const forged = ps.find(p => ['forged-referer', 'alternate-referer'].includes(p.name) && absent && forgedReferer(p, absent, ps));
      const replay = absent && ps.find(p => replayedReferer(p, absent, ps));
      if (absent && !forged && replay) add(`${t.id}:referer`, 'Referer-only 弱防护', 'high', conflicts.size || limited ? 'medium' : 'high', '观察到的 Referer 值可在独立客户端重放并取得媒体字节；仅移除该头后返回 401/403。', '本次差分表明服务端信任可由客户端重放的 Referer 值。', [...limits, '未测试任意或替代 Referer 值；本次重放保留其他观察到的鉴权条件。'], '将 Referer 作为辅助信号，并逐请求验证服务端授权与资源绑定。', [...absent.evidenceEventIds, ...accessEvidenceIds(replay, ps)]);
      if (absent && forged) add(`${t.id}:referer`, 'Referer-only 弱防护', 'high', conflicts.size || limited ? 'medium' : 'high', '缺少 Referer 返回 401/403；明确更换 Referer 后媒体字节可访问。', '该观察到的 Referer 校验可由独立客户端满足。', [...limits, '仅证明本次测试差分；不证明所有其他鉴权条件均不存在。'], '将 Referer 作为辅助信号，使用服务端授权、短期凭据及资源绑定。', [...absent.evidenceEventIds, ...accessEvidenceIds(forged, ps)]);
    }
    for (const name of [...new Set(ps.map(p => p.name))].sort(compare)) {
      if (!controls[name]) continue;
      const group = ps.filter(p => p.name === name), success = group.filter(p => supportedAccess(p, ps));
      const partitions = new Map<string, ReportProbe[]>();
      for (const p of group.filter(denied)) { const signature = mutationSignature(p); if (signature) partitions.set(signature, [...(partitions.get(signature) ?? []), p]); }
      const denial = [...partitions.entries()].sort(([a], [b]) => compare(a, b)).map(([, ps]) => ps.filter((p, i) => ps.slice(0, i).every(q => q.evidenceEventIds.every(id => !p.evidenceEventIds.includes(id))))).find(ps => ps.length >= 2) ?? [];
      if (denial.length >= 2 && !conflicts.has(name)) add(`${t.id}:${name}:deny`, `${controls[name]}：观察到服务端拒绝`, 'info', limited ? 'low' : 'medium', `${denial.length} 次等价请求的独立测试均返回 ${[...new Set(denial.map(p => p.status))].join('/')}。`, '该服务端控制在相同测试条件下限制了本次请求。', [...limits, '只覆盖已测试的条件和时间窗口；无法证明公开媒体不能被保存。'], '保留并监控该服务端控制，结合授权与过期策略继续验证。', denial.flatMap(p => p.evidenceEventIds));
      if (success.length && !['range-head', 'range-tail', 'without-query'].includes(name)) add(`${t.id}:${name}:access`, `${controls[name]}：媒体样本可访问`, name.startsWith('without') || name === 'expiry-replay' ? 'medium' : 'low', conflicts.size || limited ? 'medium' : 'high', '结构化响应证据确认本次变更后仍可取得有界媒体样本。', name === 'without-origin' ? '服务端访问与浏览器 CORS 限制相互独立。' : '该条件未阻止本次样本访问。', [...limits, '有界测试不等于完整下载；并发测试不等于无限速。'], '结合资源授权、有效期、频率和并发限额评估实际滥用成本。', success.flatMap(p => p.evidenceEventIds));
    }
  }
  for (const d of run.downloads.filter(d => verifiedDownload(run, d))) add(`${d.id}:download`, '完整下载已验证', 'high', 'high', `连续区间覆盖 ${d.byteLength} 字节并完成 SHA-256 校验。`, '已获得该媒体轨道的完整字节文件。', ['长度和哈希证明本次下载完整性，不等于已验证完整播放或所有候选轨道。'], '依据业务风险实施逐请求授权与滥用检测。', d.evidenceEventIds);
  for (const v of run.mediaVerifications.filter(v => verifiedMedia(run, v))) add(`${v.id}:media`, v.operation === 'remux' ? '无损封装已验证' : '媒体结构已验证', 'info', 'high', v.operation === 'remux' ? 'FFmpeg -c copy 输出已通过 ffprobe 的轨道与媒体参数检查。' : 'ffprobe 已读取并验证媒体结构与轨道参数。', '结果支持本次媒体结构或封装完整性判断。', ['结构和参数验证不替代完整解码播放，也不证明访问控制强弱。'], '保留证据哈希并对关键播放场景进行端到端复核。', v.evidenceEventIds);
  const failures = run.events.filter(e => fresh(run, e) && (['failed', 'cancelled'].includes(e.status) || e.evidence?.outcome === 'inconclusive' || ['timeout', 'dns', 'tls', 'parser', 'network', 'cancelled'].includes(String(e.evidence?.transportOutcome))));
  if (failures.length) add('exceptions', '测试异常', 'info', 'high', '发生传输、解析、工具、文件系统错误、取消或证据不足。', '对应测试无法判定媒体访问控制。', ['工具执行失败和未取得完整媒体不能证明防护有效。'], '排除环境问题，重新捕获有效请求并复测；保留失败事件用于复核。', failures.map(e => e.id));
  const severity = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }, confidence = { high: 0, medium: 1, low: 2 };
  return findings.sort((a, b) => severity[a.severity] - severity[b.severity] || confidence[a.confidence] - confidence[b.confidence] || compare(a.id, b.id));
}
