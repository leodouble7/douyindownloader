import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseOptions, downloadableAssets, selectMedia } from './options';
import { downloadMedia } from './download';
import { capturePage } from './capture-page';
import { createMediaAdapter } from '../media/ffmpeg-adapter';
import { redactText } from '../security/redact';
import type { RunEvent } from '../../shared/contracts';
import { createHash } from 'node:crypto';
import { createMediaResolver } from './public-dns';
import { sanitizeCaptureReport } from './report';
import { installCancellation } from './cancellation';

const HELP = `抖音媒体下载与无损合并

用法：
  npm run douyin -- "https://www.douyin.com/video/作品ID" -o ./downloads
  npm run douyin -- "抖音分享文本" --list
  npm run douyin -- --video-url "视频直链" --audio-url "音频直链" --referer "https://www.douyin.com/"
  npm run douyin -- --audio-url "音频直链" -o ./downloads
  npm run douyin -- --video-file ./video.mp4 --audio-file ./audio.m4a -o ./downloads

选项：
  -o, --output DIR       输出目录；每次生成独立子目录，默认 ./downloads
  --observe-seconds N    页面加载完成后的观察秒数，默认 30，最多 300
  --list                仅分析页面并列出候选媒体，不下载
  --select N[,M]        选择本次捕获中的单文件或视频、音频序号，例如 2,3
  --max-mb N            每条轨道大小上限（MiB），默认 4096
  --referer URL         直链请求使用的 Referer
  --user-agent TEXT     直链请求使用的 User-Agent
  -h, --help            显示帮助

页面模式会打开独立浏览器，请播放目标作品。支持 MP4/WebM 完整文件与分轨；
已合成的文件直接保存。登录限制、验证码、过期地址和加密媒体会给出失败提示。
`;

const controller = new AbortController();
installCancellation(controller);
let lastProgress = 0;
function progress(event: RunEvent): void {
  if (event.action === 'download:before') console.error('开始下载媒体轨道…');
  if (['download:receiving', 'download:progress'].includes(event.action) && Date.now() - lastProgress > 800) {
    lastProgress = Date.now();
    console.error(`已下载 ${(Number(event.evidence?.receivedBytes ?? event.evidence?.completedBytes ?? 0) / 1024 ** 2).toFixed(2)} MiB`);
  }
  if (event.action === 'download:after') console.error('轨道下载完成，长度与 SHA-256 已核对');
  if (event.action === 'remux:command') console.error('正在无损合并音视频…');
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const signal = controller.signal;
  if (options.videoFile && options.audioFile) {
    const adapter = createMediaAdapter();
    const video = await adapter.probeMedia(options.videoFile, signal);
    await mkdir(options.outputDirectory, { recursive: true });
    const directory = await mkdtemp(join(options.outputDirectory, 'douyin-merge-'));
    const result = await adapter.remuxTracks(options.videoFile, options.audioFile, join(directory, `video.${video.container}`), signal);
    await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(`合并完成：${result.outputPath}`); return;
  }
  let captured;
  if (options.pageUrl) {
    console.error(`已打开捕获浏览器。请播放目标作品，页面加载后观察 ${options.observeSeconds} 秒…`);
    const result = await capturePage({ pageUrl: options.pageUrl, observeSeconds: options.observeSeconds }, signal);
    const safeSummary = sanitizeCaptureReport({ pageUrl: options.pageUrl, summary: result.summary });
    const candidates = downloadableAssets(result.assets);
    const display = candidates.map((asset, index) => ({ index: index + 1, tracks: asset.tracks.filter(t => asset.selectedTrackIds.includes(t.id)).map(track => ({
      kind: track.kind, host: new URL(track.sanitizedUrl).hostname,
      contentId: new URL(track.sanitizedUrl).searchParams.get('video_id') ?? new URL(track.sanitizedUrl).searchParams.get('media_id'),
      codecs: track.codecs, bytes: track.byteLength,
      pathPattern: new URL(track.sanitizedUrl).pathname.split('/').map(part => part.length > 24 ? `[id:${createHash('sha256').update(part).digest('hex').slice(0, 8)}]` : part).join('/'),
      queryKeys: [...new URL(track.sanitizedUrl).searchParams.keys()]
    })) }));
    console.log(`页面：${safeSummary.summary.title}\n网络事件：${result.summary.network}，MSE 事件：${result.summary.mse}，视频元素：${result.summary.videoElements}`);
    for (const row of display) console.log(`[${row.index}] ${row.tracks.map(t => `${t.kind} ${(Number(t.bytes ?? 0) / 1024 ** 2).toFixed(2)} MiB ${t.host}${t.contentId ? ` (${t.contentId})` : ''}`).join(' + ')}`);
    await mkdir(options.outputDirectory, { recursive: true });
    const directory = await mkdtemp(join(options.outputDirectory, 'douyin-analysis-'));
    const path = join(directory, 'capture.json');
    await writeFile(path, JSON.stringify({ testedAt: new Date().toISOString(), ...safeSummary, candidates: display }, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(`播放分析：${path}`);
    if (!candidates.length) console.error(`未发现完整媒体。页面提示：${safeSummary.summary.excerpt.replace(/\s+/g, ' ')}`);
    if (options.list) return;
    let selection = options.selection;
    if (selection === undefined && candidates.length > 1 && process.stdin.isTTY) {
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      try { selection = (await reader.question('请输入目标媒体序号；分轨请输入视频,音频（例如 2,3）：', { signal })).split(',').map(Number); }
      finally { reader.close(); }
    }
    const tracks = selectMedia(result.assets, selection);
    captured = { runId: result.runId, tracks, requests: result.requests };
  }
  const result = await downloadMedia({ ...options, captured, onEvent: progress, networkPolicy: { resolveHostname: createMediaResolver() } }, signal);
  console.log(result.message);
  if (result.outputPath) console.log(`输出文件：${result.outputPath}`);
  for (const track of result.tracks) console.log(`原始轨道：${track.path}`);
  console.log(`验证结果：${result.reportPath}`);
  if (result.status === 'tracks-only') process.exitCode = 2;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '未知错误';
  console.error(controller.signal.aborted ? '已取消。' : `失败：${redactText(message)}`);
  if (error instanceof Error && 'reportPath' in error) console.error(`已保存失败记录和完整分轨路径：${String(error.reportPath)}`);
  process.exitCode = controller.signal.aborted ? 130 : 1;
});
