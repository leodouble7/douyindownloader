import { durationTolerance } from './media-duration';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, linkSync, lstatSync, realpathSync, unlinkSync, type Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, delimiter, dirname, extname, isAbsolute, join, parse, resolve } from 'node:path';
import type { RunEventInput } from '../runs/event-repository';
import { MediaToolError, runMediaProcess } from './media-process';
export { MediaToolError } from './media-process';

export interface ToolLocation { path: string; provenance: 'packaged' | 'installer' | 'system' }
export interface ToolPaths { ffmpeg: ToolLocation; ffprobe: ToolLocation }
export interface ToolResolutionOptions {
  resourcesPath?: string; packaged?: boolean; platform?: NodeJS.Platform; arch?: string;
  installerPaths?: Partial<Record<'ffmpeg' | 'ffprobe', string>>; systemPath?: string;
}
/** Task 11 must ship target-specific executables at this layout; host installers are never cross-arch packaging inputs. */
export function mediaToolSidecarDirectory(resourcesPath: string, platform = process.platform, arch: string = process.arch): string {
  return join(resourcesPath, 'media-tools', `${platform}-${arch}`);
}
function failure(code: string): never { throw new MediaToolError(code); }
function checkAbort(signal: AbortSignal): void { if (signal.aborted) failure('cancelled'); }
function safeTool(path: string): boolean {
  try { const info = lstatSync(path); if (!isAbsolute(path) || !info.isFile() || info.isSymbolicLink()) return false; accessSync(path, constants.X_OK); return true; } catch { return false; }
}
export function resolveMediaTools(options: ToolResolutionOptions = {}): ToolPaths {
  const platform = options.platform ?? process.platform; const arch = options.arch ?? process.arch;
  const resourcesPath = options.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  // Electron development has defaultApp=true. Packaged Electron must never fall back to PATH.
  const packaged = options.packaged ?? (!!process.versions.electron && !(process as NodeJS.Process & { defaultApp?: boolean }).defaultApp);
  const require = createRequire(import.meta.url);
  const resolveOne = (name: 'ffmpeg' | 'ffprobe'): ToolLocation => {
    const executable = `${name}${platform === 'win32' ? '.exe' : ''}`;
    if (resourcesPath) { const path = join(mediaToolSidecarDirectory(resourcesPath, platform, arch), executable); if (safeTool(path)) return { path, provenance: 'packaged' }; }
    if (packaged) return failure('packaged-media-tool-unavailable');
    let installer = options.installerPaths?.[name];
    if (options.installerPaths === undefined && platform === process.platform && arch === process.arch) {
      try { installer = (require(`@${name}-installer/${name}`) as { path: string }).path; } catch { /* Development PATH fallback only. */ }
    }
    if (installer && safeTool(installer)) return { path: installer, provenance: 'installer' };
    for (const directory of (options.systemPath ?? process.env.PATH ?? '').split(delimiter).slice(0, 128)) {
      if (!isAbsolute(directory)) continue;
      const path = join(directory, executable); if (safeTool(path)) return { path, provenance: 'system' };
    }
    return failure('media-tool-unavailable');
  };
  return { ffmpeg: resolveOne('ffmpeg'), ffprobe: resolveOne('ffprobe') };
}
export interface MediaStream {
  kind: 'video' | 'audio'; codec: string; codecTag: string; profile: string; level?: number;
  timeBase: string; extradataHash: string; durationSeconds: number; packetCount: number;
  width?: number; height?: number; sampleRate?: number; channels?: number;
}
export interface MediaProbe { container: 'mp4' | 'webm'; durationSeconds: number; streams: MediaStream[] }
/** outputPath is main-process-only and appears only after verified publication. Persist the probe projection, never this whole object. */
export interface RemuxResult { status: 'succeeded'; outputPath: string; probe: MediaProbe }
export type MediaToolEvent = RunEventInput;
export interface MediaAdapterOptions {
  tools?: ToolPaths; resolution?: ToolResolutionOptions; timeoutMs?: number; killGraceMs?: number;
  /** Bind to RunOrchestrator.emit / retainTerminalEmitter. Events contain no raw paths or command output. Observer errors cannot alter committed filesystem state. */
  onEvent?: (event: MediaToolEvent) => void;
}
const MAX_DURATION = 7 * 24 * 3600;
const PURPOSE = { probe: 'Verify local media structure and stream parameters', remux: 'Copy verified video and audio streams into one container' };
function boundedOption(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) return failure('invalid-tool-limit'); return value;
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return failure('invalid-media-json'); return value as Record<string, unknown>;
}
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value))) return failure('invalid-media-number');
  const result = Number(value); if (!Number.isFinite(result) || result < min || result > max) return failure('invalid-media-number'); return result;
}
function integer(value: unknown, min: number, max: number): number { const result = number(value, min, max); if (!Number.isSafeInteger(result)) return failure('invalid-media-number'); return result; }
function text(value: unknown, max = 128): string { if (typeof value !== 'string' || value.length > max || /[\x00-\x1f]/.test(value)) return failure('invalid-media-text'); return value; }
function parseProbe(json: string): MediaProbe {
  let value: unknown; try { value = JSON.parse(json); } catch { return failure('invalid-media-json'); }
  const data = record(value);
  if (/encv|enca|encrypt|drm|widevine|playready|cenc|cbcs/i.test(json)) return failure('encrypted-media-unsupported');
  const format = record(data.format); const formatName = text(format.format_name);
  const container = formatName.split(',').includes('mp4') ? 'mp4' : formatName.split(',').includes('webm') ? 'webm' : failure('unsupported-media-container');
  const durationSeconds = number(format.duration, 0.001, MAX_DURATION);
  if (!Array.isArray(data.streams) || data.streams.length < 1 || data.streams.length > 2) return failure('unexpected-media-streams');
  const streams = data.streams.map(raw => {
    const stream = record(raw); const kind = stream.codec_type;
    if (kind !== 'video' && kind !== 'audio') return failure('unexpected-media-streams');
    const codec = text(stream.codec_name); const codecTag = text(stream.codec_tag_string); const profile = text(stream.profile ?? 'unknown');
    const allowed = container === 'mp4' ? (kind === 'video' ? ['h264', 'hevc', 'av1'] : ['aac', 'opus']) : (kind === 'video' ? ['vp8', 'vp9', 'av1'] : ['opus', 'vorbis']);
    if (!allowed.includes(codec)) return failure('unsupported-media-codec');
    const timeBase = text(stream.time_base); const fraction = /^(\d+)\/(\d+)$/.exec(timeBase);
    if (!fraction || number(fraction[1], 1, 1e9) / number(fraction[2], 1, 1e9) > 1) return failure('invalid-media-timebase');
    const extradataHash = text(stream.extradata_hash ?? '');
    if (extradataHash !== '' && !/^SHA256:[a-f0-9]{64}$/i.test(extradataHash)) return failure('invalid-media-extradata');
    if (['h264', 'hevc', 'aac', 'av1', 'vorbis', 'opus'].includes(codec) && !extradataHash) return failure('missing-media-extradata');
    const duration = stream.duration === undefined ? durationSeconds : number(stream.duration, 0.001, MAX_DURATION);
    if (Math.abs(duration - durationSeconds) > durationTolerance(durationSeconds)) return failure('inconsistent-media-duration');
    if (stream.start_time !== undefined && Math.abs(number(stream.start_time, -MAX_DURATION, MAX_DURATION)) > 0.1) return failure('unsupported-media-start-time');
    const disposition = record(stream.disposition ?? {}); if (disposition.attached_pic === 1) return failure('unexpected-media-streams');
    const parsed: MediaStream = { kind, codec, codecTag, profile, timeBase, extradataHash, durationSeconds: duration, packetCount: integer(stream.nb_read_packets, 1, 1000000) };
    if (kind === 'video') { parsed.width = integer(stream.width, 1, 16384); parsed.height = integer(stream.height, 1, 16384); if (stream.level !== undefined) parsed.level = integer(stream.level, -99, 1000); }
    else { parsed.sampleRate = integer(stream.sample_rate, 8000, 384000); parsed.channels = integer(stream.channels, 1, 32); }
    return parsed;
  });
  if (new Set(streams.map(s => s.kind)).size !== streams.length) return failure('unexpected-media-streams');
  return { container, durationSeconds, streams };
}
function sameIdentity(a: Stats, b: Stats, content = false): boolean {
  return b.isFile() && a.dev === b.dev && a.ino === b.ino && (!content || (a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs));
}
interface PinnedFile { requestedPath: string; path: string; handle: FileHandle; identity: Stats; container: 'mp4' | 'webm' }
async function checkedPath(path: string): Promise<string> {
  const absolute = resolve(path);
  // Resolve pre-existing ancestor aliases (macOS /var and /tmp are symlinks),
  // while rejecting a symbolic leaf. Subsequent checks compare the canonical identity.
  if ((await lstat(absolute)).isSymbolicLink()) return failure('media-path-substituted');
  const canonical = await realpath(absolute); let current = parse(canonical).root;
  for (const segment of canonical.slice(current.length).split(/[\\/]/).filter(Boolean)) { current = join(current, segment); if ((await lstat(current)).isSymbolicLink()) return failure('media-path-substituted'); }
  return canonical;
}
async function pin(path: string, signal: AbortSignal): Promise<PinnedFile> {
  const canonical = await checkedPath(path); const before = await lstat(canonical);
  if (!before.isFile()) return failure('media-file-unavailable');
  const handle = await open(canonical, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const identity = await handle.stat(); if (!sameIdentity(before, identity, true) || identity.size < 12 || identity.size > 1024 ** 4) return failure('media-file-substituted');
    const header = Buffer.alloc(12); await handle.read(header, 0, header.length, 0);
    const container = header.toString('ascii', 4, 8) === 'ftyp' ? 'mp4' : header.readUInt32BE(0) === 0x1a45dfa3 ? 'webm' : failure('unsupported-media-container');
    await inspectProtection(handle, identity.size, container, signal);
    return { requestedPath: resolve(path), path: canonical, handle, identity, container };
  } catch (error) { await handle.close(); throw error; }
}
/** Inspect bounded container metadata without reading packet payloads or relying on ffprobe to retain DRM markers. */
async function inspectProtection(handle: FileHandle, size: number, container: 'mp4' | 'webm', signal: AbortSignal): Promise<void> {
  let inspected = 0; let elements = 0;
  const read = async (position: number, length: number) => {
    checkAbort(signal); inspected += length;
    if (inspected > 16 * 1024 * 1024) return failure('media-metadata-limit');
    const buffer = Buffer.alloc(length); const result = await handle.read(buffer, 0, length, position);
    if (result.bytesRead !== length) return failure('invalid-media-container'); return buffer;
  };
  if (container === 'mp4') {
    for (let offset = 0; offset < size;) {
      if (++elements > 65536 || size - offset < 8) return failure('invalid-media-container');
      const header = await read(offset, Math.min(16, size - offset)); const type = header.toString('ascii', 4, 8);
      let length = header.readUInt32BE(0); let headerSize = 8;
      if (length === 1) { if (header.length < 16) return failure('invalid-media-container'); const extended = header.readBigUInt64BE(8); if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return failure('invalid-media-container'); length = Number(extended); headerSize = 16; }
      if (length === 0) length = size - offset;
      if (length < headerSize || length > size - offset) return failure('invalid-media-container');
      if (['pssh', 'senc', 'uuid'].includes(type)) return failure('encrypted-media-unsupported');
      if (['moov', 'moof'].includes(type)) {
        let tail = Buffer.alloc(0);
        for (let position = offset + headerSize; position < offset + length;) {
          const chunk = await read(position, Math.min(65536, offset + length - position)); const scan = Buffer.concat([tail, chunk]);
          // Conservative refusal of protection markers in metadata also covers encrypted sample entries and PIFF UUID boxes.
          if (/encv|enca|sinf|tenc|pssh|senc|seig|uuid/.test(scan.toString('latin1'))) return failure('encrypted-media-unsupported');
          tail = scan.subarray(Math.max(0, scan.length - 7)); position += chunk.length;
        }
      }
      offset += length;
    }
    return;
  }
  const masters = new Set([0x1a45dfa3, 0x18538067, 0x1654ae6b, 0xae, 0x6d80, 0x6240]);
  const walk = async (start: number, end: number, depth: number): Promise<void> => {
    if (depth > 8) return failure('media-metadata-limit');
    for (let position = start; position < end;) {
      if (++elements > 65536 || end - position < 2) return failure('invalid-media-container');
      const bytes = await read(position, Math.min(12, end - position));
      const width = (first: number, max: number) => { for (let w = 1; w <= max; w++) if (first & (1 << (8 - w))) return w; return failure('invalid-media-container'); };
      const idWidth = width(bytes[0], 4); if (bytes.length <= idWidth) return failure('invalid-media-container');
      let id = 0; for (let i = 0; i < idWidth; i++) id = id * 256 + bytes[i];
      const sizeWidth = width(bytes[idWidth], 8); if (bytes.length < idWidth + sizeWidth) return failure('invalid-media-container');
      let length = BigInt(bytes[idWidth] & ((1 << (8 - sizeWidth)) - 1));
      for (let i = 1; i < sizeWidth; i++) length = length * 256n + BigInt(bytes[idWidth + i]);
      const body = position + idWidth + sizeWidth; const unknown = length === (1n << BigInt(7 * sizeWidth)) - 1n;
      if (unknown && id !== 0x18538067) return failure('unsupported-media-container');
      const next = unknown ? end : body + Number(length);
      if (length > BigInt(Number.MAX_SAFE_INTEGER) && !unknown || !Number.isSafeInteger(next) || next > end) return failure('invalid-media-container');
      if (id === 0x5035) return failure('encrypted-media-unsupported');
      if (id === 0x5033 && next > body) { const value = await read(body, Math.min(next - body, 8)); if (value.some(byte => byte !== 0)) return failure('encrypted-media-unsupported'); }
      if (masters.has(id)) await walk(body, next, depth + 1);
      position = next;
    }
  };
  await walk(0, size, 0);
}

async function verifyPinned(file: PinnedFile): Promise<void> {
  if (await checkedPath(file.requestedPath) !== file.path || !sameIdentity(file.identity, await lstat(file.path), true) || !sameIdentity(file.identity, await file.handle.stat(), true)) failure('media-file-substituted');
}
function inputArgument(file: PinnedFile, fd: number): string { return process.platform === 'win32' ? file.path : `/dev/fd/${fd}`; }

export function createMediaAdapter(options: MediaAdapterOptions = {}) {
  const timeoutMs = boundedOption(options.timeoutMs, 120000, 3600000); const killGraceMs = boundedOption(options.killGraceMs, 500, 5000);
  const getTools = () => options.tools ?? resolveMediaTools(options.resolution);
  function emit(operation: 'probe' | 'remux', action: string, status: MediaToolEvent['status'], fields: Partial<MediaToolEvent> = {}): void {
    try { options.onEvent?.({ phase: operation === 'probe' ? 'verify' : 'ffmpeg', action: `${operation}:${action}`, purpose: PURPOSE[operation], status, relatedIds: [], ...fields }); } catch { /* Observer failures do not interrupt child cleanup or reverse committed publication. */ }
  }
  function run(tool: ToolLocation, args: string[], safeArguments: string[], signal: AbortSignal, operation: 'probe' | 'remux', descriptors: number[], cwd?: string, output?: FileHandle, input?: { handle: FileHandle; size: number }, maxOutputBytes?: number, mode: 'probe' | 'remux' | 'timing' = operation): Promise<string> {
    checkAbort(signal); if (!safeTool(tool.path)) return Promise.reject(new MediaToolError('media-tool-unavailable'));
    emit(operation, 'command', 'running', { inputSummary: { tool: operation === 'probe' ? 'ffprobe' : 'ffmpeg', provenance: tool.provenance, arguments: safeArguments } });
    checkAbort(signal);
    return runMediaProcess({ executable: tool.path, args, signal, mode, descriptors, cwd, output, input, maxOutputBytes, timeoutMs, killGraceMs,
      onProgress: progress => emit('remux', 'progress', 'running', { evidence: progress }) });
  }
  async function probePinned(file: PinnedFile, signal: AbortSignal, ownedPipe = false): Promise<MediaProbe> {
    const args = ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm', '-count_packets', '-show_streams', '-show_format', '-show_data_hash', 'sha256', '-of', 'json', ownedPipe ? 'pipe:0' : inputArgument(file, 3)];
    const safe = [...args.slice(0, -1), 'media-input'];
    const descriptors = process.platform === 'win32' || ownedPipe ? [] : [file.handle.fd];
    const input = ownedPipe ? { handle: file.handle, size: file.identity.size } : undefined;
    let json = await run(getTools().ffprobe, args, safe, signal, 'probe', descriptors, undefined, undefined, input);
    // Streamed WebM has no seek-back Duration element. Derive its duration from
    // bounded packet timestamps, not from a duration copied from the inputs.
    let raw: Record<string, unknown>; try { raw = record(JSON.parse(json)); } catch { return failure('invalid-media-json'); }
    const format = record(raw.format);
    if (ownedPipe && file.container === 'mp4') {
      // A pipe's format duration may stop at the first fragment. count_packets
      // demuxes to EOF and updates each stream's duration and packet count.
      number(format.duration, 0.001, MAX_DURATION);
      if (!Array.isArray(raw.streams) || raw.streams.length < 1 || raw.streams.length > 2) failure('unexpected-media-streams');
      const ranges = raw.streams.map(item => { const stream = record(item); return { start: number(stream.start_time ?? 0, -0.1, 0.1), duration: number(stream.duration, 0.001, MAX_DURATION) }; });
      format.duration = Math.max(...ranges.map(r => r.start + r.duration)) - Math.min(0, ...ranges.map(r => r.start));
      json = JSON.stringify(raw);
    }
    if (file.container === 'webm' && format.duration === undefined) {
      const timingArgs = ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'matroska,webm', '-show_packets', '-show_entries', 'packet=stream_index,pts_time,duration_time:side_data=', '-of', 'compact=p=0:nk=0', args.at(-1)!];
      const timingJson = await run(getTools().ffprobe, timingArgs, [...timingArgs.slice(0, -1), 'media-input'], signal, 'probe', descriptors, undefined, undefined, input, undefined, 'timing');
      const timings = JSON.parse(timingJson) as Record<string, { first: number; end: number; packets: number }>;
      if (!Array.isArray(raw.streams) || raw.streams.length < 1 || raw.streams.length > 2 || Object.keys(timings).length !== raw.streams.length) failure('invalid-packet-timing');
      const duration = Math.max(...Object.values(timings).map(t => t.end)) - Math.min(0, ...Object.values(timings).map(t => t.first));
      format.duration = duration;
      for (const item of raw.streams) { const stream = record(item); const timing = timings[String(stream.index)]; if (!timing) failure('invalid-packet-timing'); stream.duration = timing.end - timing.first; }
      json = JSON.stringify(raw);
    }
    const probe = parseProbe(json);
    checkAbort(signal); if (probe.container !== file.container) failure('inconsistent-media-container'); await verifyPinned(file); return probe;
  }
  async function probeMedia(path: string, signal: AbortSignal): Promise<MediaProbe> {
    let file: PinnedFile | undefined;
    try { checkAbort(signal); file = await pin(path, signal); const probe = await probePinned(file, signal); checkAbort(signal); emit('probe', 'result', 'succeeded', { evidence: { probe } }); return probe; }
    catch (error) { const safe = normalize(error, signal); emit('probe', 'result', safe.name === 'AbortError' ? 'cancelled' : 'failed', { evidence: { outcome: 'inconclusive', code: safe.code } }); throw safe; }
    finally { await file?.handle.close(); }
  }
  async function remuxTracks(videoPath: string, audioPath: string, outputPath: string, signal: AbortSignal): Promise<RemuxResult> {
    const files: PinnedFile[] = []; let temporary: string | undefined; let output: FileHandle | undefined; let outputIdentity: Stats | undefined; let parent: FileHandle | undefined; let committed = false;
    try {
      checkAbort(signal); const requestedDirectory = dirname(resolve(outputPath)); const directory = await checkedPath(requestedDirectory); const destination = join(directory, basename(outputPath));
      const parentIdentity = await lstat(directory); if (!parentIdentity.isDirectory()) failure('media-output-unavailable');
      if (process.platform !== 'win32') parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const verifyDirectory = () => { const info = lstatSync(directory); if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== parentIdentity.dev || info.ino !== parentIdentity.ino || realpathSync(directory) !== directory || realpathSync(requestedDirectory) !== directory) failure('media-output-substituted'); };
      const assertAbsent = () => { try { lstatSync(destination); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; } failure('media-output-exists'); };
      verifyDirectory(); assertAbsent();
      const video = await pin(videoPath, signal); files.push(video); const audio = await pin(audioPath, signal); files.push(audio);
      const videoProbe = await probePinned(video, signal); const audioProbe = await probePinned(audio, signal);
      if (videoProbe.streams.length !== 1 || videoProbe.streams[0].kind !== 'video' || audioProbe.streams.length !== 1 || audioProbe.streams[0].kind !== 'audio') failure('expected-separated-tracks');
      if (videoProbe.container !== audioProbe.container || (videoProbe.container === 'mp4' ? !['.mp4', '.m4v'].includes(extname(destination).toLowerCase()) : extname(destination).toLowerCase() !== '.webm')) failure('incompatible-media-container');
      if (Math.abs(videoProbe.durationSeconds - audioProbe.durationSeconds) > durationTolerance(Math.min(videoProbe.durationSeconds, audioProbe.durationSeconds))) failure('incompatible-media-duration');
      checkAbort(signal); verifyDirectory();
      temporary = join(directory, `.remux-${randomUUID()}.tmp`);
      output = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW), 0o600); outputIdentity = await output.stat();
      const outputArgument = 'pipe:1';
      const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm', '-i', inputArgument(video, 3), '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm', '-i', inputArgument(audio, 4), '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-map_metadata', '-1', '-map_chapters', '-1', '-progress', 'pipe:2', '-nostats', ...(videoProbe.container === 'mp4' ? ['-movflags', '+frag_keyframe+empty_moov+default_base_moof'] : []), '-f', videoProbe.container, outputArgument];
      const safe = args.map(a => a === inputArgument(video, 3) ? 'video-input' : a === inputArgument(audio, 4) ? 'audio-input' : a);
      await run(getTools().ffmpeg, args, safe, signal, 'remux', process.platform === 'win32' ? [] : [video.handle.fd, audio.handle.fd], directory, output, undefined, Math.min(1024 ** 4, video.identity.size + audio.identity.size + 64 * 1024 * 1024));
      checkAbort(signal); await output.sync(); verifyDirectory();
      if (!sameIdentity(outputIdentity, await lstat(temporary))) failure('media-output-substituted');
      const finalFile: PinnedFile = { requestedPath: temporary, path: temporary, handle: output, identity: await output.stat(), container: video.container };
      if (!sameIdentity(outputIdentity, finalFile.identity)) failure('media-output-substituted');
      await inspectProtection(output, finalFile.identity.size, finalFile.container, signal); await verifyPinned(finalFile);
      const resultProbe = await probePinned(finalFile, signal, true);
      const expected = [videoProbe.streams[0], audioProbe.streams[0]];
      if (resultProbe.container !== videoProbe.container || resultProbe.streams.length !== 2) failure('remux-verification-failed');
      for (let i = 0; i < 2; i++) {
        const { durationSeconds: inputDuration, ...inputParameters } = expected[i]; const { durationSeconds: outputDuration, ...outputParameters } = resultProbe.streams[i];
        if (JSON.stringify(inputParameters) !== JSON.stringify(outputParameters) || Math.abs(inputDuration - outputDuration) > durationTolerance(inputDuration) || Math.abs(inputDuration - resultProbe.durationSeconds) > durationTolerance(inputDuration)) failure('remux-verification-failed');
      }
      for (const file of [...files, finalFile]) await verifyPinned(file);
      // No await between the final cancellation check and no-clobber link: publication is the linearization point.
      // Cancellation after link commits does not undo the artifact or turn its result into cancellation.
      checkAbort(signal); verifyDirectory(); assertAbsent();
      if (!sameIdentity(finalFile.identity, lstatSync(temporary), true)) failure('media-output-substituted');
      linkSync(temporary, destination); committed = true;
      verifyDirectory(); if (!sameIdentity(finalFile.identity, lstatSync(destination))) failure('media-output-substituted');
      unlinkSync(temporary); temporary = undefined; await parent?.sync();
      emit('remux', 'result', 'succeeded', { evidence: { probe: resultProbe, committed: true } });
      return { status: 'succeeded', outputPath: destination, probe: resultProbe };
    } catch (error) {
      const safe = normalize(error, committed ? undefined : signal); emit('remux', 'result', safe.name === 'AbortError' ? 'cancelled' : 'failed', { evidence: { outcome: 'inconclusive', code: safe.code, committed } }); throw safe;
    } finally {
      await Promise.all(files.map(file => file.handle.close().catch(() => undefined))); await output?.close().catch(() => undefined); await parent?.close().catch(() => undefined);
      if (temporary && outputIdentity) { try { const info = lstatSync(temporary); if (sameIdentity(outputIdentity, info)) unlinkSync(temporary); } catch { /* Never delete a substituted or unrelated entry. */ } }
    }
  }
  return { probeMedia, remuxTracks };
}
function normalize(error: unknown, signal?: AbortSignal): MediaToolError {
  if (signal?.aborted) return new MediaToolError('cancelled'); return error instanceof MediaToolError ? error : new MediaToolError('media-io-failed');
}
export function probeMedia(path: string, signal: AbortSignal): Promise<MediaProbe> { return createMediaAdapter().probeMedia(path, signal); }
export function remuxTracks(videoPath: string, audioPath: string, outputPath: string, signal: AbortSignal): Promise<RemuxResult> { return createMediaAdapter().remuxTracks(videoPath, audioPath, outputPath, signal); }
