export type RunMode = 'observe' | 'standard' | 'full-download';

export type RunPhase =
  | 'browser'
  | 'capture'
  | 'correlate'
  | 'probe'
  | 'download'
  | 'ffmpeg'
  | 'verify'
  | 'report';

export type StepStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'denied'
  | 'warning'
  | 'failed'
  | 'cancelled';

export interface RunEvent {
  id: string;
  runId: string;
  sequence: number;
  timestamp: string;
  phase: RunPhase;
  action: string;
  purpose: string;
  status: StepStatus;
  inputSummary?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  conclusion?: string;
  relatedIds: string[];
}

export interface StartRunInput {
  targetUrl: string;
  outputDirectory: string;
  mode: RunMode;
  maxConcurrency: number;
  authorizationConfirmed: boolean;
}

/** Only sanitized metadata crosses the run persistence and UI boundary. */
export interface CapturedRequest {
  id: string;
  runId: string;
  sanitizedUrl: string;
  method: string;
  resourceType?: string;
  frameId?: string;
  sessionId?: string;
  initiator?: string;
  status?: number;
  mimeType?: string;
  contentLength?: number;
  contentRange?: string;
  sanitizedRequestHeaders?: Record<string, string>;
  sanitizedResponseHeaders?: Record<string, string>;
  receivedAt: string;
  sourceIdentity?: SourceRequestIdentity;
}

export type MediaTrackKind = 'video' | 'audio' | 'muxed' | 'manifest' | 'unknown';

declare const sanitizedMediaUrlBrand: unique symbol;

/**
 * A URL that has passed the shared boundary check for UI and persistence-facing
 * media metadata. Construct this only through createSanitizedMediaUrl.
 */
export type SanitizedMediaUrl = string & {
  readonly [sanitizedMediaUrlBrand]: true;
};

const sensitiveQueryNamePattern = /token|signature|^sig$|policy|credential|key|session|authorization|cookie/i;
const redactedQueryValue = '[REDACTED]';

export function createSanitizedMediaUrl(value: string): SanitizedMediaUrl {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Media URL must be a valid HTTP(S) URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Media URL must use HTTP or HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Media URL must not contain credentials');
  }

  for (const [name, queryValue] of parsed.searchParams) {
    if (sensitiveQueryNamePattern.test(name) && queryValue !== redactedQueryValue) {
      throw new Error(`Media URL contains an unredacted sensitive query value: ${name}`);
    }
  }

  return parsed.toString() as SanitizedMediaUrl;
}

export interface MediaAsset {
  id: string;
  runId: string;
  title?: string;
  sourceRequestIds: string[];
  trackIds: string[];
  detectedAt: string;
  /** Candidate tracks are sanitized display metadata. Request IDs are resolved only in active run memory. */
  tracks: MediaTrack[];
  /** Deterministic best compatible track set; other tracks remain available as alternatives. */
  selectedTrackIds: string[];
  /** Correlation confidence from 0 through 1, backed by track detectionReasons. */
  confidence: number;
  detectionReasons: string[];
  encrypted?: boolean;
}

export interface MediaTrack {
  id: string;
  assetId: string;
  kind: MediaTrackKind;
  sourceRequestIds: string[];
  sanitizedUrl: SanitizedMediaUrl;
  mimeType?: string;
  codecs?: string;
  bitrate?: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  byteLength?: number;
  detectionReasons: string[];
  confidence?: number;
  encrypted?: boolean;
  /** False when every observed lifecycle for this representation failed or was rejected. */
  eligible?: boolean;
  /** True when capture observed a failed/cancelled lifecycle rather than a complete candidate. */
  incomplete?: boolean;
}

export type ProbeOutcome = 'accessible' | 'denied' | 'inconclusive' | 'encrypted';

export interface ProbeResult {
  id: string;
  runId: string;
  trackId: string;
  requestId?: string;
  name: string;
  outcome: ProbeOutcome;
  status?: number;
  responseMimeType?: string;
  bytesReceived?: number;
  contentRange?: string;
  durationMs: number;
  inputSummary: Record<string, unknown>;
  evidence: Record<string, unknown>;
  conclusion: string;
}

export interface DownloadArtifact {
  id: string;
  runId: string;
  trackIds: string[];
  path: string;
  byteLength: number;
  sha256: string;
  mimeType?: string;
  completedAt: string;
}

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface Finding {
  id: string;
  runId: string;
  severity: FindingSeverity;
  title: string;
  summary: string;
  recommendation: string;
  observedBehavior: string;
  practicalImpact: string;
  limitations: string[];
  evidenceEventIds: string[];
  confidence: 'low' | 'medium' | 'high';
}

export interface CancelRunInput {
  runId: string;
}

export interface StartDownloadInput {
  runId: string;
  trackIds: string[];
}

export type ReportFormat = 'json' | 'markdown';

export interface ExportReportInput {
  runId: string;
  format: ReportFormat;
  outputDirectory: string;
}

export type ApiErrorCode = 'INVALID_INPUT' | 'FORBIDDEN' | 'BUSY' | 'NOT_FOUND' | 'OUTPUT_NOT_AUTHORIZED' | 'REPORT_UNAVAILABLE' | 'OPERATION_FAILED';
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: { code: ApiErrorCode; message: string } };
export type RunStatus = 'observing' | 'probing' | 'ready' | 'downloading' | 'reporting' | 'completed' | 'partial' | 'cancelled' | 'interrupted';
export interface PreviewBounds { x: number; y: number; width: number; height: number }
export interface UiTrack { id: string; assetId: string; kind: MediaTrackKind; mimeType?: string; codecs?: string; byteLength?: number; durationSeconds?: number; encrypted?: boolean; eligible?: boolean; incomplete?: boolean }
export interface UiAsset { id: string; trackIds: string[]; selectedTrackIds: string[]; confidence: number; encrypted?: boolean }
export interface UiProbe { id: string; trackId: string; name: string; outcome: ProbeOutcome; status?: number; bytesReceived?: number; eventIds: string[] }
export interface UiArtifact { id: string; trackIds: string[]; byteLength: number; sha256: string; verification: 'verified' | 'unverified'; operation: 'download' | 'remux' }
export interface UiReport { status: 'verified' | 'unavailable'; markdown?: string; json?: string; files: string[] }
export interface RunHistoryItem { runId: string; status: RunStatus; mode: RunMode; targetLabel: string; startedAt: string; completedAt?: string }
export interface WorkbenchSnapshot extends RunHistoryItem { events: RunEvent[]; assets: UiAsset[]; tracks: UiTrack[]; probes: UiProbe[]; findings: Finding[]; artifacts: UiArtifact[]; report: UiReport; }
export interface MediaLabApi {
  startRun(input: StartRunInput): Promise<ApiResult<{ runId: string }>>;
  cancelRun(input: CancelRunInput): Promise<ApiResult<void>>;
  chooseOutputDirectory(): Promise<ApiResult<string | null>>;
  finishObservation(input: CancelRunInput): Promise<ApiResult<void>>;
  finishRun(input: CancelRunInput): Promise<ApiResult<void>>;
  getRun(input: CancelRunInput): Promise<ApiResult<WorkbenchSnapshot>>;
  listHistory(): Promise<ApiResult<RunHistoryItem[]>>;
  setPreview(input: { runId: string; bounds: PreviewBounds | null }): Promise<ApiResult<void>>;
  startDownload(input: StartDownloadInput): Promise<ApiResult<{ downloadId: string }>>;
  exportReport(input: ExportReportInput): Promise<ApiResult<{ path: string; content: string }>>;
  onRunEvent(listener: (event: RunEvent) => void): () => void;
}

declare global {
  interface Window {
    mediaLab: MediaLabApi;
  }
}

export {};

/** Sanitized observation stream shared by capture and correlation. CDP times are monotonic seconds;
 * MSE timestamps are performance.now() milliseconds within the execution context. */
export interface CaptureIdentity {
  runId: string;
  targetId: string;
  targetType: string;
  sessionId?: string;
  frameId?: string;
}

export type MseMetadata =
  | { type: 'object-url'; objectId: string; objectUrl: string; timestamp: number }
  | { type: 'source-buffer'; objectId: string; sourceBufferId: string; mimeType: string; timestamp: number }
  | { type: 'append'; objectId: string; sourceBufferId: string; byteLength: number; timestamp: number; buffered: [number, number][] };

export type CaptureObservation =
  | (CaptureIdentity & { kind: 'target'; stage: 'attached' | 'detached'; sanitizedUrl?: string })
  | (CaptureIdentity & { kind: 'frame'; stage: 'attached' | 'navigated' | 'detached'; parentFrameId?: string; sanitizedUrl?: string })
  | (CaptureIdentity & {
      kind: 'network'; stage: 'request' | 'redirect' | 'response' | 'finished' | 'failed' | 'cache';
      requestId: string; request: CapturedRequest; timestamp?: number; encodedDataLength?: number;
      initiator?: Record<string, unknown>; fromCache?: boolean; fromDiskCache?: boolean; fromServiceWorker?: boolean;
      timing?: Record<string, number>; failure?: string; canceled?: boolean;
    })
  | (CaptureIdentity & { kind: 'mse'; executionContextId?: number; metadata: MseMetadata });

/** Immutable source identity; version changes on each observed request/redirect incarnation. */
export interface SourceRequestIdentity {
  runId: string;
  targetId: string;
  sessionId: string;
  frameId: string;
  requestId: string;
  version: number;
}
export function createSourceRequestReference(identity: SourceRequestIdentity): string {
  if (![identity.runId, identity.targetId, identity.sessionId, identity.frameId, identity.requestId].every(value => typeof value === 'string') || !identity.runId || !identity.targetId || !identity.requestId || !Number.isSafeInteger(identity.version) || identity.version < 1) throw new Error('Invalid source request identity');
  return JSON.stringify([identity.runId, identity.targetId, identity.sessionId, identity.frameId, identity.requestId, identity.version]);
}
