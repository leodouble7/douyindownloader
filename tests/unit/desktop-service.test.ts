import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadService, type DownloadServiceDependencies } from '../../src/main/desktop/download-service';
import type { CaptureResult } from '../../src/main/douyin/capture-page';
import type { DownloadOptions, DownloadResult } from '../../src/main/douyin/download';
import type { DesktopDownloadResult } from '../../src/main/desktop/save-download';
import type { DownloadSnapshot } from '../../src/shared/desktop';
import type { MediaAsset, MediaTrack, RunEvent } from '../../src/shared/contracts';
import { createSanitizedCapturedUrl } from '../../src/main/security/redact';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function asset(id: string, kinds: MediaTrack['kind'][]): MediaAsset {
  const tracks: MediaTrack[] = kinds.map((kind, i) => ({ id: `${id}-${i}`, assetId: id, kind, sourceRequestIds: [`source-${id}-${i}`], sanitizedUrl: createSanitizedCapturedUrl(`https://cdn.example/${id}-${i}.mp4?sign=secret`), eligible: true, incomplete: false, byteLength: 1000, detectionReasons: [] }));
  return { id, runId: 'capture', sourceRequestIds: tracks.flatMap(t => t.sourceRequestIds), trackIds: tracks.map(t => t.id), selectedTrackIds: tracks.map(t => t.id), tracks, confidence: 1, detectionReasons: [], detectedAt: new Date().toISOString() };
}
const captured = (assets = [asset('pair', ['video', 'audio'])]): CaptureResult => ({ runId: 'capture', assets, requests: [], summary: { network: 2, mse: 2, title: '作品 https://media.example/private.mp4?token=title-secret Cookie: cookie-secret', excerpt: 'excerpt-secret', videoElements: 1 } });
const result: DownloadResult = { status: 'complete', outputPath: '/downloads/douyin-job/video.mp4', reportPath: '/downloads/douyin-job/result.json', tracks: [], message: '完成' };
const services: DownloadService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.shutdown())); vi.useRealTimers(); });
function harness(overrides: Partial<DownloadServiceDependencies> = {}) {
  const states: DownloadSnapshot[] = [];
  const dependencies: DownloadServiceDependencies = { capture: async () => captured(), download: async () => result, chooseDirectory: async () => '/downloads', validateDirectory: async () => undefined, loadDirectory: async () => '/downloads', saveDirectory: async () => undefined, reveal: async () => undefined, ...overrides };
  const service = new DownloadService(dependencies); services.push(service); service.onState(state => states.push(state)); return { service, states };
}
const start = (service: DownloadService) => service.start({ url: '复制分享 https://v.douyin.com/abc/', directory: '/downloads' });
const phase = async (service: DownloadService, value: DownloadSnapshot['phase']) => { await expect.poll(() => service.getState().phase).toBe(value); };

describe('desktop download lifecycle', () => {
  it('captures in the background by default and opens a page only when explicitly requested', async () => {
    const capture = vi.fn<DownloadServiceDependencies['capture']>(async () => captured());
    const { service } = harness({ capture });
    await start(service); await phase(service, 'completed');
    expect(capture.mock.calls[0]?.[0]).toMatchObject({ show: false });
    await service.start({ url: 'https://www.douyin.com/video/123', directory: '/downloads', interactive: true });
    await phase(service, 'completed');
    expect(capture.mock.calls[1]?.[0]).toMatchObject({ show: true });
  });
  it('offers a manual page retry only after failed background capture', async () => {
    const { service } = harness({ capture: async () => captured([]) });
    await start(service); await phase(service, 'failed');
    expect(service.getState().captureFallback).toBe(true);
    await service.start({ url: 'https://www.douyin.com/video/123', directory: '/downloads', interactive: true });
    await phase(service, 'failed'); expect(service.getState().captureFallback).toBe(false);
    const invalid = harness({ validateDirectory: async () => { throw new Error('目录不可用'); } });
    await start(invalid.service); await phase(invalid.service, 'failed');
    expect(invalid.service.getState().captureFallback).toBe(false);
  });
  it('retains a file published concurrently with cancellation and allows opening its folder', async () => {
    const done = deferred<DesktopDownloadResult>(); const opened: string[] = [];
    const { service } = harness({ download: async () => done.promise, reveal: async path => { opened.push(path); } });
    await start(service); await phase(service, 'downloading');
    const jobId = service.getState().id!; const cancelling = service.cancel({ jobId });
    done.resolve({ status: 'complete', outputPath: '/downloads/视频.mp4', tracks: [], message: '视频已保存。', committed: true });
    await cancelling;
    expect(service.getState().queue![0]).toMatchObject({ phase: 'completed', outputPath: '/downloads/视频.mp4', canRetry: false });
    await service.reveal({ jobId, taskId: service.getState().queue![0].id });
    expect(opened).toEqual(['/downloads/视频.mp4']);
  });
  it('publishes ordered safe snapshots and completes an automatic paired download', async () => {
    const { service, states } = harness(); await start(service); await phase(service, 'completed');
    expect(states.map(s => s.sequence)).toEqual(states.map((_s, i) => i + 1));
    expect(states.some(s => s.phase === 'downloading' && s.tracks.map(t => t.kind).join(',') === 'video,audio')).toBe(true);
    const text = JSON.stringify(states); for (const secret of ['title-secret', 'cookie-secret', 'excerpt-secret', 'media.example', 'source-pair', 'requestHeaders']) expect(text).not.toContain(secret);
    expect(service.getState().outputPath).toBe('/downloads/douyin-job/video.mp4');
  });
  it('maps catalog candidates to one-based indices and rejects stale/invalid choices', async () => {
    let chosen: string[] = [];
    const { service } = harness({ capture: async () => captured([asset('ineligible', ['manifest']), asset('pair', ['video', 'audio']), asset('muxed', ['muxed'])]), download: async options => { chosen = options.captured!.tracks.map(t => t.id); return result; } });
    await start(service); await phase(service, 'choosing');
    expect(service.getState().candidates.map(c => [c.index, c.kind])).toEqual([[1, 'pair'], [2, 'muxed']]);
    await expect(service.select({ jobId: 'stale', indices: [1] })).rejects.toThrow();
    await expect(service.select({ jobId: service.getState().id!, indices: [0] })).rejects.toThrow();
    expect(service.getState().phase).toBe('choosing');
    await service.select({ jobId: service.getState().id!, indices: [2] }); await phase(service, 'completed'); expect(chosen).toEqual(['muxed-0']);
  });
  it('holds the job lock until cancellation cleanup resolves, then accepts retry', async () => {
    const cleanup = deferred<CaptureResult>(); let signal!: AbortSignal;
    const { service } = harness({ capture: async (_input, s) => { signal = s; return cleanup.promise; } });
    await start(service); await expect.poll(() => Boolean(signal)).toBe(true);
    await expect(start(service)).rejects.toThrow();
    await expect(service.cancel({ jobId: 'stale' })).rejects.toThrow();
    const cancelling = service.cancel({ jobId: service.getState().id! }); expect(signal.aborted).toBe(true);
    await expect(start(service)).rejects.toThrow();
    cleanup.resolve(captured()); await cancelling; expect(service.getState().phase).toBe('cancelled');
    await start(service); await phase(service, 'completed');
  });
  it('cancels the choosing phase and clears ephemeral candidates before retry', async () => {
    const { service } = harness({ capture: async () => captured([asset('a', ['video']), asset('b', ['audio'])]) });
    await start(service); await phase(service, 'choosing'); const old = service.getState().id!;
    await service.cancel({ jobId: old }); expect(service.getState()).toMatchObject({ phase: 'cancelled', candidates: [] });
    await start(service); await phase(service, 'choosing'); await expect(service.select({ jobId: old, indices: [1] })).rejects.toThrow();
    await service.cancel({ jobId: service.getState().id! });
  });
  it('projects actual byte progress and ignores late events after cancellation', async () => {
    let onEvent!: NonNullable<DownloadOptions['onEvent']>; const done = deferred<DownloadResult>();
    const { service } = harness({ download: async options => { onEvent = options.onEvent!; return done.promise; } });
    await start(service); await phase(service, 'downloading');
    const event = (action: string, completedBytes: number): RunEvent => ({ id: 'event', runId: 'capture', sequence: 1, timestamp: new Date().toISOString(), phase: 'download', action, status: 'running', purpose: 'https://secret.example', relatedIds: ['artifact'], inputSummary: { sourceRequestId: 'source-pair-0' }, evidence: { completedBytes, totalBytes: 2000, url: 'https://secret.example' } });
    onEvent(event('download:progress', 700)); expect(service.getState().tracks[0]).toMatchObject({ downloadedBytes: 700, totalBytes: 2000, status: 'running' });
    const cancelling = service.cancel({ jobId: service.getState().id! }); const seq = service.getState().sequence; onEvent(event('download:progress', 1500)); expect(service.getState().sequence).toBe(seq);
    done.resolve(result); await cancelling; expect(service.getState().phase).toBe('cancelled');
  });
  it('keeps the overall download stage while checking the first track of a pair', async () => {
    let onEvent!: NonNullable<DownloadOptions['onEvent']>; const done = deferred<DownloadResult>();
    const { service } = harness({ download: async options => { onEvent = options.onEvent!; return done.promise; } });
    await start(service); await phase(service, 'downloading');
    const event: RunEvent = { id: 'event', runId: 'capture', sequence: 1, timestamp: new Date().toISOString(), phase: 'download', action: 'download:progress', status: 'running', purpose: '', relatedIds: [], inputSummary: { sourceRequestId: 'source-pair-0' }, evidence: { completedBytes: 0, receivedBytes: 400, totalBytes: 1000 } };
    onEvent(event); expect(service.getState().tracks[0].downloadedBytes).toBe(400);
    onEvent({ ...event, action: 'download:after', evidence: { completedBytes: 1000, totalBytes: 1000 } });
    onEvent({ ...event, phase: 'verify', action: 'probe:command' }); expect(service.getState().phase).toBe('downloading');
    onEvent({ ...event, action: 'download:after', inputSummary: { sourceRequestId: 'source-pair-1' }, evidence: { completedBytes: 1000, totalBytes: 1000 } });
    onEvent({ ...event, phase: 'verify', action: 'probe:command' }); expect(service.getState().phase).toBe('verifying');
    done.resolve(result); await phase(service, 'completed');
  });
  it('redacts failures, offers retained reports, and rejects arbitrary reveal paths', async () => {
    const opened: string[] = []; const { service } = harness({ download: async () => { throw Object.assign(new Error('失败 https://cdn.example/raw.mp4?sign=secret Authorization: bearer-secret'), { reportPath: '/downloads/douyin-job/result.json' }); }, reveal: async path => { opened.push(path); } });
    await start(service); await phase(service, 'failed'); expect(JSON.stringify(service.getState())).not.toMatch(/secret|cdn.example/);
    await expect(service.reveal({ jobId: 'wrong' })).rejects.toThrow();
    await service.reveal({ jobId: service.getState().id! }); expect(opened).toEqual(['/downloads/douyin-job/result.json']);
    const bad = harness({ download: async () => ({ ...result, outputPath: '/etc/passwd', reportPath: '/etc/shadow' }) }); await start(bad.service); await phase(bad.service, 'failed'); expect(bad.service.getState().outputPath).toBeUndefined();
  });
  it('reveals the existing result after choosing a different directory for the next download', async () => {
    const opened: string[][] = [];
    const { service } = harness({ chooseDirectory: async () => '/next-downloads', reveal: async (path, directory) => { opened.push([path, directory]); } });
    await start(service); await phase(service, 'completed'); const jobId = service.getState().id!;
    await service.chooseDirectory(); expect(service.getState().directory).toBe('/next-downloads');
    expect(service.getState().resultDirectory).toBe('/downloads');
    await service.reveal({ jobId }); expect(opened).toEqual([['/downloads/douyin-job/video.mp4', '/downloads']]);
  });
  it('rejects non-Douyin page inputs and empty directories before capture', async () => {
    const { service } = harness();
    for (const url of ['https://example.com/a.mp4', 'https://douyin.com.evil.test/a', 'file:///tmp/video', 'https://u:p@douyin.com/a', 'https://douyin.com/a https://douyin.com/b']) await expect(service.start({ url, directory: '/downloads' })).rejects.toThrow();
    await expect(service.start({ url: 'https://douyin.com/a', directory: '' })).rejects.toThrow(); expect(service.getState().phase).toBe('idle');
  });
  it('keeps a selected directory usable when persistence fails and surfaces a safe notice', async () => {
    const { service } = harness({ saveDirectory: async () => { throw new Error('permission-secret'); } });
    expect(await service.chooseDirectory()).toBe('/downloads'); expect(service.getState().directory).toBe('/downloads'); expect(service.getState().message).toMatch(/保存/); expect(service.getState().message).not.toContain('permission-secret');
  });
});

const batchCapture = () => captured([asset('one', ['muxed']), asset('two', ['muxed']), asset('three', ['muxed'])]);
const selectBatch = (service: DownloadService) => service.select({ jobId: service.getState().id!, mode: 'batch', selections: [{ candidateIndex: 1 }, { candidateIndex: 2 }, { candidateIndex: 3 }] });
const outputFor = (name: string): DownloadResult => ({ ...result, outputPath: `/downloads/${name}/video.mp4`, reportPath: `/downloads/${name}/result.json` });
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

describe('desktop independent download queue', () => {
  it('continues after an item fails and retries only that item using retained capture', async () => {
    const downloads: string[] = []; let captures = 0; let fail = true;
    const { service, states } = harness({ capture: async () => { captures++; return batchCapture(); }, download: async options => {
      const name = options.captured!.tracks[0].id; downloads.push(name);
      if (name === 'two-0' && fail) throw new Error('第二项下载失败 https://secret.example/a?token=private Cookie: private');
      return outputFor(name);
    } });
    await start(service); await phase(service, 'choosing'); await selectBatch(service); await phase(service, 'partial');
    const before = service.getState();
    expect(downloads).toEqual(['one-0', 'two-0', 'three-0']);
    expect(before.queue?.map(item => [item.phase, item.attempts, item.canRetry])).toEqual([['completed', 1, false], ['failed', 1, true], ['completed', 1, false]]);
    expect(before.message).toMatch(/2.*1/);
    expect(JSON.stringify(states)).not.toMatch(/secret\.example|private|source-one|requestHeaders/);
    fail = false;
    await service.retry({ jobId: before.id!, taskId: before.queue![1].id }); await phase(service, 'completed');
    expect(downloads).toEqual(['one-0', 'two-0', 'three-0', 'two-0']); expect(captures).toBe(1);
    expect(service.getState().queue?.map(item => item.attempts)).toEqual([1, 2, 1]);
    expect(service.getState().queue![0]).toEqual(before.queue![0]); expect(service.getState().queue![2]).toEqual(before.queue![2]);
    await expect(service.retry({ jobId: before.id!, taskId: before.queue![0].id })).rejects.toThrow();
  });
  it('cancels active and waiting items while retaining completed output, then retries one cancelled item', async () => {
    const active = deferred<DownloadResult>(); let runs = 0; let activeSignal!: AbortSignal;
    const { service } = harness({ capture: async () => batchCapture(), download: async (options, signal) => {
      runs++; if (runs === 2) { activeSignal = signal; return active.promise; }
      return outputFor(options.captured!.tracks[0].id);
    } });
    await start(service); await phase(service, 'choosing'); await selectBatch(service);
    await expect.poll(() => runs).toBe(2);
    const jobId = service.getState().id!; const cancelling = service.cancel({ jobId });
    expect(activeSignal.aborted).toBe(true); await expect(start(service)).rejects.toThrow();
    await expect(service.retry({ jobId, taskId: service.getState().queue![0].id })).rejects.toThrow();
    active.resolve(outputFor('two')); await cancelling;
    expect(service.getState().phase).toBe('cancelled');
    expect(service.getState().queue?.map(item => [item.phase, item.attempts, item.canRetry])).toEqual([['completed', 1, false], ['cancelled', 1, true], ['cancelled', 0, true]]);
    expect(service.getState().queue![0].outputPath).toBe('/downloads/one-0/video.mp4');
    await service.retry({ jobId, taskId: service.getState().queue![2].id }); await phase(service, 'partial');
    expect(runs).toBe(3); expect(service.getState().queue?.map(item => item.phase)).toEqual(['completed', 'cancelled', 'completed']);
  });
  it('ignores callbacks from earlier queue items and keeps item progress independent', async () => {
    const next = deferred<DownloadResult>(); let late!: NonNullable<DownloadOptions['onEvent']>; let current!: NonNullable<DownloadOptions['onEvent']>;
    const { service } = harness({ capture: async () => batchCapture(), download: async options => {
      const name = options.captured!.tracks[0].id;
      if (name === 'one-0') { late = options.onEvent!; return outputFor(name); }
      if (name === 'two-0') { current = options.onEvent!; return next.promise; }
      return outputFor(name);
    } });
    await start(service); await phase(service, 'choosing'); await selectBatch(service); await expect.poll(() => !!current).toBe(true);
    const event: RunEvent = { id: 'event', runId: 'capture', sequence: 1, timestamp: new Date().toISOString(), phase: 'download', action: 'download:progress', status: 'running', purpose: '', relatedIds: [], inputSummary: { sourceRequestId: 'source-two-0' }, evidence: { receivedBytes: 400, totalBytes: 1000 } };
    current(event); expect(service.getState().queue![1].tracks[0].downloadedBytes).toBe(400);
    const snapshot = service.getState(); late({ ...event, phase: 'ffmpeg', action: 'remux:command' }); expect(service.getState()).toEqual(snapshot);
    next.resolve(outputFor('two')); await phase(service, 'completed');
  });
  it('expires retry credentials after ten minutes while preserving readable completed results', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { service } = harness({ download: async () => { throw new Error('临时失败'); } });
    await start(service); await flush(); expect(service.getState().phase).toBe('failed');
    const state = service.getState(); expect(state.queue![0].canRetry).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(service.getState().queue![0].canRetry).toBe(false); expect(service.getState().queue![0].message).toMatch(/重新解析/);
    await expect(service.retry({ jobId: state.id!, taskId: state.queue![0].id })).rejects.toThrow(/重新解析/);
  });
  it('uses the original validated batch directory for each reveal and rejects foreign task ids', async () => {
    const opened: string[][] = [];
    const { service } = harness({ capture: async () => batchCapture(), download: async options => outputFor(options.captured!.tracks[0].id), chooseDirectory: async () => '/next-downloads', reveal: async (path, directory) => { opened.push([path, directory]); } });
    await start(service); await phase(service, 'choosing'); await selectBatch(service); await phase(service, 'completed');
    const state = service.getState(); await service.chooseDirectory();
    await service.reveal({ jobId: state.id!, taskId: state.queue![2].id });
    expect(opened).toEqual([['/downloads/three-0/video.mp4', '/downloads']]);
    await expect(service.reveal({ jobId: state.id!, taskId: 'foreign' })).rejects.toThrow();
    await expect(service.reveal({ jobId: 'stale', taskId: state.queue![2].id })).rejects.toThrow();
  });
  it('strictly rejects malformed direct selections without ending the choosing stage', async () => {
    const { service } = harness({ capture: async () => batchCapture() });
    await start(service); await phase(service, 'choosing'); const jobId = service.getState().id!;
    const bad = [
      { jobId, mode: 'single', selections: [{ candidateIndex: 1 }, { candidateIndex: 2 }] },
      { jobId, mode: 'batch', selections: [] },
      { jobId, mode: 'batch', selections: Array.from({ length: 101 }, () => ({ candidateIndex: 1 })) },
      { jobId, mode: 'batch', selections: [{ candidateIndex: 1, rawUrl: 'https://private' }] },
      { jobId, mode: 'batch', selections: [{ candidateIndex: 1 }], outputDirectory: '/etc' },
      { jobId, mode: 'batch', selections: [{ candidateIndex: 1 }], indices: [1] },
      { jobId, indices: [1, 2] },
      { jobId, mode: 'unknown', selections: [{ candidateIndex: 1 }] }
    ];
    for (const request of bad) await expect(service.select(request as Parameters<DownloadService['select']>[0])).rejects.toThrow();
    expect(service.getState().phase).toBe('choosing'); await service.cancel({ jobId });
  });
});

describe('desktop queue safety boundaries', () => {
  it('does not expose captured header values embedded in titles, downloader messages, or errors', async () => {
    const capture = captured();
    capture.requests = [{ id: 'source-pair-0', url: 'https://cdn.example/raw?sign=raw-signature', method: 'GET', requestHeaders: { 'X-Client': 'captured-private-client', Authorization: 'Bearer captured-private-bearer' } }];
    capture.summary.title = '作品 captured-private-client';
    const { service, states } = harness({ capture: async () => capture, download: async () => { throw new Error('拒绝 captured-private-client {"Authorization":"Bearer captured-private-bearer"}'); } });
    await start(service); await phase(service, 'failed');
    expect(JSON.stringify(states)).not.toMatch(/captured-private|raw-signature|cdn\.example/);
  });
  it('keeps validation and cancellation locked and never captures after cancellation', async () => {
    const validation = deferred<string | void>(); let captures = 0;
    const { service } = harness({ validateDirectory: async () => validation.promise, capture: async () => { captures++; return captured(); } });
    await start(service); await expect(start(service)).rejects.toThrow();
    const cancelling = service.cancel({ jobId: service.getState().id! });
    await expect(service.chooseDirectory()).rejects.toThrow(); validation.resolve('/downloads'); await cancelling;
    expect(service.getState().phase).toBe('cancelled'); expect(captures).toBe(0);
  });
  it('reserves the cancellation promise before notifying observers about a new job', async () => {
    let captures = 0; let cancelled!: Promise<void>;
    const { service } = harness({ capture: async () => { captures++; return captured(); } });
    service.onState(state => { if (state.phase === 'parsing' && state.message.includes('正在后台读取')) cancelled = service.cancel({ jobId: state.id! }); });
    await start(service); await cancelled;
    expect(service.getState().phase).toBe('cancelled'); expect(captures).toBe(0);
  });
  it('rejects paths outside the batch root per item and preserves valid later results', async () => {
    const { service } = harness({ capture: async () => batchCapture(), download: async options => {
      const name = options.captured!.tracks[0].id;
      return name === 'two-0' ? { ...result, outputPath: '/elsewhere/secret.mp4', reportPath: '/elsewhere/private.json' } : outputFor(name);
    } });
    await start(service); await phase(service, 'choosing'); await selectBatch(service); await phase(service, 'partial');
    const state = service.getState(); expect(state.queue?.map(item => item.phase)).toEqual(['completed', 'failed', 'completed']);
    expect(JSON.stringify(state)).not.toContain('/elsewhere');
    await expect(service.reveal({ jobId: state.id!, taskId: state.queue![1].id })).rejects.toThrow();
    const edited = service.getState(); edited.queue![2].outputPath = '/etc/passwd';
    expect(service.getState().queue![2].outputPath).toBe('/downloads/three-0/video.mp4');
  });
  it('invalidates old task ids after a new parse and clears retry capability on shutdown', async () => {
    const { service } = harness({ download: async () => { throw new Error('失败'); } });
    await start(service); await phase(service, 'failed'); const old = service.getState();
    await start(service); await phase(service, 'failed'); const current = service.getState();
    await expect(service.retry({ jobId: old.id!, taskId: old.queue![0].id })).rejects.toThrow();
    await expect(service.reveal({ jobId: current.id!, taskId: old.queue![0].id })).rejects.toThrow();
    await service.shutdown(); expect(service.getState().queue![0].canRetry).toBe(false);
    await expect(service.retry({ jobId: current.id!, taskId: current.queue![0].id })).rejects.toThrow(/关闭|重新解析/);
  });
  it('pauses credential expiry while a retry is active and starts a fresh window afterwards', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const retryResult = deferred<DownloadResult>(); let attempts = 0;
    const { service } = harness({ download: async () => { attempts++; if (attempts === 1) throw new Error('失败'); return retryResult.promise; } });
    await start(service); await flush(); const state = service.getState();
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
    await service.retry({ jobId: state.id!, taskId: state.queue![0].id }); await flush();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(service.getState().phase).toBe('downloading');
    retryResult.resolve(result); await flush(); expect(service.getState().phase).toBe('completed');
  });
});

it('summarizes complete and silent track-only results separately and marks mixed output partial', async () => {
  const { service } = harness({ capture: async () => batchCapture(), download: async options => {
    const name = options.captured!.tracks[0].id;
    return name === 'two-0' ? { ...outputFor(name), status: 'tracks-only' } : outputFor(name);
  } });
  await start(service); await phase(service, 'choosing'); await selectBatch(service); await phase(service, 'partial');
  expect(service.getState().queue?.map(item => item.phase)).toEqual(['completed', 'tracks-only', 'completed']);
  expect(service.getState().message).toMatch(/2.*完成.*1.*仅单轨.*0.*失败.*0.*取消/);
});

it('rejects new work while shutdown is releasing an active capture', async () => {
  const captureDone = deferred<CaptureResult>(); let attempt: Promise<unknown> | undefined;
  const { service } = harness({ capture: async () => captureDone.promise });
  service.onState(state => { if (state.phase === 'cancelled' && !attempt) attempt = start(service).then(() => 'accepted', () => 'rejected'); });
  await start(service); await flush(); const shuttingDown = service.shutdown(); captureDone.resolve(captured()); await shuttingDown;
  expect(await attempt).toBe('rejected');
  await expect(start(service)).rejects.toThrow();
});

describe('target-work desktop flow', () => {
  it('refuses unrelated captured sources when work ownership is unresolved', async () => {
    const download = vi.fn(async () => result);
    const { service } = harness({ capture: async () => ({ ...captured(), target: { workId: '7684438409082866998', status: 'unresolved' } }), download });
    await start(service); await phase(service, 'failed');
    expect(download).not.toHaveBeenCalled();
    expect(service.getState().message).toContain('对应的视频');
    expect(service.getState().captureFallback).toBe(true);
  });
  it('presents one target with variants and preserves each variant’s declared audio pairing', async () => {
    const first = asset('720', ['video', 'audio']), second = asset('1080', ['video', 'audio']);
    first.tracks[0].height = 720; second.tracks[0].height = 1080;
    const download = vi.fn<DownloadServiceDependencies['download']>(async () => result);
    const { service } = harness({ capture: async () => ({ ...captured([first, second]), target: { workId: '7684438409082866998', status: 'matched' } }), download });
    await start(service); await phase(service, 'choosing');
    const state = service.getState();
    expect(state.targetWorkId).toBe('7684438409082866998');
    expect(new Set(state.candidates.map(candidate => candidate.groupKey)).size).toBe(1);
    expect(state.candidates.every(candidate => candidate.kind === 'pair')).toBe(true);
    await service.select({ jobId: state.id!, mode: 'single', selections: [{ candidateIndex: 2 }] });
    await phase(service, 'completed');
    expect(download.mock.calls[0][0].captured?.tracks.map(track => track.id)).toEqual(['1080-0', '1080-1']);
  });
});
