import { describe, expect, it } from 'vitest';
import { buildFindings } from '../../src/main/reports/finding-engine';
import { probe, reportRun } from '../helpers/report-fixture';
import type { ReportProbe, ReportRun } from '../../src/main/reports/report-run';
function sync(r: ReportRun) { for (const p of r.probes) { const e = r.events.find(e => e.id === p.evidenceEventIds[0])!; e.evidence = structuredClone(p.evidence); e.relatedIds = [p.id, p.trackId, p.requestId!]; } }
function range(p: ReportProbe) { const d = p.evidence.requestDiff as { range: string; afterHeaders: Record<string, string> }; d.range = d.afterHeaders.range = 'bytes=-4096'; p.contentRange = p.evidence.contentRange = 'bytes 5904-9999/10000'; }
describe.each(['baseline', 'forged-referer', 'alternate-referer'])('%s Referer recognition provenance', branch => {
  function pair() {
    const r = reportRun(), success = probe(r, branch), absent = probe(r, 'without-referer', { outcome: 'denied', status: 403 });
    if (branch === 'alternate-referer') { const d = success.evidence.requestDiff as { afterHeaders: Record<string, string>; changedHeaderNames: string[] }; d.afterHeaders.referer = 'https://media.example/alternate'; d.changedHeaderNames.push('referer'); }
    return { r, success, absent };
  }
  it('rejects an impossible head tagged linked-range without structural head evidence', () => {
    const { r, success } = pair(); success.evidence.mediaEvidence = 'linked-range'; sync(r);
    expect(buildFindings(r).some(f => f.title === 'Referer-only 弱防护')).toBe(false);
  });
  it('rejects standalone non-head structural bytes without a recognized head', () => {
    const { r, success, absent } = pair(); range(success); range(absent); sync(r);
    expect(buildFindings(r).some(f => f.title === 'Referer-only 弱防护')).toBe(false);
  });
  it('accepts structural head evidence', () => {
    const { r } = pair(); sync(r); expect(buildFindings(r).some(f => f.title === 'Referer-only 弱防护')).toBe(true);
  });
  it('requires same-source structural head for linked-tail success and cites it', () => {
    const { r, success, absent } = pair(); range(success); range(absent); success.evidence.mediaEvidence = 'linked-range'; sync(r);
    expect(buildFindings(r).some(f => f.title === 'Referer-only 弱防护')).toBe(false);
    const head = probe(r, 'range-head', { requestId: 'different-incarnation' }); r.tracks[0].sourceRequestIds.push('different-incarnation'); sync(r);
    expect(buildFindings(r).some(f => f.title === 'Referer-only 弱防护')).toBe(false);
    head.requestId = success.requestId; sync(r);
    const finding = buildFindings(r).find(f => f.title === 'Referer-only 弱防护');
    expect(finding).toBeDefined(); expect(finding!.evidenceEventIds).toEqual(expect.arrayContaining([...success.evidenceEventIds, ...absent.evidenceEventIds, ...head.evidenceEventIds]));
  });
});
