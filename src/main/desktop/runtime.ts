import { app, dialog, shell, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureSession } from '../douyin/capture-session';
import { saveDesktopDownload } from './save-download';
import { DownloadService } from './download-service';
import { MemoryEventRepository } from './memory-event-repository';
import { electronOutputWorkerLauncher } from './output-worker';
import { DirectoryPreferences, validateDirectory, validateRevealPath } from './preferences';

export function createDesktopService(getWindow: () => BrowserWindow | undefined): DownloadService {
  const preferences = new DirectoryPreferences(join(app.getPath('userData'), 'downloader-preferences.json'));
  return new DownloadService({
    capture: captureSession,
    download: (options, signal) => saveDesktopDownload({ ...options, createEventRepository: () => new MemoryEventRepository(), outputWorkerLauncher: electronOutputWorkerLauncher, outputWorkerModulePath: fileURLToPath(new URL('./output-worker.cjs', import.meta.url)) }, signal),
    chooseDirectory: async current => {
      const window = getWindow(); if (!window || window.isDestroyed()) throw new Error('主窗口已关闭。');
      const choice = await dialog.showOpenDialog(window, { title: '选择视频保存位置', defaultPath: current || app.getPath('downloads'), properties: ['openDirectory', 'createDirectory'] });
      return choice.canceled ? null : choice.filePaths[0] ?? null;
    },
    validateDirectory,
    loadDirectory: () => preferences.load(),
    saveDirectory: directory => preferences.save(directory),
    reveal: async (path, directory) => { shell.showItemInFolder(await validateRevealPath(path, directory)); }
  });
}
