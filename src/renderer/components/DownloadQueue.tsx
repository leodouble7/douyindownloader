import type { DownloadQueueItem } from '../../shared/desktop';
import { DownloadProgress } from './DownloadProgress';
import { FailureMessage } from './FailureMessage';
import { Icon } from './Icon';

const labels: Record<DownloadQueueItem['phase'], string> = { queued: '等待中', downloading: '正在下载', merging: '正在保存', verifying: '正在保存', completed: '已保存', 'tracks-only': '视频没有声音', cancelled: '已取消', failed: '下载失败' };
export function DownloadQueue({ items, pending, active, onRetry, onReveal }: {
  items: DownloadQueueItem[]; pending: boolean; active: boolean; onRetry: (taskId: string) => void; onReveal: (taskId: string) => void;
}) {
  const needsAttention = (item: DownloadQueueItem) => ['failed', 'cancelled'].includes(item.phase);
  const ordered = active ? items : [...items.filter(needsAttention), ...items.filter(item => !needsAttention(item))];
  return <section className="panel queue-panel" aria-label={active ? '下载队列' : '下载结果'}>{ordered.map(item => {
    const index = items.indexOf(item), working = ['downloading', 'merging', 'verifying'].includes(item.phase);
    const failed = needsAttention(item), finished = item.phase === 'completed' || item.phase === 'tracks-only';
    const audioOnly = item.tracks.length > 0 && item.tracks.every(track => track.kind === 'audio');
    const filename = item.outputPath?.split(/[\\/]/).pop();
    const label = filename || item.label.split(' · ')[0].replace(/^待确认资源\s*/, audioOnly ? '音频 ' : '视频 ');
    return <article className={`job ${failed ? 'needs-attention' : ''}`} key={item.id} aria-label={`任务 ${index + 1}：${item.label}`}>
      <div className="job-heading"><span className={`media-icon ${audioOnly ? 'audio' : ''}`}><Icon name={audioOnly ? 'audio' : 'video'} size={19} /></span><div className="job-name"><h2>{label}</h2></div><span className={`job-state ${item.phase}`}>{item.phase === 'completed' && <Icon name="check" size={15} />}{labels[item.phase]}</span></div>
      {working && <div className="job-content">{item.phase === 'downloading' ? <DownloadProgress tracks={item.tracks} /> : <p className="processing-note"><span className="spinner" aria-hidden="true" />正在保存，请稍候…</p>}</div>}
      {(finished || failed) && <div className="job-content result-content">{failed && <FailureMessage message={item.message} />}
        <div className="result-actions">{failed && <button type="button" className="button primary" disabled={pending || active || !item.canRetry} onClick={() => onRetry(item.id)}><Icon name="retry" size={16} />{!active && !item.canRetry ? '已过期，无法重试' : '重试此项'}</button>}
          {item.outputPath && <button type="button" className={`button ${finished ? 'primary' : ''}`} disabled={pending || active} onClick={() => onReveal(item.id)}><Icon name="folder" size={15} />打开文件夹</button>}
        </div>
      </div>}
    </article>;
  })}</section>;
}
