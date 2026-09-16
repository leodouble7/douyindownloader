import { app, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { captureSession } from '../../src/main/douyin/capture-session';
import { saveDesktopDownload } from '../../src/main/desktop/save-download';
import { selectMedia } from '../../src/main/douyin/options';
import { MemoryEventRepository } from '../../src/main/desktop/memory-event-repository';
import { electronOutputWorkerLauncher } from '../../src/main/desktop/output-worker';

const [origin, directory, output, worker] = process.argv.slice(2);
void app.whenReady().then(async () => {
  const host = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    let captureWindowHidden = false, captureAudioMuted = false;
    app.once('browser-window-created', (_event, created) => {
      created.webContents.once('dom-ready', () => { captureWindowHidden = !created.isVisible(); captureAudioMuted = created.webContents.isAudioMuted(); });
    });
    const captured = await captureSession({ pageUrl: `${origin}/watch`, observeSeconds: 2, show: false }, new AbortController().signal);
    const hostSurvivedCapture = !host.isDestroyed() && BrowserWindow.getAllWindows().length === 1;
    const result = await saveDesktopDownload({ outputDirectory: directory, captured: { runId: captured.runId, tracks: selectMedia(captured.assets), requests: captured.requests }, networkPolicy: { labLoopback: [{ origin, address: '127.0.0.1' }] }, createEventRepository: () => new MemoryEventRepository(), outputWorkerLauncher: electronOutputWorkerLauncher, outputWorkerModulePath: worker }, new AbortController().signal);
    const controller = new AbortController(); const cancelled = captureSession({ pageUrl: `${origin}/watch`, observeSeconds: 30, show: false }, controller.signal); setTimeout(() => controller.abort(), 200);
    let cancellation = ''; try { await cancelled; } catch (error) { cancellation = (error as Error).name; }
    const hostSurvivedCancellation = !host.isDestroyed() && BrowserWindow.getAllWindows().length === 1;
    const hungController = new AbortController(); let summaryReadStarted = false; let abortedAt = 0;
    // Observe the actual remote call, then abort while the fixture's infinite loop prevents its reply.
    app.once('browser-window-created', (_event, created) => {
      const execute = created.webContents.executeJavaScript.bind(created.webContents);
      created.webContents.executeJavaScript = (code, userGesture) => {
        summaryReadStarted = true; setTimeout(() => { abortedAt = Date.now(); hungController.abort(); }, 200);
        return execute(code, userGesture);
      };
    });
    const hungCapture = captureSession({ pageUrl: `${origin}/hang`, observeSeconds: 1, show: false }, hungController.signal)
      .then(() => 'unexpected-success', error => (error as Error).name);
    const hungCancellation = await Promise.race([hungCapture, wait(4000).then(() => 'still-pending')]);
    const hungCancellationMs = Date.now() - abortedAt;
    const hostSurvivedHungCancellation = !host.isDestroyed() && BrowserWindow.getAllWindows().length === 1;
    await writeFile(output, JSON.stringify({ result, captureWindowHidden, captureAudioMuted, hostSurvivedCapture, hostSurvivedCancellation, cancellation, summaryReadStarted, hungCancellation, hungCancellationMs, hostSurvivedHungCancellation }));
  } catch (error) { await writeFile(output, JSON.stringify({ error: String(error) })); }
  finally { for (const window of BrowserWindow.getAllWindows()) window.destroy(); app.quit(); }
});
