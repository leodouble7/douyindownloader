import { randomUUID } from 'node:crypto';
import { WebContentsView, type BrowserWindow, type WebContents, type Session } from 'electron';
import type { CaptureObservation } from '../../shared/contracts';
import type { EphemeralRequest } from '../runs/run-orchestrator';
import { CdpCapture, type CaptureEventSink } from './cdp-capture';
import { ElectronDebuggerPort } from './debugger-port';

export interface BrowserRun { runId: string; targetUrl: string; authorizationConfirmed: boolean; signal?: AbortSignal }
export interface BrowserControllerOptions {
  host: BrowserWindow;
  rememberRequest?: (runId: string, request: EphemeralRequest) => void;
  emit: CaptureEventSink;
  observe: (observation: CaptureObservation) => void;
}
interface ActiveBrowser { view: WebContentsView; contents: WebContents; session: Session; capture: CdpCapture; removeAbort: () => void; closing?: Promise<void> }

/** Owns the untrusted surface entirely in main. No preload or product IPC is exposed. */
export class BrowserController {
  private readonly runs = new Map<string, ActiveBrowser>();
  constructor(private readonly options: BrowserControllerOptions) {
    options.host.once('closed', () => { for (const runId of this.runs.keys()) void this.close(runId).catch(() => undefined); });
  }
  async open(run: BrowserRun): Promise<WebContentsView> {
    if (!run.authorizationConfirmed) throw new Error('Target authorization is required');
    if (!isHttpUrl(run.targetUrl)) throw new Error('Target must use HTTP or HTTPS');
    if (run.signal?.aborted) throw new Error('Run is cancelled');
    if (this.runs.has(run.runId)) throw new Error('Browser run is already open');
    this.audit(run.runId, 'browser-create', 'before');
    try {
      const view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: `media-lab-${randomUUID()}`, webSecurity: true } });
      const contents = view.webContents;
      const session = contents.session;
      session.setPermissionRequestHandler((_contents, _permission, callback) => { this.audit(run.runId, 'permission-request', 'before'); callback(false); this.audit(run.runId, 'permission-request', 'failed'); });
      session.setPermissionCheckHandler(() => false);
      session.on('will-download', (event) => { this.audit(run.runId, 'automatic-download', 'before'); event.preventDefault(); this.audit(run.runId, 'automatic-download', 'failed'); });
      contents.setWindowOpenHandler(() => { this.audit(run.runId, 'popup', 'before'); this.audit(run.runId, 'popup', 'failed'); return { action: 'deny' }; });
      contents.on('will-attach-webview', (event) => event.preventDefault());
      const guard = (event: Electron.Event, url: string) => {
        if (!isHttpUrl(url)) { this.audit(run.runId, 'unsupported-navigation', 'before'); event.preventDefault(); this.audit(run.runId, 'unsupported-navigation', 'failed'); }
      };
      contents.on('will-navigate', guard);
      contents.on('will-redirect', guard);
      contents.on('will-frame-navigate', (event) => guard(event, event.url));
      session.webRequest.onBeforeRequest((details, callback) => {
        const protocol = new URL(details.url).protocol;
        callback({ cancel: !['http:', 'https:', 'blob:', 'data:', 'about:', 'ws:', 'wss:'].includes(protocol) });
      });
      const capture = new CdpCapture({ runId: run.runId, port: new ElectronDebuggerPort(contents.debugger), emit: this.options.emit, observe: this.options.observe, rememberRequest: request => this.options.rememberRequest?.(run.runId, request), onError: () => { void this.close(run.runId).catch(() => undefined); } });
      const abort = () => { void this.close(run.runId).catch(() => undefined); };
      run.signal?.addEventListener('abort', abort, { once: true });
      this.runs.set(run.runId, { view, contents, session, capture, removeAbort: () => run.signal?.removeEventListener('abort', abort) });
      contents.once('destroyed', abort);
      contents.once('render-process-gone', () => { this.audit(run.runId, 'target-renderer', 'failed'); abort(); });
      this.options.host.contentView.addChildView(view);
      view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
      view.setVisible(false);
      this.audit(run.runId, 'browser-create', 'after');
      this.audit(run.runId, 'target-initialize', 'before');
      await contents.loadURL('about:blank');
      this.audit(run.runId, 'target-initialize', 'after');
      await capture.start({ targetId: String(contents.id), type: 'page', url: run.targetUrl });
      if (run.signal?.aborted || contents.isDestroyed()) throw new Error('Run is cancelled');
      this.audit(run.runId, 'navigation', 'before');
      try { await contents.loadURL(run.targetUrl); this.audit(run.runId, 'navigation', 'after'); }
      catch (error) { this.audit(run.runId, 'navigation', 'failed'); throw error; }
      return view;
    } catch (error) {
      this.audit(run.runId, 'browser-open', 'failed');
      await this.close(run.runId);
      throw error;
    }
  }
  setBounds(runId: string, bounds: { x: number; y: number; width: number; height: number } | null): void {
    const active = this.runs.get(runId); if (!active || active.closing) return;
    if (!bounds) { active.view.setVisible(false); return; }
    const size = this.options.host.getContentBounds();
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) || bounds.x < 12 || bounds.y < 160 || bounds.width < 1 || bounds.height < 1 || bounds.width > 640 || bounds.height > 420 || bounds.x + bounds.width > size.width - 12 || bounds.y + bounds.height > size.height - 12) { active.view.setVisible(false); throw new Error('Invalid target aperture'); }
    active.view.setBounds(bounds); active.view.setVisible(true);
  }
  async close(runId: string): Promise<void> {
    const active = this.runs.get(runId);
    if (!active) return;
    active.closing ??= this.closeActive(runId, active);
    return active.closing;
  }
  private async closeActive(runId: string, active: ActiveBrowser): Promise<void> {
    this.audit(runId, 'browser-close', 'before');
    active.removeAbort();
    const session = active.session;
    try {
      let captureFailure: unknown;
      try { await active.capture.stop(); } catch (error) { captureFailure = error; }
      if (!this.options.host.isDestroyed()) this.options.host.contentView.removeChildView(active.view);
      if (!active.contents.isDestroyed()) active.contents.close({ waitForBeforeUnload: false });
      await session.closeAllConnections();
      await session.clearStorageData();
      await session.clearCache();
      if (captureFailure) throw captureFailure;
      this.audit(runId, 'browser-close', 'after');
    } catch (error) { this.audit(runId, 'browser-close', 'failed'); throw error; }
    finally {
      session.webRequest.onBeforeRequest(null);
      session.setPermissionRequestHandler(null);
      session.setPermissionCheckHandler(null);
      session.removeAllListeners('will-download');
      this.runs.delete(runId);
    }
  }
  private audit(runId: string, action: string, stage: 'before' | 'after' | 'failed'): void {
    this.options.emit({ runId, phase: 'browser', action: `${action}:${stage}`, purpose: 'Manage isolated authorized target browser', status: stage === 'before' ? 'running' : stage === 'after' ? 'succeeded' : 'failed', relatedIds: [] });
  }
}
function isHttpUrl(value: string): boolean {
  try { const url = new URL(value); return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password; } catch { return false; }
}
