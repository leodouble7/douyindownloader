import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateReports } from '../../src/main/reports/report-generator';
import { reportRun } from '../helpers/report-fixture';
const dirs: string[] = [];
async function directory() { const d = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'report-publication-')); dirs.push(d); return d; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });
async function receipts(root: string): Promise<string[]> { const result: string[] = []; for (const name of await fs.readdir(root)) { const path = join(root, name); if ((await fs.lstat(path)).isDirectory()) { try { const receipt = await fs.readFile(join(path, 'complete.json'), 'utf8'); if (receipt) result.push(receipt); } catch { /* uncommitted bundle */ } } } return result; }
describe('owned final handles and private completion receipts', () => {
  it('returns only a complete private bundle with exact content hashes and exclusive private leaves', async () => {
    const root = await directory(); const paths = await generateReports(reportRun(), root);
    expect(dirname(paths.jsonPath)).not.toBe(root); expect(dirname(paths.markdownPath)).toBe(dirname(paths.jsonPath));
    const receipt = JSON.parse(await fs.readFile(join(dirname(paths.jsonPath), 'complete.json'), 'utf8'));
    for (const path of [paths.jsonPath, paths.markdownPath]) { const data = await fs.readFile(path); const name = path.endsWith('.md') ? 'report.md' : 'report.json'; expect(receipt.files[name]).toEqual({ bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }); expect((await fs.stat(path)).mode & 0o777).toBe(0o600); }
    expect((await fs.stat(dirname(paths.jsonPath))).mode & 0o777).toBe(0o700);
  });
  it('never invokes pathname link, rename or unlink on success or cancellation', async () => {
    const root = await directory(); const bad = async () => { throw new Error('unsafe pathname mutation'); };
    vi.spyOn(fs, 'link').mockImplementation(bad); vi.spyOn(fs, 'rename').mockImplementation(bad); vi.spyOn(fs, 'unlink').mockImplementation(bad);
    const paths = await generateReports(reportRun(), root); expect(await fs.readFile(paths.jsonPath, 'utf8')).toContain('run-001');
    await expect(generateReports(reportRun(), { directory: root, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('existing report leaves are unchanged and repeated exports use distinct bundles', async () => {
    const root = await directory(); await fs.writeFile(join(root, 'report.json'), 'existing'); await fs.symlink(join(root, 'report.json'), join(root, 'report.md'));
    const a = await generateReports(reportRun(), root), b = await generateReports(reportRun(), root);
    expect(a.jsonPath).not.toBe(b.jsonPath); expect(await fs.readFile(join(root, 'report.json'), 'utf8')).toBe('existing');
  });
  it.each(['report.json', 'report.md', 'complete.json'])('a leaf swap while writing %s never commits attacker-selected source bytes', async name => {
    const root = await directory(), realOpen = fs.open; let swapped: string | undefined, owned: string | undefined;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const h = await realOpen(path, flags, mode);
      if (String(path).endsWith('/' + name)) {
        const write = h.writeFile.bind(h);
        vi.spyOn(h, 'writeFile').mockImplementation(async (...args) => { swapped = String(path); owned = String(path) + '.original'; await fs.rename(swapped, owned); await fs.writeFile(swapped, 'attacker-selected-bytes'); return write(...args); });
      }
      return h;
    });
    await expect(generateReports(reportRun(), root)).rejects.toMatchObject({ outcome: 'inconclusive' });
    expect(await fs.readFile(swapped!, 'utf8')).toBe('attacker-selected-bytes'); expect((await fs.stat(owned!)).size).toBe(0);
    // A forged/non-JSON receipt is never a committed report. No report paths were returned.
    for (const receipt of await receipts(root)) expect(() => JSON.parse(receipt)).toThrow();
  });
  it.each(['rollback', 'cancel'])('%s truncates only owned handles and preserves replacements', async action => {
    const root = await directory(), abort = new AbortController(), realOpen = fs.open; let replacement: string | undefined, original: string | undefined;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const h = await realOpen(path, flags, mode);
      if (String(path).endsWith('/report.md')) { const write = h.writeFile.bind(h); vi.spyOn(h, 'writeFile').mockImplementation(async (...args) => {
        replacement = join(dirname(String(path)), 'report.json'); original = replacement + '.original'; await fs.rename(replacement, original); await fs.writeFile(replacement, 'replacement-canary');
        if (action === 'cancel') { abort.abort(); return write(...args); } throw new Error('injected disk failure');
      }); } return h;
    });
    await expect(generateReports(reportRun(), { directory: root, signal: abort.signal })).rejects.toMatchObject({ outcome: 'inconclusive' });
    expect(await fs.readFile(replacement!, 'utf8')).toBe('replacement-canary'); expect((await fs.stat(original!)).size).toBe(0); expect(await receipts(root)).toEqual([]);
  });
  it('preexisting destination symlinks cannot become writable report handles', async () => {
    const root = await directory(), realOpen = fs.open; const victim = join(root, 'victim'); await fs.writeFile(victim, 'keep');
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (String(path).endsWith('/report.json')) { await fs.symlink(victim, path); expect(Number(flags) & constants.O_EXCL).toBeTruthy(); }
      return realOpen(path, flags, mode);
    });
    await expect(generateReports(reportRun(), root)).rejects.toMatchObject({ outcome: 'inconclusive' }); expect(await fs.readFile(victim, 'utf8')).toBe('keep'); expect(await receipts(root)).toEqual([]);
  });
});

describe('exact filesystem identity', () => {
  it('does not mistake rounded 64-bit file IDs for ownership after a leaf swap', async () => {
    const root = await directory(), realOpen = fs.open, realLstat = fs.lstat;
    vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      const info = await realLstat(path, options as { bigint: true });
      if (String(path).endsWith('/report.json') && !(options as { bigint?: boolean } | undefined)?.bigint) return Object.assign(info, { ino: 9007199254740992 });
      return info;
    });
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const h = await realOpen(path, flags, mode);
      if (String(path).endsWith('/report.json')) {
        const stat = h.stat.bind(h); vi.spyOn(h, 'stat').mockImplementation(async options => {
          const info = await stat(options as { bigint: true });
          return options?.bigint ? info : Object.assign(info, { ino: 9007199254740992 });
        });
        const write = h.writeFile.bind(h); vi.spyOn(h, 'writeFile').mockImplementation(async (...args) => {
          await fs.rename(path, String(path) + '.original'); await fs.writeFile(path, 'X'.repeat(Buffer.byteLength(args[0] as Buffer))); return write(...args);
        });
      } return h;
    });
    await expect(generateReports(reportRun(), root)).rejects.toMatchObject({ outcome: 'inconclusive' }); expect(await receipts(root)).toEqual([]);
  });
});
