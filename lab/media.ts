import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import ffmpeg from '@ffmpeg-installer/ffmpeg';

export interface MediaFixtures {
  root: string;
  video: string;
  videoOnly: string;
  audioOnly: string;
  hlsManifest: string;
  dashManifest: string;
  hlsSegments: readonly string[];
  dashSegments: readonly string[];
  cleanup(): Promise<void>;
}

const DURATION_SECONDS = '6';
const VIDEO_SOURCE = 'testsrc2=size=320x180:rate=30';
const AUDIO_SOURCE = 'sine=frequency=1000:sample_rate=48000';
const MEDIA_METADATA = ['-metadata', 'title=Media Security Lab Fixture', '-metadata', 'creation_time=1970-01-01T00:00:00Z'];

export async function createMediaFixtures(signal?: AbortSignal): Promise<MediaFixtures> {
  throwIfAborted(signal);
  const root = await mkdtemp(join(tmpdir(), 'media-security-lab-'));
  const video = join(root, 'video.mp4');
  const videoOnly = join(root, 'video-only.mp4');
  const audioOnly = join(root, 'audio-only.mp4');
  const hlsManifest = join(root, 'stream.m3u8');
  const dashManifest = join(root, 'manifest.mpd');

  try {
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', VIDEO_SOURCE,
      '-f', 'lavfi', '-i', AUDIO_SOURCE,
      '-t', DURATION_SECONDS,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-profile:v', 'baseline', '-level:v', '3.0', '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
      '-map_metadata', '-1', ...MEDIA_METADATA, '-movflags', '+faststart', video
    ], signal);
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y', '-i', video,
      '-map', '0:v:0', '-an', '-c', 'copy', '-map_metadata', '-1', ...MEDIA_METADATA,
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof', videoOnly
    ], signal);
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y', '-i', video,
      '-map', '0:a:0', '-vn', '-c', 'copy', '-map_metadata', '-1', ...MEDIA_METADATA,
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof', audioOnly
    ], signal);
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-c', 'copy',
      '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_list_size', '0',
      '-hls_segment_filename', join(root, 'segment-%03d.ts'), hlsManifest
    ], signal);
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y', '-i', video,
      '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'dash', '-seg_duration', '2',
      '-use_template', '1', '-use_timeline', '0', '-adaptation_sets', 'id=0,streams=v id=1,streams=a', dashManifest
    ], signal);

    const hlsSegments = (await readdir(root))
      .filter((name) => /^segment-\d+\.ts$/.test(name))
      .sort()
      .map((name) => join(root, name));
    const dashSegments = (await readdir(root))
      .filter((name) => name.endsWith('.m4s'))
      .sort()
      .map((name) => join(root, name));
    if (hlsSegments.length < 3) {
      throw new Error('FFmpeg did not create the expected HLS segments');
    }
    if (dashSegments.length === 0) {
      throw new Error('FFmpeg did not create the expected DASH segments');
    }

    return {
      root,
      video,
      videoOnly,
      audioOnly,
      hlsManifest,
      dashManifest,
      hlsSegments,
      dashSegments,
      cleanup: async () => rm(root, { recursive: true, force: true })
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** Optional clear WebM fixture tracks; generated only by media adapter tests. */
export async function createWebmFixtureTracks(fixtures: MediaFixtures, signal?: AbortSignal): Promise<{ videoOnly: string; audioOnly: string }> {
  const videoOnly = join(fixtures.root, 'video-only.webm'); const audioOnly = join(fixtures.root, 'audio-only.webm');
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', fixtures.video, '-map', '0:v:0', '-an', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-threads', '1', '-map_metadata', '-1', videoOnly], signal);
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', fixtures.video, '-map', '0:a:0', '-vn', '-c:a', 'libopus', '-map_metadata', '-1', audioOnly], signal);
  return { videoOnly, audioOnly };
}

export async function readFixture(path: string): Promise<Buffer> {
  return readFile(path);
}

export function fixtureName(path: string): string {
  return basename(path);
}

function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg.path, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
    });
    child.once('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(abortError());
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg fixture generation failed with exit code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

function abortError(): Error {
  return new DOMException('Media fixture generation was cancelled', 'AbortError');
}
