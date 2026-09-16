import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDesktopService } from './desktop/runtime';
import { registerDesktopIpc } from './desktop/ipc';
import type { DownloadService } from './desktop/download-service';

let mainWindow: BrowserWindow | undefined;
let service: DownloadService | undefined;
let closing = false;
let disposeIpc: (() => void) | undefined;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const rendererPath = join(__dirname, '../renderer/index.html');
const trustedUrl = process.env.ELECTRON_RENDERER_URL || pathToFileURL(rendererPath).href;

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({ width: 1180, height: 800, minWidth: 680, minHeight: 600, show: false, title: '抖音视频下载', backgroundColor: '#101521', webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-navigate', (event, url) => { if (url !== trustedUrl) event.preventDefault(); });
  window.on('close', event => {
    if (closing) return;
    event.preventDefault(); closing = true;
    void service?.shutdown().finally(() => { if (!window.isDestroyed()) window.destroy(); app.quit(); });
  });
  window.on('closed', () => { if (mainWindow === window) mainWindow = undefined; });
  void (process.env.ELECTRON_RENDERER_URL ? window.loadURL(trustedUrl) : window.loadFile(rendererPath));
  return window;
}

void app.whenReady().then(async () => {
  service = createDesktopService(() => mainWindow); await service.initialize();
  disposeIpc = registerDesktopIpc({ ipcMain, getWindow: () => mainWindow, trustedUrl, service });
  mainWindow = createMainWindow();
  app.on('activate', () => { if (!mainWindow && !closing) mainWindow = createMainWindow(); });
});
app.on('before-quit', event => {
  if (closing || !service) return;
  event.preventDefault(); closing = true;
  void service.shutdown().finally(() => { disposeIpc?.(); app.quit(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || closing) app.quit(); });
