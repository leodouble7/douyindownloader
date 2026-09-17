import { afterEach, expect, it, vi } from 'vitest';
import type { CaptureOptions } from '../../src/main/browser/cdp-capture';
import type { DouyinWorkIndex } from '../../src/main/douyin/target-work';

const state = vi.hoisted(() => ({
  captureFlush: vi.fn(), captureStop: vi.fn(), observerFlush: vi.fn(), observerStop: vi.fn(), destroy: vi.fn(),
  page: 'https://www.douyin.com/video/123', video: 'https://cdn.test/video.mp4', status: 200, navigations: [] as string[]
}));
vi.mock('electron', () => ({
  app: { whenReady: async () => undefined },
  BrowserWindow: class {
    on = vi.fn(); removeListener = vi.fn(); isDestroyed = () => false; destroy = state.destroy;
    webContents = {
      id: 1, debugger: {}, on: vi.fn(), stop: vi.fn(), setAudioMuted: vi.fn(), setWindowOpenHandler: vi.fn(),
      loadURL: async (url: string) => { state.navigations.push(url); }, getURL: () => state.page,
      executeJavaScript: async () => ({ title: 'page', excerpt: '', videoElements: 1 }),
      session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn(),
        webRequest: { onBeforeRequest: vi.fn() }, closeAllConnections: async () => undefined, clearStorageData: async () => undefined, clearCache: async () => undefined }
    };
  }
}));
vi.mock('../../src/main/browser/debugger-port', () => ({ ElectronDebuggerPort: class {} }));
vi.mock('../../src/main/media/media-correlator', () => ({ MediaCorrelator: class {
  ingest() { return [{ id: 'asset', runId: 'run', tracks: [{ id: 'track', assetId: 'asset', kind: 'video', sourceRequestIds: ['source'], detectionReasons: [] }], sourceRequestIds: ['source'], trackIds: ['track'], selectedTrackIds: ['track'], detectionReasons: [], confidence: 1, detectedAt: '' }]; }
} }));
vi.mock('../../src/main/browser/cdp-capture', () => ({ CdpCapture: class {
  constructor(private options: CaptureOptions) {}
  async start() {
    this.options.rememberRequest?.({ id: 'source', url: state.video, method: 'GET', requestHeaders: {} });
    this.options.observe({ kind: 'network', stage: 'finished', request: { id: 'source', status: state.status } } as Parameters<CaptureOptions['observe']>[0]);
  }
  flush = state.captureFlush; stop = state.captureStop;
} }));
vi.mock('../../src/main/douyin/work-observer', () => ({ observeDouyinWork: (_port: unknown, index: DouyinWorkIndex) => {
  // Response-body ingestion happens after navigation; readiness must keep listening for it.
  setTimeout(() => index.ingest(JSON.stringify({ awemeId: '123', desc: 'target', video: { playAddr: [{ src: state.video }], format: 'mp4' } }), 'json'), 1000);
  return { flush: state.observerFlush, stop: state.observerStop };
} }));
import { captureSession } from '../../src/main/douyin/capture-session';

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); state.status = 200; state.navigations = []; });
it.each([403, 500])('does not finish early or retain completed HTTP %s media', async status => {
  vi.useFakeTimers(); state.status = status;
  const task = captureSession({ pageUrl: state.page, observeSeconds: 30, show: true }, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(29000);
  expect(state.captureFlush).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  const result = await task;
  expect(result.requests).toEqual([]);
  expect(result.target?.status).not.toBe('matched');
  expect(vi.getTimerCount()).toBe(0);
});
it.each(['https://www.douyin.com/video/123', 'https://www.douyin.com/root/search/dance?modal_id=123&type=general'])('captures %s through the work page and awaits both terminal drains', async pageUrl => {
  vi.useFakeTimers();
  state.captureFlush.mockImplementation(() => new Promise<void>(resolve => setTimeout(resolve, 100)));
  state.observerFlush.mockImplementation(() => new Promise<void>(resolve => setTimeout(resolve, 100)));
  state.captureStop.mockResolvedValue(undefined);
  const done = vi.fn();
  const task = captureSession({ pageUrl, observeSeconds: 30, show: true }, new AbortController().signal).then(result => { done(); return result; });
  await vi.advanceTimersByTimeAsync(2500);
  expect(state.observerFlush).not.toHaveBeenCalled(); expect(state.captureFlush).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(250);
  expect(state.captureFlush).toHaveBeenCalledOnce(); expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(state.observerFlush).toHaveBeenCalledOnce(); expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  const result = await task;
  expect(state.navigations).toEqual(['about:blank', state.page]);
  expect(result.target).toEqual({ workId: '123', status: 'matched' });
  expect(result.requests.map(request => request.id)).toEqual(['source']);
  expect(result.assets[0].tracks[0].kind).toBe('muxed');
  expect(state.captureStop).toHaveBeenCalledOnce(); expect(state.observerStop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
