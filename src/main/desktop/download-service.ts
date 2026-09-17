import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import type { DownloadArchiveMetadata, DownloadHistoryPage, DownloadMode, DownloadQueueItem, DownloadSelection, DownloadSelectionRequest, DownloadSnapshot, DownloadStartRequest, TrackProgress } from '../../shared/desktop';
import type { DownloadHistory } from './download-history';
import { resolveWorkId } from '../douyin/target-work';
import type { MediaTrack, RunEvent } from '../../shared/contracts';
import type { CaptureInput, CaptureResult } from '../douyin/capture-page';
import type { DownloadOptions } from '../douyin/download';
import type { DesktopDownloadResult } from './save-download';
import { parseOptions } from '../douyin/options';
import { createMediaResolver } from '../douyin/public-dns';
import { redactText } from '../security/redact';
import { buildMediaCatalog, selectCatalogJobs, type CatalogEntry, type CatalogJob } from './media-catalog';

export interface DownloadServiceDependencies {
  history?: Pick<DownloadHistory, 'list' | 'get' | 'find' | 'record'>;
  capture(input: CaptureInput, signal: AbortSignal): Promise<CaptureResult>;
  download(options: DownloadOptions, signal: AbortSignal): Promise<DesktopDownloadResult>;
  chooseDirectory(current: string): Promise<string | null>;
  validateDirectory(directory: string): Promise<string | void>;
  loadDirectory(): Promise<string>;
  saveDirectory(directory: string): Promise<void>;
  reveal(path: string, directory: string): Promise<void>;
}
interface QueueTask extends CatalogJob { id: string }
interface Choice { mode: DownloadMode; jobs: CatalogJob[] }
interface Job {
  id: string; controller: AbortController; done: Promise<void>;
  capture?: CaptureResult; catalog: CatalogEntry[]; tasks: QueueTask[]; mode: DownloadMode;
  /** Assigned once after validation; preference changes never alter a batch's root. */
  batchRoot?: string;
  choose?: (choice: Choice) => void;
  continueDuplicate?: () => void;
  archive?: DownloadArchiveMetadata;
  checkedWorkId?: string;
  active?: { task: QueueTask; token: object };
  samples: Map<string, { bytes: number; time: number }>;
  expiresAt?: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
}
const RETRY_TTL_MS = 10 * 60 * 1000;

/** Owns ephemeral capture credentials. Only the explicit display projection leaves this service. */
export class DownloadService {
  private state: DownloadSnapshot = { sequence: 0, phase: 'idle', directory: '', message: '粘贴抖音链接，选择保存位置后开始下载。', candidates: [], tracks: [] };
  private readonly listeners = new Set<(state: DownloadSnapshot) => void>();
  private job?: Job;
  private retained?: Job;
  private picking = false;
  private closing = false;
  constructor(private readonly dependencies: DownloadServiceDependencies) {}

  async initialize(): Promise<void> {
    try { const directory = await this.dependencies.loadDirectory(); if (directory && isAbsolute(directory)) this.publish({ directory }); }
    catch { this.publish({ message: '无法读取上次保存位置，请重新选择文件夹。' }); }
  }
  getState(): DownloadSnapshot { return structuredClone(this.state); }
  onState(listener: (state: DownloadSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async chooseDirectory(): Promise<string | null> {
    if (this.closing) throw new Error('应用正在关闭，无法选择保存位置。');
    if (this.job || this.picking) throw new Error('请等待当前任务结束后选择保存位置。');
    this.picking = true;
    try {
      let directory = await this.dependencies.chooseDirectory(this.state.directory);
      if (!directory) return null;
      this.directory(directory); directory = this.directory(await this.dependencies.validateDirectory(directory) || directory);
      this.publish({ directory });
      try { await this.dependencies.saveDirectory(directory); }
      catch { this.publish({ message: '已选择文件夹，但无法保存偏好；下次启动时请重新选择。' }); }
      return directory;
    } catch { throw new Error('无法选择或写入此文件夹，请选择其他保存位置。'); }
    finally { this.picking = false; }
  }
  async start(input: DownloadStartRequest): Promise<void> {
    if (this.closing) throw new Error('应用正在关闭，无法开始新任务。');
    if (this.job || this.picking) throw new Error('当前任务仍在运行，请等待结束或取消完成。');
    if (!input || typeof input.url !== 'string' || input.url.length > 16384) throw new Error('请粘贴一个抖音作品链接或分享文本。');
    if (input.interactive !== undefined && typeof input.interactive !== 'boolean') throw new Error('请求参数无效。');
    let pageUrl: string;
    try { pageUrl = parseOptions(['--', input.url.trim()]).pageUrl!; if (!pageUrl) throw new Error(); }
    catch { throw new Error('请粘贴一个有效的抖音作品链接或分享文本。'); }
    const directory = this.directory(input.directory);
    if (this.retained) this.clearCredentials(this.retained);
    const job: Job = { id: randomUUID(), controller: new AbortController(), done: Promise.resolve(), samples: new Map(), catalog: [], tasks: [], mode: 'single' };
    this.job = job; this.retained = job;
    // Install the cleanup promise before publishing, because observers can request cancellation.
    job.done = Promise.resolve().then(() => this.prepare(job, pageUrl, directory, input.interactive === true));
    this.publish({ id: job.id, phase: 'parsing', directory, resultDirectory: directory, captureMode: input.interactive ? 'interactive' : 'background', captureFallback: false, title: undefined, targetWorkId: undefined, duplicate: undefined, historyWarning: undefined, message: input.interactive ? '请在打开的抖音网页中播放目标视频。' : '正在后台读取视频，请稍候…', candidates: [], tracks: [], queue: [], mode: undefined, outputPath: undefined, reportPath: undefined });
  }
  async getHistory(input: { offset: number }): Promise<DownloadHistoryPage> {
    if (!validKeys(input, ['offset']) || !Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > 100000) throw new Error('历史记录页码无效。');
    try { return await this.dependencies.history?.list(input.offset, 20) ?? { items: [], total: 0, offset: 0, limit: 20 }; }
    catch { throw new Error('无法读取下载历史，请重试。'); }
  }
  async revealHistory(input: { id: string }): Promise<void> {
    if (!validKeys(input, ['id']) || !validId(input.id)) throw new Error('历史记录无效。');
    try {
      const entry = await this.dependencies.history?.get(input.id);
      if (!entry?.available || !withinDirectory(entry.outputPath, entry.directory)) throw new Error();
      await this.dependencies.reveal(entry.outputPath, entry.directory);
    } catch { throw new Error('历史文件已移动、删除或无法打开，请重新下载。'); }
  }
  async continueDownload(input: { jobId: string }): Promise<void> {
    if (!validKeys(input, ['jobId'])) throw new Error('请求参数无效。');
    const job = this.requireJob(input.jobId);
    if (this.state.phase !== 'duplicate' || !job.continueDuplicate || job.controller.signal.aborted) throw new Error('重复下载提示已失效。');
    job.continueDuplicate();
  }
  private async checkDuplicate(job: Job, workId?: string): Promise<void> {
    if (!workId || job.checkedWorkId === workId || !this.dependencies.history) return;
    const signal = job.controller.signal;
    let entry;
    try { entry = await this.dependencies.history.find(workId); }
    catch { this.publish({ historyWarning: '暂时无法检查下载历史，本次仍可下载。' }); }
    signal.throwIfAborted(); job.checkedWorkId = workId;
    if (!entry) return;
    await new Promise<void>((resolveChoice, reject) => {
      const abort = () => { job.continueDuplicate = undefined; reject(new DOMException('Cancelled', 'AbortError')); };
      job.continueDuplicate = () => { signal.removeEventListener('abort', abort); job.continueDuplicate = undefined; resolveChoice(); };
      signal.addEventListener('abort', abort, { once: true });
      this.publish({ phase: 'duplicate', duplicate: entry, title: entry.title, targetWorkId: workId, message: '这个作品已下载过，原文件仍在。' });
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
    this.publish({ phase: 'parsing', duplicate: undefined, message: '正在准备重新下载…' });
  }
  async select(input: DownloadSelectionRequest): Promise<void> {
    const job = this.requireJob(input?.jobId);
    if (job.controller.signal.aborted || this.state.phase !== 'choosing' || !job.capture || !job.choose) throw new Error('当前任务没有等待选择的资源。');
    const choice = this.selection(job, input);
    const choose = job.choose; job.choose = undefined; choose(choice);
  }
  async retry(input: { jobId: string; taskId: string }): Promise<void> {
    if (!validKeys(input, ['jobId', 'taskId']) || !validId(input.jobId) || !validId(input.taskId)) throw new Error('请求参数无效。');
    if (this.closing) throw new Error('应用正在关闭，无法重试。');
    if (this.job || this.picking) throw new Error('当前任务仍在运行，请等待结束或取消完成。');
    const job = this.retained;
    if (!job || input.jobId !== job.id || input.jobId !== this.state.id) throw new Error('此任务已结束或已被新的任务替换。');
    if (job.expiresAt !== undefined && Date.now() >= job.expiresAt) this.expire(job);
    if (!job.capture || !job.catalog.length) throw new Error('媒体凭证已过期，请重新解析链接。');
    const item = this.state.queue?.find(entry => entry.id === input.taskId);
    const task = job.tasks.find(entry => entry.id === input.taskId);
    if (!item || !task || !['failed', 'cancelled'].includes(item.phase)) throw new Error('只能重试当前列表中失败或取消的任务。');
    this.stopExpiry(job); job.controller = new AbortController(); this.job = job;
    job.done = Promise.resolve().then(async () => { try { await this.execute(job, [task]); } finally { this.finish(job); } });
    this.updateItem(task.id, { phase: 'queued', message: '等待重试…', canRetry: false, outputPath: undefined, reportPath: undefined, tracks: trackProgress(task.tracks) });
    this.publish({ phase: 'downloading', message: '正在重试所选任务…', outputPath: undefined, reportPath: undefined });
  }
  async cancel(input: { jobId: string }): Promise<void> {
    const job = this.requireJob(input?.jobId);
    if (!job.controller.signal.aborted) {
      job.controller.abort(); this.publish({ message: '正在取消并释放文件与网络资源…' });
    }
    await job.done;
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    if (this.job) await this.cancel({ jobId: this.job.id });
    if (this.retained) this.expire(this.retained);
  }
  async reveal(input: { jobId: string; taskId?: string }): Promise<void> {
    if (!validKeys(input, ['jobId', 'taskId']) || !validId(input.jobId) || (input.taskId !== undefined && !validId(input.taskId))) throw new Error('请求参数无效。');
    const job = this.retained;
    if (!job || input.jobId !== this.state.id || input.jobId !== job.id || this.job) throw new Error('此任务的结果已过期。');
    const item = input.taskId === undefined ? this.state : this.state.queue?.find(entry => entry.id === input.taskId);
    const path = item?.outputPath ?? item?.reportPath;
    if (!path || !job.batchRoot || !withinDirectory(path, job.batchRoot)) throw new Error('当前任务没有可打开的结果。');
    try { await this.dependencies.reveal(path, job.batchRoot); }
    catch { throw new Error('结果文件已移动或无法打开，请检查保存位置。'); }
  }
  private directory(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0') || !isAbsolute(value)) throw new Error('请选择有效的保存文件夹。');
    return resolve(value);
  }
  private requireJob(id: unknown): Job {
    if (!this.job || typeof id !== 'string' || id !== this.job.id) throw new Error('此任务已结束或已被新的任务替换。');
    return this.job;
  }
  private publish(patch: Partial<DownloadSnapshot>): void {
    this.state = { ...this.state, ...patch, sequence: this.state.sequence + 1 };
    for (const listener of this.listeners) { try { listener(this.getState()); } catch { /* UI observers do not control job cleanup. */ } }
  }
  private updateItem(id: string, patch: Partial<DownloadQueueItem>, snapshot: Partial<DownloadSnapshot> = {}): void {
    this.publish({ ...snapshot, queue: this.state.queue?.map(item => item.id === id ? { ...item, ...patch } : item) });
  }
  private selection(job: Job, input: DownloadSelectionRequest): Choice {
    let mode: DownloadMode; let selections: DownloadSelection[];
    if ('indices' in input) {
      if (!validKeys(input, ['jobId', 'indices']) || !Array.isArray(input.indices) || input.indices.length < 1 || input.indices.length > 2 || new Set(input.indices).size !== input.indices.length || input.indices.some(n => !Number.isSafeInteger(n) || n < 1 || n > job.catalog.length)) throw new Error('请选择当前列表中的有效资源。');
      mode = 'single';
      if (input.indices.length === 1) selections = [{ candidateIndex: input.indices[0] }];
      else {
        const entries = input.indices.map(index => job.catalog[index - 1]);
        const video = entries.find(entry => entry.candidate.kind === 'video');
        const audio = entries.find(entry => entry.candidate.kind === 'audio');
        if (!video || !audio) throw new Error('跨资源选择必须是一条视频轨和一条音频轨。');
        selections = [{ candidateIndex: video.candidate.index, audioIndex: audio.candidate.index }];
      }
    } else {
      if (!validKeys(input, ['jobId', 'mode', 'selections']) || !['single', 'batch'].includes(input.mode)) throw new Error('请选择有效的下载模式与资源。');
      mode = input.mode; selections = input.selections;
    }
    return { mode, jobs: selectCatalogJobs(job.catalog, selections, mode) };
  }
  private async prepare(job: Job, pageUrl: string, directory: string, interactive: boolean): Promise<void> {
    const signal = job.controller.signal;
    let captureFallback = false;
    try {
      signal.throwIfAborted();
      job.batchRoot = this.directory(await this.dependencies.validateDirectory(directory) || directory); signal.throwIfAborted();
      if (job.batchRoot !== this.state.directory) this.publish({ directory: job.batchRoot, resultDirectory: job.batchRoot });
      await this.checkDuplicate(job, resolveWorkId(pageUrl));
      captureFallback = !interactive;
      const capture = await this.dependencies.capture({ pageUrl, observeSeconds: 30, show: interactive }, signal); signal.throwIfAborted();
      job.capture = capture;
      const title = displayText(capture.summary.title, 160, capture.requests) || '抖音作品';
      if (capture.target?.status === 'unresolved') throw new Error('无法确认链接对应的视频或声音，请检查作品链接，或打开网页播放后重试。');
      if (capture.target?.status === 'matched' && capture.target.workId) {
        job.archive = { workId: capture.target.workId, title, author: displayText(capture.summary.author ?? '', 80, capture.requests) || '未知作者' };
        await this.checkDuplicate(job, capture.target.workId);
      }
      // Each target asset is one explicitly matched video/audio combination. Do not
      // regroup all assets by shared audio, which could replace a variant's declared pair.
      job.catalog = capture.target?.status === 'matched'
        ? capture.assets.flatMap(asset => buildMediaCatalog([asset])).map((entry, index) => ({ ...entry, candidate: { ...entry.candidate, index: index + 1, groupKey: 'target-work', groupLabel: title, grouping: 'confirmed' as const, audioOptions: undefined } }))
        : buildMediaCatalog(capture.assets);
      this.publish({ title, targetWorkId: capture.target?.status === 'matched' ? capture.target.workId : undefined });
      if (!job.catalog.length) throw new Error(interactive ? '没有找到可下载的视频，请确认网页中已播放目标视频后重试。' : '暂时无法自动获取视频。网页可能需要登录、验证或手动播放。');
      captureFallback = false;
      const choice: Choice = job.catalog.length === 1 ? { mode: 'single', jobs: selectCatalogJobs(job.catalog, [{ candidateIndex: 1 }], 'single') } : await new Promise<Choice>((resolveChoice, reject) => {
        const abort = () => { job.choose = undefined; reject(new DOMException('Cancelled', 'AbortError')); };
        job.choose = values => { signal.removeEventListener('abort', abort); resolveChoice(values); };
        signal.addEventListener('abort', abort, { once: true });
        this.publish({ phase: 'choosing', message: capture.target?.status === 'matched' ? '已找到链接对应的视频，请选择清晰度。' : '请选择作品与版本；可单个下载，或加入批量队列。', candidates: job.catalog.map(entry => entry.candidate) });
        if (signal.aborted) abort();
      });
      signal.throwIfAborted(); job.mode = choice.mode; job.tasks = choice.jobs.map(item => ({ ...item, id: randomUUID() }));
      this.publish({ phase: 'downloading', mode: job.mode, candidates: [], queue: job.tasks.map(task => ({ id: task.id, label: displayText(task.label, 160), phase: 'queued', message: '等待下载…', tracks: trackProgress(task.tracks), attempts: 0, canRetry: false })) });
      await this.execute(job, job.tasks);
    } catch (error) {
      this.publish({ phase: cancelled(signal, error) ? 'cancelled' : 'failed', duplicate: undefined, captureFallback: !cancelled(signal, error) && captureFallback, candidates: [], message: cancelled(signal, error) ? '下载已取消，可以修改上方链接后重新开始。' : errorMessage(error, job.capture), tracks: this.state.tracks.map(track => ({ ...track, bytesPerSecond: 0 })) });
    } finally { this.finish(job); }
  }
  private async execute(job: Job, tasks: QueueTask[]): Promise<void> {
    const signal = job.controller.signal;
    for (const task of tasks) {
      if (signal.aborted) break;
      const token = {}; job.active = { task, token }; job.samples.clear();
      const item = this.state.queue!.find(entry => entry.id === task.id)!;
      const tracks = trackProgress(task.tracks);
      this.updateItem(task.id, { phase: 'downloading', message: '正在验证媒体访问并下载…', tracks, attempts: item.attempts + 1, canRetry: false, outputPath: undefined, reportPath: undefined }, { phase: 'downloading', tracks, message: '正在验证媒体访问并下载…', outputPath: undefined, reportPath: undefined });
      try {
        const capture = job.capture!; const directory = job.batchRoot!;
        const output = await this.dependencies.download({ outputDirectory: directory, archive: job.archive, captured: { runId: capture.runId, tracks: task.tracks, requests: capture.requests }, networkPolicy: { resolveHostname: createMediaResolver() }, onEvent: event => this.progress(job, token, event) }, signal);
        if (!output.committed) signal.throwIfAborted();
        const outputPath = output.outputPath ?? (output.status === 'tracks-only' ? output.tracks[0]?.path : undefined);
        if ((outputPath && !withinDirectory(outputPath, directory)) || (output.reportPath && !withinDirectory(output.reportPath, directory))) throw new Error('下载结果位置无效，请检查保存位置。');
        if (output.status === 'complete' && outputPath && job.archive && this.dependencies.history) {
          try { await this.dependencies.history.record(job.archive, outputPath); }
          catch { this.publish({ historyWarning: '文件已保存，但下载历史未能写入；下次可能无法提示重复下载。' }); }
        }
        const phase = output.status === 'complete' ? 'completed' : 'tracks-only';
        const message = output.status === 'tracks-only' ? '已保存纯视频轨；未找到对应音频，文件暂时没有声音。' : displayText(output.message, 400, capture.requests);
        const completedTracks = this.state.tracks.map(track => ({ ...track, status: 'completed' as const, bytesPerSecond: 0 }));
        this.updateItem(task.id, { phase, message, outputPath, reportPath: output.reportPath, tracks: completedTracks }, { tracks: completedTracks, outputPath, reportPath: output.reportPath });
      } catch (error) {
        const report = (error as { reportPath?: unknown } | null)?.reportPath;
        const reportPath = typeof report === 'string' && withinDirectory(report, job.batchRoot!) ? report : undefined;
        const phase = cancelled(signal, error) ? 'cancelled' : 'failed';
        const tracks = this.state.tracks.map(track => ({ ...track, bytesPerSecond: 0 }));
        this.updateItem(task.id, { phase, message: phase === 'cancelled' ? '任务已取消。' : errorMessage(error, job.capture), reportPath, tracks }, { tracks, reportPath });
      } finally { job.active = undefined; job.samples.clear(); }
    }
    if (signal.aborted) {
      this.publish({ queue: this.state.queue?.map(item => item.phase === 'queued' ? { ...item, phase: 'cancelled', message: '尚未开始，已取消。' } : item) });
    }
  }
  private finish(job: Job): void {
    job.active = undefined; job.choose = undefined; job.continueDuplicate = undefined; job.samples.clear();
    if (this.job !== job) return;
    const queue = this.state.queue ?? [];
    const retryable = queue.some(item => ['failed', 'cancelled'].includes(item.phase));
    if (job.capture && queue.length && retryable) {
      job.expiresAt = Date.now() + RETRY_TTL_MS;
      job.expiryTimer = setTimeout(() => this.expire(job), RETRY_TTL_MS); job.expiryTimer.unref?.();
    } else this.clearCredentials(job);
    this.job = undefined;
    if (!queue.length) return;
    const completed = queue.filter(item => item.phase === 'completed').length;
    const tracksOnly = queue.filter(item => item.phase === 'tracks-only').length;
    const failed = queue.filter(item => item.phase === 'failed').length;
    const stopped = queue.filter(item => item.phase === 'cancelled').length;
    const mixed = (completed > 0 && tracksOnly > 0) || (completed + tracksOnly > 0 && failed + stopped > 0);
    const phase = job.controller.signal.aborted ? 'cancelled' : mixed ? 'partial' : failed ? 'failed' : stopped ? 'cancelled' : tracksOnly ? 'tracks-only' : 'completed';
    const message = queue.length === 1 ? queue[0].message : `队列结束：${completed} 项完成，${tracksOnly} 项仅单轨，${failed} 项失败，${stopped} 项取消。`;
    this.publish({ phase, message, queue: queue.map(item => ({ ...item, canRetry: !!job.capture && ['failed', 'cancelled'].includes(item.phase) })) });
  }
  private stopExpiry(job: Job): void {
    if (job.expiryTimer !== undefined) clearTimeout(job.expiryTimer);
    job.expiryTimer = undefined; job.expiresAt = undefined;
  }
  private clearCredentials(job: Job): void {
    this.stopExpiry(job); job.capture = undefined; job.catalog = []; job.tasks.forEach(task => { task.tracks = []; });
    job.active = undefined; job.choose = undefined; job.samples.clear();
  }
  private expire(job: Job): void {
    if (this.job === job) return;
    this.clearCredentials(job);
    if (this.retained !== job || this.state.id !== job.id || !this.state.queue?.some(item => item.canRetry)) return;
    this.publish({ queue: this.state.queue?.map(item => item.canRetry ? { ...item, canRetry: false, message: `${item.message} 媒体凭证已过期，请重新解析链接。` } : item) });
  }
  private progress(job: Job, token: object, event: RunEvent): void {
    if (this.job !== job || job.controller.signal.aborted || job.active?.token !== token) return;
    const task = job.active.task;
    if (event.phase === 'download') {
      const index = task.tracks.findIndex(track => track.sourceRequestIds.includes(String(event.inputSummary?.sourceRequestId ?? '')));
      if (index < 0) return;
      const tracks = this.state.tracks.map(track => ({ ...track })); const track = tracks[index];
      const bytes = nonnegative(event.evidence?.receivedBytes) ?? nonnegative(event.evidence?.completedBytes); const total = positive(event.evidence?.totalBytes);
      if (total !== undefined) track.totalBytes = total;
      if (bytes !== undefined) track.downloadedBytes = Math.max(track.downloadedBytes, Math.min(bytes, track.totalBytes ?? bytes));
      const time = performance.now(); const previous = job.samples.get(track.id);
      if (previous && time > previous.time) track.bytesPerSecond = Math.max(0, (track.downloadedBytes - previous.bytes) * 1000 / (time - previous.time));
      if (bytes !== undefined) job.samples.set(track.id, { bytes: track.downloadedBytes, time });
      track.status = event.action === 'download:after' ? 'completed' : event.action === 'download:queued' ? 'queued' : 'running';
      if (track.status === 'completed') track.bytesPerSecond = 0;
      this.updateItem(task.id, { phase: 'downloading', tracks, message: '正在下载并检查文件完整性…' }, { phase: 'downloading', tracks, message: '正在下载并检查文件完整性…' });
    } else if (event.phase === 'ffmpeg' && event.action !== 'remux:result') this.updateItem(task.id, { phase: 'merging', message: '正在无损合并音视频…' }, { phase: 'merging', message: '正在无损合并音视频…' });
    else if (event.phase === 'verify') {
      const allDownloaded = this.state.tracks.length > 0 && this.state.tracks.every(track => track.status === 'completed');
      const patch = { phase: allDownloaded ? 'verifying' as const : 'downloading' as const, message: allDownloaded ? '正在验证媒体格式与时长…' : '正在检查已下载文件…' };
      this.updateItem(task.id, patch, patch);
    }
  }
}
function trackProgress(tracks: MediaTrack[]): TrackProgress[] { return tracks.map((track, i) => ({ id: `track-${i + 1}`, kind: track.kind, downloadedBytes: 0, totalBytes: positive(track.byteLength), bytesPerSecond: 0, status: 'queued' })); }
function validKeys(value: unknown, keys: string[]): boolean { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)); }
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 100; }
function cancelled(signal: AbortSignal, error: unknown): boolean { return signal.aborted || (error instanceof Error && error.name === 'AbortError'); }
function errorMessage(error: unknown, capture?: CaptureResult): string { return displayText(error instanceof Error ? error.message : '下载失败，请重试。', 400, capture?.requests); }
function nonnegative(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined; }
function positive(value: unknown): number | undefined { const n = nonnegative(value); return n && n > 0 ? n : undefined; }
function displayText(value: string, limit = 400, requests: CaptureResult['requests'] = []): string {
  const headerValues = new Set(requests.flatMap(request => [...Object.values(request.requestHeaders ?? {}), ...Object.values(request.responseHeaders ?? {})]).filter(Boolean));
  for (const header of [...headerValues].sort((a, b) => b.length - a.length)) value = value.split(header).join('[已隐藏]');
  return redactText(value).replace(/https?:\/\/[^\s<>"'`;]+/gi, '[链接]').replace(/\b(?:token|signature|sign|authorization|cookie|session|credential|password|x-bogus|a-bogus)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[已隐藏]').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit);
}
export function withinDirectory(path: string, directory: string): boolean { const child = relative(resolve(directory), resolve(path)); return isAbsolute(path) && !!child && child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(child); }
