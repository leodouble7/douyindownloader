import { randomUUID } from 'node:crypto';
import { createSourceRequestReference, type SourceRequestIdentity, type RunEvent, type StartRunInput } from '../../shared/contracts';
import { createSanitizedCapturedUrl, redactEvidence, redactHeaders, redactText, redactUrlValue } from '../security/redact';
import { EventRepository, type RunEventInput, type SanitizedCapturedRequest } from './event-repository';

export interface EphemeralRequest {
  sourceIdentity?: SourceRequestIdentity;
  id: string;
  url: string;
  method: string;
  resourceType?: string;
  frameId?: string;
  sessionId?: string;
  initiator?: string;
  status?: number;
  mimeType?: string;
  contentLength?: number;
  contentRange?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

interface ActiveRun {
  controller: AbortController;
  requests: Map<string, EphemeralRequest>;
  mode: StartRunInput['mode'];
  settings: Readonly<StartRunInput>;
}

export interface EmitRunEventInput extends RunEventInput {
  runId: string;
}

export class RunOrchestrator {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly exitHandler = (): void => this.dispose();

  constructor(
    private readonly repository: EventRepository,
    private readonly onStoredEvent: (event: RunEvent) => void = () => undefined
  ) {
    process.once('exit', this.exitHandler);
  }

  start(_input: StartRunInput, runId: string = randomUUID()): string {
    if (this.activeRuns.has(runId)) {
      throw new Error(`Run is already active: ${runId}`);
    }

    this.activeRuns.set(runId, { controller: new AbortController(), requests: new Map(), mode: _input.mode, settings: Object.freeze(structuredClone(_input)) });
    let started = false;
    try {
      this.emitAction(runId, 'browser', 'run-start', 'Start authorized media verification run', 'before', 'running');
      this.emitAction(runId, 'browser', 'run-start', 'Start authorized media verification run', 'after', 'succeeded');
      started = true;
      return runId;
    } catch (error) {
      return this.throwWithFailureAudit(runId, 'browser', 'run-start', 'Starting the media verification run failed', error);
    } finally {
      if (!started) {
        this.releaseRun(runId);
      }
    }
  }

  emit(input: EmitRunEventInput): RunEvent {
    this.requireActiveRun(input.runId);
    const event = this.repository.append(input.runId, sanitizeEventInput(input));
    this.onStoredEvent(event);
    return event;
  }

  /** A running operation may finish its terminal audit after cancellation releases run memory. */
  retainTerminalEmitter(runId: string): (input: RunEventInput) => RunEvent {
    this.requireActiveRun(runId);
    return input => {
      if (!['succeeded', 'failed', 'cancelled', 'denied', 'warning'].includes(input.status)) throw new Error('Only terminal events may outlive an active run');
      const event = this.repository.append(runId, sanitizeEventInput({ ...input, runId }));
      this.onStoredEvent(event);
      return event;
    };
  }

  captureRequest(runId: string, request: EphemeralRequest): SanitizedCapturedRequest {
    const context = this.requireActiveRun(runId);
    if (request.sourceIdentity) this.assertRequestIdentity(runId, request);
    let capturedSuccessfully = false;
    try {
      this.emitAction(runId, 'capture', 'capture-request', 'Record sanitized browser response metadata', 'before', 'running', [request.id]);
      const captured: SanitizedCapturedRequest = {
        id: request.id,
        runId,
        sanitizedUrl: createSanitizedCapturedUrl(request.url),
        method: request.method,
        resourceType: request.resourceType,
        frameId: request.frameId,
        initiator: request.initiator === undefined ? undefined : redactUrlValue(request.initiator),
        status: request.status,
        mimeType: request.mimeType,
        contentLength: request.contentLength,
        contentRange: request.contentRange,
        sanitizedRequestHeaders: request.requestHeaders === undefined ? undefined : redactHeaders(request.requestHeaders),
        sanitizedResponseHeaders: request.responseHeaders === undefined ? undefined : redactHeaders(request.responseHeaders),
        receivedAt: new Date().toISOString()
      };
      const persisted = this.repository.persistCapturedRequest(captured);
      this.emitAction(
        runId,
        'capture',
        'capture-request',
        'Record sanitized browser response metadata',
        'after',
        'succeeded',
        [persisted.id],
        {
          requestId: persisted.id,
          sanitizedUrl: persisted.sanitizedUrl,
          requestHeaders: persisted.sanitizedRequestHeaders,
          responseHeaders: persisted.sanitizedResponseHeaders,
          status: persisted.status,
          mimeType: persisted.mimeType,
          contentLength: persisted.contentLength,
          contentRange: persisted.contentRange
        }
      );
      if (request.sourceIdentity) this.rememberRequest(runId, request);
      capturedSuccessfully = true;
      return persisted;
    } catch (error) {
      return this.throwWithFailureAudit(runId, 'capture', 'capture-request', 'Capturing browser response metadata failed', error, [request.id]);
    } finally {
      if (!capturedSuccessfully) context.requests.delete(request.id);
    }
  }

  /** Main-process memory only. Bounded snapshots expire with the active run. */
  rememberRequest(runId: string, request: EphemeralRequest): void {
    const context = this.requireActiveRun(runId);
    if (context.controller.signal.aborted) return;
    this.assertRequestIdentity(runId, request);
    if (context.requests.has(request.id)) return;
    const url = new URL(request.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || request.url.length > 16384) return;
    if (JSON.stringify(request).length > 65536) return;
    if (!context.requests.has(request.id) && context.requests.size >= 512) context.requests.delete(context.requests.keys().next().value!);
    context.requests.set(request.id, structuredClone(request));
  }

  private assertRequestIdentity(runId: string, request: EphemeralRequest): void {
    const identity = request.sourceIdentity;
    if (!identity || identity.runId !== runId || createSourceRequestReference(identity) !== request.id || (request.frameId !== undefined && request.frameId !== identity.frameId) || (request.sessionId !== undefined && request.sessionId !== identity.sessionId)) throw new Error('Request reference does not match full source identity');
    const previous = this.requireActiveRun(runId).requests.get(request.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(request)) throw new Error('Request source snapshots are immutable');
  }

  resolveRequest(runId: string, sourceRequestId: string): EphemeralRequest | undefined {
    const value = this.requireActiveRun(runId).requests.get(sourceRequestId);
    return value === undefined ? undefined : structuredClone(value);
  }

  getMode(runId: string): StartRunInput['mode'] {
    return this.requireActiveRun(runId).mode;
  }

  /** Immutable main-process configuration; renderer download arguments cannot replace it. */
  getDownloadSettings(runId: string): Readonly<StartRunInput> {
    return { ...this.requireActiveRun(runId).settings };
  }

  cancel(runId: string): void {
    const context = this.requireActiveRun(runId);
    try {
      this.emitAction(runId, 'browser', 'run-cancel', 'Stop all active media verification operations', 'before', 'running');
      context.controller.abort();
      this.emitAction(runId, 'browser', 'run-cancel', 'Stop all active media verification operations', 'after', 'cancelled');
    } catch (error) {
      this.throwWithFailureAudit(runId, 'browser', 'run-cancel', 'Cancelling the media verification run failed', error);
    } finally {
      context.controller.abort();
      this.releaseRun(runId);
    }
  }

  complete(runId: string): void {
    this.requireActiveRun(runId);
    try {
      this.emitAction(runId, 'report', 'run-complete', 'Finish the media verification run', 'before', 'running');
      this.emitAction(runId, 'report', 'run-complete', 'Finish the media verification run', 'after', 'succeeded');
    } catch (error) {
      this.throwWithFailureAudit(runId, 'report', 'run-complete', 'Completing the media verification run failed', error);
    } finally {
      this.releaseRun(runId);
    }
  }

  getAbortSignal(runId: string): AbortSignal {
    return this.requireActiveRun(runId).controller.signal;
  }

  isActive(runId: string): boolean {
    return this.activeRuns.has(runId);
  }

  dispose(): void {
    for (const [runId, context] of this.activeRuns) {
      context.controller.abort();
      this.releaseRun(runId);
    }
    process.off('exit', this.exitHandler);
  }

  private requireActiveRun(runId: string): ActiveRun {
    const context = this.activeRuns.get(runId);
    if (context === undefined) {
      throw new Error(`Run is not active: ${runId}`);
    }
    return context;
  }

  private releaseRun(runId: string): void {
    const context = this.activeRuns.get(runId);
    context?.controller.abort();
    context?.requests.clear();
    this.activeRuns.delete(runId);
  }

  private emitAction(
    runId: string,
    phase: RunEventInput['phase'],
    action: string,
    purpose: string,
    stage: 'before' | 'after',
    status: RunEventInput['status'],
    relatedIds: string[] = [],
    evidence?: Record<string, unknown>
  ): RunEvent {
    return this.emit({ runId, phase, action: `${action}:${stage}`, purpose, status, relatedIds, evidence });
  }

  private throwWithFailureAudit(
    runId: string,
    phase: RunEventInput['phase'],
    action: string,
    purpose: string,
    error: unknown,
    relatedIds: string[] = []
  ): never {
    try {
      const event = this.repository.append(runId, {
        phase,
        action: `${action}:failed`,
        purpose,
        status: 'failed',
        evidence: { failure: redactText(error instanceof Error ? error.message : String(error)) },
        relatedIds
      });
      this.onStoredEvent(event);
    } catch (auditError) {
      const originalMessage = error instanceof Error ? error.message : String(error);
      throw new AggregateError([error, auditError], `${originalMessage}; failure audit could not be persisted`);
    }
    throw error;
  }
}

function sanitizeEventInput(input: EmitRunEventInput): RunEventInput {
  return {
    phase: input.phase,
    action: input.action,
    purpose: input.purpose,
    status: input.status,
    inputSummary: redactEvidence(input.inputSummary),
    evidence: redactEvidence(input.evidence),
    conclusion: input.conclusion,
    relatedIds: [...input.relatedIds],
    timestamp: input.timestamp
  };
}
