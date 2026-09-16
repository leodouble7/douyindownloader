import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RunOrchestrator } from '../runs/run-orchestrator';

export interface FileIdentity { dev: string; ino: string; size: number; nlink: number; isFile: boolean }
export interface RootIdentity { path: string; dev: string; ino: string }
export interface WorkerPort {
  send(message: unknown): void;
  onMessage(callback: (message: WorkerMessage) => void): void;
  onExit(callback: () => void): void;
  terminate(): void;
}
interface WorkerMessage { id?: number; value?: unknown; error?: string; code?: string; committed?: boolean }
/** Task 11 can adapt Electron utilityProcess without changing the filesystem protocol. */
export type OutputWorkerLauncher = (options: { cwd: string; modulePath: string }) => WorkerPort;
export const nodeOutputWorkerLauncher: OutputWorkerLauncher = options => {
  if (process.versions.electron) throw new Error('output-worker-launcher-required');
  const child = fork(options.modulePath, [], { cwd: options.cwd, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' });
  return { send: message => { if (!child.connected) throw new Error('output-worker-unavailable'); child.send(message as object, () => undefined); }, onMessage: callback => { child.on('message', callback); },
    onExit: callback => { child.once('exit', callback); child.once('error', callback); }, terminate: () => { child.kill(); } };
};
const roots = new WeakMap<RunOrchestrator, Map<string, Promise<RootIdentity>>>();
export function getOutputRoot(context: RunOrchestrator, runId: string): Promise<RootIdentity> {
  let runs = roots.get(context); if (!runs) { runs = new Map(); roots.set(context, runs); }
  let root = runs.get(runId);
  if (!root) {
    const signal = context.getAbortSignal(runId);
    root = (async () => {
      if (process.platform === 'win32') {
        const native = createRequire(import.meta.url)(fileURLToPath(new URL('./windows-output.cjs', import.meta.url))) as { openWindowsRoot(path: string): RootIdentity & { close(): void } };
        const root = native.openWindowsRoot(context.getDownloadSettings(runId).outputDirectory);
        if (signal.aborted) { root.close(); throw new Error('output-root-unavailable'); }
        signal.addEventListener('abort', () => { root.close(); runs!.delete(runId); }, { once: true });
        return { path: root.path, dev: root.dev, ino: root.ino };
      }
      const path = await realpath(context.getDownloadSettings(runId).outputDirectory);
      const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isDirectory() || signal.aborted) { await handle.close(); throw new Error('output-root-unavailable'); }
      signal.addEventListener('abort', () => { void handle.close().catch(() => undefined); runs!.delete(runId); }, { once: true });
      return { path, dev: String(info.dev), ino: String(info.ino) };
    })();
    runs.set(runId, root);
  }
  return root;
}
/** Owns a cwd-anchored filesystem actor; one acknowledged bounded operation at a time. */
export class OutputWorkspace {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private committed: () => void = () => undefined;
  private disposed = false;
  private constructor(private readonly port: WorkerPort) {
    port.onMessage(message => {
      if (message.committed) { this.committed(); return; }
      const waiter = this.pending.get(message.id!); if (!waiter) return;
      this.pending.delete(message.id!); clearTimeout(waiter.timer);
      if (message.error) waiter.reject(Object.assign(new Error(message.error), { code: message.code })); else waiter.resolve(message.value);
    });
    port.onExit(() => this.interrupt());
  }
  static async create(root: RootIdentity, id: string, resume: boolean, launcher = nodeOutputWorkerLauncher, modulePath = fileURLToPath(new URL('./output-worker.cjs', import.meta.url))): Promise<OutputWorkspace> {
    const workspace = new OutputWorkspace(launcher({ cwd: root.path, modulePath }));
    try { await workspace.call('init', { root, id, resume }); return workspace; }
    catch (error) { await workspace.dispose(); throw error; }
  }
  private call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('output-worker-unavailable'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.interrupt(), 30000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.port.send({ id, op, args }); } catch { this.pending.delete(id); clearTimeout(timer); reject(new Error('output-worker-unavailable')); }
    });
  }
  openFile(name: string, create = false): Promise<FileIdentity> { return this.call('openFile', { name, create }); }
  async write(data: Buffer, position: number): Promise<void> {
    for (let offset = 0; offset < data.length; offset += 65536) await this.call('write', { data: data.subarray(offset, offset + 65536), position: position + offset });
  }
  async read(position: number, length: number): Promise<Buffer> { return Buffer.from(await this.call<Uint8Array>('read', { position, length })); }
  stat(): Promise<FileIdentity> { return this.call('stat'); }
  statEntry(name: string): Promise<FileIdentity | null> { return this.call('statEntry', { name }); }
  truncate(length: number): Promise<void> { return this.call('truncate', { length }); }
  sync(): Promise<void> { return this.call('sync'); }
  closeFile(): Promise<void> { return this.call('closeFile'); }
  durability(): Promise<'directory-flush' | 'write-through-file-flush'> { return this.call('durability'); }
  async freeBytes(): Promise<bigint> { return BigInt(await this.call<string>('freeBytes')); }
  readManifest(): Promise<unknown> { return this.call('readManifest'); }
  saveManifest(payload: unknown): Promise<void> { return this.call('saveManifest', { payload }); }
  async publish(name: string, identity: FileIdentity, signal: AbortSignal, committed: () => void = () => undefined): Promise<void> {
    signal.throwIfAborted(); this.committed = committed;
    const onAbort = () => this.port.send({ cancel: true });
    signal.addEventListener('abort', onAbort, { once: true });
    try { signal.throwIfAborted(); await this.call('publish', { name, identity }); }
    finally { signal.removeEventListener('abort', onAbort); }
  }
  removePart(identity: FileIdentity): Promise<void> { return this.call('removePart', { identity }); }
  cleanupManifest(): Promise<void> { return this.call('cleanupManifest'); }
  path(): Promise<string> { return this.call('path'); }
  interrupt(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('output-worker-unavailable')); }
    this.pending.clear(); this.port.terminate();
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    try { await this.call('dispose'); } finally { this.interrupt(); }
  }
}
