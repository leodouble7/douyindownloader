import { describe, expect, it } from 'vitest';
import { createSourceRequestReference } from '../../src/shared/contracts';
import { EventRepository } from '../../src/main/runs/event-repository';
import { RunOrchestrator } from '../../src/main/runs/run-orchestrator';

describe('immutable full capture references', () => {
  it.each(['cancel', 'complete', 'dispose'] as const)('isolates every identity dimension and clears on %s', terminal => {
    const repository = new EventRepository(':memory:'); const events: unknown[] = [];
    const context = new RunOrchestrator(repository, event => events.push(event));
    const runId = context.start({ targetUrl: 'https://example.test', outputDirectory: '/tmp', mode: 'standard', maxConcurrency: 4, authorizationConfirmed: true });
    const base = { runId, targetId: 'page', sessionId: 'session', frameId: 'frame', requestId: '42', version: 1 };
    const variants = [base, { ...base, targetId: 'other' }, { ...base, sessionId: 'other' }, { ...base, frameId: 'other' }, { ...base, version: 2 }];
    variants.forEach((sourceIdentity, index) => context.captureRequest(runId, { sourceIdentity, id: createSourceRequestReference(sourceIdentity), method: 'GET', url: `https://example.test/video?token=secret-${index}`, requestHeaders: { Cookie: `secret-${index}` } }));
    variants.forEach((identity, index) => expect(context.resolveRequest(runId, createSourceRequestReference(identity))?.url).toContain(`secret-${index}`));
    const originalId = createSourceRequestReference(base);
    expect(() => context.rememberRequest(runId, { id: originalId, sourceIdentity: base, method: 'GET', url: 'https://example.test/video?token=overwritten' })).toThrow(/immutable/);
    expect(() => context.rememberRequest(runId, { id: originalId, sourceIdentity: variants[3], method: 'GET', url: 'https://example.test/video?token=wrong-frame' })).toThrow(/identity/);
    expect(() => context.captureRequest(runId, { id: originalId, sourceIdentity: base, method: 'GET', url: 'https://example.test/video?token=overwrite-through-capture' })).toThrow(/immutable/);
    expect(context.resolveRequest(runId, originalId)?.url).toContain('secret-0');
    expect(JSON.stringify({ events, rows: repository.list(runId) })).not.toMatch(/secret-\d|overwritten|wrong-frame/);
    if (terminal === 'dispose') context.dispose(); else context[terminal](runId);
    expect(() => context.resolveRequest(runId, originalId)).toThrow();
    context.dispose(); repository.close();
  });
});
