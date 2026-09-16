import { app, BrowserWindow, dialog, ipcMain, utilityProcess } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { BrowserController } from './browser/browser-controller';
import { EventRepository } from './runs/event-repository';
import { WorkbenchService } from './workbench-service';
import { IpcRouter, commandNames } from './ipc';
import type { OutputWorkerLauncher } from './download/output-workspace';
let repository: EventRepository;
const services = new Map<number, WorkbenchService>();
const launchWorker: OutputWorkerLauncher = ({ cwd, modulePath }) => {
  const child = utilityProcess.fork(modulePath, [], { cwd, stdio: 'ignore', serviceName: 'Media Lab output writer' });
  return { send: message => child.postMessage(message), onMessage: callback => { child.on('message', callback); }, onExit: callback => { child.once('exit', callback); }, terminate: () => { child.kill(); } };
};
function createMainWindow(): void {
  const window = new BrowserWindow({ width: 1440, height: 960, minWidth: 400, minHeight: 580, show: false, backgroundColor: '#eef2f5', webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const service = new WorkbenchService({ repository, browserFactory: hooks => new BrowserController({ host: window, ...hooks }), onEvent: event => { if (!window.isDestroyed()) window.webContents.send('media-lab:run-event', event); }, outputWorkerLauncher: launchWorker, outputWorkerModulePath: join(__dirname, 'electron-output-bootstrap.cjs') });
  services.set(window.webContents.id, service);
  // Capture the owner frame for every call; a target or renderer subframe never becomes an owner.
  const router = () => new IpcRouter({ ownerId: window.webContents.id, mainFrame: window.webContents.mainFrame, service, ownsRun: id => service.ownsRun(id), contentSize: () => window.getContentBounds(), chooseDirectory: async () => { const result = await dialog.showOpenDialog(window, { title: '选择本次运行的输出目录', properties: ['openDirectory', 'createDirectory'] }); return result.canceled || !result.filePaths[0] ? null : service.selectDirectory(result.filePaths[0]); } });
  routers.set(window.webContents.id, router);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.once('closed', () => { routers.delete(window.webContents.id); services.delete(window.webContents.id); void service.dispose(); });
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL); else void window.loadFile(join(__dirname, '../renderer/index.html'));
}
const routers = new Map<number, () => IpcRouter>();
void app.whenReady().then(() => {
  mkdirSync(app.getPath('userData'), { recursive: true }); repository = new EventRepository(join(app.getPath('userData'), 'runs.sqlite')); repository.interruptUnfinished();
  for (const name of commandNames) ipcMain.handle(`media-lab:${name}`, (event, payload: unknown) => {
    const router = routers.get(event.sender.id); return router ? router().invoke({ senderId: event.sender.id, frame: event.senderFrame }, name, payload) : { ok: false, error: { code: 'FORBIDDEN', message: '此窗口无权执行该操作。' } };
  });
  createMainWindow(); app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createMainWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
let quitting = false;
app.on('before-quit', event => { if (quitting) return; quitting = true; event.preventDefault(); void Promise.allSettled([...services.values()].map(s => s.dispose())).then(() => { repository?.close(); app.quit(); }); });
