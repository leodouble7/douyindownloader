import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { downloadMedia, type DownloadOptions, type DownloadResult } from '../douyin/download';
import { archiveName } from './archive-name';

export type DesktopDownloadResult = Omit<DownloadResult, 'reportPath'> & { reportPath?: string; committed?: true };
type Download = (options: DownloadOptions, signal: AbortSignal) => Promise<DownloadResult>;

/** Internal artifacts stay outside the chosen folder; only verified media is published there. */
export async function saveDesktopDownload(options: DownloadOptions, signal: AbortSignal, download: Download = downloadMedia): Promise<DesktopDownloadResult> {
  signal.throwIfAborted();
  const destination = await realpath(options.outputDirectory);
  if (!(await stat(destination)).isDirectory()) throw new Error('请选择一个可用的保存文件夹。');
  const temporary = await mkdtemp(join(tmpdir(), 'douyin-download-'));
  const staging = join(destination, `.download-${randomUUID()}.tmp`);
  try {
    const result = await download({ ...options, outputDirectory: temporary }, signal);
    signal.throwIfAborted();
    const source = result.outputPath ?? result.tracks[0]?.path;
    if (!source) throw new Error('没有生成可保存的视频或音频文件。');
    const resolved = await realpath(source), root = await realpath(temporary), within = relative(root, resolved);
    if (!within || within.startsWith('..') || isAbsolute(within) || !(await stat(resolved)).isFile()) throw new Error('下载结果不可用，请重试。');
    const extension = extname(resolved).toLowerCase();
    if (!['.mp4', '.m4a', '.webm', '.mp3', '.aac', '.wav', '.ogg', '.mov', '.mkv'].includes(extension)) throw new Error('下载结果不是可识别的媒体文件。');
    const audio = result.probe?.streams.every(stream => stream.kind === 'audio') || ['.m4a', '.mp3', '.aac', '.wav', '.ogg'].includes(extension);
    await copyExclusive(resolved, staging, signal);
    signal.throwIfAborted();
    const now = new Date(), pad = (value: number) => String(value).padStart(2, '0');
    const stem = archiveName(options.archive) ?? `${audio ? '音频' : '视频'}_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    let outputPath = '';
    let copyToFinal = false;
    for (let suffix = 0; suffix < 10000; suffix++) {
      signal.throwIfAborted();
      const target = join(destination, `${stem}${suffix ? ` (${suffix + 1})` : ''}${extension}`);
      try {
        // Hard-link publication is atomic and cannot replace an existing file or symlink.
        try {
          if (copyToFinal) await copyExclusive(resolved, target, signal);
          else await link(staging, target);
        }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (copyToFinal || !['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(code ?? '')) throw error;
          // FAT/network volumes may not support links. Release staging space first,
          // then copy exclusively from the verified source with cancellation support.
          await rm(staging, { force: true });
          copyToFinal = true;
          await copyExclusive(resolved, target, signal);
        }
        outputPath = target; break;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    if (!outputPath) throw new Error('同名文件过多，请更换保存文件夹后重试。');
    // A completed publication wins a concurrent cancellation; callers retain the saved file.
    return { status: result.status, outputPath, tracks: [], probe: result.probe, committed: true,
      message: result.status === 'tracks-only' ? '视频已保存，但没有声音。' : audio ? '音频已保存。' : '视频已保存。' };
  } catch (error) {
    // Internal diagnostic paths must not become the user's visible download result.
    const failure = new Error(error instanceof Error ? error.message : '下载失败，请重试。');
    if (error instanceof Error) failure.name = error.name;
    throw failure;
  } finally {
    await rm(staging, { force: true }).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function copyExclusive(source: string, target: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  // Create before the try block: an EEXIST error must never remove somebody else's file.
  const handle = await open(target, 'wx', 0o600);
  try {
    await pipeline(createReadStream(source), handle.createWriteStream(), { signal });
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(target, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
