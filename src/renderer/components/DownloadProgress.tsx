import { useState } from 'react';
import type { TrackProgress } from '../../shared/desktop';
import { MediaProgress } from './MediaProgress';

/** One truthful overall byte progress; individual streams remain available on demand. */
export function DownloadProgress({ tracks }: { tracks: TrackProgress[] }) {
  const [expanded, setExpanded] = useState(false);
  const known = tracks.length > 0 && tracks.every(track => track.totalBytes && track.totalBytes > 0);
  const total = tracks.reduce((sum, track) => sum + (track.totalBytes ?? 0), 0);
  const received = tracks.reduce((sum, track) => sum + Math.min(track.downloadedBytes, track.totalBytes ?? track.downloadedBytes), 0);
  const percent = known ? Math.min(100, Math.floor(received / total * 100)) : undefined;
  return <div className="download-progress"><div className="simple-progress-label"><span>{percent === 100 ? '下载完成，正在保存…' : '正在下载'}</span><strong>{percent === undefined ? '大小待获取' : `${percent}%`}</strong></div>
    <div className="progress-track" role="progressbar" aria-label="下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><div className="progress-fill" style={{ width: `${percent ?? 0}%` }} /></div>
    <details className="download-details" onToggle={event => setExpanded(event.currentTarget.open)}><summary>下载详情</summary>{expanded && <div className="track-list">{tracks.map(track => <MediaProgress key={track.id} track={track} />)}</div>}</details>
  </div>;
}
