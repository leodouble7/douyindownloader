import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildFindings } from '../../src/main/reports/finding-engine';
import { generateReports } from '../../src/main/reports/report-generator';
import { validateRun, type ReportRun } from '../../src/main/reports/report-run';
import { event, probe, reportRun } from '../helpers/report-fixture';
const dirs: string[] = [];
async function dir() { const d = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'report-review-')); dirs.push(d); return d; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });
function sync(run: ReportRun) { for (const p of run.probes) { const e = run.events.find(e => e.id === p.evidenceEventIds[0]); if (e) e.evidence = structuredClone(p.evidence); } }
function diff(name: string) {
  const beforeHeaders: Record<string, string> = { cookie: '[REDACTED]', authorization: '[REDACTED]', referer: 'https://media.example/watch', origin: 'https://media.example', accept: 'video/mp4' };
  const afterHeaders: Record<string, string> = { ...beforeHeaders, range: 'bytes=0-4095', 'accept-encoding': 'identity' };
  const omitted = name.startsWith('without-') ? name.slice(8) : '';
  if (omitted && omitted !== 'query') delete afterHeaders[omitted as keyof typeof afterHeaders];
  if (name === 'forged-referer') afterHeaders.referer = 'https://media.example/alternate';
  return { beforeHeaders, afterHeaders, query: name === 'without-query' ? 'all observed query fields omitted' : 'observed query unchanged', range: 'bytes=0-4095', omittedHeaderNames: omitted && omitted !== 'query' ? [omitted] : [], changedHeaderNames: ['range', 'accept-encoding', ...(name === 'forged-referer' ? ['referer'] : [])] };
}
function refPair() { const r = reportRun(); const a = probe(r, 'without-referer', { outcome: 'denied', status: 403, bytesReceived: 0 }); const b = probe(r, 'forged-referer'); a.evidence.requestDiff = diff(a.name); b.evidence.requestDiff = diff(b.name); sync(r); return r; }
describe('reviewed finding counterexamples', () => {
  it.each(['authorization', 'cookie', 'origin', 'range', 'query', 'redirect', 'missing'])('forged Referer plus %s mutation is not Referer-only evidence', change => {
    const r = refPair(); const d = r.probes[1].evidence.requestDiff as ReturnType<typeof diff>;
    if (change === 'query') d.query = 'all observed query fields omitted';
    else if (change === 'redirect') r.probes[1].evidence.redirects = [{ status: 302, sanitizedUrl: 'https://other.test', followed: true }];
    else if (change === 'missing') delete (d as Partial<typeof d>).beforeHeaders;
    else (d.afterHeaders as Record<string, string>)[change] = 'changed';
    sync(r); expect(buildFindings(r).some(f => f.title === 'Referer-only 弱防护')).toBe(false);
  });
  it('complete sole forged Referer differential is supported', () => { expect(buildFindings(refPair()).some(f => f.title === 'Referer-only 弱防护')).toBe(true); });
  it.each(['header-not-removed', 'different-source', 'different-range', 'different-query', 'cookie-never-present'])('repeated denials cannot prove a control with %s', change => {
    const r = reportRun(); for (let i = 0; i < 2; i++) { const p = probe(r, 'without-cookie', { outcome: 'denied', status: 403, bytesReceived: 0 }); p.evidence.requestDiff = diff(p.name); }
    const d = r.probes[1].evidence.requestDiff as ReturnType<typeof diff>;
    if (change === 'header-not-removed') d.afterHeaders.cookie = '[REDACTED]';
    if (change === 'different-source') { r.tracks[0].sourceRequestIds.push('source-v2'); r.probes[1].requestId = 'source-v2'; r.events[1].relatedIds[2] = 'source-v2'; }
    if (change === 'different-range') { d.range = 'bytes=100-199'; d.afterHeaders.range = 'bytes=100-199'; }
    if (change === 'different-query') d.query = 'all observed query fields omitted';
    if (change === 'cookie-never-present') { delete d.beforeHeaders.cookie; }
    sync(r); expect(buildFindings(r).some(f => f.title.includes('服务端拒绝'))).toBe(false);
  });
  it.each(['sampled-200', 'unknown-total-200', 'wrong-total-200', 'html-mime'])('does not infer complete retrieval from %s', change => {
    const r = reportRun(); const p = probe(r, 'without-query'); probe(r, 'range-tail');
    if (change === 'html-mime') p.evidence.responseMimeType = 'text/html';
    else { p.status = 200; p.contentRange = undefined; p.evidence.status = 200; p.evidence.contentRange = undefined; p.evidence.contentLength = change === 'unknown-total-200' ? undefined : 4096; p.evidence.intentionallySampled = change === 'sampled-200'; }
    sync(r); expect(buildFindings(r).some(f => f.title === '可完整获取')).toBe(false);
  });
  it('unrelated empty-track or one-stream remux events do not verify media', () => {
    const r = reportRun(); const media = { container: 'mp4' as const, durationSeconds: 0, streams: [{ kind: 'video' as const, codec: 'invalid', codecTag: '', profile: '', timeBase: 'garbage', extradataHash: 'wrong', durationSeconds: 0, packetCount: 0 }] };
    const e = event(r, { phase: 'ffmpeg', action: 'remux:result', relatedIds: [], evidence: { committed: true, probe: media } });
    r.mediaVerifications.push({ id: 'v', operation: 'remux', status: 'succeeded', trackIds: [], evidenceEventIds: [e.id], probe: media });
    expect(buildFindings(r).some(f => f.title === '无损封装已验证')).toBe(false);
  });
  it('duplicate downloads cannot generate duplicate Finding IDs and conflicting duplicates are rejected', () => {
    const r = reportRun(); const e = event(r, { phase: 'download', action: 'download:after', relatedIds: ['d'], inputSummary: { sourceRequestId: 'source' }, evidence: { completedBytes: 10, totalBytes: 10, sha256: 'a'.repeat(64) } });
    const d = { id: 'd', trackIds: ['video'], evidenceEventIds: [e.id], byteLength: 10, sha256: 'a'.repeat(64), intervals: [{ start: 0, end: 9 }], completed: true };
    r.downloads = [d, structuredClone(d)]; expect(buildFindings(r).filter(f => f.title === '完整下载已验证')).toHaveLength(1);
    r.downloads[1].byteLength = 20; expect(() => buildFindings(r)).toThrow();
  });
});
describe('reviewed export boundary counterexamples', () => {
  it('aliases full source references and strips custom query canaries without declared secrets', async () => {
    const r = reportRun(); const secret = 'CustomCanary-Q3987'; const ref = JSON.stringify(['run', 'target-secret', 'session-secret', 'frame-secret', 'request-secret', 2]);
    r.requests.push({ id: ref, sanitizedUrl: `https://x.test/video?custom=${secret}`, method: 'GET', receivedAt: r.startedAt });
    const p = probe(r, 'without-query'); p.evidence.requestDiff = { query: `custom=${secret}`, changedHeaderNames: [secret], omittedHeaderNames: [secret] };
    event(r, { purpose: `fetch /clip?custom=${secret}`, action: `custom=${secret}`, conclusion: `custom=${secret}` }); sync(r);
    const paths = await generateReports(r, await dir()); const json = await fs.readFile(paths.jsonPath, 'utf8'), md = await fs.readFile(paths.markdownPath, 'utf8');
    for (const forbidden of [secret, 'target-secret', 'session-secret', 'frame-secret', 'request-secret', ref]) expect(json + md).not.toContain(forbidden);
    expect(JSON.parse(json).requests[0].id).toBe('request-001'); expect(JSON.parse(json).tracks[0].id).toBe('track-001');
  });
  it('numeric-only object keys count immediately toward the aggregate budget', () => {
    const r = reportRun(); event(r, { evidence: Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`${i}${'x'.repeat(10000)}`, 1])) });
    const { events, ...rest } = r; expect(() => validateRun({ ...rest, events })).toThrow(expect.objectContaining({ code: 'output-limit' }));
  });
  it('JSON and Markdown artifact ordering is identical across permuted snapshots', async () => {
    const r = reportRun(); r.mediaVerifications = ['z', 'a'].map(id => ({ id, trackIds: [], operation: 'remux', status: 'failed', evidenceEventIds: [] }));
    r.downloads = ['z', 'a'].map(id => ({ id, trackIds: ['video'], evidenceEventIds: [], byteLength: 1, sha256: 'a'.repeat(64), intervals: [{ start: 0, end: 0 }], completed: false }));
    const a = await generateReports(r, await dir()); r.mediaVerifications.reverse(); r.downloads.reverse(); const b = await generateReports(r, await dir());
    expect(await fs.readFile(a.markdownPath, 'utf8')).toBe(await fs.readFile(b.markdownPath, 'utf8'));
  });
});

describe('remux ownership, parameter and duplicate boundaries', () => {
  it.each(['unrelated-event', 'empty-tracks', 'nonexistent-track', 'muxed-input', 'one-output-stream', 'wrong-codec', 'invalid-hash', 'zero-packets', 'duration-mismatch', 'wrong-source', 'wrong-input-parameters', 'unrelated-artifact'])('rejects %s even with an otherwise succeeded committed result', async kind => {
    const { remuxRun } = await import('../helpers/report-fixture'); const r = remuxRun(); const v = r.mediaVerifications[0]; const e = r.events[0];
    if (kind === 'unrelated-event') e.relatedIds = [];
    if (kind === 'empty-tracks') v.trackIds = [];
    if (kind === 'nonexistent-track') v.trackIds[0] = 'missing';
    if (kind === 'muxed-input') r.tracks[0].kind = 'muxed';
    if (kind === 'one-output-stream') v.probe!.streams.pop();
    if (kind === 'wrong-codec') v.probe!.streams[0].codec = 'vp9';
    if (kind === 'invalid-hash') v.probe!.streams[0].extradataHash = 'not-a-hash';
    if (kind === 'zero-packets') v.probe!.streams[0].packetCount = 0;
    if (kind === 'duration-mismatch') v.probe!.durationSeconds = 200;
    if (kind === 'wrong-source') v.inputs![0].sourceRequestId = 'source-version-2';
    if (kind === 'wrong-input-parameters') { v.inputs![0].probe = structuredClone(v.inputs![0].probe); v.inputs![0].probe.streams[0].width = 1920; }
    if (kind === 'unrelated-artifact') v.inputs![0].downloadId = 'missing-artifact';
    e.evidence!.probe = structuredClone(v.probe); e.inputSummary!.inputs = structuredClone(v.inputs);
    expect(buildFindings(r).some(f => f.title === '无损封装已验证')).toBe(false);
  });
  it('linked compatible video/audio input and output probes verify once despite identical duplicates', async () => {
    const { remuxRun } = await import('../helpers/report-fixture'); const r = remuxRun(); r.mediaVerifications.push(structuredClone(r.mediaVerifications[0]));
    expect(buildFindings(r).filter(f => f.title === '无损封装已验证')).toHaveLength(1);
    r.mediaVerifications[1].trackIds = []; expect(() => buildFindings(r)).toThrow(expect.objectContaining({ code: 'invalid-snapshot' }));
  });
});

describe('sanitized verification audit trail', () => {
  it('retains aliased input/output probe evidence for the linked successful remux event', async () => {
    const { remuxRun } = await import('../helpers/report-fixture'); const r = remuxRun(); const paths = await generateReports(r, await dir());
    const json = JSON.parse(await fs.readFile(paths.jsonPath, 'utf8')); const v = json.mediaVerifications[0], e = json.events[0];
    expect(v.inputs).toHaveLength(2); expect(v.inputs[0].trackId).toBe('track-002'); expect(v.inputs[0].requestId).toMatch(/^request-\d{3}$/);
    expect(e.evidence.probe.streams).toHaveLength(2); expect(e.inputSummary.inputs).toEqual(v.inputs);
    expect(json.findings.find((f: { title: string }) => f.title === '无损封装已验证').evidenceEventIds).toEqual([e.id]);
  });
});

describe('completed HTTP 200 consistency', () => {
  it.each(['none', 'track', 'capture'])('requires complete 200 head consistency with %s known-length evidence', async conflict => {
    const r = reportRun(), head = probe(r, 'without-query', { status: 200, bytesReceived: 2000, contentRange: undefined }), tail = probe(r, 'range-tail', { bytesReceived: 16, contentRange: 'bytes 1984-1999/2000' });
    Object.assign(head.evidence, { status: 200, bytesReceived: 2000, contentRange: undefined, contentLength: 2000, intentionallySampled: false });
    Object.assign(tail.evidence, { bytesReceived: 16, contentRange: 'bytes 1984-1999/2000', contentLength: 16, requestDiff: { ...(tail.evidence.requestDiff as object), range: 'bytes=-16', afterHeaders: { ...(tail.evidence.requestDiff as { afterHeaders: object }).afterHeaders, range: 'bytes=-16' } } });
    if (conflict === 'track') r.tracks[0].byteLength = 3000;
    if (conflict === 'capture') r.requests.push({ id: 'source', method: 'GET', receivedAt: r.startedAt, sanitizedUrl: r.tracks[0].sanitizedUrl, status: 200, contentLength: 3000 });
    sync(r); expect(buildFindings(r).some(f => f.title === '可完整获取')).toBe(conflict === 'none');
  });
});
