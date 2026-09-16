import { describe, expect, it } from 'vitest';
import { buildFindings } from '../../src/main/reports/finding-engine';
import { event, probe, reportRun, remuxRun } from '../helpers/report-fixture';

describe('evidence-backed findings', () => {
  it('query-free bounded bytes and exact independent tail support high-confidence retrieval inference', () => {
    const run = reportRun(); probe(run, 'without-query'); probe(run, 'range-tail');
    const finding = buildFindings(run).find(f => f.title === '可完整获取')!;
    expect(finding).toMatchObject({ confidence: 'high', evidenceEventIds: ['ep1', 'ep2'] });
    expect(finding.limitations.join(' ')).toContain('推断');
    expect(finding.observedBehavior).toContain('4096'); expect(finding.practicalImpact).toBeTruthy(); expect(finding.recommendation).toBeTruthy();
  });
  it('requires actual missing-Referer denial and explicitly changed Referer success', () => {
    const run = reportRun(); probe(run, 'without-referer', { outcome: 'denied', status: 403, bytesReceived: 0 });
    const base = probe(run, 'baseline'); base.evidence.requestDiff = {}; run.events[1].evidence = structuredClone(base.evidence); expect(buildFindings(run).some(f => f.title === 'Referer-only 弱防护')).toBe(false);
    probe(run, 'forged-referer');
    expect(buildFindings(run).find(f => f.title === 'Referer-only 弱防护')).toMatchObject({ evidenceEventIds: ['ep1', 'ep3'] });
  });
  it.each(['timeout', 'dns', 'tls', 'parser', 'network', 'cancelled'])('%s is inconclusive, never security evidence', transportOutcome => {
    const run = reportRun(); probe(run, 'baseline', { outcome: 'inconclusive', status: undefined, bytesReceived: 0, evidence: { transportOutcome, limitations: [] } });
    expect(buildFindings(run)).toEqual(expect.arrayContaining([expect.objectContaining({ title: '测试异常', severity: 'info' })]));
    expect(JSON.stringify(buildFindings(run))).not.toContain('安全');
  });
  it('encryption plus license tool failure never infers license enforcement or bypass', () => {
    const run = reportRun(); run.tracks[0].encrypted = true;
    event(run, { evidence: { encrypted: true } }); event(run, { phase: 'verify', status: 'failed', evidence: { outcome: 'inconclusive', code: 'tool-unavailable' } });
    expect(buildFindings(run).map(f => f.title)).toContain('检测到加密，未验证许可证策略');
    expect(buildFindings(run).map(f => f.title)).toContain('测试异常');
    expect(buildFindings(run).every(f => f.evidenceEventIds.every(id => run.events.some(e => e.id === id)))).toBe(true);
  });
  it('contradictory repeat probes downgrade retrieval and exact duplicate probes do not amplify', () => {
    const run = reportRun(); probe(run, 'without-query'); probe(run, 'range-tail');
    const first = buildFindings(run); run.probes.push(structuredClone(run.probes[0])); expect(buildFindings(run)).toEqual(first);
    probe(run, 'without-query', { outcome: 'denied', status: 403, bytesReceived: 0 });
    expect(buildFindings(run).find(f => f.title === '可完整获取')?.confidence).not.toBe('high');
    expect(buildFindings(run).some(f => f.limitations.join(' ').includes('矛盾'))).toBe(true);
  });
  it.each(['missing', 'bogus', 'wrong-track', 'stale', 'invalid-range'])('does not infer retrieval from %s evidence', kind => {
    const run = reportRun(); const p = probe(run, 'without-query'); probe(run, 'range-tail');
    if (kind === 'missing') p.evidenceEventIds = [];
    if (kind === 'bogus') p.evidenceEventIds = ['no-event'];
    if (kind === 'wrong-track') run.events[0].relatedIds = ['other'];
    if (kind === 'stale') run.events[0].timestamp = '2020-01-01T00:00:00Z';
    if (kind === 'invalid-range') { p.bytesReceived = 8; p.evidence.bytesReceived = 8; run.events[0].evidence!.bytesReceived = 8; }
    expect(buildFindings(run).some(f => f.title === '可完整获取')).toBe(false);
  });
  it('downgrades incomplete capture and never treats absence of download as security', () => {
    const run = reportRun(); probe(run, 'without-query'); probe(run, 'range-tail'); run.limitations = ['Worker early request missing'];
    expect(buildFindings(run).find(f => f.title === '可完整获取')?.confidence).toBe('medium');
    expect(buildFindings(reportRun())).toEqual([]);
  });
  it('only repeatable exact denial supports a scoped tested control', () => {
    const run = reportRun(); probe(run, 'without-cookie', { outcome: 'denied', status: 401, bytesReceived: 0 });
    expect(buildFindings(run).some(f => f.title.includes('服务端拒绝'))).toBe(false);
    probe(run, 'without-cookie', { outcome: 'denied', status: 401, bytesReceived: 0 });
    expect(buildFindings(run).find(f => f.title.includes('服务端拒绝'))).toMatchObject({ evidenceEventIds: ['ep1', 'ep2'], severity: 'info' });
  });
  it('ordering is stable when snapshot arrays are permuted', () => {
    const run = reportRun(); probe(run, 'without-query'); probe(run, 'range-tail'); probe(run, 'without-cookie');
    const findings = buildFindings(run); run.probes.reverse(); run.events.reverse(); expect(buildFindings(run)).toEqual(findings);
  });
});

describe('real transport and artifact evidence boundaries', () => {
  function replayPair(extraChange = false) {
    const run = reportRun();
    const baseline = probe(run, 'baseline'); const absent = probe(run, 'without-referer', { outcome: 'denied', status: 403, bytesReceived: 0 });
    const before = { referer: 'https://media.example/watch', accept: 'video/mp4' };
    baseline.evidence.requestDiff = { beforeHeaders: before, afterHeaders: { ...before, range: 'bytes=0-4095', 'accept-encoding': 'identity' }, query: 'observed query unchanged', range: 'bytes=0-4095', omittedHeaderNames: [], changedHeaderNames: ['range', 'accept-encoding'] };
    absent.evidence.requestDiff = { beforeHeaders: before, afterHeaders: { accept: extraChange ? '*/*' : 'video/mp4', range: 'bytes=0-4095', 'accept-encoding': 'identity' }, query: 'observed query unchanged', range: 'bytes=0-4095', omittedHeaderNames: ['referer'], changedHeaderNames: ['range', 'accept-encoding'] };
    run.events.forEach((e, i) => { e.evidence = structuredClone(run.probes[i].evidence); }); return run;
  }
  it('existing baseline replay and solely missing Referer rejection prove the observed value is replayable', () => {
    const result = buildFindings(replayPair()).find(f => f.title === 'Referer-only 弱防护');
    expect(result).toMatchObject({ evidenceEventIds: ['ep1', 'ep2'], confidence: 'high' });
    expect(result?.observedBehavior).toContain('观察到的 Referer 值'); expect(result?.limitations.join(' ')).toContain('替代');
  });
  it('baseline and omitted-Referer requests may both omit the same transport-only headers', () => {
    const run = replayPair();
    for (let i = 0; i < run.probes.length; i++) {
      const diff = run.probes[i].evidence.requestDiff as Record<string, unknown>;
      (diff.beforeHeaders as Record<string, unknown>).host = '[REDACTED]';
      diff.omittedHeaderNames = i ? ['host', 'referer'] : ['host'];
      run.events[i].evidence = structuredClone(run.probes[i].evidence);
    }
    expect(buildFindings(run).some(f => f.title === 'Referer-only 弱防护')).toBe(true);
  });
  it('does not attribute changed Accept plus removed Referer to Referer alone', () => {
    expect(buildFindings(replayPair(true)).some(f => f.title === 'Referer-only 弱防护')).toBe(false);
  });
  it('full download requires source-linked terminal integrity and gap-free intervals', () => {
    const run = reportRun(); const e = event(run, { phase: 'download', action: 'download:after', relatedIds: ['download'], inputSummary: { sourceRequestId: 'source' }, evidence: { completedBytes: 10000, totalBytes: 10000, sha256: 'b'.repeat(64) } });
    run.downloads.push({ id: 'download', trackIds: ['video'], byteLength: 10000, sha256: 'b'.repeat(64), intervals: [{ start: 0, end: 9999 }], completed: true, evidenceEventIds: [e.id] });
    expect(buildFindings(run).find(f => f.title === '完整下载已验证')).toMatchObject({ evidenceEventIds: [e.id] });
    run.downloads[0].intervals[0].start = 1; expect(buildFindings(run).some(f => f.title === '完整下载已验证')).toBe(false);
    run.downloads[0].intervals[0].start = 0; e.inputSummary!.sourceRequestId = 'unrelated'; expect(buildFindings(run).some(f => f.title === '完整下载已验证')).toBe(false);
  });
  it('aggregate concurrent evidence must validate every constituent response', () => {
    const run = reportRun(); const p = probe(run, 'range-concurrent'); const first = structuredClone(p.evidence), second: Record<string, unknown> = { ...first, contentRange: 'bytes 4096-8191/10000', requestDiff: { ...first.requestDiff as object, range: 'bytes=4096-8191', afterHeaders: { ...(first.requestDiff as { afterHeaders: object }).afterHeaders, range: 'bytes=4096-8191' } } };
    p.evidence.responses = [first, second]; p.bytesReceived = 8192; p.evidence.bytesReceived = 8192; run.events[0].evidence = structuredClone(p.evidence);
    expect(buildFindings(run).some(f => f.title === '并发 Range：媒体样本可访问')).toBe(true);
    second.bytesReceived = 2; p.evidence.responses = [first, second]; run.events[0].evidence = structuredClone(p.evidence);
    expect(buildFindings(run).some(f => f.title === '并发 Range：媒体样本可访问')).toBe(false);
  });
  it('accepts existing long immutable source references without exporting them', () => {
    const run = reportRun(); const source = JSON.stringify(['run', 'target'.repeat(20), 'session'.repeat(20), 'frame', 'request', 1]);
    run.tracks[0].sourceRequestIds = [source]; probe(run, 'without-query', { requestId: source }); probe(run, 'range-tail', { requestId: source });
    expect(buildFindings(run).some(f => f.title === '可完整获取')).toBe(true);
  });
});

describe('incomplete and contradictory evidence confidence', () => {
  it('stale duplicate probe cannot preserve high confidence for fresh access samples', () => {
    const run = reportRun(); probe(run, 'without-query'); probe(run, 'range-tail'); probe(run, 'without-query', { outcome: 'denied', status: 403, bytesReceived: 0 }); run.events[2].timestamp = '2020-01-01T00:00:00Z';
    expect(buildFindings(run).find(f => f.title === '可完整获取')?.confidence).toBe('medium');
  });
  it('same probe ID with different results is excluded even when each claims valid events', () => {
    const run = reportRun(); probe(run, 'without-query'); probe(run, 'range-tail'); run.probes.push({ ...run.probes[0], status: 403 });
    expect(() => buildFindings(run)).toThrow();
  });
  it('an HTTP 200 with truncated declared full body cannot count as successful baseline bytes', () => {
    const run = reportRun(); const p = probe(run, 'without-query', { status: 200, bytesReceived: 16, contentRange: undefined });
    p.evidence.contentLength = 10000; p.evidence.intentionallySampled = false; run.events[0].evidence = structuredClone(p.evidence); probe(run, 'range-tail');
    expect(buildFindings(run).some(f => f.title === '可完整获取')).toBe(false);
  });
});

describe('independent observations and remux validation', () => {
  it('one terminal HTTP event cannot establish repeatable denial for two probe IDs', () => {
    const run = reportRun(); const first = probe(run, 'without-cookie', { outcome: 'denied', status: 403, bytesReceived: 0 }); const second = probe(run, 'without-cookie', { outcome: 'denied', status: 403, bytesReceived: 0 });
    run.events[0].relatedIds.push(second.id); second.evidenceEventIds = first.evidenceEventIds; run.events.pop();
    expect(buildFindings(run).some(f => f.title.includes('服务端拒绝'))).toBe(false);
  });
  it('a successful remux requires committed output and matching verified media parameters', () => {
    const run = remuxRun(), e = run.events[0];
    expect(buildFindings(run).find(f => f.title === '无损封装已验证')).toMatchObject({ evidenceEventIds: [e.id], confidence: 'high' });
    e.evidence!.committed = false; expect(buildFindings(run).some(f => f.title === '无损封装已验证')).toBe(false);
  });
  it('conflicting captured track length downgrades an otherwise valid head/tail inference', () => {
    const run = reportRun(); run.tracks[0].byteLength = 20000; probe(run, 'without-query'); probe(run, 'range-tail');
    expect(buildFindings(run).find(f => f.title === '可完整获取')?.confidence).not.toBe('high');
  });
});
