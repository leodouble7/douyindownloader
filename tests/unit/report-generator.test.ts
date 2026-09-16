import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile, symlink, stat } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateReports } from '../../src/main/reports/report-generator';
import { event, probe, reportRun } from '../helpers/report-fixture';
const directories: string[] = [];
async function directory() { const p = await mkdtemp(join(await fs.realpath(tmpdir()), 'report-test-')); directories.push(p); return p; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
describe('sanitized report publication', () => {
  it('renders all Chinese sections and deterministic JSON/Markdown', async () => {
    const run = reportRun(); probe(run, 'without-query'); probe(run, 'range-tail');
    const first = await generateReports(run, await directory()); const second = await generateReports(run, await directory());
    const md = await readFile(first.markdownPath, 'utf8'); const json = await readFile(first.jsonPath, 'utf8');
    for (const heading of ['范围与授权', '架构与角色', '资产与音视频轨道', '可见动作时间线', '探针矩阵', '下载区间与完整性', 'FFmpeg', '发现', '限制', '优先修复']) expect(md).toContain(heading);
    expect(md).toContain('CDP'); expect(md).toContain('iframe'); expect(md).toContain('Worker'); expect(md).toContain('MSE'); expect(md).toContain('-c copy');
    expect(md).toContain('客户端'); expect(md).toContain('可完整获取');
    expect(await readFile(second.markdownPath, 'utf8')).toBe(md); expect(await readFile(second.jsonPath, 'utf8')).toBe(json);
    expect(JSON.parse(json).findings[0].evidenceEventIds).toEqual(['event-001', 'event-002']);
    expect((await stat(first.jsonPath)).mode & 0o777).toBe(0o600);
  });
  it('redacts secret canaries everywhere, raw URLs, headers, local paths, commands and internal keys', async () => {
    const run = reportRun(); const canary = 'SecretCanary-Z9x987654321'; run.rawSecretValues = [canary];
    run.target.sanitizedPath = `/watch?token=${canary}`; run.tracks[0].sanitizedUrl = `https://user:${canary}@example.test/video?custom=${canary}`;
    event(run, { purpose: `观察 | <img src=x>\nAuthorization: Bearer ${canary}`, conclusion: `Cookie: sid=${canary}\n/Users/private/media.mp4 C:\\Users\\private\\media.mp4`, evidence: { nested: { text: canary, url: `https://x.test/a?signature=${canary}`, headers: { Authorization: canary } }, relationKey: 'hidden-relation-canary', rawLog: 'raw-tool-log-canary', arguments: ['sh', '-c', 'command-canary'] } });
    const paths = await generateReports(run, await directory()); const output = await readFile(paths.jsonPath, 'utf8') + await readFile(paths.markdownPath, 'utf8');
    for (const forbidden of [canary, 'hidden-relation-canary', 'raw-tool-log-canary', 'command-canary', '/Users/private', 'C:\\\\Users', 'token=', 'signature=', 'user:']) expect(output).not.toContain(forbidden);
    expect(output).not.toContain('<img'); expect(output).not.toContain('Authorization:');
  });
  it('rejects unknown snapshot fields and oversized arrays before writing', async () => {
    const dir = await directory(); const run = reportRun();
    await expect(generateReports({ ...run, rawUrl: 'https://x.test/' } as typeof run, dir)).rejects.toMatchObject({ outcome: 'inconclusive' });
    run.events = Array.from({ length: 2001 }, (_, i) => ({ id: String(i) })) as typeof run.events;
    await expect(generateReports(run, dir)).rejects.toMatchObject({ outcome: 'inconclusive' }); expect(await readdir(dir)).toEqual([]);
  });



  it('rejects nonexistent destinations, files and symlink destinations', async () => {
    const dir = await directory(); const file = join(dir, 'file'); await writeFile(file, 'x'); const alias = join(dir, 'alias'); await symlink(dir, alias);
    for (const invalid of [join(dir, 'absent'), file, alias]) await expect(generateReports(reportRun(), invalid)).rejects.toMatchObject({ outcome: 'inconclusive' });
  });
});

describe('report defensive limits and scanning', () => {
  it('fingerprint-only canary aborts before any output is written', async () => {
    const { createHash } = await import('node:crypto'); const run = reportRun(); const secret = '/Fingerprint-Canary-X78z';
    run.rawSecretFingerprints = [createHash('sha256').update(secret).digest('hex')]; run.target.sanitizedPath = secret;
    const dir = await directory(); await expect(generateReports(run, dir)).rejects.toMatchObject({ code: 'secret-detected', outcome: 'inconclusive' }); expect(await readdir(dir)).toEqual([]);
  });
  it('bounds strings and rejects aggregate output amplification', async () => {
    const run = reportRun(); event(run, { purpose: '长'.repeat(5000) }); const dir = await directory();
    const { jsonPath } = await generateReports(run, dir); const json = JSON.parse(await readFile(jsonPath, 'utf8')); expect(json.events[0].purpose.length).toBeLessThanOrEqual(1000);
    const large = reportRun(); for (let i = 0; i < 600; i++) event(large, { purpose: '长'.repeat(5000) });
    const out = await directory(); await expect(generateReports(large, out)).rejects.toMatchObject({ code: 'output-limit' }); expect(await readdir(out)).toEqual([]);
  });
  it('ignores tiny/common declared values and redacts encoded secret query prose', async () => {
    const run = reportRun(); run.rawSecretValues = ['a', '1', 'true']; event(run, { purpose: 'relative ?to%6ben=EncodedSecret-Q928z /one-level-file' });
    const paths = await generateReports(run, await directory()); const all = await readFile(paths.jsonPath, 'utf8') + await readFile(paths.markdownPath, 'utf8');
    expect(all).not.toContain('EncodedSecret-Q928z'); expect(all).not.toContain('/one-level-file'); expect(JSON.parse(await readFile(paths.jsonPath, 'utf8')).runId).toBe('run-001');
  });
  it('reports failed remux inconclusively and rejects unlinked successful verification', async () => {
    const run = reportRun(); const e = event(run, { phase: 'ffmpeg', action: 'remux:result', status: 'failed', evidence: { outcome: 'inconclusive', code: 'timeout' } });
    run.mediaVerifications = [{ id: 'remux', trackIds: ['video'], operation: 'remux', status: 'succeeded', evidenceEventIds: [e.id] }];
    const paths = await generateReports(run, await directory()); const json = JSON.parse(await readFile(paths.jsonPath, 'utf8'));
    expect(json.mediaVerifications[0].verified).toBe(false); expect(json.findings.some((f: { title: string }) => f.title === '测试异常')).toBe(true);
  });

  it('pre-aborted export leaves no output', async () => {
    const dir = await directory(); await expect(generateReports(reportRun(), { directory: dir, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'cancelled' }); expect(await readdir(dir)).toEqual([]);
  });
});

describe('untrusted event text and artifact identity', () => {
  it('removes hidden relation identifiers and shell/log text even when nested in prose', async () => {
    const run = reportRun(); event(run, { action: 'ffmpeg:command', purpose: 'ffmpeg -i /tmp/a.mp4 -c copy /tmp/b.mp4', conclusion: 'relationKey=internal-secret-relation; sessionId=internal-secret-session; rawLog=unfiltered-private-log', evidence: { requestDiff: { query: 'Authorization: Basic abcdefghijklmnop' } } });
    const paths = await generateReports(run, await directory()); const output = await readFile(paths.jsonPath, 'utf8') + await readFile(paths.markdownPath, 'utf8');
    expect(output).not.toContain('internal-secret-relation'); expect(output).not.toContain('unfiltered-private-log'); expect(output).not.toContain('ffmpeg -i');
  });
  it('conflicting duplicate projection order cannot change either report', async () => {
    const run = reportRun(); probe(run, 'without-query'); run.probes.push({ ...run.probes[0], outcome: 'denied', status: 403 });
    await expect(generateReports(run, await directory())).rejects.toMatchObject({ code: 'invalid-snapshot' }); run.probes.reverse();
    await expect(generateReports(run, await directory())).rejects.toMatchObject({ code: 'invalid-snapshot' });
  });

});

describe('serialized evidence references', () => {
  it('does not serialize bogus download or media evidence IDs as report references', async () => {
    const run = reportRun(); run.downloads.push({ id: 'd', trackIds: ['video'], evidenceEventIds: ['bogus-event-id'], byteLength: 10, sha256: 'a'.repeat(64), intervals: [{ start: 0, end: 9 }], completed: true });
    run.mediaVerifications.push({ id: 'm', trackIds: [], evidenceEventIds: ['bogus-event-id'], status: 'succeeded', operation: 'remux' });
    const paths = await generateReports(run, await directory()); const json = JSON.parse(await readFile(paths.jsonPath, 'utf8'));
    expect(json.downloads[0].evidenceEventIds).toEqual([]); expect(json.mediaVerifications[0].evidenceEventIds).toEqual([]); expect(json.findings).toEqual([]);
  });
});

describe('asset and track presentation', () => {
  it('shows asset selection and video/audio separation in readable Markdown', async () => {
    const run = reportRun(); run.tracks.push({ ...run.tracks[0], id: 'audio', kind: 'audio', sanitizedUrl: 'https://media.example/audio.m4a' });
    run.assets.push({ id: 'asset-1', title: '课程 | 示例', trackIds: ['video', 'audio'], selectedTrackIds: ['video', 'audio'], confidence: 0.9, detectionReasons: ['观察到分离音视频轨道'] });
    const paths = await generateReports(run, await directory()); const markdown = await readFile(paths.markdownPath, 'utf8');
    expect(markdown).toContain('asset-001'); expect(markdown).toContain('视频资产 001'); expect(markdown).not.toContain('课程'); expect(markdown).toContain('track-002, track-001'); expect(markdown).toContain('0.9');
  });
});
