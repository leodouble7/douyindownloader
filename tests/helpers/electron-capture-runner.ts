import { app, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { BrowserController } from '../../src/main/browser/browser-controller';
import type { CaptureObservation } from '../../src/shared/contracts';
import type { EmitRunEventInput } from '../../src/main/runs/run-orchestrator';

app.commandLine.appendSwitch('site-per-process');
const [baseUrl, output] = process.argv.slice(2);
void app.whenReady().then(async () => {
  const observations: CaptureObservation[] = [];
  const events: EmitRunEventInput[] = [];
  const host = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const browser = new BrowserController({ host, emit: (event) => { events.push(event); }, observe: (observation) => { observations.push(observation); } });
  try {
    const view = await browser.open({ runId: 'integration', targetUrl: `${baseUrl}/open-range/watch`, authorizationConfirmed: true });
    const contents = view.webContents;
    const firstSession = contents.session;
    // Cross-site iframe forces an actual child target/session in addition to the lab's same-site frame.
    await view.webContents.executeJavaScript(`(() => { const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(baseUrl.replace('127.0.0.1', 'localhost') + '/open-range/frame')}; document.body.append(frame); })()`);
    await contents.executeJavaScript(`globalThis.sharedCaptureWorker = new SharedWorker(URL.createObjectURL(new Blob([${JSON.stringify(`fetch('${baseUrl}/open-range/video.mp4', {headers:{Range:'bytes=256-383'}});`)}], {type:'application/javascript'})));`);
    // Non-pausing auto-attach can miss a worker's first synchronous request. Exercise
    // a real subsequent request after its Network domain acknowledges activation.
    const workerDeadline = Date.now() + 2000;
    const workerReady = () => {
      const worker = observations.find((item) => item.kind === 'target' && item.targetType === 'worker');
      return worker && events.some((event) => event.action === 'cdp-Network.enable:after' && event.evidence?.targetSession === worker.sessionId);
    };
    while (Date.now() < workerDeadline && !workerReady()) await new Promise((resolve) => setTimeout(resolve, 25));
    await contents.executeJavaScript("labWorker.postMessage('capture-request')");
    const isolated = await view.webContents.executeJavaScript("typeof require === 'undefined' && typeof process === 'undefined' && typeof window.mediaLab === 'undefined'");
    const summary = () => ({
      realPageIdentity: observations.some((item) => item.kind === 'target' && item.targetType === 'page' && /^[0-9A-F]{32}$/i.test(item.targetId)),
      page: observations.some((item) => item.kind === 'target' && item.targetType === 'page'),
      iframe: observations.some((item) => item.kind === 'target' && item.targetType === 'iframe' && item.sessionId),
      sharedWorker: observations.some((item) => item.kind === 'network' && item.targetType === 'shared_worker' && item.sessionId && item.request.sanitizedUrl.includes('video.mp4')),
      worker: observations.some((item) => item.kind === 'network' && item.targetType === 'worker' && item.sessionId && item.request.sanitizedUrl.includes('video.mp4')),
      serviceWorker: observations.some((item) => item.kind === 'network' && item.targetType === 'service_worker' && item.sessionId && item.request.sanitizedUrl.includes('video.mp4')),
      blob: observations.some((item) => item.kind === 'mse' && item.metadata.type === 'object-url'),
      sourceBuffers: new Set(observations.filter((item) => item.kind === 'mse' && item.metadata.type === 'source-buffer').map((item) => item.kind === 'mse' && item.metadata.type === 'source-buffer' ? item.metadata.sourceBufferId : '')).size,
      appends: observations.some((item) => item.kind === 'mse' && item.metadata.type === 'append' && item.metadata.byteLength > 0),
      direct: observations.some((item) => item.kind === 'network' && item.stage === 'response' && item.request.sanitizedUrl.includes('video.mp4') && item.request.status === 206),
      dash: observations.some((item) => item.kind === 'network' && item.stage === 'response' && item.request.mimeType === 'application/dash+xml'),
      isolated
    });
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && !Object.values(summary()).every((value) => value === true || value === 2)) await new Promise((resolve) => setTimeout(resolve, 50));
    process.stderr.write(JSON.stringify(summary()) + '\n');
    process.stderr.write(await contents.executeJavaScript("document.querySelector('#dash-status').textContent") + '\n');
    await browser.close('integration');
    const firstSummary = summary();
    const hlsView = await browser.open({ runId: 'hls', targetUrl: `${baseUrl}/segment-token/watch`, authorizationConfirmed: true });
    const partitionIsolated = hlsView.webContents.session !== firstSession;
    const hlsDeadline = Date.now() + 5000;
    const hasHlsSegments = () => observations.filter((item) => item.kind === 'network' && item.stage === 'response' && item.runId === 'hls' && item.request.sanitizedUrl.includes('segment-') && item.request.mimeType === 'video/mp2t').length >= 2;
    while (Date.now() < hlsDeadline && !hasHlsSegments()) await new Promise((resolve) => setTimeout(resolve, 50));
    await browser.close('hls');
    const externalView = await browser.open({ runId: 'external-close', targetUrl: `${baseUrl}/open-range/frame`, authorizationConfirmed: true });
    externalView.webContents.close({ waitForBeforeUnload: false });
    await browser.close('external-close');
    const externallyClosed = events.some((event) => event.runId === 'external-close' && event.action === 'browser-close:after');
    await writeFile(output, JSON.stringify({ summary: { ...firstSummary, hls: hasHlsSegments(), partitionIsolated, externallyClosed, closed: contents.isDestroyed() }, events, observations }));
  } catch (error) { await writeFile(output, JSON.stringify({ error: String(error), events, observations })); }
  finally { await browser.close('external-close'); await browser.close('hls'); await browser.close('integration'); host.destroy(); app.quit(); }
});
