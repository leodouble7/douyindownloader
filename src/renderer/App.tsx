import { useEffect, useRef, useState } from 'react';
import { isDownloadActive, type DesktopDownloaderApi, type DownloadSnapshot } from '../shared/desktop';
import { Icon } from './components/Icon';
import { DownloadTask } from './components/DownloadTask';
import { FailureMessage } from './components/FailureMessage';

const initial: DownloadSnapshot = { sequence: -1, phase: 'idle', directory: '', message: '', candidates: [], tracks: [] };

export function App({ api = window.downloader }: { api?: DesktopDownloaderApi }) {
  const [state, setState] = useState(initial);
  const [url, setUrl] = useState('');
  const [submittedUrl, setSubmittedUrl] = useState('');
  const [directory, setDirectory] = useState('');
  const [error, setError] = useState('');
  const [fields, setFields] = useState({ url: '', directory: '' });
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const directoryButton = useRef<HTMLButtonElement>(null);
  const operationPending = useRef(false);
  const lastSequence = useRef(-1);
  const touchedDirectory = useRef(false);
  const busy = isDownloadActive(state.phase);
  const displayedDirectory = busy ? state.resultDirectory ?? directory : directory;

  useEffect(() => {
    if (!api) { setError('请在桌面应用中打开下载工具'); return; }
    let alive = true;
    lastSequence.current = -1;
    const accept = (next: DownloadSnapshot) => {
      if (!alive || next.sequence <= lastSequence.current) return;
      lastSequence.current = next.sequence;
      setState(next); setReady(true);
      if (!touchedDirectory.current) setDirectory(next.directory);
    };
    const unsubscribe = api.onState(accept);
    void api.getState().then(accept).catch(() => { if (alive) setError('无法连接下载服务，请重新启动应用'); });
    return () => { alive = false; unsubscribe(); };
  }, [api]);

  const action = async (operation: () => Promise<unknown>) => {
    if (operationPending.current) return;
    operationPending.current = true; setPending(true); setError('');
    try { await operation(); }
    catch (failure) {
      const message = failure instanceof Error ? failure.message.replace(/^Error invoking remote method 'downloader:[^']+': (?:Error: )?/, '') : '';
      setError(message || '操作失败，请重试');
    }
    finally { operationPending.current = false; setPending(false); }
  };
  const startDownload = (interactive = false) => {
    if (busy || pending || !ready) return;
    if (!validDouyinLink(url)) { setFields({ url: '请输入一个有效的抖音链接或分享文字', directory: '' }); input.current?.focus(); return; }
    if (!directory) { setFields({ url: '', directory: '请选择视频的保存文件夹' }); directoryButton.current?.focus(); return; }
    setFields({ url: '', directory: '' });
    const submitted = url.trim(), previous = submittedUrl;
    setSubmittedUrl(submitted);
    void action(async () => {
      try { await api!.start({ url: submitted, directory, ...(interactive ? { interactive: true } : {}) }); }
      catch (failure) { setSubmittedUrl(previous); throw failure; }
    });
  };
  const chooseDirectory = () => void action(async () => {
    const selected = await api!.chooseDirectory();
    if (selected) { touchedDirectory.current = true; setDirectory(selected); setFields(previous => ({ ...previous, directory: '' })); }
  });

  return <div className="app-shell single-page">
    <h1 className="sr-only">视频下载</h1>
    <main className="download-workspace" aria-label="下载工作区">
      <form className="entry-form" aria-label="下载设置" noValidate onSubmit={event => { event.preventDefault(); startDownload(); }}>
        <div className="form-grid">
          <div className="field"><label htmlFor="video-url">视频链接</label><div className="input-wrap"><Icon name="link" size={17} /><input ref={input} id="video-url" value={busy ? submittedUrl || url : url} onChange={event => { setUrl(event.target.value); setFields(previous => ({ ...previous, url: '' })); setError(''); }} placeholder="粘贴抖音链接或分享文字" readOnly={busy} disabled={pending || !ready} autoComplete="off" spellCheck={false} aria-invalid={!!fields.url} aria-describedby="url-error" />
            {url && <button type="button" className="button icon-button" aria-label="清空视频地址" disabled={pending || busy} onClick={() => { setUrl(''); setFields(previous => ({ ...previous, url: '' })); input.current?.focus(); }}><Icon name="close" size={15} /></button>}
          </div><p className="field-error" id="url-error" role={fields.url ? 'alert' : undefined}>{fields.url}</p></div>
          <div className="field"><label htmlFor="output-directory">保存位置</label><div className="input-wrap"><Icon name="folder" size={17} /><input id="output-directory" value={displayedDirectory} readOnly placeholder="请选择保存文件夹" title={displayedDirectory} aria-invalid={!!fields.directory} aria-describedby="directory-error" /><button ref={directoryButton} type="button" className="button link" disabled={pending || !ready || busy} onClick={chooseDirectory}>选择文件夹</button></div><p className="field-error" id="directory-error" role={fields.directory ? 'alert' : undefined}>{fields.directory}</p></div>
        </div>
        {error && <div className="inline-error"><FailureMessage message={error} alert /></div>}
        <div className="form-submit"><p>{busy ? '取消后可修改链接和保存位置' : '文件直接保存在此文件夹'}</p>
          <button type={busy ? 'button' : 'submit'} className={busy ? 'button' : 'button primary'} disabled={pending || !ready} aria-busy={pending} onClick={busy ? event => { event.preventDefault(); void action(() => api!.cancel({ jobId: state.id! })); } : undefined}><Icon name={busy ? 'close' : 'download'} size={18} />{busy ? pending ? '正在处理…' : '取消下载' : '开始下载'}</button>
        </div>
        {!busy && !!state.queue?.some(item => item.canRetry) && <p className="inline-note">开始新下载后，无法重试这次的失败项；已保存文件会保留。</p>}
      </form>
      {!ready && !error && <p className="connection-status" role="status">正在连接…</p>}
      {state.phase !== 'idle' && <DownloadTask state={state} pending={pending}
        onSelect={(mode, selections) => void action(() => api!.select({ jobId: state.id!, mode, selections }))}
        onRetry={taskId => void action(() => api!.retry({ jobId: state.id!, taskId }))}
        onReveal={taskId => void action(() => api!.reveal({ jobId: state.id!, ...(taskId ? { taskId } : {}) }))}
        onManualCapture={() => startDownload(true)} />}
    </main>
  </div>;
}

function validDouyinLink(value: string): boolean {
  const matches = value.match(/https?:\/\/[^\s<>"'，。；、）】]+/g);
  if (matches?.length !== 1) return false;
  try { const url = new URL(matches[0]); return !url.username && !url.password && (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com')); }
  catch { return false; }
}
