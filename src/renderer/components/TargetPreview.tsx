import { useEffect, useRef, useState } from 'react';
export function TargetPreview({ runId, active }: { runId: string; active: boolean }) {
  const aperture = useRef<HTMLDivElement>(null); const [visible, setVisible] = useState(false);
  useEffect(() => {
    let alive = true;
    const sync = () => { const r = aperture.current?.getBoundingClientRect(); if (!r || !window.mediaLab) return; const show = active && document.visibilityState === 'visible' && r.y >= 160 && r.bottom <= window.innerHeight - 12 && r.x >= 12 && r.right <= window.innerWidth - 12;
      setVisible(show); void window.mediaLab.setPreview({ runId, bounds: show ? { x: Math.ceil(r.x), y: Math.ceil(r.y), width: Math.floor(r.width) - 1, height: Math.floor(r.height) - 1 } : null }).then(result => { if (alive && !result.ok) setVisible(false); }); };
    const observer = new ResizeObserver(sync); if (aperture.current) observer.observe(aperture.current); sync();
    const timer = setInterval(sync, 1000); window.addEventListener('scroll', sync, true); window.addEventListener('resize', sync); document.addEventListener('visibilitychange', sync);
    return () => { alive = false; clearInterval(timer); observer.disconnect(); window.removeEventListener('scroll', sync, true); window.removeEventListener('resize', sync); document.removeEventListener('visibilitychange', sync); void window.mediaLab?.setPreview({ runId, bounds: null }); };
  }, [active, runId]);
  return <><div className="target-aperture" ref={aperture} aria-label="隔离目标页面预览"><div className="preview-reticle" aria-hidden="true">⌖</div><strong>{active ? '隔离页面观察区' : '目标预览已关闭'}</strong><p>{active ? '目标正在独立沙箱中运行' : '观察阶段结束，页面与连接已释放'}</p></div><p className="preview-caption"><span className="live-marker" />{active ? visible ? '目标页面显示于此区域 · 独立沙箱' : '预览移出可见范围时自动隐藏' : '后续验证仅使用已观察的请求'}</p></>;
}
