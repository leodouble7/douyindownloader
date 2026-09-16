import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { CapturedRequest, RunEvent, RunPhase, StepStatus } from '../../shared/contracts';
import type { SanitizedMediaUrl } from '../../shared/contracts';
import { createSanitizedCapturedUrl, redactEvidence, redactHeaders, redactUrlValue } from '../security/redact';

export interface RunEventInput {
  phase: RunPhase;
  action: string;
  purpose: string;
  status: StepStatus;
  inputSummary?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  conclusion?: string;
  relatedIds: string[];
  timestamp?: string;
}

/**
 * Persistence-safe capture data. Raw URLs and raw headers intentionally have
 * no representation in this type.
 */
export interface SanitizedCapturedRequest {
  id: string;
  runId: string;
  sanitizedUrl: SanitizedMediaUrl;
  method: string;
  resourceType?: string;
  frameId?: string;
  initiator?: string;
  status?: number;
  mimeType?: string;
  contentLength?: number;
  contentRange?: string;
  sanitizedRequestHeaders?: Record<string, string>;
  sanitizedResponseHeaders?: Record<string, string>;
  receivedAt: string;
}

interface RunEventRow {
  id: string;
  run_id: string;
  sequence: number;
  timestamp: string;
  phase: RunPhase;
  action: string;
  purpose: string;
  status: StepStatus;
  input_summary: string | null;
  evidence: string | null;
  conclusion: string | null;
  related_ids: string;
}

interface CapturedRequestRow {
  id: string;
  run_id: string;
  sanitized_url: string;
  method: string;
  resource_type: string | null;
  frame_id: string | null;
  initiator: string | null;
  status: number | null;
  mime_type: string | null;
  content_length: number | null;
  content_range: string | null;
  sanitized_request_headers: string | null;
  sanitized_response_headers: string | null;
  received_at: string;
}

export interface RunEventStore {
  append(runId: string, input: RunEventInput): RunEvent;
  persistCapturedRequest(request: SanitizedCapturedRequest): SanitizedCapturedRequest;
  close(): void;
}

export class EventRepository implements RunEventStore {
  private readonly database: Database.Database;

  constructor(path: string) {
    this.database = new Database(path);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        phase TEXT NOT NULL,
        action TEXT NOT NULL,
        purpose TEXT NOT NULL,
        status TEXT NOT NULL,
        input_summary TEXT,
        evidence TEXT,
        conclusion TEXT,
        related_ids TEXT NOT NULL,
        UNIQUE (run_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS run_events_by_run ON run_events(run_id, sequence);
      CREATE TABLE IF NOT EXISTS captured_requests (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        sanitized_url TEXT NOT NULL,
        method TEXT NOT NULL,
        resource_type TEXT,
        frame_id TEXT,
        initiator TEXT,
        status INTEGER,
        mime_type TEXT,
        content_length INTEGER,
        content_range TEXT,
        sanitized_request_headers TEXT,
        sanitized_response_headers TEXT,
        received_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS captured_requests_by_run ON captured_requests(run_id, received_at);
    `);
  }

  append(runId: string, input: RunEventInput): RunEvent {
    return this.database.transaction(() => {
      const event: RunEvent = {
        id: randomUUID(),
        runId,
        sequence: this.nextSequence(runId),
        timestamp: input.timestamp ?? new Date().toISOString(),
        phase: input.phase,
        action: input.action,
        purpose: input.purpose,
        status: input.status,
        inputSummary: cloneRecord(redactEvidence(input.inputSummary)),
        evidence: cloneRecord(redactEvidence(input.evidence)),
        conclusion: input.conclusion,
        relatedIds: [...input.relatedIds]
      };

      this.database.prepare(`
        INSERT INTO run_events (
          id, run_id, sequence, timestamp, phase, action, purpose, status,
          input_summary, evidence, conclusion, related_ids
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.runId,
        event.sequence,
        event.timestamp,
        event.phase,
        event.action,
        event.purpose,
        event.status,
        stringifyOptional(event.inputSummary),
        stringifyOptional(event.evidence),
        event.conclusion ?? null,
        JSON.stringify(event.relatedIds)
      );

      return event;
    })();
  }

  list(runId: string): RunEvent[] {
    const rows = this.database.prepare(`
      SELECT id, run_id, sequence, timestamp, phase, action, purpose, status,
             input_summary, evidence, conclusion, related_ids
      FROM run_events WHERE run_id = ? ORDER BY sequence ASC
    `).all(runId) as RunEventRow[];

    return rows.map(toRunEvent);
  }

  persistCapturedRequest(request: SanitizedCapturedRequest): SanitizedCapturedRequest {
    const sanitizedRequest: SanitizedCapturedRequest = {
      ...request,
      sanitizedUrl: createSanitizedCapturedUrl(request.sanitizedUrl),
      initiator: request.initiator === undefined ? undefined : redactUrlValue(request.initiator),
      sanitizedRequestHeaders: request.sanitizedRequestHeaders === undefined
        ? undefined
        : redactHeaders(request.sanitizedRequestHeaders),
      sanitizedResponseHeaders: request.sanitizedResponseHeaders === undefined
        ? undefined
        : redactHeaders(request.sanitizedResponseHeaders)
    };

    this.database.prepare(`
      INSERT INTO captured_requests (
        id, run_id, sanitized_url, method, resource_type, frame_id, initiator,
        status, mime_type, content_length, content_range,
        sanitized_request_headers, sanitized_response_headers, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sanitizedRequest.id, sanitizedRequest.runId, sanitizedRequest.sanitizedUrl, sanitizedRequest.method,
      sanitizedRequest.resourceType ?? null, sanitizedRequest.frameId ?? null, sanitizedRequest.initiator ?? null,
      sanitizedRequest.status ?? null, sanitizedRequest.mimeType ?? null,
      sanitizedRequest.contentLength ?? null, sanitizedRequest.contentRange ?? null,
      stringifyOptional(sanitizedRequest.sanitizedRequestHeaders),
      stringifyOptional(sanitizedRequest.sanitizedResponseHeaders), sanitizedRequest.receivedAt
    );

    return sanitizedRequest;
  }

  listCapturedRequests(runId: string): CapturedRequest[] {
    const rows = this.database.prepare(`
      SELECT id, run_id, sanitized_url, method, resource_type, frame_id,
             initiator, status, mime_type, content_length, content_range,
             sanitized_request_headers, sanitized_response_headers, received_at
      FROM captured_requests WHERE run_id = ? ORDER BY received_at ASC, id ASC
    `).all(runId) as CapturedRequestRow[];

    return rows.map(toCapturedRequest);
  }

  close(): void {
    this.database.close();
  }

  private nextSequence(runId: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM run_events WHERE run_id = ?
    `).get(runId) as { sequence: number };
    return row.sequence;
  }
}

function toRunEvent(row: RunEventRow): RunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    timestamp: row.timestamp,
    phase: row.phase,
    action: row.action,
    purpose: row.purpose,
    status: row.status,
    inputSummary: parseOptionalRecord(row.input_summary),
    evidence: parseOptionalRecord(row.evidence),
    conclusion: row.conclusion ?? undefined,
    relatedIds: JSON.parse(row.related_ids) as string[]
  };
}

function toCapturedRequest(row: CapturedRequestRow): CapturedRequest {
  return {
    id: row.id,
    runId: row.run_id,
    sanitizedUrl: row.sanitized_url as SanitizedMediaUrl,
    method: row.method,
    resourceType: row.resource_type ?? undefined,
    frameId: row.frame_id ?? undefined,
    initiator: row.initiator ?? undefined,
    status: row.status ?? undefined,
    mimeType: row.mime_type ?? undefined,
    contentLength: row.content_length ?? undefined,
    contentRange: row.content_range ?? undefined,
    sanitizedRequestHeaders: parseOptionalStringRecord(row.sanitized_request_headers),
    sanitizedResponseHeaders: parseOptionalStringRecord(row.sanitized_response_headers),
    receivedAt: row.received_at
  };
}

function cloneRecord(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function stringifyOptional(value: Record<string, unknown> | Record<string, string> | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseOptionalRecord(value: string | null): Record<string, unknown> | undefined {
  return value === null ? undefined : JSON.parse(value) as Record<string, unknown>;
}

function parseOptionalStringRecord(value: string | null): Record<string, string> | undefined {
  return value === null ? undefined : JSON.parse(value) as Record<string, string>;
}
