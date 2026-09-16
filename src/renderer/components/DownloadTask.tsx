import type { DownloadMode, DownloadSelection, DownloadSnapshot } from '../../shared/desktop';
import { Icon } from './Icon';
import { MediaSelection } from './MediaSelection';
import { DownloadQueue } from './DownloadQueue';
import { DownloadProgress } from './DownloadProgress';
import { TaskContext } from './TaskContext';
import { FailureMessage } from './FailureMessage';

export function DownloadTask({ state, pending, onSelect, onRetry, onReveal, onManualCapture }: {
  state: DownloadSnapshot; pending: boolean;
  onSelect: (mode: DownloadMode, selections: DownloadSelection[]) => void; onRetry: (taskId: string) => void;
  onReveal: (taskId?: string) => void; onManualCapture: () => void;
}) {
  const choosing = state.phase === 'choosing', parsing = state.phase === 'parsing';
  const working = ['downloading', 'merging', 'verifying'].includes(state.phase);
  const hasQueue = !!state.queue?.length, failed = state.phase === 'failed';
  const recovery = !hasQueue && (failed || state.phase === 'cancelled');
  const needsAttention = state.queue?.filter(item => ['failed', 'cancelled'].includes(item.phase)) ?? [];
  const expired = !working && needsAttention.length > 0 && needsAttention.every(item => !item.canRetry);
  const activeIndex = state.queue?.findIndex(item => ['downloading', 'merging', 'verifying', 'queued'].includes(item.phase)) ?? -1;
  const retrying = working && ((state.queue?.[activeIndex]?.attempts ?? 0) > 1 || state.message.includes('重试'));
  const saved = state.queue?.some(item => ['completed', 'tracks-only'].includes(item.phase));
  const resultTitle = !needsAttention.length ? '下载完成' : saved ? '部分文件未下载成功' : needsAttention.some(item => item.phase === 'failed') ? '下载未成功' : '下载已取消';
  const title = parsing ? '正在准备下载' : choosing ? state.targetWorkId ? '选择清晰度' : '选择要下载的内容' : working ? retrying ? '正在重试' : '正在下载' : recovery ? failed ? '下载未成功' : '下载已取消' : resultTitle;

  return <section className="current-download" aria-label="当前下载">
    <div className="download-heading"><h2>{title}</h2>{working && (state.queue?.length ?? 0) > 1 && <span className="queue-count">{Math.max(1, activeIndex + 1)} / {state.queue!.length}</span>}</div>
    {!parsing && !choosing && !working && (hasQueue || state.outputPath) && <TaskContext directory={state.resultDirectory ?? state.directory} />}
    {choosing ? <MediaSelection key={state.id} targetTitle={state.targetWorkId ? state.title || '抖音作品' : undefined} candidates={state.candidates} pending={pending} onSubmit={onSelect} /> : <>
      {expired && <p className="expiry-banner">下载信息已过期，请用上方链接重新开始。已保存文件可以正常打开。</p>}
      {hasQueue ? <DownloadQueue items={state.queue!} pending={pending} active={working} onRetry={onRetry} onReveal={onReveal} /> : parsing || recovery ? <section className="panel inline-download-state" aria-label="下载状态">
        {parsing ? <p className="processing-note" role="status"><span className="spinner" aria-hidden="true" />{state.captureMode === 'interactive' ? '请在打开的抖音网页中播放要下载的视频。' : '正在后台读取视频，通常需要约 30 秒。'}</p> : failed ? <FailureMessage message={state.message} alert /> : <p role="status">{state.message || '下载已取消，可以修改上方链接后重新开始。'}</p>}
        {failed && state.captureFallback && <div className="capture-fallback"><p>如果需要登录、验证或手动播放，可以打开网页操作。</p><button type="button" className="button" disabled={pending} onClick={onManualCapture}>打开抖音网页重试</button></div>}
      </section> : <section className="panel standalone-task">
        {working ? state.phase === 'downloading' ? <DownloadProgress tracks={state.tracks} /> : <p className="processing-note" role="status"><span className="spinner" aria-hidden="true" />正在保存，请稍候…</p> : <><p className="result-path">{state.outputPath || state.reportPath}</p><button className="button primary" type="button" onClick={() => onReveal()} disabled={pending || !(state.outputPath || state.reportPath)}><Icon name="folder" size={18} />打开文件夹</button></>}
      </section>}
      {hasQueue && <p className="sr-only" role="status">{state.message}</p>}
    </>}
  </section>;
}
