import { expect, it } from 'vitest';
import { MemoryEventRepository } from '../../src/main/desktop/memory-event-repository';
import { RunOrchestrator } from '../../src/main/runs/run-orchestrator';
import { createSourceRequestReference } from '../../src/shared/contracts';

it('uses transient sanitized events while retaining immutable raw requests only in the active run', () => {
  const repository = new MemoryEventRepository(); const context = new RunOrchestrator(repository);
  const runId = context.start({ targetUrl: 'https://douyin.com/', outputDirectory: '/tmp', mode: 'full-download', authorizationConfirmed: true, maxConcurrency: 2 });
  const sourceIdentity = { runId, targetId: 'page', sessionId: '', frameId: '', requestId: 'one', version: 1 };
  const request = { id: createSourceRequestReference(sourceIdentity), sourceIdentity, url: 'https://cdn.example/v.mp4?token=raw-secret', method: 'GET', requestHeaders: { Cookie: 'cookie-secret' } };
  const stored = context.captureRequest(runId, request); expect(JSON.stringify(stored)).not.toMatch(/raw-secret|cookie-secret/);
  expect(context.resolveRequest(runId, request.id)?.url).toContain('raw-secret');
  const events = repository.list(runId); expect(events.map(e => e.sequence)).toEqual([1, 2, 3, 4]); expect(JSON.stringify(events)).not.toMatch(/raw-secret|cookie-secret/);
  events[0].purpose = 'tampered'; expect(repository.list(runId)[0].purpose).not.toBe('tampered');
  context.complete(runId); expect(() => context.resolveRequest(runId, request.id)).toThrow(); context.dispose(); repository.close(); expect(repository.list(runId)).toEqual([]);
});
