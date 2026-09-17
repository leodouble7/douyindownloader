import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopDownloaderApi, DownloadSnapshot } from '../shared/desktop';

const downloader: DesktopDownloaderApi = {
  getState: () => ipcRenderer.invoke('downloader:get-state'),
  chooseDirectory: () => ipcRenderer.invoke('downloader:choose-directory'),
  start: input => ipcRenderer.invoke('downloader:start', input),
  select: input => ipcRenderer.invoke('downloader:select', input),
  retry: input => ipcRenderer.invoke('downloader:retry', input),
  cancel: input => ipcRenderer.invoke('downloader:cancel', input),
  reveal: input => ipcRenderer.invoke('downloader:reveal', input),
  continueDownload: input => ipcRenderer.invoke('downloader:continue-download', input),
  getHistory: input => ipcRenderer.invoke('downloader:get-history', input),
  revealHistory: input => ipcRenderer.invoke('downloader:reveal-history', input),
  onState: listener => {
    const callback = (_event: Electron.IpcRendererEvent, state: DownloadSnapshot) => listener(state);
    ipcRenderer.on('downloader:state', callback);
    return () => { ipcRenderer.removeListener('downloader:state', callback); };
  }
};
contextBridge.exposeInMainWorld('downloader', downloader);
