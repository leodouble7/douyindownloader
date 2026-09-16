import type { TrackProgress } from '../../shared/desktop';
import { Icon } from './Icon';

export const kindLabels: Record<string, string> = { video: '视频', audio: '音频', muxed: '完整视频', pair: '视频 + 音频', unknown: '媒体文件' };

export function MediaProgress({ track }: { track: TrackProgress }) {
  const label = kindLabels[track.kind] || '媒体';
  const percent = track.totalBytes && track.totalBytes > 0 ? Math.min(100, Math.floor(track.downloadedBytes / track.totalBytes * 100)) : undefined;
  const complete = track.status === 'completed';
  return <div className={`track ${track.kind === 'audio' ? 'audio-track' : ''}`}>
    <div className="track-header"><span className="track-kind"><Icon name={track.kind === 'audio' ? 'audio' : 'video'} size={18} />{label}</span><span className="track-percent">{complete ? <><Icon name="check" size={13} />已下载</> : track.status === 'queued' ? '等待下载' : percent === undefined ? '下载中' : `${percent}%`}</span></div>
    <div className="progress-track" role="progressbar" aria-label={`${label}下载进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><div className="progress-fill" style={{ width: `${percent ?? 0}%` }} /></div>
    <div className="track-details"><span>{formatBytes(track.downloadedBytes)}<span className="subtle"> / {track.totalBytes ? formatBytes(track.totalBytes) : '大小待获取'}</span></span><span>{track.status === 'running' && track.bytesPerSecond > 0 ? `${formatBytes(track.bytesPerSecond)}/s` : complete ? '下载完成' : '—'}</span></div>
  </div>;
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const unit = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}
