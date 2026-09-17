import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { DownloadArchiveMetadata, DownloadHistoryEntry, DownloadHistoryPage } from '../../shared/desktop';
import { validArchiveMetadata } from './archive-name';

type StoredEntry = Omit<DownloadHistoryEntry, 'directory' | 'available'>;
const maximumRecords = 1000;

export class DownloadHistory {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly filePath: string) {}

  async list(offset = 0, limit = 20): Promise<DownloadHistoryPage> {
    await this.pending;
    const items = await this.read();
    offset = Number.isSafeInteger(offset) ? Math.max(0, offset) : 0;
    limit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 20;
    return { items: await Promise.all(items.slice(offset, offset + limit).map(expose)), total: items.length, offset, limit };
  }

  async find(workId: string): Promise<DownloadHistoryEntry | undefined> {
    await this.pending;
    for (const item of await this.read()) {
      if (item.workId === workId && await available(item.outputPath)) return expose(item);
    }
    return undefined;
  }

  async get(id: string): Promise<DownloadHistoryEntry | undefined> {
    await this.pending;
    const item = (await this.read()).find(entry => entry.id === id);
    return item ? expose(item) : undefined;
  }

  record(metadata: DownloadArchiveMetadata, outputPath: string): Promise<void> {
    const operation = this.pending.then(async () => {
      if (!validArchiveMetadata(metadata) || !safePath(outputPath) || !await available(outputPath)) throw new Error('无法记录未完成或不可用的下载文件。');
      const path = resolve(outputPath);
      const entry: StoredEntry = { workId: metadata.workId, author: metadata.author, title: metadata.title,
        outputPath: path, id: randomUUID(), completedAt: new Date().toISOString() };
      const previous = await this.read();
      const items = [entry, ...previous.filter(item => item.outputPath !== path)].slice(0, maximumRecords);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, items }), { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.filePath);
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private async read(): Promise<StoredEntry[]> {
    let data: unknown;
    try {
      if ((await lstat(this.filePath)).size > 5 * 1024 * 1024) return [];
      data = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (!data || typeof data !== 'object') return [];
    const document = data as { version?: unknown; items?: unknown };
    if (document.version !== 1 || !Array.isArray(document.items)) return [];
    const result: StoredEntry[] = [], ids = new Set<string>();
    for (const candidate of document.items) {
      if (!candidate || typeof candidate !== 'object') continue;
      const item: Record<string, unknown> = candidate;
      if (!validArchiveMetadata(item) || typeof item.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.id)
        || !safePath(item.outputPath) || typeof item.completedAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(item.completedAt)
        || !Number.isFinite(Date.parse(item.completedAt)) || ids.has(item.id)) continue;
      ids.add(item.id);
      result.push({ id: item.id, workId: item.workId, author: item.author, title: item.title,
        outputPath: resolve(item.outputPath), completedAt: item.completedAt });
      if (result.length === maximumRecords) break;
    }
    return result.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  }
}

function safePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32767 && !/[\u0000-\u001f]/.test(value) && isAbsolute(value);
}
async function available(path: string): Promise<boolean> {
  try { const info = await lstat(path); return info.isFile() && info.size > 0; } catch { return false; }
}
async function expose(item: StoredEntry): Promise<DownloadHistoryEntry> {
  return { ...item, directory: dirname(item.outputPath), available: await available(item.outputPath) };
}
