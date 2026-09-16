import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { buildFindings } from '../../src/main/reports/finding-engine';
import * as reports from '../../src/main/reports/report-generator';
import { event, probe, remuxRun, reportRun } from '../helpers/report-fixture';
import type { ReportRun } from '../../src/main/reports/report-run';
const dirs: string[] = [];
async function dir() { const p = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'report-round2-')); dirs.push(p); return p; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
function sync(run: ReportRun) { for (const p of run.probes) run.events.find(e => e.id === p.evidenceEventIds[0])!.evidence = structuredClone(p.evidence); }
describe('success mutation validation', () => {
  it.each(['restored-cookie', 'empty-omitted', 'unrelated-authorization', 'query-restored', 'mislabeled'])('does not report access-control mutation success for %s', change => {
    const r = reportRun(), p = probe(r, change === 'query-restored' ? 'without-query' : 'without-cookie');
    const d = p.evidence.requestDiff as { beforeHeaders: Record<string, string>; afterHeaders: Record<string, string>; omittedHeaderNames: string[]; query: string };
    if (change === 'restored-cookie') { d.afterHeaders.cookie = '[REDACTED]'; d.omittedHeaderNames = []; }
    if (change === 'empty-omitted') d.omittedHeaderNames = [];
    if (change === 'unrelated-authorization') d.afterHeaders.authorization = 'new-value';
    if (change === 'query-restored') { d.query = 'observed query unchanged'; probe(r, 'range-tail'); }
    if (change === 'mislabeled') { p.inputSummary.mutation = 'baseline'; r.events[0].inputSummary = structuredClone(p.inputSummary); }
    sync(r); expect(buildFindings(r).filter(f => f.title.includes('媒体样本可访问') || f.title === '可完整获取')).toEqual([]);
  });
});
describe('adapter duration contract', () => {
  it.each([[3600, 3530, false], [3600, 3598, true], [3600, 3597.999, false], [100, 99.9, true], [100, 99.89, false], [500, 499.5, true], [500, 499.49, false]])('input %s/output %s verifies=%s', (input, output, accepted) => {
    const r = remuxRun(), v = r.mediaVerifications[0];
    r.tracks.forEach(t => { t.durationSeconds = input as number; });
    v.inputs!.forEach(i => { i.probe = structuredClone(i.probe); i.probe.durationSeconds = input as number; i.probe.streams[0].durationSeconds = input as number; });
    v.probe!.durationSeconds = output as number; v.probe!.streams.forEach(s => { s.durationSeconds = output as number; });
    r.events[0].inputSummary!.inputs = structuredClone(v.inputs); r.events[0].evidence!.probe = structuredClone(v.probe);
    expect(buildFindings(r).some(f => f.title === '无损封装已验证')).toBe(accepted);
  });
});
describe('source-reference display suppression', () => {
  it('does not export tuple references/components or encoded references from any display prose', async () => {
    const r = reportRun(), source = JSON.stringify(['run-secret', 'target-secret', 'session-secret', 'frame-secret', 'request-secret', 1]);
    r.tracks[0].sourceRequestIds = [source]; r.tracks[0].detectionReasons = [source];
    r.tracks[0].sanitizedUrl = `https://media.example/${Buffer.from(source).toString('base64url')}.mp4`;
    r.assets.push({ id: 'a', title: `观察 ${source} ${encodeURIComponent(source)} ${Buffer.from(source).toString('base64')}`, trackIds: ['video'], selectedTrackIds: ['video'], confidence: 1, detectionReasons: [source] });
    event(r, { purpose: source, conclusion: source }); const bundle = await reports.generateReports(r, await dir()); const all = await fs.readFile(bundle.jsonPath, 'utf8') + await fs.readFile(bundle.markdownPath, 'utf8');
    for (const value of [source, 'session-secret', 'frame-secret', 'request-secret', Buffer.from(source).toString('base64url')]) expect(all).not.toContain(value);
    expect(all).toContain('视频资产 001');
  });
});
describe('explicit transport media recognition', () => {
  it.each([undefined, 'application/octet-stream', 'text/html'])('does not infer retrieval from %s without structural recognition', mime => {
    const r = reportRun(); const h = probe(r, 'without-query'); probe(r, 'range-tail'); h.evidence.responseMimeType = mime; delete h.evidence.mediaEvidence; sync(r);
    expect(buildFindings(r).some(f => f.title === '可完整获取')).toBe(false);
  });
  it('generic structural head plus linked tail on the same immutable source supports inference', () => {
    const r = reportRun(); const h = probe(r, 'without-query'), t = probe(r, 'range-tail'); h.evidence.responseMimeType = 'application/octet-stream'; h.evidence.mediaEvidence = 'structural'; t.evidence.responseMimeType = 'application/octet-stream'; t.evidence.mediaEvidence = 'linked-range'; sync(r);
    expect(buildFindings(r).some(f => f.title === '可完整获取')).toBe(true);
    t.requestId = 'other-source'; r.tracks[0].sourceRequestIds.push('other-source'); r.events[1].relatedIds[2] = 'other-source';
    expect(buildFindings(r).some(f => f.title === '可完整获取')).toBe(false);
  });
  it('text/html cannot override MIME rejection with a claimed structural flag', () => {
    const r = reportRun(); const h = probe(r, 'without-query'); probe(r, 'range-tail'); h.evidence.responseMimeType = 'text/html'; h.evidence.mediaEvidence = 'structural'; sync(r);
    expect(buildFindings(r).some(f => f.title === '可完整获取')).toBe(false);
  });
});
describe('trusted report bundle verification', () => {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  async function replaceAndForge(directory: string) {
    const json = 'attacker-json', markdown = 'attacker-markdown';
    for (const [name, value] of [['report.json', json], ['report.md', markdown]]) { const p = join(directory, name); await fs.rename(p, p + '.old'); await fs.writeFile(p, value); }
    const receipt = { version: 1, state: 'complete', files: { 'report.json': { bytes: json.length, sha256: sha(json) }, 'report.md': { bytes: markdown.length, sha256: sha(markdown) } } };
    await fs.writeFile(join(directory, 'complete.json'), JSON.stringify(receipt) + '\n');
  }
  it('returns trusted memory hashes and verifies original bytes', async () => {
    expect(reports).toHaveProperty('verifyReportBundle');
    const bundle = await reports.generateReports(reportRun(), await dir());
    expect(bundle).toMatchObject({ bundleId: expect.any(String), jsonSha256: expect.stringMatching(/^[a-f0-9]{64}$/), markdownSha256: expect.stringMatching(/^[a-f0-9]{64}$/), receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const content = await reports.verifyReportBundle(bundle); expect(sha(content.json)).toBe(bundle.jsonSha256); expect(sha(content.markdown)).toBe(bundle.markdownSha256);
  });
  it.each(['directory-sync', 'handle-close'])('rejects replacement plus forged receipt during %s', async stage => {
    const root = await dir(), realOpen = fs.open; let attacked = false;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const h = await realOpen(path, flags, mode), p = String(path);
      if (stage === 'directory-sync' && p.includes('/.report-') && !p.endsWith('.json') && !p.endsWith('.md')) {
        const sync = h.sync.bind(h); vi.spyOn(h, 'sync').mockImplementation(async () => { await sync(); if (!attacked) { attacked = true; await replaceAndForge(p); } });
      }
      if (stage === 'handle-close' && p.endsWith('/report.json')) { const close = h.close.bind(h); vi.spyOn(h, 'close').mockImplementation(async () => { if (!attacked) { attacked = true; await replaceAndForge(dirname(p)); } await close(); }); }
      return h;
    });
    try { const bundle = await reports.generateReports(reportRun(), root); expect(reports).toHaveProperty('verifyReportBundle'); await expect(reports.verifyReportBundle(bundle)).rejects.toMatchObject({ outcome: 'inconclusive' }); }
    catch (e) { expect(e).toMatchObject({ outcome: 'inconclusive' }); }
    expect(attacked).toBe(true);
  });
  it('rejects a leaf replaced during final synchronous handle close', async () => {
    const root = await dir(), close = syncFs.closeSync; let attacked = false;
    vi.spyOn(syncFs, 'closeSync').mockImplementation(fd => {
      close(fd);
      if (!attacked) {
        const bundle = syncFs.readdirSync(root).find(name => name.startsWith('.report-'));
        if (bundle) { attacked = true; const p = join(root, bundle, 'report.json'); syncFs.renameSync(p, p + '.old'); syncFs.writeFileSync(p, 'attacker-json'); }
      }
    });
    await expect(reports.generateReports(reportRun(), root)).rejects.toMatchObject({ outcome: 'inconclusive' });
    expect(attacked).toBe(true);
  });
  it('rejects same-inode content mutation and reconstructed bundle lookalikes', async () => {
    const bundle = await reports.generateReports(reportRun(), await dir());
    await expect(reports.verifyReportBundle({ ...bundle })).rejects.toMatchObject({ outcome: 'inconclusive' });
    const contents = await fs.readFile(bundle.jsonPath); contents[0] = contents[0] === 32 ? 33 : 32;
    await fs.writeFile(bundle.jsonPath, contents);
    await expect(reports.verifyReportBundle(bundle)).rejects.toMatchObject({ outcome: 'inconclusive' });
  });
  it('detects post-return replacement even when every disk hash is forged consistently', async () => {
    expect(reports).toHaveProperty('verifyReportBundle'); const bundle = await reports.generateReports(reportRun(), await dir()); await replaceAndForge(dirname(bundle.jsonPath));
    await expect(reports.verifyReportBundle(bundle)).rejects.toMatchObject({ outcome: 'inconclusive' });
  });
});
