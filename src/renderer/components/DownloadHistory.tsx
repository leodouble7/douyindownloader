import { useEffect, useState } from 'react';
import type { DesktopDownloaderApi, DownloadHistoryPage } from '../../shared/desktop';

export function DownloadHistory({ api, revision, disabled, onReveal }: {
  api: DesktopDownloaderApi; revision: string; disabled: boolean; onReveal: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState<DownloadHistoryPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    setLoading(true); setError('');
    void api.getHistory({ offset }).then(result => {
      if (!active) return;
      setPage(result);
    }).catch(() => { if (active) setError('无法读取下载历史，请重试。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, expanded, offset, retry, revision]);
  return <section className="download-history" aria-label="下载历史">
    <div className="history-heading"><h2><button type="button" className="button link history-toggle" aria-expanded={expanded} aria-controls="download-history-list" onClick={() => setExpanded(value => !value)}>下载历史<span aria-hidden="true">{expanded ? '−' : '+'}</span></button></h2><span>仅保存在本机 · 最近 1000 条</span></div>
    {expanded && <div id="download-history-list" className="history-content" aria-busy={loading}>
      {loading ? <p className="processing-note" role="status">正在读取历史…</p> : error ? <div className="inline-error"><p role="alert">{error}</p><button type="button" className="button" onClick={() => setRetry(value => value + 1)}>重试加载历史</button></div> : page && <>
        {!page.items.length ? <p className="history-empty">还没有下载记录。成功保存的作品会显示在这里。</p> : <ul className="history-list">{page.items.map(item => <li key={item.id}>
          <div className="history-info"><h3>{item.title}</h3><p>{item.author} · 作品 {item.workId}</p><p><time dateTime={item.completedAt}>{new Date(item.completedAt).toLocaleString('zh-CN', { hour12: false })}</time>（本地时间）{!item.available && <span className="history-missing"> · 文件已移动或删除</span>}</p><p className="history-path">{item.outputPath}</p></div>
          <button type="button" className="button" disabled={disabled || !item.available} onClick={() => onReveal(item.id)}>打开文件夹</button>
        </li>)}</ul>}
        {page.total > page.limit && <nav className="history-pagination" aria-label="下载历史分页"><button type="button" className="button" disabled={page.offset === 0} onClick={() => setOffset(Math.max(0, page.offset - page.limit))}>上一页</button><span>{page.offset + 1}–{Math.min(page.total, page.offset + page.items.length)} / {page.total}</span><button type="button" className="button" disabled={page.offset + page.limit >= page.total} onClick={() => setOffset(page.offset + page.limit)}>下一页</button></nav>}
      </>}
    </div>}
  </section>;
}
