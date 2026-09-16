import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventRepository } from '../../src/main/runs/event-repository';
import { WorkbenchService, type BrowserFactory } from '../../src/main/workbench-service';
import { startLabServer } from '../../lab/server';
import { createSourceRequestReference } from '../../src/shared/contracts';
import { createSanitizedCapturedUrl } from '../../src/main/security/redact';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const f of cleanups.reverse().splice(0)) await f(); });
it('connects capture snapshots to real probes, requires an explicit download, and publishes verifiable reports and persisted history', async () => {
  const lab = await startLabServer(); cleanups.push(() => lab.close()); const root = await mkdtemp(join(tmpdir(), 'workbench-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repository = new EventRepository(join(root, 'runs.sqlite')); cleanups.push(() => repository.close());
  const browserFactory: BrowserFactory = hooks => ({ open: async run => {
    for (const kind of ['video', 'audio']) {
      const sourceIdentity = { runId: run.runId, targetId: 'page', sessionId: '', frameId: 'frame', requestId: `${kind}-SECRET-REQUEST`, version: 1 };
      const id = createSourceRequestReference(sourceIdentity), url = `${lab.baseUrl}/open-range/${kind}-only.mp4?content_id=demo`;
      hooks.rememberRequest(run.runId, { id, sourceIdentity, url, method: 'GET', frameId: 'frame' });
      const response = await fetch(url, { headers: { range: 'bytes=0-4095' } }); await response.arrayBuffer();
      const request = { id, sourceIdentity, runId: run.runId, sanitizedUrl: createSanitizedCapturedUrl(url), method: 'GET', receivedAt: new Date().toISOString(), status: response.status, mimeType: `${kind}/mp4`, contentRange: response.headers.get('content-range') ?? undefined, contentLength: Number(response.headers.get('content-length')) };
      for (const stage of ['response', 'finished'] as const) hooks.observe({ kind: 'network', stage, runId: run.runId, targetId: 'page', targetType: 'page', frameId: 'frame', requestId: sourceIdentity.requestId, request });
    }
  }, close: async () => {}, setBounds: () => {} });
  const service = new WorkbenchService({ repository, browserFactory, onEvent: () => {}, observationMs: 60000, networkPolicy: { labLoopback: [{ origin: lab.baseUrl, address: '127.0.0.1' }] } }); cleanups.push(() => service.dispose());
  const output = await service.selectDirectory(root); const { runId } = await service.start({ targetUrl: `${lab.baseUrl}/open-range/watch`, outputDirectory: output, mode: 'full-download', authorizationConfirmed: true, maxConcurrency: 4 });
  await service.waitForIdle(runId); await service.finishObservation(runId); await service.waitForIdle(runId);
  const ready = await service.get(runId); expect(ready.status).toBe('ready'); expect(ready.artifacts).toHaveLength(0); expect(ready.probes.some(p => p.outcome === 'accessible')).toBe(true); expect(JSON.stringify(ready)).not.toContain('SECRET-REQUEST');
  const tracks = ready.assets.flatMap(a => a.selectedTrackIds); expect(tracks.length).toBeGreaterThan(0); await service.download({ runId, trackIds: tracks.slice(0, 2) }); await service.waitForIdle(runId);
  const complete = await service.get(runId); expect(['completed', 'partial']).toContain(complete.status); expect(complete.artifacts.filter(a => a.operation === 'download')).toHaveLength(2); expect(complete.artifacts.some(a => a.operation === 'remux' && a.verification === 'verified')).toBe(true); expect(complete.report.status).toBe('verified'); expect(complete.report.markdown).toContain('媒体访问控制验证报告');
  const exported = await service.export({ runId, format: 'markdown', outputDirectory: output }); expect(exported.content).toBe(complete.report.markdown);
  await service.dispose(); const reopened = new WorkbenchService({ repository, browserFactory, onEvent: () => {} }); cleanups.push(() => reopened.dispose()); expect(reopened.history().find(r => r.runId === runId)).toBeDefined(); const history = await reopened.get(runId); expect(history.events.length).toBeGreaterThan(0); expect(history.report.status).toBe('unavailable');
}, 30000);
it('refuses unselected output directories before creating a run', async () => {
  const repository = new EventRepository(':memory:'); cleanups.push(() => repository.close()); const service = new WorkbenchService({ repository, browserFactory: () => ({ open: async () => {}, close: async () => {}, setBounds: () => {} }), onEvent: () => {} }); cleanups.push(() => service.dispose());
  await expect(service.start({ targetUrl: 'https://example.test', outputDirectory: '/tmp', mode: 'standard', authorizationConfirmed: true, maxConcurrency: 4 })).rejects.toMatchObject({ code: 'OUTPUT_NOT_AUTHORIZED' }); expect(service.history()).toHaveLength(0);
});
