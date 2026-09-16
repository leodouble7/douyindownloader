import { access, mkdir, open, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withinDirectory } from './download-service';

export class DirectoryPreferences {
  constructor(private readonly path: string) {}
  async load(): Promise<string> {
    let file;
    try {
      file = await open(this.path, 'r'); if ((await file.stat()).size > 16384) throw new Error('Invalid preferences');
      const value = JSON.parse(await file.readFile('utf8')) as Record<string, unknown>;
      if (!value || Object.keys(value).length !== 1 || typeof value.directory !== 'string' || !isAbsolute(value.directory) || value.directory.includes('\0')) throw new Error('Invalid preferences');
      return value.directory;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
    finally { await file?.close(); }
  }
  async save(directory: string): Promise<void> {
    if (!isAbsolute(directory) || directory.includes('\0') || directory.length > 4096) throw new Error('Invalid directory');
    await mkdir(dirname(this.path), { recursive: true }); const temporary = `${this.path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify({ directory }), { flag: 'wx', mode: 0o600 }); await rename(temporary, this.path); }
    finally { await rm(temporary, { force: true }); }
  }
}
export async function validateDirectory(directory: string): Promise<string> {
  if (!(await stat(directory)).isDirectory()) throw new Error('Invalid directory');
  await access(directory, constants.W_OK | constants.R_OK);
  return realpath(directory);
}
export async function validateRevealPath(path: string, directory: string): Promise<string> {
  if (!withinDirectory(path, directory)) throw new Error('Invalid output path');
  const [target, root] = await Promise.all([realpath(path), realpath(directory)]);
  if (!withinDirectory(target, root) || !(await stat(target)).isFile()) throw new Error('Invalid output file');
  return target;
}
