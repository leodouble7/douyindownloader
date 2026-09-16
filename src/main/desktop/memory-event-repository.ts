import { randomUUID } from 'node:crypto';
import type { RunEvent } from '../../shared/contracts';
import type { RunEventInput, RunEventStore, SanitizedCapturedRequest } from '../runs/event-repository';
import { createSanitizedCapturedUrl, redactEvidence, redactHeaders, redactText, redactUrlValue } from '../security/redact';

/** GUI runs have no event database. Keeps bounded, sanitized diagnostics until cleanup. */
export class MemoryEventRepository implements RunEventStore {
  private readonly events = new Map<string, RunEvent[]>();
  private readonly sequences = new Map<string, number>();
  append(runId: string, input: RunEventInput): RunEvent {
    const sequence = (this.sequences.get(runId) ?? 0) + 1; this.sequences.set(runId, sequence);
    const event: RunEvent = structuredClone({ id: randomUUID(), runId, sequence, timestamp: input.timestamp ?? new Date().toISOString(), phase: input.phase, action: redactText(input.action), purpose: redactText(input.purpose), status: input.status, inputSummary: redactEvidence(input.inputSummary), evidence: redactEvidence(input.evidence), conclusion: input.conclusion === undefined ? undefined : redactText(input.conclusion), relatedIds: [...input.relatedIds] });
    const list = this.events.get(runId) ?? []; list.push(event); if (list.length > 2048) list.shift(); this.events.set(runId, list); return structuredClone(event);
  }
  list(runId: string): RunEvent[] { return structuredClone(this.events.get(runId) ?? []); }
  persistCapturedRequest(request: SanitizedCapturedRequest): SanitizedCapturedRequest {
    return structuredClone({ ...request, sanitizedUrl: createSanitizedCapturedUrl(request.sanitizedUrl), initiator: request.initiator === undefined ? undefined : redactUrlValue(request.initiator), sanitizedRequestHeaders: request.sanitizedRequestHeaders === undefined ? undefined : redactHeaders(request.sanitizedRequestHeaders), sanitizedResponseHeaders: request.sanitizedResponseHeaders === undefined ? undefined : redactHeaders(request.sanitizedResponseHeaders) });
  }
  close(): void { this.events.clear(); this.sequences.clear(); }
}
