import { createRequire } from 'node:module';
import { createHash, randomUUID, type Hash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import type { DownloadArtifact } from '../../shared/contracts';
import type { RunOrchestrator } from '../runs/run-orchestrator';
import type { DownloadGrant, HttpTransport } from '../probes/http-transport';
import { normalizedHeaders, type OpenResponse } from '../probes/http-request';
import { recognizableMedia } from '../probes/media-bytes';
import { createRangePlan } from './range-plan';
import { OutputWorkspace, getOutputRoot, type OutputWorkerLauncher, type FileIdentity } from './output-workspace';
import { StreamingEncryptionClassifier } from './streaming-encryption';

const { safeFilename } = createRequire(import.meta.url)('./output-names.cjs') as { safeFilename(value?: string): string };

interface DownloaderOptions {
  context: RunOrchestrator;
  runId: string;
  transport: HttpTransport;
  maxBytes?: number;
  maxChunkBytes?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  outputWorkerLauncher?: OutputWorkerLauncher;
  outputWorkerModulePath?: string;
}
export interface DownloadInput { sourceRequestId: string; filename?: string; resumeId?: string }
export class DownloadError extends Error {
  constructor(readonly code: string, readonly outcome: 'inconclusive' | 'denied' = 'inconclusive', readonly resumeId?: string) {
    super(outcome === 'denied' ? 'Server denied the download request' : `Download incomplete: ${code}; access control is inconclusive`);
    this.name = 'DownloadError';
  }
}
const interval = z.object({ start: z.literal(0), end: z.number().int().nonnegative().safe() }).strict();
const manifestSchema = z.object({
  durability: z.enum(['directory-flush', 'write-through-file-flush']).optional(),
  version: z.literal(2), sourceRequestId: z.string().max(4096), sanitizedUrl: z.string().max(16384),
  totalBytes: z.number().int().positive().safe(), completed: z.array(interval).max(1),
  etagSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), lastModifiedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  prefixSha256: z.string().regex(/^[a-f0-9]{64}$/), filename: z.string().max(120), state: z.enum(['partial', 'publishing', 'complete']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  fileIdentity: z.object({ dev: z.string(), ino: z.string(), size: z.number().int().nonnegative().safe(), nlink: z.number().int().positive(), isFile: z.literal(true) }).strict().optional()
}).strict();
type Manifest = z.infer<typeof manifestSchema>;
const activeDirectories = new Set<string>();

/** One ordered streaming writer per artifact. Run concurrency remains bounded and visible. */
export class Downloader {
  constructor(private readonly options: DownloaderOptions) {}

  async download(input: DownloadInput, signal: AbortSignal): Promise<DownloadArtifact> {
    const { context, runId, transport } = this.options;
    if (!context.isActive(runId)) throw new DownloadError('fresh-capture-required');
    const combined = AbortSignal.any([signal, context.getAbortSignal(runId)]);
    const settings = context.getDownloadSettings(runId);
    const terminalEmitter = context.retainTerminalEmitter(runId);
    const maxConcurrency = bounded(settings.maxConcurrency, 4, 1, 4);
    const id = input.resumeId ?? randomUUID();
    let terminal = false, completed = 0, publishing = false, committed = false;
    let lastProgressAt = -Infinity;
    const audit = (stage: 'queued' | 'before' | 'receiving' | 'progress' | 'after' | 'failed' | 'cancelled', code?: string, denied = false, details: Record<string, unknown> = {}) => {
      if (terminal) return;
      const isTerminal = ['after', 'failed', 'cancelled'].includes(stage);
      if (!isTerminal && !context.isActive(runId)) return;
      const event = { phase: 'download' as const, action: `download:${stage}`, purpose: 'Retrieve an authorized media track with continuous byte coverage and integrity checks',
        status: stage === 'queued' ? 'queued' as const : stage === 'after' ? 'succeeded' as const : stage === 'cancelled' ? 'cancelled' as const : stage === 'failed' ? denied ? 'denied' as const : 'failed' as const : 'running' as const,
        inputSummary: { sourceRequestId: input.sourceRequestId, maxConcurrency, activeWorkers: 1 }, evidence: { completedBytes: completed, code, ...details },
        conclusion: stage === 'after' ? 'Complete ordered track bytes verified by length and SHA-256' : stage === 'failed' || stage === 'cancelled' ? denied ? 'Server explicitly denied retrieval' : 'Download incomplete; access control is inconclusive' : undefined,
        relatedIds: [id] };
      if (isTerminal) { terminal = true; terminalEmitter(event); } else context.emit({ ...event, runId });
    };
    audit('queued'); audit('before');
    const onAbort = () => { if (!publishing && !committed) { audit('cancelled', 'cancelled'); workspace?.interrupt(); } };
    combined.addEventListener('abort', onAbort, { once: true });
    let workspace: OutputWorkspace | undefined;
    let lock: string | undefined;
    try {
      combined.throwIfAborted();
      let grant: DownloadGrant;
      try { grant = transport.authorizeDownload(context, runId, input.sourceRequestId); }
      catch (error) { throw new DownloadError(knownGate(error)); }
      const total = grant.totalBytes;
      const maxBytes = this.options.maxBytes ?? 4 * 1024 ** 3;
      if (!Number.isSafeInteger(total) || total! <= 0) throw new DownloadError('unknown-total');
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || total! > maxBytes) throw new DownloadError('limit');
      const chunkBytes = this.options.maxChunkBytes ?? total!;
      createRangePlan(total!, chunkBytes);
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new DownloadError('invalid-resume-id');
      const root = await getOutputRoot(context, runId);
      const key = `${root.dev}:${root.ino}:${id}`;
      if (activeDirectories.has(key)) throw new DownloadError('artifact-busy');
      activeDirectories.add(key); lock = key;
      workspace = await OutputWorkspace.create(root, id, Boolean(input.resumeId), this.options.outputWorkerLauncher, this.options.outputWorkerModulePath);
      combined.throwIfAborted();
      let hash = createHash('sha256');
      let detector = new StreamingEncryptionClassifier();
      const validators = validatorDigests(grant);
      let manifest: Manifest = { version: 2, sourceRequestId: input.sourceRequestId, sanitizedUrl: grant.track.sanitizedUrl, totalBytes: total!, completed: [],
        ...validators, durability: await workspace.durability(), prefixSha256: hash.copy().digest('hex'), filename: safeFilename(input.filename), state: 'partial' };
      let recoveredFinal = false;
      if (input.resumeId) {
        manifest = manifestSchema.parse(await workspace.readManifest());
        if (manifest.filename !== safeFilename(manifest.filename) || manifest.sourceRequestId !== input.sourceRequestId || manifest.sanitizedUrl !== grant.track.sanitizedUrl || manifest.totalBytes !== total || manifest.etagSha256 !== validators.etagSha256 || manifest.lastModifiedSha256 !== validators.lastModifiedSha256) throw new DownloadError('stale');
        completed = manifest.completed[0] ? manifest.completed[0].end + 1 : 0;
        if (completed > total! || (completed > 0 && !ifRangeValue(grant))) throw new DownloadError('invalid-resume');
        const final = await workspace.statEntry(manifest.filename);
        const part = await workspace.statEntry('track.part');
        if (final) {
          if (manifest.state === 'partial' || !manifest.fileIdentity || !manifest.sha256 || !sameFile(final, manifest.fileIdentity) || final.size !== total || completed !== total || (part && !sameFile(part, final))) throw new DownloadError('unrelated-final');
          const opened = await workspace.openFile(manifest.filename);
          if (!sameFile(opened, manifest.fileIdentity) || !sameFile(opened, final)) throw new DownloadError('recovery-identity-changed');
          recoveredFinal = true;
        } else {
          if (manifest.state === 'complete' || !part || part.nlink !== 1) throw new DownloadError('invalid-resume');
          const opened = await workspace.openFile('track.part');
          if (!sameFile(opened, part) || (manifest.fileIdentity && !sameFile(opened, manifest.fileIdentity))) throw new DownloadError('recovery-identity-changed');
        }
        const existing = await workspace.stat();
        if (!existing.isFile || existing.size < completed || existing.nlink > (recoveredFinal ? 2 : 1)) throw new DownloadError('invalid-resume');
        if (!recoveredFinal) await workspace.truncate(completed);
        hash = await hashPrefix(workspace, completed, combined, detector);
        if (hash.copy().digest('hex') !== manifest.prefixSha256 || detector.encrypted) throw new DownloadError('partial-integrity');
      } else {
        await workspace.openFile('track.part', true);
        await workspace.saveManifest(manifest);
      }
      if (BigInt(total! - completed) > await workspace.freeBytes()) throw new DownloadError('insufficient-space');
      const retries = bounded(this.options.maxRetries, 2, 0, 3);
      while (completed < total!) {
        combined.throwIfAborted();
        const start = completed, end = start + Math.min(chunkBytes, total! - start) - 1;
        let next: { end: number; hash: Hash; detector: StreamingEncryptionClassifier };
        for (let attempt = 0; ; attempt++) {
          try { next = await this.receive(grant, start, end, workspace, hash, detector, combined, receivedBytes => {
            const now = performance.now();
            if (now - lastProgressAt < 200) return;
            lastProgressAt = now;
            // Received bytes are display progress; completedBytes continues to mean durable verified coverage.
            audit('receiving', undefined, false, { receivedBytes, totalBytes: total });
          }); break; }
          catch (error) {
            await workspace.truncate(completed);
            if (combined.aborted || attempt >= retries || !retryable(error)) throw error;
            await wait(bounded(this.options.retryDelayMs, 100, 1, 1000) * 2 ** attempt, undefined, { signal: combined });
          }
        }
        completed = next.end + 1; hash = next.hash; detector = next.detector;
        manifest.completed = [{ start: 0, end: completed - 1 }]; manifest.prefixSha256 = hash.copy().digest('hex');
        await workspace.sync(); await workspace.saveManifest(manifest);
        audit('progress', undefined, false, { interval: { start, end: completed - 1 }, totalBytes: total });
        combined.throwIfAborted();
        if (completed < total! && !ifRangeValue(grant)) throw new DownloadError('validator-required');
      }
      const identity = await workspace.stat();
      if (identity.size !== total || identity.nlink > (recoveredFinal ? 2 : 1)) throw new DownloadError('length-or-identity-mismatch');
      const finalDetector = new StreamingEncryptionClassifier();
      const finalHash = (await hashPrefix(workspace, total!, combined, finalDetector)).digest('hex');
      finalDetector.finish();
      if (finalDetector.encrypted || finalHash !== hash.digest('hex') || (recoveredFinal && finalHash !== manifest.sha256)) throw new DownloadError('integrity-mismatch');
      await workspace.sync();
      manifest = { ...manifest, state: 'publishing', sha256: finalHash, fileIdentity: { ...identity, isFile: true } };
      if (!recoveredFinal) await workspace.saveManifest(manifest);
      await workspace.closeFile();
      combined.throwIfAborted();
      const markCommitted = () => { committed = true; combined.removeEventListener('abort', onAbort); };
      if (!recoveredFinal) {
        publishing = true;
        await workspace.publish(manifest.filename, identity, combined, markCommitted);
      } else markCommitted();
      // Once final visibility commits, cancellation cannot retroactively turn success into cancellation.
      // Cleanup is idempotent, and the complete receipt remains durable for restart recovery.
      manifest.state = 'complete'; await workspace.saveManifest(manifest);
      await workspace.removePart(identity);
      await workspace.cleanupManifest();
      const path = join(await workspace.path(), manifest.filename);
      const artifact: DownloadArtifact = { id, runId, trackIds: [grant.track.id], path, byteLength: total!, sha256: finalHash, mimeType: grant.track.mimeType, completedAt: new Date().toISOString() };
      audit('after', undefined, false, { sha256: finalHash, totalBytes: total });
      return artifact;
    } catch (error) {
      const cancelled = combined.aborted && !committed;
      const code = cancelled ? 'cancelled' : error instanceof DownloadError ? error.code : committed ? 'publication-recovery-required' : workspaceFailure(error);
      const outcome = error instanceof DownloadError ? error.outcome : 'inconclusive';
      audit(cancelled ? 'cancelled' : 'failed', code, outcome === 'denied');
      throw new DownloadError(code, outcome, lock ? id : undefined);
    } finally {
      combined.removeEventListener('abort', onAbort);
      // Durable artifact cleanup already finished; actor teardown must not replace its outcome.
      try { await workspace?.dispose(); } catch { workspace?.interrupt(); }
      if (lock) activeDirectories.delete(lock);
    }
  }

  private async receive(grant: DownloadGrant, start: number, end: number, file: OutputWorkspace, hash: Hash, detector: StreamingEncryptionClassifier, signal: AbortSignal, onReceived: (bytes: number) => void): Promise<{ end: number; hash: Hash; detector: StreamingEncryptionClassifier }> {
    const { context, runId, transport } = this.options;
    let opened: OpenResponse | undefined;
    try {
      opened = await transport.openDownloadRange(context, runId, grant.sourceRequestId, `bytes=${start}-${end}`, ifRangeValue(grant), signal);
      const response = opened.response;
      const headers = normalizedHeaders(response);
      if (response.statusCode === 401 || response.statusCode === 403) throw new DownloadError('http-denied', 'denied');
      if (response.statusCode === 412 || headers.etag !== grant.etag || headers['last-modified'] !== grant.lastModified) throw new DownloadError('stale');
      if (response.statusCode !== 206) throw new DownloadError('range-ignored-or-invalid');
      if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') throw new DownloadError('encoded-response');
      if (Object.entries(headers).some(([name, value]) => /encrypted|drm|content-protection/i.test(name) && value !== 'false')) throw new DownloadError('encrypted');
      const range = headers['content-range']?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (!range) throw new DownloadError('invalid-range');
      const [actualStart, actualEnd, total] = range.slice(1).map(Number);
      if (![actualStart, actualEnd, total].every(Number.isSafeInteger) || actualStart !== start || actualEnd < start || actualEnd > end || actualEnd >= total || total !== grant.totalBytes) throw new DownloadError('invalid-range');
      const expected = actualEnd - start + 1;
      if (headers['content-length'] !== undefined && (!/^\d+$/.test(headers['content-length']) || Number(headers['content-length']) !== expected)) throw new DownloadError('length-mismatch');
      let received = 0; let prefix = Buffer.alloc(0);
      const nextDetector = detector.copy();
      const nextHash = hash.copy();
      for await (const data of response) {
        signal.throwIfAborted();
        const chunk = Buffer.from(data);
        opened.progress(chunk.length);
        if (chunk.length > expected - received) throw new DownloadError('length-mismatch');
        if (start === 0 && prefix.length < 4096) prefix = Buffer.concat([prefix, chunk.subarray(0, 4096 - prefix.length)]);
        nextDetector.push(chunk);
        if (nextDetector.encrypted) throw new DownloadError('encrypted');
        await file.write(chunk, start + received);
        nextHash.update(chunk); received += chunk.length; onReceived(start + received);
      }
      signal.throwIfAborted();
      if (!response.complete || received !== expected) throw new DownloadError('premature-eof');
      if (start === 0 && !recognizableMedia(prefix)) throw new DownloadError('unrecognized-media');
      return { end: actualEnd, hash: nextHash, detector: nextDetector };
    } finally { opened?.close(); }
  }
}
function validatorDigests(grant: DownloadGrant) {
  return { etagSha256: grant.etag === undefined ? undefined : createHash('sha256').update(grant.etag).digest('hex'),
    lastModifiedSha256: grant.lastModified === undefined ? undefined : createHash('sha256').update(grant.lastModified).digest('hex') };
}
function ifRangeValue(grant: DownloadGrant): string | undefined {
  if (grant.etag && /^"[^"\r\n]*"$/.test(grant.etag)) return grant.etag;
  if (grant.lastModified && new Date(grant.lastModified).toUTCString() === grant.lastModified) return grant.lastModified;
  return undefined;
}
async function hashPrefix(file: OutputWorkspace, length: number, signal: AbortSignal, detector: StreamingEncryptionClassifier): Promise<Hash> {
  const hash = createHash('sha256');
  for (let position = 0; position < length;) {
    signal.throwIfAborted();
    const buffer = await file.read(position, Math.min(65536, length - position));
    if (!buffer.length) throw new DownloadError('premature-eof');
    hash.update(buffer); detector.push(buffer); position += buffer.length;
  }
  signal.throwIfAborted(); return hash;
}
function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.isFile && right.isFile && left.dev === right.dev && left.ino === right.ino && left.nlink >= 1 && left.nlink <= 2;
}
function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value!))) : fallback;
}
function knownGate(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  return ['fresh-capture-required', 'unauthorized', 'ineligible', 'bounded-evidence-required'].includes(code) ? code : 'ineligible';
}
function retryable(error: unknown): boolean {
  return !(error instanceof DownloadError) && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ERR_STREAM_PREMATURE_CLOSE)$/.test((error as NodeJS.ErrnoException).code ?? '');
}

function workspaceFailure(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  return ['anchored-workspace-unsupported', 'output-worker-launcher-required', 'directory-durability-unsupported', 'output-root-substituted', 'output-directory-substituted', 'output-worker-unavailable'].includes(code) ? code : 'local-or-network-failure';
}
