import fs, { constants, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { ReportError } from './report-run';
export interface ReportBundle {
  readonly bundleId: string;
  readonly jsonPath: string;
  readonly markdownPath: string;
  readonly jsonSha256: string;
  readonly markdownSha256: string;
  readonly receiptSha256: string;
}
interface Identity { dev: bigint; ino: bigint }
export interface BundleFile { path: string; identity: Identity; bytes: Buffer }
interface TrustedFile { path: string; identity: Identity; length: number; sha256: string }
interface TrustedBundle { root: string; directory: string; rootIdentity: Identity; directoryIdentity: Identity; files: TrustedFile[] }
const trusted = new WeakMap<ReportBundle, TrustedBundle>();
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
function checkEntries(bundle: TrustedBundle): void {
  const root = fs.lstatSync(bundle.root, { bigint: true }), directory = fs.lstatSync(bundle.directory, { bigint: true });
  if (!root.isDirectory() || !directory.isDirectory() || !same(root, bundle.rootIdentity) || !same(directory, bundle.directoryIdentity)
    || fs.realpathSync(bundle.root) !== bundle.root || fs.realpathSync(bundle.directory) !== bundle.directory) throw new ReportError('publication-failed');
  for (const file of bundle.files) {
    const entry = fs.lstatSync(file.path, { bigint: true });
    if (!entry.isFile() || entry.nlink !== 1n || !same(entry, file.identity) || entry.size !== BigInt(file.length)) throw new ReportError('publication-failed');
  }
}
/** Synchronous, bounded verification: all close callbacks finish before the final entry checks.
 * Returns verified in-memory contents so callers need not reopen a mutable path to render them. */
function readTrusted(bundle: TrustedBundle): { json: string; markdown: string } {
  const contents: Buffer[] = [];
  try {
    checkEntries(bundle);
    for (const file of bundle.files) {
      const fd = fs.openSync(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const held = fs.fstatSync(fd, { bigint: true });
        if (!held.isFile() || held.nlink !== 1n || !same(held, file.identity) || held.size !== BigInt(file.length) || file.length > 1024 * 1024) throw new ReportError('publication-failed');
        const bytes = Buffer.alloc(file.length); let offset = 0;
        while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) throw new ReportError('publication-failed'); offset += n; }
        if (sha256(bytes) !== file.sha256) throw new ReportError('publication-failed');
        contents.push(bytes);
      } finally { fs.closeSync(fd); }
    }
    const result = { json: contents[0].toString('utf8'), markdown: contents[1].toString('utf8') };
    // No await, user callback or file close occurs after this final OS entry check.
    checkEntries(bundle);
    return result;
  } catch (error) { throw error instanceof ReportError ? error : new ReportError('publication-failed'); }
}
/** Main-process only: accepts the original in-memory return object, not a disk receipt or a
 * deserialized lookalike. Task 10 must render these verified contents rather than reread paths. */
export async function verifyReportBundle(bundle: ReportBundle): Promise<{ json: string; markdown: string }> {
  const metadata = trusted.get(bundle);
  if (!metadata) throw new ReportError('publication-failed');
  return readTrusted(metadata);
}
/** Internal publication bridge called only after all asynchronous sync/read/close work. */
export function completeReportBundle(bundleId: string, root: string, directory: string, rootIdentity: BigIntStats, directoryIdentity: BigIntStats, files: BundleFile[]): ReportBundle {
  if (files.length !== 3) throw new ReportError('publication-failed');
  const metadata: TrustedBundle = { root, directory, rootIdentity: { dev: rootIdentity.dev, ino: rootIdentity.ino }, directoryIdentity: { dev: directoryIdentity.dev, ino: directoryIdentity.ino }, files: files.map(f => ({ path: f.path, identity: { dev: f.identity.dev, ino: f.identity.ino }, length: f.bytes.length, sha256: sha256(f.bytes) })) };
  const bundle: ReportBundle = Object.freeze({ bundleId, jsonPath: files[0].path, markdownPath: files[1].path, jsonSha256: metadata.files[0].sha256, markdownSha256: metadata.files[1].sha256, receiptSha256: metadata.files[2].sha256 });
  readTrusted(metadata);
  trusted.set(bundle, metadata);
  return bundle;
}
