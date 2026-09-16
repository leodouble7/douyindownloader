import { z } from 'zod';

const text = z.string().max(16384);
const id = z.string().min(1).max(16384);
const count = z.number().int().nonnegative().safe();
const record = z.record(z.string(), z.unknown());
const ids = z.array(id).max(2000);
const references = z.array(text).max(2000);
const strings = z.array(text).max(100);
const outcome = z.enum(['accessible', 'denied', 'inconclusive', 'encrypted']);
const status = z.enum(['queued', 'running', 'succeeded', 'denied', 'warning', 'failed', 'cancelled']);
const track = z.object({
  id, kind: z.enum(['video', 'audio', 'muxed', 'manifest', 'unknown']), sanitizedUrl: text,
  sourceRequestIds: references, detectionReasons: strings, mimeType: text.optional(), codecs: text.optional(),
  byteLength: count.optional(), durationSeconds: z.number().nonnegative().finite().optional(),
  width: count.optional(), height: count.optional(), bitrate: count.optional(),
  encrypted: z.boolean().optional(), eligible: z.boolean().optional(), incomplete: z.boolean().optional()
}).strict();
const stream = z.object({ kind: z.enum(['video', 'audio']), codec: text, codecTag: text, profile: text,
  level: z.number().finite().optional(), timeBase: text, extradataHash: text, durationSeconds: z.number().nonnegative().finite(), packetCount: count,
  width: count.optional(), height: count.optional(), sampleRate: count.optional(), channels: count.optional() }).strict();
const mediaProbe = z.object({ container: z.enum(['mp4', 'webm']), durationSeconds: z.number().nonnegative().finite(), streams: z.array(stream).max(16) }).strict();
export const reportRunSchema = z.object({
  runId: id, mode: z.enum(['observe', 'standard', 'full-download']), authorizationConfirmed: z.boolean(),
  startedAt: z.iso.datetime({ offset: true }), completedAt: z.iso.datetime({ offset: true }),
  target: z.object({ sanitizedOrigin: text, sanitizedPath: text }).strict(),
  events: z.array(z.object({ id, runId: id, sequence: count, timestamp: z.iso.datetime({ offset: true }),
    phase: z.enum(['browser', 'capture', 'correlate', 'probe', 'download', 'ffmpeg', 'verify', 'report']),
    action: text, purpose: text, status, inputSummary: record.optional(), evidence: record.optional(), conclusion: text.optional(), relatedIds: references
  }).strict()).max(2000),
  requests: z.array(z.object({ id, sanitizedUrl: text, method: text, receivedAt: text,
    status: count.optional(), mimeType: text.optional(), contentLength: count.optional(), contentRange: text.optional(),
    resourceType: text.optional(), sanitizedRequestHeaders: z.record(z.string(), text).optional(), sanitizedResponseHeaders: z.record(z.string(), text).optional()
  }).strict()).max(1000),
  assets: z.array(z.object({ id, title: text.optional(), trackIds: ids, selectedTrackIds: ids, detectionReasons: strings, confidence: z.number().min(0).max(1), encrypted: z.boolean().optional() }).strict()).max(100),
  tracks: z.array(track).max(100),
  probes: z.array(z.object({ id, trackId: id, requestId: text.optional(), name: text, outcome, status: count.optional(),
    bytesReceived: count.optional(), contentRange: text.optional(), durationMs: z.number().nonnegative().finite(),
    inputSummary: record, evidence: record, evidenceEventIds: ids
  }).strict()).max(300),
  downloads: z.array(z.object({ id, trackIds: ids, evidenceEventIds: ids, byteLength: count,
    sha256: z.string().regex(/^[a-f0-9]{64}$/), intervals: z.array(z.object({ start: count, end: count }).strict()).max(1000),
    completed: z.boolean()
  }).strict()).max(100),
  mediaVerifications: z.array(z.object({ id, trackIds: ids, evidenceEventIds: ids, status,
    operation: z.enum(['probe', 'remux']), probe: mediaProbe.optional(),
    inputs: z.array(z.object({ trackId: id, sourceRequestId: text, downloadId: id.optional(), probe: mediaProbe }).strict()).max(2).optional()
  }).strict()).max(100),
  limitations: strings,
  /** Active-memory scan declarations. These are excluded from every persistent projection. */
  rawSecretValues: z.array(z.string().max(16384)).max(1000).optional(),
  rawSecretFingerprints: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(1000).optional()
}).strict();
/** Explicit persistence projection: no DownloadArtifact.path, raw request template, tool log or command field.
 * Callers map existing DTOs to these fields and attach terminal RunEvent IDs. Generic event payloads are
 * defensively allowlisted again on export; they never authorize conclusions by prose alone. */
export type ReportRun = z.infer<typeof reportRunSchema>;
export type ReportProbe = ReportRun['probes'][number];
export class ReportError extends Error {
  readonly outcome = 'inconclusive';
  constructor(readonly code: 'invalid-snapshot' | 'secret-detected' | 'output-limit' | 'publication-failed' | 'cancelled') {
    super(`报告未生成：${code}；测试结果无法据此判定`); this.name = 'ReportError';
  }
}
export function validateRun(run: ReportRun): ReportRun {
  // Bound untyped evidence before Zod clones it, including cyclic/oversized input.
  const seen = new WeakSet<object>(); let items = 0, chars = 0;
  const walk = (value: unknown, depth: number) => {
    if (++items > 150000 || depth > 16) throw new ReportError('output-limit');
    if (typeof value === 'string') { chars += value.length; if (chars > 2000000) throw new ReportError('output-limit'); }
    if (value && typeof value === 'object') {
      if (seen.has(value)) throw new ReportError('invalid-snapshot'); seen.add(value);
      for (const [key, item] of Object.entries(value)) { chars += key.length; if (chars > 2000000) throw new ReportError('output-limit'); walk(item, depth + 1); }
      seen.delete(value);
    }
  };
  walk(run, 0);
  const result = reportRunSchema.safeParse(run);
  if (!result.success) throw new ReportError('invalid-snapshot');
  const r = result.data;
  if (Date.parse(r.completedAt) < Date.parse(r.startedAt) || r.events.some(e => e.runId !== r.runId)) throw new ReportError('invalid-snapshot');
  for (const collection of ['events', 'requests', 'assets', 'tracks', 'probes', 'downloads', 'mediaVerifications'] as const) {
    const unique = new Map<string, { id: string }>();
    for (const item of r[collection]) {
      const prior = unique.get(item.id);
      if (prior && canonical(prior) !== canonical(item)) throw new ReportError('invalid-snapshot');
      unique.set(item.id, item);
    }
    // Each collection retains its own strict element type; the shared ID operation does not change shape.
    Object.assign(r, { [collection]: [...unique.values()] });
  }
  return r;
}

export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return JSON.stringify(value.map(v => JSON.parse(canonical(v))));
  if (value && typeof value === 'object') return JSON.stringify(Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, JSON.parse(canonical(v))])));
  return JSON.stringify(value);
}
