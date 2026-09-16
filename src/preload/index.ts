import { contextBridge, ipcRenderer } from 'electron';
import type {
  CancelRunInput,
  ExportReportInput,
  MediaLabApi,
  RunEvent,
  StartDownloadInput,
  StartRunInput
} from '../shared/contracts';

const mediaLab: MediaLabApi = {
  startRun: (input: StartRunInput) => ipcRenderer.invoke('media-lab:start-run', input),
  cancelRun: (input: CancelRunInput) => ipcRenderer.invoke('media-lab:cancel-run', input),
  chooseOutputDirectory: () => ipcRenderer.invoke('media-lab:choose-output-directory'),
  startDownload: (input: StartDownloadInput) => ipcRenderer.invoke('media-lab:start-download', input),
  exportReport: (input: ExportReportInput) => ipcRenderer.invoke('media-lab:export-report', input),
  getRun: input => ipcRenderer.invoke('media-lab:get-run', input),
  listHistory: () => ipcRenderer.invoke('media-lab:list-history'),
  finishObservation: input => ipcRenderer.invoke('media-lab:finish-observation', input),
  finishRun: input => ipcRenderer.invoke('media-lab:finish-run', input),
  setPreview: input => ipcRenderer.invoke('media-lab:set-preview', input),
  onRunEvent: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, payload: RunEvent) => listener(payload);
    ipcRenderer.on('media-lab:run-event', callback);
    return () => ipcRenderer.removeListener('media-lab:run-event', callback);
  }
};

contextBridge.exposeInMainWorld('mediaLab', mediaLab);
