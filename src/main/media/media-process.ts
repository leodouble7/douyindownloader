import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, lstatSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class MediaToolError extends Error {
  readonly outcome = 'inconclusive';
  constructor(readonly code: string) { super(code); this.name = code === 'cancelled' ? 'AbortError' : 'MediaToolError'; }
}
export interface MediaProcessOptions {
  executable: string; args: string[]; signal: AbortSignal; mode: 'probe' | 'remux' | 'timing';
  /** Owned open handles only: this layer never opens a media pathname. */
  output?: FileHandle; input?: { handle: FileHandle; size: number }; maxOutputBytes?: number;
  descriptors?: number[]; cwd?: string; timeoutMs: number; killGraceMs: number;
  onProgress?: (progress: Record<string, number | boolean>) => void;
}
const MAX_JSON = 1024 * 1024; const MAX_DIAGNOSTICS = 65536; const MAX_PROGRESS = 4 * 1024 * 1024;
const CHUNK_SIZE = 65536;

/** An app.asar executable must be launched from its unpacked physical location. */
export function resolveWindowsMediaRunner(): string {
  const adjacent = fileURLToPath(new URL('./media-job-runner.exe', import.meta.url)).replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');
  const packaged = !!process.versions.electron && !(process as NodeJS.Process & { defaultApp?: boolean }).defaultApp;
  const candidates = packaged ? [adjacent] : [adjacent, fileURLToPath(new URL('../../../native/windows-media-runner/build/Release/media_job_runner.exe', import.meta.url))];
  for (const candidate of candidates) {
    try { const info = lstatSync(candidate); if (isAbsolute(candidate) && info.isFile() && !info.isSymbolicLink()) { accessSync(candidate, constants.X_OK); return candidate; } } catch { /* A missing runner is a local-tool failure, never a reason to launch uncontained. */ }
  }
  throw new MediaToolError('windows-media-runner-unavailable');
}

/** Direct contained execution; binary media, probe JSON, and progress never share a parser or buffer. */
export function runMediaProcess(options: MediaProcessOptions): Promise<string> {
  const { signal, mode, output, input } = options;
  if (signal.aborted) return Promise.reject(new MediaToolError('cancelled'));
  const maxOutputBytes = options.maxOutputBytes ?? 1024 ** 4;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1024 ** 4 || (mode === 'remux' && !output)) return Promise.reject(new MediaToolError('invalid-tool-limit'));
  let executable = options.executable; let args = options.args;
  try { if (process.platform === 'win32') { executable = resolveWindowsMediaRunner(); args = [String(process.pid), options.executable, ...options.args]; } }
  catch (error) { return Promise.reject(error); }
  return new Promise((resolveRun, reject) => {
    let child: ChildProcess;
    try { child = spawn(executable, args, { shell: false, detached: process.platform !== 'win32', windowsHide: true, cwd: options.cwd, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe', ...(options.descriptors ?? [])] }); }
    catch { reject(new MediaToolError('tool-spawn-failed')); return; }
    let settled = false; let closed = false; let exitCode: number | null = null; let reason: string | undefined;
    let stdout = ''; let stdoutBytes = 0; let stderrBytes = 0; let diagnosticBytes = 0;
    let timingBuffer = ''; let packetCount = 0; const timings: Record<string, { first: number; end: number; packets: number }> = {};
    let progressBuffer = ''; let progressCount = 0; let progress: Record<string, number | boolean> = {};
    let outputDone = mode !== 'remux'; let inputDone = !input;
    let outputSink: Writable | undefined; let inputSource: Readable | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined; let forceSettlement: ReturnType<typeof setTimeout> | undefined;
    const signalTree = (termination: NodeJS.Signals) => {
      try {
        if (process.platform === 'win32') child.kill(termination); // Closing the runner's sole Job handle kills the contained tree.
        else if (child.pid) process.kill(-child.pid, termination); // The group still exists when its original leader has exited.
      } catch { /* ESRCH / an already closed Job are expected cleanup outcomes. */ }
    };
    const destroyStreams = () => { inputSource?.destroy(); outputSink?.destroy(); child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); };
    const finish = (forced = false) => {
      if (settled || (!forced && (!closed || !outputDone || !inputDone || reason !== undefined))) return;
      settled = true; clearTimeout(timer); clearTimeout(escalation); clearTimeout(forceSettlement); signal.removeEventListener('abort', abort);
      signalTree('SIGKILL'); // Also reap helpers that closed inherited stdio before their leader exited.
      destroyStreams(); if (forced) child.unref();
      if (signal.aborted) reason = 'cancelled';
      if (reason || exitCode !== 0) reject(new MediaToolError(reason ?? 'tool-exit-failed')); else resolveRun(mode === 'timing' ? JSON.stringify(timings) : stdout);
    };
    const stop = (code: string) => {
      if (settled || reason) return; reason = code; signalTree('SIGTERM');
      escalation = setTimeout(() => {
        signalTree('SIGKILL'); destroyStreams();
        // Neither leader 'close' nor EOF is guaranteed when descendants retain pipe handles.
        forceSettlement = setTimeout(() => finish(true), 100);
      }, options.killGraceMs);
    };
    const timer = setTimeout(() => stop('tool-timeout'), options.timeoutMs);
    const abort = () => stop('cancelled'); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    if (mode === 'remux') {
      let position = 0;
      outputSink = new Writable({ highWaterMark: CHUNK_SIZE, write(chunk: Buffer, _encoding, callback) {
        if (reason || settled) { callback(new MediaToolError(reason ?? 'cancelled')); return; }
        if (position + chunk.length > maxOutputBytes) { stop('tool-output-limit'); callback(new MediaToolError('tool-output-limit')); return; }
        const write = async () => {
          for (let offset = 0; offset < chunk.length;) {
            if (reason || settled) throw new MediaToolError(reason ?? 'cancelled');
            const size = Math.min(CHUNK_SIZE, chunk.length - offset);
            const result = await output!.write(chunk, offset, size, position);
            if (result.bytesWritten < 1 || result.bytesWritten > size) throw new MediaToolError('media-output-write-failed');
            offset += result.bytesWritten; position += result.bytesWritten;
          }
        };
        void write().then(() => callback(), () => callback(new MediaToolError('media-output-write-failed')));
      } });
      void pipeline(child.stdout!, outputSink).then(() => { outputDone = true; finish(); }, () => { outputDone = true; stop('media-output-write-failed'); });
    } else {
      child.stdout!.on('data', (chunk: Buffer) => {
        if (reason || settled) return; stdoutBytes += chunk.length;
        if (stdoutBytes > (mode === 'timing' ? 64 * 1024 * 1024 : MAX_JSON)) { stop('tool-output-limit'); return; }
        if (mode === 'probe') { stdout += chunk.toString('utf8'); return; }
        timingBuffer += chunk.toString('utf8');
        for (;;) {
          const end = timingBuffer.indexOf('\n'); if (end < 0) break;
          if (end > 512 || ++packetCount > 1000000) { stop('tool-output-limit'); return; }
          const line = timingBuffer.slice(0, end).trim(); timingBuffer = timingBuffer.slice(end + 1); if (!line) continue;
          const fields = line.split('|'); const values = Object.fromEntries(fields.map(field => field.split('=', 2)));
          const validNumber = (value: string | undefined) => value !== undefined && /^-?\d{1,9}(?:\.\d{1,9})?$/.test(value) && Number.isFinite(Number(value));
          if (fields.length !== 3 || !/^[01]$/.test(values.stream_index ?? '') || !validNumber(values.pts_time) || !validNumber(values.duration_time)) { stop('invalid-packet-timing'); return; }
          const start = Number(values.pts_time); const duration = Number(values.duration_time);
          if (start < -0.1 || start > 604800 || duration <= 0 || duration > 10) { stop('invalid-packet-timing'); return; }
          const prior = timings[values.stream_index];
          timings[values.stream_index] = { first: Math.min(prior?.first ?? start, start), end: Math.max(prior?.end ?? 0, start + duration), packets: (prior?.packets ?? 0) + 1 };
        }
        if (timingBuffer.length > 512) stop('tool-output-limit');
      });
    }
    if (input) {
      inputSource = Readable.from((async function* () {
        for (let position = 0; position < input.size;) {
          if (reason || settled) return;
          const buffer = Buffer.alloc(Math.min(CHUNK_SIZE, input.size - position));
          const result = await input.handle.read(buffer, 0, buffer.length, position);
          if (result.bytesRead !== buffer.length) throw new MediaToolError('media-input-read-failed');
          position += result.bytesRead; yield buffer;
        }
      })(), { objectMode: false, highWaterMark: CHUNK_SIZE });
      void pipeline(inputSource, child.stdin!).then(() => { inputDone = true; finish(); }, error => {
        inputDone = true;
        // ffprobe may stop reading after it has sufficient metadata; its exit status still decides success.
        if (!['EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error?.code)) stop('media-input-read-failed'); else finish();
      });
    }
    const progressKeys = new Set(['frame', 'fps', 'stream_0_0_q', 'bitrate', 'total_size', 'out_time_us', 'out_time_ms', 'out_time', 'dup_frames', 'drop_frames', 'speed', 'progress']);
    child.stderr!.on('data', (chunk: Buffer) => {
      if (reason || settled) return; stderrBytes += chunk.length;
      if (mode !== 'remux') { if (stderrBytes > MAX_DIAGNOSTICS) stop('tool-diagnostic-limit'); return; }
      if (stderrBytes > MAX_PROGRESS) { stop('tool-output-limit'); return; }
      progressBuffer += chunk.toString('utf8');
      for (;;) {
        const end = progressBuffer.indexOf('\n'); if (end < 0) break;
        if (end > 4096) { stop('tool-output-limit'); return; }
        const line = progressBuffer.slice(0, end).trim(); progressBuffer = progressBuffer.slice(end + 1);
        const [key, value] = line.split('=', 2);
        if (!progressKeys.has(key)) { diagnosticBytes += end + 1; if (diagnosticBytes > MAX_DIAGNOSTICS) { stop('tool-diagnostic-limit'); return; } }
        if (key === 'progress' && (value === 'continue' || value === 'end')) {
          if (++progressCount > 1024) { stop('tool-output-limit'); return; }
          try { options.onProgress?.({ ...progress, completed: value === 'end' }); } catch { /* Observers cannot prevent process cleanup. */ }
          progress = {}; if (reason) return;
        } else if (['frame', 'total_size', 'out_time_us', 'out_time_ms'].includes(key) && /^\d{1,16}$/.test(value ?? '')) {
          const numeric = Number(value); if (Number.isSafeInteger(numeric)) progress[key] = numeric;
        }
      }
      if (progressBuffer.length > 4096) stop('tool-output-limit');
    });
    child.once('error', () => { stop('tool-spawn-failed'); if (!child.pid) { destroyStreams(); finish(true); } });
    child.once('exit', code => { exitCode = code; if (code !== 0) stop('tool-exit-failed'); });
    child.once('close', code => { closed = true; exitCode = code; if (mode === 'timing' && (timingBuffer.trim() || packetCount === 0)) stop('invalid-packet-timing'); if (code !== 0) stop('tool-exit-failed'); else finish(); });
  });
}
