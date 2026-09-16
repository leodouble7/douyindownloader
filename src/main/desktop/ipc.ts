import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { DownloadService } from './download-service';

interface DesktopIpcOptions { ipcMain: IpcMain; getWindow(): BrowserWindow | undefined; trustedUrl: string; service: DownloadService }
const job = z.object({ jobId: z.string().min(1).max(100) }).strict();
const start = z.object({ url: z.string().min(1).max(16384), directory: z.string().min(1).max(4096), interactive: z.boolean().optional() }).strict();
const index = z.number().int().min(1).max(2048);
const selection = z.object({ candidateIndex: index, audioIndex: index.optional() }).strict();
const select = z.union([
  job.extend({ indices: z.array(index).min(1).max(2) }).strict(),
  job.extend({ mode: z.literal('single'), selections: z.array(selection).length(1) }).strict(),
  job.extend({ mode: z.literal('batch'), selections: z.array(selection).min(1).max(100) }).strict()
]);
const retry = job.extend({ taskId: z.string().min(1).max(100) }).strict();
const reveal = job.extend({ taskId: z.string().min(1).max(100).optional() }).strict();
const withoutHash = (url: string): string => { try { const parsed = new URL(url); parsed.hash = ''; return parsed.href; } catch { return ''; } };

/** Every IPC method requires the known top-level renderer frame and exact application URL. */
export function registerDesktopIpc(options: DesktopIpcOptions): () => void {
  const { ipcMain, service, getWindow } = options; const registered: string[] = [];
  const trusted = (event: IpcMainInvokeEvent) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || withoutHash(event.senderFrame.url) !== withoutHash(options.trustedUrl)) throw new Error('请求来源无效。');
  };
  const handle = <T>(name: string, schema: z.ZodType<T>, action: (input: T) => unknown) => {
    const channel = `downloader:${name}`; registered.push(channel);
    ipcMain.handle(channel, async (event, input: unknown) => {
      trusted(event); const parsed = schema.safeParse(input); if (!parsed.success) throw new Error('请求参数无效。');
      return action(parsed.data);
    });
  };
  handle('get-state', z.undefined(), () => service.getState());
  handle('choose-directory', z.undefined(), () => service.chooseDirectory());
  handle('start', start, input => service.start(input));
  handle('select', select, input => service.select(input));
  handle('retry', retry, input => service.retry(input));
  handle('cancel', job, input => service.cancel(input));
  handle('reveal', reveal, input => service.reveal(input));
  const unsubscribe = service.onState(state => {
    const window = getWindow();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed() && withoutHash(window.webContents.mainFrame.url) === withoutHash(options.trustedUrl)) window.webContents.send('downloader:state', state);
  });
  return () => { unsubscribe(); registered.forEach(channel => ipcMain.removeHandler(channel)); };
}
