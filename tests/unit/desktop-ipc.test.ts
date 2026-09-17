import { expect, it } from 'vitest';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { registerDesktopIpc } from '../../src/main/desktop/ipc';
import { DownloadService } from '../../src/main/desktop/download-service';

it('rejects foreign senders, child frames, unexpected navigation and malformed request fields', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>();
  const ipcMain = { handle: (name: string, handler: (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) } as unknown as IpcMain;
  const frame = { url: 'file:///app/index.html' }; const contents = { mainFrame: frame, isDestroyed: () => false, send: () => undefined }; const window = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow;
  const service = new DownloadService({ capture: async () => { throw new Error('unused'); }, download: async () => { throw new Error('unused'); }, chooseDirectory: async () => null, validateDirectory: async () => undefined, loadDirectory: async () => '', saveDirectory: async () => undefined, reveal: async () => undefined });
  const dispose = registerDesktopIpc({ ipcMain, getWindow: () => window, trustedUrl: 'file:///app/index.html', service });
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  expect(await handlers.get('downloader:get-state')!(event)).toMatchObject({ phase: 'idle' });
  await expect(handlers.get('downloader:get-state')!({ ...event, sender: {} } as IpcMainInvokeEvent)).rejects.toThrow();
  await expect(handlers.get('downloader:get-state')!({ ...event, senderFrame: { url: frame.url } } as IpcMainInvokeEvent)).rejects.toThrow();
  frame.url = 'https://douyin.com/'; await expect(handlers.get('downloader:get-state')!(event)).rejects.toThrow(); frame.url = 'file:///app/index.html';
  await expect(handlers.get('downloader:start')!(event, { url: 'https://douyin.com/a', directory: '/tmp', networkPolicy: { labLoopback: [] } })).rejects.toThrow();
  await expect(handlers.get('downloader:start')!(event, { url: 'https://douyin.com/a', directory: '/tmp', interactive: 'true' })).rejects.toThrow('请求参数无效');
  await expect(handlers.get('downloader:reveal')!(event, { jobId: 'abc', path: '/etc/passwd' })).rejects.toThrow();
  expect(await handlers.get('downloader:get-history')!(event, { offset: 0 })).toMatchObject({ items: [], total: 0 });
  await expect(handlers.get('downloader:get-history')!(event, { offset: -1 })).rejects.toThrow('请求参数无效');
  await expect(handlers.get('downloader:reveal-history')!(event, { id: 'saved', path: '/etc/passwd' })).rejects.toThrow('请求参数无效');
  await expect(handlers.get('downloader:continue-download')!(event, { jobId: 'old' })).rejects.toThrow();
  await expect(handlers.get('downloader:get-history')!({ ...event, sender: {} } as IpcMainInvokeEvent, { offset: 0 })).rejects.toThrow();
  expect(service.getState().phase).toBe('idle'); dispose(); expect(handlers.size).toBe(0);
});

it('validates bounded explicit selections and task-specific retry and reveal at the trusted boundary', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>();
  const ipcMain = { handle: (name: string, handler: (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) } as unknown as IpcMain;
  const frame = { url: 'file:///app/index.html' }; const contents = { mainFrame: frame, isDestroyed: () => false, send: () => undefined }; const window = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow;
  const accepted: unknown[] = [];
  const service = { start: (input: unknown) => accepted.push(input), select: (input: unknown) => accepted.push(input), retry: (input: unknown) => accepted.push(input), reveal: (input: unknown) => accepted.push(input), onState: () => () => undefined } as unknown as DownloadService;
  const dispose = registerDesktopIpc({ ipcMain, getWindow: () => window, trustedUrl: frame.url, service });
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const request = { jobId: 'job', mode: 'batch', selections: [{ candidateIndex: 1, audioIndex: 2 }, { candidateIndex: 3 }] };
  await handlers.get('downloader:select')!(event, request);
  await handlers.get('downloader:retry')!(event, { jobId: 'job', taskId: 'task' });
  await handlers.get('downloader:reveal')!(event, { jobId: 'job', taskId: 'task' });
  expect(accepted).toEqual([request, { jobId: 'job', taskId: 'task' }, { jobId: 'job', taskId: 'task' }]);
  const manual = { url: 'https://douyin.com/video/123', directory: '/downloads', interactive: true };
  await handlers.get('downloader:start')!(event, manual); expect(accepted.at(-1)).toEqual(manual);
  for (const input of [
    { ...request, selections: [] },
    { ...request, selections: Array.from({ length: 101 }, () => ({ candidateIndex: 1 })) },
    { ...request, mode: 'single' },
    { ...request, selections: [{ candidateIndex: 1, rawUrl: 'https://private' }] },
    { ...request, indices: [1] },
    { ...request, selections: [{ candidateIndex: 0 }] },
    { ...request, selections: [{ candidateIndex: 1.5 }] }
  ]) await expect(handlers.get('downloader:select')!(event, input)).rejects.toThrow('请求参数无效');
  await expect(handlers.get('downloader:retry')!(event, { jobId: 'job', taskId: 'task', path: '/etc' })).rejects.toThrow();
  await expect(handlers.get('downloader:retry')!(event, { jobId: 'job', taskId: '' })).rejects.toThrow();
  await expect(handlers.get('downloader:retry')!({ ...event, sender: {} } as IpcMainInvokeEvent, { jobId: 'job', taskId: 'task' })).rejects.toThrow();
  dispose();
});
