export type DownloadPhase = 'idle' | 'parsing' | 'choosing' | 'downloading' | 'merging' | 'verifying' | 'completed' | 'partial' | 'tracks-only' | 'cancelled' | 'failed';

export type DownloadMode = 'single' | 'batch';
export interface DownloadStartRequest { url: string; directory: string; interactive?: boolean }
export interface DownloadSelection { candidateIndex: number; audioIndex?: number }
export type DownloadSelectionRequest = { jobId: string } & (
  { mode: DownloadMode; selections: DownloadSelection[] } | { indices: number[] }
);

export interface DownloadCandidate {
  index: number;
  kind: 'video' | 'audio' | 'muxed' | 'pair' | 'unknown';
  byteLength?: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  codecs?: string;
  groupKey?: string;
  groupLabel?: string;
  grouping?: 'confirmed' | 'unconfirmed';
  variantLabel?: string;
  duplicateCount?: number;
  audioOptions?: number[];
}

export interface DownloadQueueItem {
  id: string;
  label: string;
  phase: Exclude<DownloadPhase, 'idle' | 'parsing' | 'choosing' | 'partial'> | 'queued';
  message: string;
  tracks: TrackProgress[];
  attempts: number;
  canRetry: boolean;
  outputPath?: string;
  reportPath?: string;
}

export interface TrackProgress {
  id: string;
  kind: string;
  downloadedBytes: number;
  totalBytes?: number;
  bytesPerSecond: number;
  status: 'queued' | 'running' | 'completed';
}

/** Product snapshots contain display metadata only, never captured URLs or request headers. */
export interface DownloadSnapshot {
  sequence: number;
  id?: string;
  phase: DownloadPhase;
  directory: string;
  resultDirectory?: string;
  captureFallback?: boolean;
  captureMode?: 'background' | 'interactive';
  title?: string;
  targetWorkId?: string;
  message: string;
  candidates: DownloadCandidate[];
  tracks: TrackProgress[];
  outputPath?: string;
  reportPath?: string;
  mode?: DownloadMode;
  queue?: DownloadQueueItem[];
}

export interface DesktopDownloaderApi {
  getState(): Promise<DownloadSnapshot>;
  chooseDirectory(): Promise<string | null>;
  start(input: DownloadStartRequest): Promise<void>;
  select(input: DownloadSelectionRequest): Promise<void>;
  retry(input: { jobId: string; taskId: string }): Promise<void>;
  cancel(input: { jobId: string }): Promise<void>;
  reveal(input: { jobId: string; taskId?: string }): Promise<void>;
  onState(listener: (state: DownloadSnapshot) => void): () => void;
}

export const isDownloadActive = (phase: DownloadPhase): boolean =>
  ['parsing', 'choosing', 'downloading', 'merging', 'verifying'].includes(phase);

declare global {
  interface Window { downloader: DesktopDownloaderApi }
}
