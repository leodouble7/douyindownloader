import { describe, expect, it, vi } from 'vitest';
import { EventRepository, type RunEventInput } from '../../src/main/runs/event-repository';
import { RunOrchestrator } from '../../src/main/runs/run-orchestrator';
import { createSanitizedMediaUrl, createSourceRequestReference } from '../../src/shared/contracts';

function eventInput(phase: RunEventInput['phase'], action: string): RunEventInput {
  return {
    phase,
    action,
    purpose: `Record ${action}`,
    status: 'running',
    relatedIds: []
  };
}

describe('EventRepository', () => {
  it('assigns strictly increasing sequences and lists events in order', () => {
    const repo = new EventRepository(':memory:');
    const runId = 'run-1';

    const first = repo.append(runId, eventInput('browser', 'navigate'));
    const second = repo.append(runId, eventInput('capture', 'response'));

    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(repo.list(runId).map((event) => event.action)).toEqual(['navigate', 'response']);
    repo.close();
  });

  it('stores an immutable snapshot of an appended event', () => {
    const repo = new EventRepository(':memory:');
    const input = {
      ...eventInput('probe', 'range-request'),
      evidence: { range: 'bytes=0-15' }
    };

    const stored = repo.append('run-1', input);
    input.evidence.range = 'mutated';
    stored.evidence!.range = 'mutated again';

    expect(repo.list('run-1')[0]?.evidence).toEqual({ range: 'bytes=0-15' });
    repo.close();
  });

  it('redacts URL and header evidence before writing SQLite', () => {
    const repo = new EventRepository(':memory:');

    repo.append('run-1', {
      ...eventInput('capture', 'response'),
      evidence: {
        observedUrl: 'https://cdn.example.test/video.mp4?signature=secret',
        responseHeaders: { Authorization: 'Bearer secret', 'Content-Type': 'video/mp4' }
      }
    });

    expect(repo.list('run-1')[0]?.evidence).toEqual({
      observedUrl: 'https://cdn.example.test/video.mp4?signature=%5BREDACTED%5D',
      responseHeaders: { Authorization: '[REDACTED]', 'Content-Type': 'video/mp4' }
    });
    repo.close();
  });

  it('defensively sanitizes lied-about captured URLs, initiators, and headers', () => {
    const repo = new EventRepository(':memory:');

    repo.persistCapturedRequest({
      id: 'request-1',
      runId: 'run-1',
      sanitizedUrl: 'https://cdn.example.test/video.mp4?token=secret-marker' as ReturnType<typeof createSanitizedMediaUrl>,
      method: 'GET',
      initiator: 'https://site.example.test/watch?signature=secret-marker',
      sanitizedRequestHeaders: { Authorization: 'Bearer secret-marker', Referer: 'https://site.example.test/?token=secret-marker' },
      sanitizedResponseHeaders: { Cookie: 'sid=secret-marker' },
      receivedAt: '2026-09-15T00:00:00.000Z'
    });

    const persisted = repo.listCapturedRequests('run-1');
    expect(persisted[0]).toMatchObject({
      sanitizedUrl: 'https://cdn.example.test/video.mp4?token=%5BREDACTED%5D',
      initiator: 'https://site.example.test/watch?signature=%5BREDACTED%5D',
      sanitizedRequestHeaders: {
        Authorization: '[REDACTED]',
        Referer: 'https://site.example.test/?token=%5BREDACTED%5D'
      },
      sanitizedResponseHeaders: { Cookie: '[REDACTED]' }
    });
    expect(JSON.stringify(persisted)).not.toContain('secret-marker');
    repo.close();
  });
});

describe('RunOrchestrator', () => {
  const input = {
    targetUrl: 'https://media.example.test/watch/1',
    outputDirectory: '/tmp/media-lab',
    mode: 'observe' as const,
    maxConcurrency: 4,
    authorizationConfirmed: true
  };

  it('emits deterministic before and after events around start, capture, cancellation, and completion', () => {
    const repo = new EventRepository(':memory:');
    const delivered: string[] = [];
    const orchestrator = new RunOrchestrator(repo, (event) => {
      expect(repo.list(event.runId).map((stored) => stored.id)).toContain(event.id);
      delivered.push(`${event.action}:${event.status}`);
    });
    const runId = orchestrator.start(input, 'run-1');

    orchestrator.captureRequest(runId, {
      id: 'request-1',
      url: 'https://cdn.example.test/video.mp4?token=secret',
      method: 'GET',
      requestHeaders: { Cookie: 'sid=secret', Range: 'bytes=0-15' }
    });
    orchestrator.cancel(runId);

    expect(delivered).toEqual([
      'run-start:before:running', 'run-start:after:succeeded',
      'capture-request:before:running', 'capture-request:after:succeeded',
      'run-cancel:before:running', 'run-cancel:after:cancelled'
    ]);
    expect(repo.listCapturedRequests(runId)[0]).toMatchObject({
      sanitizedUrl: 'https://cdn.example.test/video.mp4?token=%5BREDACTED%5D',
      sanitizedRequestHeaders: { Cookie: '[REDACTED]', Range: 'bytes=0-15' }
    });
    expect(orchestrator.isActive(runId)).toBe(false);

    const secondRun = orchestrator.start(input, 'run-2');
    orchestrator.complete(secondRun);
    expect(repo.list(secondRun).map((event) => `${event.action}:${event.status}`))
      .toEqual(['run-start:before:running', 'run-start:after:succeeded', 'run-complete:before:running', 'run-complete:after:succeeded']);
    repo.close();
  });

  it('releases active raw request context when append or renderer delivery fails', () => {
    const appendFailureRepo = new EventRepository(':memory:');
    const appendFailureOrchestrator = new RunOrchestrator(appendFailureRepo);
    const appendSpy = vi.spyOn(appendFailureRepo, 'append');
    const runId = appendFailureOrchestrator.start(input, 'append-failure');
    appendSpy.mockImplementationOnce(() => { throw new Error('append failed'); });

    expect(() => appendFailureOrchestrator.cancel(runId)).toThrow('append failed');
    expect(appendFailureOrchestrator.isActive(runId)).toBe(false);
    expect(appendFailureRepo.list(runId).map((event) => event.action)).toContain('run-cancel:failed');

    const listenerFailureRepo = new EventRepository(':memory:');
    let shouldThrow = false;
    const listenerFailureOrchestrator = new RunOrchestrator(listenerFailureRepo, () => {
      if (shouldThrow) throw new Error('renderer failed');
    });
    const listenerRunId = listenerFailureOrchestrator.start(input, 'listener-failure');
    shouldThrow = true;

    expect(() => listenerFailureOrchestrator.cancel(listenerRunId)).toThrow('renderer failed');
    expect(listenerFailureOrchestrator.isActive(listenerRunId)).toBe(false);
    expect(listenerFailureRepo.list(listenerRunId).slice(-2).map((event) => `${event.action}:${event.status}`))
      .toEqual(['run-cancel:before:running', 'run-cancel:failed:failed']);
    appendFailureRepo.close();
    listenerFailureRepo.close();
  });

  it('audits failed capture persistence without writing a succeeded after-event or retaining the raw request', () => {
    const repo = new EventRepository(':memory:');
    const delivered: string[] = [];
    const orchestrator = new RunOrchestrator(repo, (event) => delivered.push(`${event.action}:${event.status}`));
    const runId = orchestrator.start(input, 'capture-failure');
    vi.spyOn(repo, 'persistCapturedRequest').mockImplementationOnce(() => {
      throw new Error('capture persistence failed');
    });

    expect(() => orchestrator.captureRequest(runId, {
      id: 'request-1',
      url: 'https://cdn.example.test/video.mp4?token=secret-marker',
      method: 'GET',
      requestHeaders: { Cookie: 'sid=secret-marker' }
    })).toThrow('capture persistence failed');

    expect(repo.list(runId).slice(-2).map((event) => `${event.action}:${event.status}`))
      .toEqual(['capture-request:before:running', 'capture-request:failed:failed']);
    expect(delivered.slice(-2)).toEqual(['capture-request:before:running', 'capture-request:failed:failed']);
    const internalRuns = orchestrator as unknown as { activeRuns: Map<string, { requests: Map<string, unknown> }> };
    expect(internalRuns.activeRuns.get(runId)?.requests.size).toBe(0);
    orchestrator.cancel(runId);
    repo.close();
  });

  it('redacts embedded URL and credential text before persisting a failure audit event', () => {
    const repo = new EventRepository(':memory:');
    const orchestrator = new RunOrchestrator(repo);
    const runId = orchestrator.start(input, 'failure-text');
    vi.spyOn(repo, 'persistCapturedRequest').mockImplementationOnce(() => {
      throw new Error('Request failed for https://cdn.test/v.mp4?token=url-secret-marker; Authorization: Bearer auth-secret-marker Cookie: sid=cookie-secret-marker');
    });

    expect(() => orchestrator.captureRequest(runId, {
      id: 'request-1',
      url: 'https://cdn.example.test/video.mp4?token=secret-marker',
      method: 'GET'
    })).toThrow('url-secret-marker');

    const failure = repo.list(runId).at(-1);
    expect(failure).toMatchObject({ action: 'capture-request:failed', status: 'failed' });
    const persisted = JSON.stringify(failure?.evidence);
    expect(persisted).toContain('Request failed for https://cdn.test/v.mp4?token=%5BREDACTED%5D');
    expect(persisted).not.toContain('url-secret-marker');
    expect(persisted).not.toContain('auth-secret-marker');
    expect(persisted).not.toContain('cookie-secret-marker');
    orchestrator.cancel(runId);
    repo.close();
  });

  it('redacts every whitespace-separated cookie and authorization value in persisted failure evidence', () => {
    const repo = new EventRepository(':memory:');
    const orchestrator = new RunOrchestrator(repo);
    const runId = orchestrator.start(input, 'failure-header-text');
    vi.spyOn(repo, 'persistCapturedRequest').mockImplementationOnce(() => {
      throw new Error('Request context follows\nCookie: sid=first-secret-marker; auth=second-secret-marker; theme=third-secret-marker\nAuthorization: Bearer first-auth-marker additional-auth-marker\nRetry remains safe.');
    });

    expect(() => orchestrator.captureRequest(runId, {
      id: 'request-1',
      url: 'https://cdn.example.test/video.mp4?token=secret-marker',
      method: 'GET'
    })).toThrow('first-secret-marker');

    const persisted = JSON.stringify(repo.list(runId).at(-1)?.evidence);
    expect(persisted).toContain('Request context follows');
    expect(persisted).toContain('Retry remains safe.');
    expect(persisted).not.toContain('first-secret-marker');
    expect(persisted).not.toContain('second-secret-marker');
    expect(persisted).not.toContain('third-secret-marker');
    expect(persisted).not.toContain('first-auth-marker');
    expect(persisted).not.toContain('additional-auth-marker');
    orchestrator.cancel(runId);
    repo.close();
  });
});

describe('ephemeral replay context', () => {
  it.each(['cancel', 'complete', 'dispose'] as const)('scopes raw templates and releases them after %s', terminal => {
    const repository = new EventRepository(':memory:');
    const delivered: unknown[] = [];
    const context = new RunOrchestrator(repository, e => delivered.push(e));
    const input = { targetUrl: 'https://example.test', outputDirectory: '/tmp', mode: 'standard' as const, maxConcurrency: 4, authorizationConfirmed: true };
    const runId = context.start(input); input.mode = 'observe' as 'standard';
    const sourceIdentity = { runId, targetId: 'page', sessionId: 'session', frameId: 'frame', requestId: '42', version: 1 };
    const request = { id: createSourceRequestReference(sourceIdentity), sourceIdentity, url: 'https://example.test/v?sig=secret-marker', method: 'GET', requestHeaders: { Cookie: 'secret-marker' } };
    context.captureRequest(runId, request);
    request.requestHeaders.Cookie = 'changed';
    expect(context.resolveRequest(runId, request.id)?.requestHeaders?.Cookie).toBe('secret-marker');
    expect(context.getMode(runId)).toBe('standard');
    expect(context.resolveRequest(runId, '["other","42"]')).toBeUndefined();
    expect(JSON.stringify({ events: repository.list(runId), delivered })).not.toContain('secret-marker');
    if (terminal === 'dispose') context.dispose(); else context[terminal](runId);
    expect(() => context.resolveRequest(runId, request.id)).toThrow();
    context.dispose(); repository.close();
  });
});
