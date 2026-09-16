import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createSourceRequestReference, type DownloadArtifact, type MediaTrack, type RunEvent } from '../../shared/contracts';
import type { RunEventStore } from '../runs/event-repository';
import { RunOrchestrator, type EphemeralRequest } from '../runs/run-orchestrator';
import type { OutputWorkerLauncher } from '../download/output-workspace';
import { Downloader } from '../download/downloader';
import { HttpTransport } from '../probes/http-transport';
import { planProbes } from '../probes/probe-planner';
import type { NetworkPolicy } from '../probes/address-policy';
import { createMediaAdapter, resolveMediaTools, type MediaProbe } from '../media/ffmpeg-adapter';
import { createSanitizedCapturedUrl, redactText } from '../security/redact';
import { httpUrl } from './options';

export interface CapturedSelection { runId: string; tracks: MediaTrack[]; requests: EphemeralRequest[] }
export interface DownloadOptions {
  outputDirectory: string; videoUrl?: string; audioUrl?: string; referer?: string; userAgent?: string;
  maxBytes?: number; captured?: CapturedSelection; networkPolicy?: NetworkPolicy;
  onEvent?: (event: RunEvent) => void;
  createEventRepository?: () => RunEventStore;
  outputWorkerLauncher?: OutputWorkerLauncher;
  outputWorkerModulePath?: string;
}
export interface DownloadResult {
  status: 'complete' | 'tracks-only'; outputPath?: string; reportPath: string;
  tracks: DownloadArtifact[]; probe?: MediaProbe; message: string;
}

/** Uses the same HTTP evidence gate, ordered downloader and media verifier as the desktop lab. */
export async function downloadMedia(options: DownloadOptions, signal: AbortSignal): Promise<DownloadResult> {
  signal.throwIfAborted();
  const tools = resolveMediaTools();
  const runId = options.captured?.runId ?? randomUUID();
  const selected = options.captured ?? directSelection(runId, options);
  if (!selected.tracks.length || selected.tracks.length > 2) throw new Error('必须选择一个媒体文件或一对音视频轨道');
  await mkdir(options.outputDirectory, { recursive: true });
  const directory = await mkdtemp(join(options.outputDirectory, 'douyin-'));
  const repository = options.createEventRepository?.() ?? new (await import('../runs/event-repository')).EventRepository(':memory:');
  const context = new RunOrchestrator(repository, options.onEvent);
  const tracks: DownloadArtifact[] = [];
  const probes: MediaProbe[] = [];
  const reportPath = join(directory, 'result.json');
  const targetUrl = selected.requests[0]?.url;
  if (!targetUrl) { repository.close(); context.dispose(); throw new Error('媒体请求已失效，请重新捕获'); }
  context.start({ targetUrl, outputDirectory: directory, mode: 'full-download', authorizationConfirmed: true, maxConcurrency: 2 }, runId);
  const adapter = createMediaAdapter({ tools, onEvent: event => context.emit({ ...event, runId }) });
  try {
    const ids = new Set(selected.tracks.flatMap(t => t.sourceRequestIds));
    for (const request of selected.requests) if (ids.has(request.id)) context.rememberRequest(runId, request);
    for (const [index, track] of selected.tracks.entries()) {
      signal.throwIfAborted();
      const transport = new HttpTransport({ context, runId, track, networkPolicy: options.networkPolicy });
      // Only the unchanged baseline is replayed. No signature/header mutation matrix is needed to download.
      const baseline = planProbes(track, 'full-download').find(plan => plan.id === 'baseline');
      if (!baseline) throw new Error('该轨道不完整、已加密或不支持下载');
      const evidence = await transport.execute(baseline, signal);
      if (evidence.outcome !== 'accessible') throw new Error(redactText(`媒体访问验证失败：${evidence.outcome} (${evidence.transportOutcome})${evidence.status ? `，HTTP ${evidence.status}` : ''}；${evidence.conclusion}；${evidence.limitations.join('；')}`));
      // Stream one continuous response where possible: some CDN range caches expose
      // different validators for later offsets. Memory and progress remain streaming;
      // server-capped responses still use the downloader's strict range/validator checks.
      const downloader = new Downloader({ context, runId, transport, maxBytes: options.maxBytes, outputWorkerLauncher: options.outputWorkerLauncher, outputWorkerModulePath: options.outputWorkerModulePath });
      const artifact = await downloader.download({ sourceRequestId: baseline.sourceRequestId, filename: `track-${index + 1}.bin` }, signal);
      tracks.push(artifact);
      const probe = await adapter.probeMedia(artifact.path, signal);
      const isAudio = probe.streams.every(stream => stream.kind === 'audio');
      const extension = isAudio && probe.container === 'mp4' ? 'm4a' : probe.container;
      // The containing artifact directory is fresh for this run; retain each downloaded track.
      const path = join(dirname(artifact.path), `${isAudio ? 'audio' : 'video'}.${extension}`);
      await rename(artifact.path, path); artifact.path = path;
      probes.push(probe);
    }
    signal.throwIfAborted();
    let result: DownloadResult;
    if (tracks.length === 2) {
      const muxedIndex = probes.findIndex(p => p.streams.length === 2 && p.streams.some(s => s.kind === 'video') && p.streams.some(s => s.kind === 'audio'));
      const videoIndex = probes.findIndex(p => p.streams.length === 1 && p.streams[0].kind === 'video');
      const audioIndex = probes.findIndex(p => p.streams.length === 1 && p.streams[0].kind === 'audio');
      if (muxedIndex >= 0 && audioIndex >= 0) {
        result = { status: 'complete', outputPath: tracks[muxedIndex].path, reportPath, tracks, probe: probes[muxedIndex], message: '原视频已含声音，下载并验证完成；单独音轨也已保留' };
      } else {
        if (videoIndex < 0 || audioIndex < 0) throw new Error('输入不是一条纯视频轨和一条纯音频轨；已保留下载文件');
        const output = await adapter.remuxTracks(tracks[videoIndex].path, tracks[audioIndex].path, join(directory, `video.${probes[videoIndex].container}`), signal);
        result = { status: 'complete', outputPath: output.outputPath, reportPath, tracks, probe: output.probe, message: '音视频已无损合并，并通过完整性验证' };
      }
    } else {
      const probe = probes[0];
      const videoOnly = probe.streams.length === 1 && probe.streams[0].kind === 'video';
      result = { status: videoOnly ? 'tracks-only' : 'complete', outputPath: videoOnly ? undefined : tracks[0].path, reportPath, tracks, probe,
        message: videoOnly ? '已保存纯视频轨，尚无音频；请提供对应音频后使用本地合并命令' : probe.streams.length === 2 ? '原文件已含音视频，下载并验证完成' : '音频下载并验证完成' };
    }
    await writeFile(reportPath, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
    return result;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('下载或合并失败');
    const report = { status: signal.aborted ? 'cancelled' : 'failed', message: redactText(failure.message), tracks,
      verifiedTracks: probes.length, reportPath };
    try {
      await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
      Object.assign(failure, { reportPath });
    } catch { /* Preserve the original failure when the output filesystem is unavailable. */ }
    throw failure;
  } finally { context.dispose(); repository.close(); }
}

function directSelection(runId: string, options: DownloadOptions): CapturedSelection {
  const tracks: MediaTrack[] = [], requests: EphemeralRequest[] = [];
  for (const [kind, value] of [['video', options.videoUrl], ['audio', options.audioUrl]] as const) {
    if (!value) continue;
    const url = httpUrl(value);
    const sourceIdentity = { runId, targetId: 'explicit-media-url', sessionId: '', frameId: '', requestId: kind, version: 1 };
    const id = createSourceRequestReference(sourceIdentity);
    const headers: Record<string, string> = {};
    if (options.referer) headers.Referer = httpUrl(options.referer);
    if (options.userAgent) headers['User-Agent'] = options.userAgent;
    requests.push({ id, sourceIdentity, url, method: 'GET', requestHeaders: headers });
    tracks.push({ id: kind, assetId: 'explicit-pair', kind, eligible: true, incomplete: false, sanitizedUrl: createSanitizedCapturedUrl(url), sourceRequestIds: [id], detectionReasons: ['Explicit user-provided media URL; actual streams are verified with ffprobe'] });
  }
  return { runId, requests, tracks };
}
