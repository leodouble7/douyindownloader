import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { WorkTarget } from './target-work';
import type { MediaAsset } from '../../shared/contracts';
import type { EphemeralRequest } from '../runs/run-orchestrator';

export interface CaptureInput { pageUrl: string; observeSeconds: number; show?: boolean }
export interface CaptureResult {
  runId: string; assets: MediaAsset[]; requests: EphemeralRequest[]; target?: WorkTarget;
  summary: { network: number; mse: number; title: string; author?: string; excerpt: string; videoElements: number };
}
export async function capturePage(input: CaptureInput, signal: AbortSignal): Promise<CaptureResult> {
  signal.throwIfAborted();
  const executable = createRequire(import.meta.url)('electron') as string;
  const adjacent = fileURLToPath(new URL('./capture.cjs', import.meta.url));
  const entry = existsSync(adjacent) ? adjacent : fileURLToPath(new URL('../../../out/douyin/capture.cjs', import.meta.url));
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    // Signed URLs and ephemeral headers travel over the process pipe, never argv or disk.
    const child = spawn(executable, [entry], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let result: CaptureResult | undefined, failure: Error | undefined;
    const timeout = setTimeout(() => { failure = new Error('页面捕获超时'); child.kill('SIGKILL'); }, (input.observeSeconds + 45) * 1000);
    let killTimer: NodeJS.Timeout | undefined;
    const abort = () => {
      failure = new DOMException('页面捕获已取消', 'AbortError');
      if (child.connected) child.send({ cancel: true }, () => undefined);
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timeout); clearTimeout(killTimer); signal.removeEventListener('abort', abort); };
    child.on('message', (message: { ready?: boolean; result?: CaptureResult; error?: string }) => {
      if (message.ready && child.connected) child.send(input, () => undefined);
      if (message.result) result = message.result;
      if (message.error) failure = new Error(message.error);
    });
    child.once('error', () => { cleanup(); reject(new Error('无法启动 Electron 浏览器，请检查依赖安装')); });
    child.once('exit', code => { cleanup(); if (failure) reject(failure); else if (code === 0 && result) resolve(result); else reject(new Error('页面捕获进程退出，未获得可用结果')); });
    if (signal.aborted) abort();
  });
}
