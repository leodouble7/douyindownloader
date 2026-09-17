import { afterEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { stageMediaTools } = require('../../scripts/stage-media-tools.cjs') as {
  stageMediaTools: (context: {
    appOutDir: string;
    electronPlatformName: string;
    arch: number;
    packager: { appInfo: { productFilename: string } };
  }, projectRoot: string) => void;
};
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'release-media-tools-'));
  roots.push(root);
  return { root, project: join(root, 'project'), output: join(root, 'output') };
}

async function source(project: string, tool: 'ffmpeg' | 'ffprobe', platform: string, arch: string) {
  const name = `${tool}${platform === 'win32' ? '.exe' : ''}`;
  const path = join(project, 'node_modules', `@${tool}-installer`, `${platform}-${arch}`, name);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${tool}-${platform}-${arch}`);
  await chmod(path, 0o755);
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('puts executable arm64 media tools beside the packaged macOS app', async () => {
  const { project, output } = await fixture();
  await source(project, 'ffmpeg', 'darwin', 'arm64');
  await source(project, 'ffprobe', 'darwin', 'arm64');
  stageMediaTools({ appOutDir: output, electronPlatformName: 'darwin', arch: 3, packager: { appInfo: { productFilename: '抖音视频下载' } } }, project);
  const directory = join(output, '抖音视频下载.app', 'Contents', 'Resources', 'media-tools', 'darwin-arm64');
  expect(await readFile(join(directory, 'ffmpeg'), 'utf8')).toBe('ffmpeg-darwin-arm64');
  expect(await readFile(join(directory, 'ffprobe'), 'utf8')).toBe('ffprobe-darwin-arm64');
  expect((await stat(join(directory, 'ffmpeg'))).mode & 0o111).not.toBe(0);
});

it('puts Windows x64 tools in the resources directory', async () => {
  const { project, output } = await fixture();
  await source(project, 'ffmpeg', 'win32', 'x64');
  await source(project, 'ffprobe', 'win32', 'x64');
  stageMediaTools({ appOutDir: output, electronPlatformName: 'win32', arch: 1, packager: { appInfo: { productFilename: '抖音视频下载' } } }, project);
  const directory = join(output, 'resources', 'media-tools', 'win32-x64');
  expect(await readFile(join(directory, 'ffmpeg.exe'), 'utf8')).toBe('ffmpeg-win32-x64');
  expect(await readFile(join(directory, 'ffprobe.exe'), 'utf8')).toBe('ffprobe-win32-x64');
});

it('refuses an x64 build when only arm64 binaries are installed', async () => {
  const { project, output } = await fixture();
  await source(project, 'ffmpeg', 'darwin', 'arm64');
  await source(project, 'ffprobe', 'darwin', 'arm64');
  expect(() => stageMediaTools({ appOutDir: output, electronPlatformName: 'darwin', arch: 1, packager: { appInfo: { productFilename: '抖音视频下载' } } }, project)).toThrow(/darwin-x64/);
});
