import type { MediaAsset, MediaTrack } from '../../shared/contracts';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { eligibleTrack } from '../probes/probe-planner';

export interface Options {
  pageUrl?: string; videoUrl?: string; audioUrl?: string; videoFile?: string; audioFile?: string;
  outputDirectory: string; referer?: string; userAgent?: string;
  observeSeconds: number; maxBytes: number; selection?: number[]; list: boolean; help: boolean;
}
export function httpUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('请输入完整的 HTTP/HTTPS 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('媒体地址必须是 HTTP/HTTPS；blob 地址仅在浏览器内有效');
  return url.href;
}
export function parseOptions(args: string[]): Options {
  const { values: v, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    'video-url': { type: 'string' }, 'audio-url': { type: 'string' },
    'video-file': { type: 'string' }, 'audio-file': { type: 'string' },
    output: { type: 'string', short: 'o' }, referer: { type: 'string' }, 'user-agent': { type: 'string' },
    'observe-seconds': { type: 'string' }, 'max-mb': { type: 'string' }, select: { type: 'string' },
    list: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
  } });
  const bounded = (value: string | undefined, fallback: number, max: number) => {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`参数必须是 1 到 ${max} 的整数`);
    return n;
  };
  const result: Options = { outputDirectory: resolve(v.output ?? 'downloads'), observeSeconds: bounded(v['observe-seconds'], 30, 300),
    maxBytes: bounded(v['max-mb'], 4096, 102400) * 1024 ** 2, selection: v.select ? v.select.split(',').map(n => bounded(n, 1, 512)) : undefined,
    list: v.list ?? false, help: v.help ?? false, userAgent: v['user-agent'] };
  if (result.help) return result;
  if (positionals.length > 1) throw new Error('分享文本或页面地址请放在一对引号中');
  if (positionals[0]) {
    const urls = positionals[0].match(/https?:\/\/[^\s<>"'，。；、）】]+/g);
    if (!urls || urls.length !== 1) throw new Error('请提供一个抖音视频或分享链接');
    result.pageUrl = httpUrl(urls[0]);
    const host = new URL(result.pageUrl).hostname;
    if (host !== 'douyin.com' && !host.endsWith('.douyin.com')) throw new Error('页面捕获入口只接受抖音链接；媒体直链请使用 --video-url / --audio-url');
  }
  if (v['video-url']) result.videoUrl = httpUrl(v['video-url']);
  if (v['audio-url']) result.audioUrl = httpUrl(v['audio-url']);
  if (v.referer) result.referer = httpUrl(v.referer);
  if (v['video-file']) result.videoFile = resolve(v['video-file']);
  if (v['audio-file']) result.audioFile = resolve(v['audio-file']);
  if (result.userAgent && /[\r\n]/.test(result.userAgent)) throw new Error('User-Agent 不能包含换行');
  const local = !!(result.videoFile || result.audioFile), remote = !!(result.videoUrl || result.audioUrl);
  if (Number(local) + Number(remote) + Number(!!result.pageUrl) !== 1) throw new Error('请选择页面捕获、媒体直链或本地合并中的一种输入方式');
  if (local && (!result.videoFile || !result.audioFile)) throw new Error('本地合并必须同时指定 --video-file 和 --audio-file');
  if ((result.list || result.selection !== undefined) && !result.pageUrl) throw new Error('--list / --select 只用于页面捕获');
  return result;
}

export function downloadableAssets(assets: MediaAsset[]): MediaAsset[] {
  return assets.filter(asset => !asset.encrypted && asset.selectedTrackIds.length > 0 &&
    asset.selectedTrackIds.every(id => asset.tracks.some(track => track.id === id && eligibleTrack(track))));
}
export function selectMedia(assets: MediaAsset[], selection?: number | number[]): MediaTrack[] {
  const candidates = downloadableAssets(assets);
  if (!candidates.length) throw new Error('没有发现完整、可下载的 MP4/WebM 媒体请求；请确认页面已播放，或传入媒体直链');
  if (selection === undefined && candidates.length !== 1) throw new Error('发现多个媒体资源，无法确认目标作品；请选择当前列表中的序号');
  const indices = selection === undefined ? [1] : Array.isArray(selection) ? selection : [selection];
  if (!indices.length || indices.length > 2 || new Set(indices).size !== indices.length || indices.some(n => !Number.isSafeInteger(n) || n < 1 || n > candidates.length)) throw new Error('选择序号超出当前媒体列表范围或存在重复');
  const tracks = indices.flatMap(n => { const asset = candidates[n - 1]; return asset.selectedTrackIds.map(id => asset.tracks.find(track => track.id === id)!); });
  if (indices.length === 2 && (tracks.length !== 2 || !tracks.some(t => t.kind === 'video') || !tracks.some(t => t.kind === 'audio'))) throw new Error('跨资源选择必须是一条视频轨和一条音频轨');
  return tracks;
}
