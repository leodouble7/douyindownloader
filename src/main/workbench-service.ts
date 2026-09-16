import { randomUUID, createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { createReadStream } from 'node:fs';
import type { CaptureObservation, DownloadArtifact, ExportReportInput, MediaAsset, MediaTrack, PreviewBounds, RunEvent, StartDownloadInput, StartRunInput, WorkbenchSnapshot, RunHistoryItem } from '../shared/contracts';
import { startRunInputSchema } from '../shared/schemas';
import { EventRepository } from './runs/event-repository';
import { RunOrchestrator, type EmitRunEventInput, type EphemeralRequest } from './runs/run-orchestrator';
import { MediaCorrelator } from './media/media-correlator';
import { HttpTransport } from './probes/http-transport';
import { ProbeRunner } from './probes/probe-runner';
import { planProbes } from './probes/probe-planner';
import type { NetworkPolicy } from './probes/address-policy';
import { Downloader } from './download/downloader';
import { getOutputRoot, type OutputWorkerLauncher } from './download/output-workspace';
import { createMediaAdapter, type MediaProbe } from './media/ffmpeg-adapter';
import { generateReports, verifyReportBundle, type ReportBundle, type ReportRun } from './reports/report-generator';
import { buildFindings } from './reports/finding-engine';
import { alias, projectEvent } from './ui-projection';
import { assertAuthorizedDirectory, assertOutputPath, authorizeDirectory, CommandError, type DirectoryGrant } from './ipc';
export interface BrowserPort { open(run: { runId: string; targetUrl: string; authorizationConfirmed: boolean; signal: AbortSignal }): Promise<unknown>; close(runId: string): Promise<void>; setBounds(runId: string, bounds: PreviewBounds | null): void }
export type BrowserFactory = (hooks: { emit(event: EmitRunEventInput): unknown; observe(observation: CaptureObservation): void; rememberRequest(runId: string, request: EphemeralRequest): void }) => BrowserPort;
interface Options { repository: EventRepository; browserFactory: BrowserFactory; onEvent(event: RunEvent): void; observationMs?: number; networkPolicy?: NetworkPolicy; outputWorkerLauncher?: OutputWorkerLauncher; outputWorkerModulePath?: string }
interface Session { snapshot: WorkbenchSnapshot; assets: MediaAsset[]; correlator: MediaCorrelator; transports: Map<string, HttpTransport>; reportProbes: ReportRun['probes']; downloads: DownloadArtifact[]; mediaVerifications: ReportRun['mediaVerifications']; bundle?: ReportBundle; grant: DirectoryGrant; timer?: ReturnType<typeof setTimeout>; work?: Promise<void>; terminal: (event: Omit<EmitRunEventInput, 'runId'>) => RunEvent; persistedRequests: Set<string>; hadFailure: boolean; }
const terminalStatuses = new Set(['completed', 'partial', 'cancelled', 'interrupted']);
/** Application coordinator; all raw replay templates and report capabilities stay in this process. */
export class WorkbenchService {
  readonly context: RunOrchestrator;
  private readonly browser: BrowserPort;
  private readonly sessions = new Map<string, Session>();
  private readonly historicalIds: Set<string>;
  private readonly grants: DirectoryGrant[] = [];
  private selected?: DirectoryGrant;
  private disposed = false;
  constructor(private readonly options: Options) {
    this.historicalIds = new Set(options.repository.listHistory().map(s => s.runId));
    this.context = new RunOrchestrator(options.repository, event => options.onEvent(projectEvent(event)));
    this.browser = options.browserFactory({ emit: input => this.emit(input), observe: observation => this.observe(observation), rememberRequest: (runId, request) => { if (this.context.isActive(runId)) this.context.rememberRequest(runId, request); } });
  }
  ownsRun(runId: string): boolean { return this.sessions.has(runId) || this.historicalIds.has(runId); }
  async selectDirectory(path: string): Promise<string> { const grant = await authorizeDirectory(path); this.grants.push(grant); this.selected = grant; return grant.path; }
  async start(input: StartRunInput): Promise<{ runId: string }> {
    const checked = startRunInputSchema.safeParse(input); if (!checked.success) throw new CommandError('INVALID_INPUT');
    if (this.disposed || [...this.sessions.values()].some(s => !terminalStatuses.has(s.snapshot.status))) throw new CommandError('BUSY');
    if (!this.selected) throw new CommandError('OUTPUT_NOT_AUTHORIZED'); await assertAuthorizedDirectory(this.selected, input.outputDirectory);
    const runId = randomUUID(), startedAt = new Date().toISOString();
    this.context.start(input, runId);
    const snapshot: WorkbenchSnapshot = { runId, status: 'observing', mode: input.mode, targetLabel: new URL(input.targetUrl).hostname, startedAt, events: [], assets: [], tracks: [], probes: [], findings: [], artifacts: [], report: { status: 'unavailable', files: [] } };
    const state: Session = { snapshot, assets: [], correlator: new MediaCorrelator(), transports: new Map(), reportProbes: [], downloads: [], mediaVerifications: [], grant: this.selected, terminal: this.context.retainTerminalEmitter(runId), persistedRequests: new Set(), hadFailure: false };
    this.sessions.set(runId, state); this.save(state);
    this.launch(state, async () => {
      await getOutputRoot(this.context, runId);
      await this.browser.open({ runId, targetUrl: input.targetUrl, authorizationConfirmed: true, signal: this.context.getAbortSignal(runId) });
      if (this.context.isActive(runId)) state.timer = setTimeout(() => { void this.finishObservation(runId).catch(() => undefined); }, Math.min(60000, this.options.observationMs ?? 15000));
    });
    return { runId };
  }
  private emit(input: EmitRunEventInput): RunEvent | undefined {
    const state = this.sessions.get(input.runId);
    if (state && input.status === 'failed') state.hadFailure = true;
    if (this.context.isActive(input.runId)) return this.context.emit(input);
    if (state && !['running', 'queued'].includes(input.status)) return state.terminal(input);
  }
  private observe(observation: CaptureObservation): void {
    const s = this.sessions.get(observation.runId); if (!s || !this.context.isActive(observation.runId) || s.snapshot.status !== 'observing') return;
    // Capture owns lifecycle audit. Persist only each terminal incarnation, never replay it through captureRequest.
    if (observation.kind === 'network' && ['finished', 'failed', 'redirect'].includes(observation.stage) && !s.persistedRequests.has(observation.request.id)) {
      const { sourceIdentity: _identity, sessionId: _session, ...request } = observation.request;
      this.options.repository.persistCapturedRequest({ ...request, sanitizedUrl: request.sanitizedUrl as MediaTrack['sanitizedUrl'] }); s.persistedRequests.add(request.id);
    }
    s.assets = s.correlator.ingest(observation).slice(0, 24);
    s.snapshot.assets = s.assets.map(a => ({ id: a.id, trackIds: a.trackIds, selectedTrackIds: a.selectedTrackIds, confidence: a.confidence, encrypted: a.encrypted }));
    s.snapshot.tracks = s.assets.flatMap(a => a.tracks).map(t => ({ id: t.id, assetId: t.assetId, kind: t.kind, mimeType: /^(audio|video|application)\/[a-z0-9.+-]+$/.test(t.mimeType ?? '') ? t.mimeType : undefined, byteLength: t.byteLength, durationSeconds: t.durationSeconds, encrypted: t.encrypted, eligible: t.eligible, incomplete: t.incomplete }));
    this.save(s);
  }
  private save(s: Session): void { this.options.repository.saveSnapshot(s.snapshot); }
  private status(s: Session, status: WorkbenchSnapshot['status']): void { s.snapshot.status = status; this.save(s); this.emit({ runId: s.snapshot.runId, phase: status === 'reporting' ? 'report' : 'correlate', action: 'state:after', purpose: '更新运行阶段', status: 'succeeded', relatedIds: [] }); }
  private require(runId: string): Session { const s = this.sessions.get(runId); if (!s) throw new CommandError('NOT_FOUND'); return s; }
  private launch(s: Session, task: () => Promise<void>): void {
    if (s.work) throw new CommandError('BUSY');
    const work = Promise.resolve().then(task).catch(() => {
      if (s.snapshot.status === 'cancelled' || this.disposed) return;
      s.hadFailure = true;
      this.emit({ runId: s.snapshot.runId, phase: 'report', action: 'workbench:failed', purpose: '记录执行异常', status: 'failed', conclusion: '工具执行异常，不能据此证明防护有效', relatedIds: [] });
      s.snapshot.status = 'partial'; s.snapshot.completedAt = new Date().toISOString(); this.save(s);
      void this.browser.close(s.snapshot.runId).catch(() => undefined);
      if (this.context.isActive(s.snapshot.runId)) this.context.complete(s.snapshot.runId);
    }).finally(() => { if (s.work === work) s.work = undefined; });
    s.work = work;
  }
  async waitForIdle(runId: string): Promise<void> { await this.require(runId).work; }
  async finishObservation(runId: string): Promise<void> {
    const s = this.require(runId); if (s.snapshot.status !== 'observing') return; if (s.work) throw new CommandError('BUSY'); clearTimeout(s.timer);
    this.launch(s, async () => {
      await this.browser.close(runId); if (!this.context.isActive(runId)) return;
      this.status(s, 'probing');
      if (s.snapshot.mode !== 'observe') {
        for (const track of s.assets.flatMap(a => a.tracks).filter(t => t.eligible !== false).slice(0, 24)) {
          if (!this.context.isActive(runId)) return;
          const transport = new HttpTransport({ context: this.context, runId, track, networkPolicy: this.options.networkPolicy }); s.transports.set(track.id, transport);
          const runner = new ProbeRunner({ context: this.context, runId, transport });
          for await (const p of runner.run(track, planProbes(track, s.snapshot.mode).filter(p => p.id !== 'range-full'), this.context.getAbortSignal(runId))) {
            const events = this.options.repository.list(runId); const eventIds = events.filter(e => e.relatedIds.includes(p.id) && !['running', 'queued'].includes(e.status)).map(e => e.id);
            s.reportProbes.push({ id: p.id, trackId: p.trackId, requestId: p.requestId, name: p.name, outcome: p.outcome, status: p.status, bytesReceived: p.bytesReceived, contentRange: p.contentRange, durationMs: p.durationMs, inputSummary: p.inputSummary, evidence: p.evidence, evidenceEventIds: eventIds });
            s.snapshot.probes.push({ id: p.id, trackId: p.trackId, name: p.name, outcome: p.outcome, status: p.status, bytesReceived: p.bytesReceived, eventIds }); this.save(s);
          }
        }
      }
      if (!this.context.isActive(runId)) return;
      if (s.snapshot.mode === 'full-download') { this.status(s, 'ready'); s.snapshot.findings = buildFindings(this.reportInput(s)); this.save(s); }
      else await this.publish(s);
    });
  }
  async finish(runId: string): Promise<void> { const s = this.require(runId); if (s.snapshot.status === 'observing') return this.finishObservation(runId); if (s.snapshot.status !== 'ready') throw new CommandError('BUSY'); this.launch(s, () => this.publish(s)); }
  async download(input: StartDownloadInput): Promise<{ downloadId: string }> {
    const s = this.require(input.runId); if (s.snapshot.mode !== 'full-download' || s.snapshot.status !== 'ready') throw new CommandError('FORBIDDEN'); if (s.work) throw new CommandError('BUSY');
    const ids = [...new Set(input.trackIds)]; const tracks = ids.map(id => s.assets.flatMap(a => a.tracks).find(t => t.id === id));
    if (!ids.length || ids.length > 2 || tracks.some(t => !t || t.encrypted || t.eligible === false || t.kind === 'manifest') || !s.assets.some(a => ids.every(id => a.trackIds.includes(id)))) throw new CommandError('INVALID_INPUT');
    for (const track of tracks as MediaTrack[]) { const transport = s.transports.get(track.id); if (!transport || !track.sourceRequestIds.some(id => { try { transport.authorizeDownload(this.context, input.runId, id); return true; } catch { return false; } })) throw new CommandError('FORBIDDEN'); }
    await assertAuthorizedDirectory(s.grant, s.grant.path); const downloadId = randomUUID(); this.status(s, 'downloading');
    this.launch(s, async () => {
      const signal = this.context.getAbortSignal(input.runId); const downloaded: { track: MediaTrack; artifact: DownloadArtifact; probe: MediaProbe; sourceRequestId: string }[] = [];
      const media = createMediaAdapter({ onEvent: event => this.emit({ ...event, runId: input.runId }) });
      for (const track of tracks as MediaTrack[]) {
        signal.throwIfAborted(); await assertAuthorizedDirectory(s.grant, s.grant.path);
        const transport = s.transports.get(track.id)!;
        const sourceRequestId = track.sourceRequestIds.find(id => { try { transport.authorizeDownload(this.context, input.runId, id); return true; } catch { return false; } })!;
        try {
          const artifact = await new Downloader({ context: this.context, runId: input.runId, transport, outputWorkerLauncher: this.options.outputWorkerLauncher, outputWorkerModulePath: this.options.outputWorkerModulePath }).download({ sourceRequestId, filename: `${track.kind}.${track.mimeType?.includes('webm') ? 'webm' : 'mp4'}` }, signal);
          await assertOutputPath(s.grant, artifact.path); s.downloads.push(artifact); s.snapshot.artifacts.push({ id: artifact.id, trackIds: artifact.trackIds, byteLength: artifact.byteLength, sha256: artifact.sha256, verification: 'unverified', operation: 'download' }); this.save(s);
          const probe = await media.probeMedia(artifact.path, signal); s.snapshot.artifacts.at(-1)!.verification = 'verified'; downloaded.push({ track, artifact, probe, sourceRequestId }); this.save(s);
        } catch { if (signal.aborted) return; s.hadFailure = true; this.emit({ runId: input.runId, phase: 'download', action: 'track-retrieval:failed', purpose: '完整下载并验证轨道', status: 'failed', relatedIds: [track.id] }); }
      }
      const video = downloaded.find(d => d.track.kind === 'video'), audio = downloaded.find(d => d.track.kind === 'audio');
      if (video && audio) {
        try {
          await assertOutputPath(s.grant, video.artifact.path); await assertOutputPath(s.grant, audio.artifact.path);
          const id = randomUUID(), output = join(dirname(video.artifact.path), `remux-${id}.${video.probe.container}`), inputs = [video, audio].map(d => ({ trackId: d.track.id, sourceRequestId: d.sourceRequestId, downloadId: d.artifact.id, probe: d.probe }));
          // Attach the exact verification lineage to the adapter's terminal event.
          let finalEvent: RunEvent | undefined;
          const adapter = createMediaAdapter({ onEvent: event => { finalEvent = this.emit({ ...event, runId: input.runId, relatedIds: [id, video.track.id, audio.track.id, video.artifact.id, audio.artifact.id], inputSummary: event.action === 'remux:result' ? { inputs } : event.inputSummary }); } });
          const result = await adapter.remuxTracks(video.artifact.path, audio.artifact.path, output, signal); await assertOutputPath(s.grant, result.outputPath);
          if (finalEvent) s.mediaVerifications.push({ id, operation: 'remux', status: 'succeeded', trackIds: [video.track.id, audio.track.id], evidenceEventIds: [finalEvent.id], probe: result.probe, inputs });
          const hash = createHash('sha256'); let length = 0; for await (const chunk of createReadStream(result.outputPath, { signal })) { length += chunk.length; hash.update(chunk); }
          s.snapshot.artifacts.push({ id, trackIds: [video.track.id, audio.track.id], byteLength: length, sha256: hash.digest('hex'), verification: 'verified', operation: 'remux' });
        } catch { if (signal.aborted) return; s.hadFailure = true; }
      }
      if (!signal.aborted) await this.publish(s);
    });
    return { downloadId };
  }
  private reportInput(s: Session): ReportRun {
    const runId = s.snapshot.runId, events = this.options.repository.list(runId), tracks = s.assets.flatMap(a => a.tracks);
    const requests = this.options.repository.listCapturedRequests(runId).map(r => ({ id: r.id, sanitizedUrl: r.sanitizedUrl, method: r.method, receivedAt: r.receivedAt, status: r.status, mimeType: r.mimeType, contentLength: r.contentLength, contentRange: r.contentRange, resourceType: r.resourceType, sanitizedRequestHeaders: r.sanitizedRequestHeaders, sanitizedResponseHeaders: r.sanitizedResponseHeaders }));
    const secretValues = new Set<string>(); if (this.context.isActive(runId)) for (const t of tracks) for (const id of t.sourceRequestIds) { const raw = this.context.resolveRequest(runId, id); if (raw) { for (const v of new URL(raw.url).searchParams.values()) if (v.length >= 8) secretValues.add(v); for (const [k,v] of Object.entries(raw.requestHeaders ?? {})) if (/cookie|authorization/i.test(k) && v.length >= 8) secretValues.add(v); } }
    return { runId, mode: s.snapshot.mode, authorizationConfirmed: true, startedAt: s.snapshot.startedAt, completedAt: new Date().toISOString(), target: { sanitizedOrigin: `https://${s.snapshot.targetLabel}`, sanitizedPath: '/' }, events: events.slice(-2000), requests: requests.slice(0, 1000), assets: s.assets.map(a => ({ id: a.id, trackIds: a.trackIds, selectedTrackIds: a.selectedTrackIds, detectionReasons: a.detectionReasons, confidence: a.confidence, encrypted: a.encrypted })), tracks: tracks.map(({ assetId: _asset, confidence: _confidence, ...t }) => t), probes: s.reportProbes.slice(0, 300), downloads: s.downloads.map(d => ({ id: d.id, trackIds: d.trackIds, byteLength: d.byteLength, sha256: d.sha256, completed: true, intervals: [{ start: 0, end: d.byteLength - 1 }], evidenceEventIds: events.filter(e => e.action === 'download:after' && e.relatedIds.includes(d.id)).map(e => e.id) })), mediaVerifications: s.mediaVerifications, limitations: s.hadFailure ? ['部分工具或捕获操作未完成，结论受限'] : [], rawSecretValues: [...secretValues].slice(0, 1000) };
  }
  private async publish(s: Session): Promise<void> {
    const runId = s.snapshot.runId; if (!this.context.isActive(runId)) return; this.status(s, 'reporting'); await assertAuthorizedDirectory(s.grant, s.grant.path);
    const input = this.reportInput(s); const bundle = await generateReports(input, { directory: s.grant.path, signal: this.context.getAbortSignal(runId) });
    s.bundle = bundle; await assertOutputPath(s.grant, bundle.jsonPath); await assertOutputPath(s.grant, bundle.markdownPath); await verifyReportBundle(bundle);
    s.snapshot.findings = buildFindings(input); s.snapshot.status = s.hadFailure ? 'partial' : 'completed'; s.snapshot.completedAt = new Date().toISOString(); this.save(s); this.context.complete(runId); s.transports.clear();
  }
  async get(runId: string): Promise<WorkbenchSnapshot> {
    if (!this.ownsRun(runId)) throw new CommandError('NOT_FOUND'); const s = this.sessions.get(runId), stored = s?.snapshot ?? this.options.repository.readSnapshot(runId); if (!stored) throw new CommandError('NOT_FOUND');
    const snapshot = structuredClone(stored); snapshot.events = this.options.repository.list(runId).map(projectEvent); snapshot.report = { status: 'unavailable', files: [] };
    if (s?.bundle) { try { await assertOutputPath(s.grant, s.bundle.jsonPath); await assertOutputPath(s.grant, s.bundle.markdownPath); const contents = await verifyReportBundle(s.bundle); snapshot.report = { status: 'verified', ...contents, files: [basename(s.bundle.markdownPath), basename(s.bundle.jsonPath)] }; } catch { /* A failed trust check exposes no report contents. */ } }
    return snapshot;
  }
  history(): RunHistoryItem[] { return this.options.repository.listHistory().filter(s => this.ownsRun(s.runId)); }
  preview(runId: string, bounds: PreviewBounds | null): void { const s = this.require(runId); this.browser.setBounds(runId, s.snapshot.status === 'observing' ? bounds : null); }
  async export(input: ExportReportInput): Promise<{ path: string; content: string }> {
    const s = this.require(input.runId); if (!s.bundle) throw new CommandError('REPORT_UNAVAILABLE'); await assertAuthorizedDirectory(s.grant, input.outputDirectory);
    const path = input.format === 'json' ? s.bundle.jsonPath : s.bundle.markdownPath; await assertOutputPath(s.grant, path); const content = await verifyReportBundle(s.bundle); return { path, content: input.format === 'json' ? content.json : content.markdown };
  }
  async cancel(runId: string): Promise<void> {
    const s = this.require(runId); if (terminalStatuses.has(s.snapshot.status)) return; clearTimeout(s.timer); s.snapshot.status = 'cancelled'; s.snapshot.completedAt = new Date().toISOString(); this.save(s);
    if (this.context.isActive(runId)) this.context.cancel(runId); await this.browser.close(runId); await s.work; s.transports.clear();
  }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; for (const s of this.sessions.values()) { clearTimeout(s.timer); await this.cancel(s.snapshot.runId).catch(() => undefined); } this.context.dispose(); for (const grant of this.grants) await grant.handle.close().catch(() => undefined); }
}
