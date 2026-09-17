import { app, BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { CdpCapture } from '../browser/cdp-capture';
import { ElectronDebuggerPort } from '../browser/debugger-port';
import { MediaCorrelator } from '../media/media-correlator';
import type { MediaAsset } from '../../shared/contracts';
import type { EphemeralRequest } from '../runs/run-orchestrator';
import type { CaptureInput, CaptureResult } from './capture-page';
import { DouyinWorkIndex, DouyinWorkLink, isDouyinUrl, resolveWorkId, capturePageUrl } from './target-work';
import { observeDouyinWork } from './work-observer';
import { completedMedia, targetReadinessKey, waitForCapture } from './capture-readiness';

/** Runs inside the current Electron app. Never quits its host process. */
export async function captureSession(input: CaptureInput, externalSignal: AbortSignal): Promise<CaptureResult> {
  input = { ...input, pageUrl: capturePageUrl(input.pageUrl) };
  const localController = new AbortController();
  const signal = AbortSignal.any([externalSignal, localController.signal]);
  let window: BrowserWindow | undefined, capture: CdpCapture | undefined;
  let captureSession: Electron.Session | undefined;
  let workObserver: ReturnType<typeof observeDouyinWork> | undefined;
  let closing = false;
  const onClosed = () => { if (!closing) localController.abort(); };
  const preventDownload = (event: { preventDefault(): void }) => event.preventDefault();
  const closeCaptureWindow = () => {
    if (!window || window.isDestroyed()) return;
    try { window.webContents.stop(); } catch { /* A concurrent renderer exit may already have stopped it. */ }
    window.destroy();
  };
  // Closing the native window does not require the renderer's JavaScript event loop to respond.
  signal.addEventListener('abort', closeCaptureWindow, { once: true });
  try {
    await remoteOperation(() => app.whenReady(), signal, 30000); signal.throwIfAborted();
    const runId = randomUUID();
    const background = input.show === false;
    window = new BrowserWindow({ width: 1200, height: 850, show: !background, title: '抖音网页：请播放要下载的视频',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: !background, autoplayPolicy: background ? 'no-user-gesture-required' : 'document-user-activation-required', partition: `douyin-capture-${runId}` } });
    window.on('closed', onClosed);
    const contents = window.webContents; captureSession = contents.session; const session = captureSession;
    if (background) contents.setAudioMuted(true);
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.on('will-download', preventDownload);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', event => event.preventDefault());
    session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !['http:', 'https:', 'blob:', 'data:', 'about:', 'ws:', 'wss:'].includes(new URL(details.url).protocol) });
    });
    const requests = new Map<string, EphemeralRequest>();
    const completed = new Set<string>();
    const correlator = new MediaCorrelator();
    let assets: MediaAsset[] = [], network = 0, mse = 0;
    const port = new ElectronDebuggerPort(contents.debugger);
    const workLink = new DouyinWorkLink(input.pageUrl);
    contents.on('did-navigate', (_event, url) => workLink.observe(url));
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) workLink.observe(url); });
    const workIndex = isDouyinUrl(input.pageUrl) ? new DouyinWorkIndex(resolveWorkId(input.pageUrl)) : undefined;
    if (workIndex) workObserver = observeDouyinWork(port, workIndex);
    capture = new CdpCapture({ runId, port, emit: () => undefined,
      onError: () => localController.abort(), rememberRequest: request => { requests.set(request.id, request); if (requests.size > 2048) requests.delete(requests.keys().next().value!); },
      observe: observation => {
        if (observation.kind === 'network') {
          network++;
          if (observation.stage === 'finished') {
            const status = observation.request.status;
            if (status !== undefined && status >= 200 && status < 300) completed.add(observation.request.id);
            else completed.delete(observation.request.id);
          }
          if (observation.stage === 'failed') completed.delete(observation.request.id);
        }
        if (observation.kind === 'mse') mse++;
        assets = correlator.ingest(observation);
      } });
    await remoteOperation(() => contents.loadURL('about:blank'), signal);
    await remoteOperation(() => capture!.start({ targetId: String(contents.id), type: 'page', url: input.pageUrl }), signal);
    if (background) await remoteOperation(() => contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: backgroundPlayback(input.observeSeconds) }), signal);
    await remoteOperation(() => contents.loadURL(input.pageUrl), signal, 30000);
    // Metadata bodies settle asynchronously; polling observes ingestion without calling the
    // observer's terminal flush (which unsubscribes and would miss later work metadata).
    await waitForCapture(input.observeSeconds * 1000, signal, workIndex ? () => {
      workLink.observe(contents.getURL());
      return targetReadinessKey(workIndex, input.pageUrl, workLink.resolvedUrl, assets, requests, completed);
    } : undefined);
    await remoteOperation(() => capture!.flush(), signal);
    const page = await remoteOperation(() => contents.executeJavaScript(`({title: document.title, excerpt: (document.body?.innerText || '').slice(0, 800), videoElements: document.querySelectorAll('video').length})`), signal) as Pick<CaptureResult['summary'], 'title' | 'excerpt' | 'videoElements'>;
    if (workObserver) await remoteOperation(() => workObserver!.flush(), signal, 6000);
    workLink.observe(contents.getURL());
    await remoteOperation(() => capture!.stop(), signal); capture = undefined;
    // A later in-flight Range does not invalidate an earlier completed request of the same representation.
    // Only completed immutable source references are handed to the download process.
    const snapshot = completedMedia(assets, requests, completed);
    assets = snapshot.assets;
    const retained = snapshot.requests;
    const target = workIndex?.select(input.pageUrl, workLink.resolvedUrl, assets, retained);
    return { runId, assets: target?.assets ?? assets, requests: target?.requests ?? retained, ...(target ? { target: target.target } : {}), summary: { network, mse, ...page, title: target?.title ?? page.title, author: target?.author } };
  } catch {
    if (signal.aborted) throw new DOMException('页面捕获已取消或浏览器已关闭', 'AbortError');
    throw new Error('页面加载或捕获失败，请检查网络后重试。');
  } finally {
    closing = true; workObserver?.stop();
    signal.removeEventListener('abort', closeCaptureWindow);
    window?.removeListener('closed', onClosed);
    closeCaptureWindow(); localController.abort();
    const cleanupSignal = new AbortController().signal;
    await remoteOperation(() => capture?.stop() ?? Promise.resolve(), cleanupSignal, 5000).catch(() => undefined);
    if (captureSession) {
      captureSession.removeListener('will-download', preventDownload);
      captureSession.webRequest.onBeforeRequest(null);
      captureSession.setPermissionRequestHandler(null); captureSession.setPermissionCheckHandler(null);
      await remoteOperation(() => Promise.allSettled([captureSession!.closeAllConnections(), captureSession!.clearStorageData(), captureSession!.clearCache()]), cleanupSignal, 5000).catch(() => undefined);
    }
  }
}

/** Trigger normal media requests without clicking page controls, login or verification UI. */
function backgroundPlayback(seconds: number): string {
  return `(() => {
    const tryPlayback = () => {
      const videos = [...document.querySelectorAll('video')];
      if (videos.some(video => !video.paused && !video.ended)) return;
      const video = videos.find(video => {
        const rect = video.getBoundingClientRect(), style = getComputedStyle(video);
        return !video.ended && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth && style.visibility !== 'hidden' && style.display !== 'none';
      });
      if (video) { video.muted = true; video.play().catch(() => {}); }
    };
    const timer = setInterval(tryPlayback, 500);
    setTimeout(() => clearInterval(timer), ${Math.max(1000, (seconds + 5) * 1000)});
    addEventListener('DOMContentLoaded', tryPlayback, { once: true });
  })();`;
}

/** Remote Electron calls can stay pending forever when a page blocks its event loop. */
function remoteOperation<T>(operation: () => Promise<T>, signal: AbortSignal, timeoutMs = 15000): Promise<T> {
  signal.throwIfAborted();
  let timer: NodeJS.Timeout | undefined;
  let abort: () => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new DOMException('Capture cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => reject(new Error('Capture operation timed out')), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), interrupted])
    .finally(() => { clearTimeout(timer); signal.removeEventListener('abort', abort); });
}
