import { useEffect, useRef, useState } from 'react';
import type { RunEvent } from '../../shared/contracts';
import { EventDetails } from './EventDetails';
import { actionLabel, Empty, formatTime, Status } from './ui';
export function RunTimeline({ events, selectedEventId }: { events: RunEvent[]; selectedEventId?: string }) {
  const [limit, setLimit] = useState(60); const selected = useRef<HTMLLIElement>(null);
  useEffect(() => { if (selectedEventId) { setLimit(events.length); requestAnimationFrame(() => selected.current?.scrollIntoView({ block: 'center', behavior: 'instant' })); } }, [selectedEventId, events.length]);
  const visible = events.slice(-limit);
  return <div className="timeline-surface">{!events.length ? <Empty title="等待第一条证据">启动运行后，所有动作会按发生顺序记录在这里。</Empty> : <><p className="list-summary">按时间升序 · 显示 {visible.length} / {events.length} 条 <span>本地时间</span></p>{events.length > limit && <button className="button ghost load-more" onClick={() => setLimit(l => l + 100)}>加载更早的 100 条</button>}<ol className="timeline">{visible.map(event => <li key={event.id} ref={event.id === selectedEventId ? selected : undefined} className={event.id === selectedEventId ? 'timeline-item selected-evidence' : 'timeline-item'} id={`evidence-${event.id}`}><div className="event-meta"><span className="event-sequence">{String(event.sequence).padStart(3, '0')}</span><time dateTime={event.timestamp}>{formatTime(event.timestamp)}</time><Status value={event.status} /></div><h3>{actionLabel(event.action)}</h3><p className="event-purpose">{event.purpose}</p><p className="event-conclusion">{typeof event.evidence?.status === 'number' && <strong className="http-code">HTTP {event.evidence.status} · </strong>}{event.conclusion ?? '动作执行中，等待完整证据。'}</p><details open={event.id === selectedEventId ? true : undefined}><summary>展开证据</summary><EventDetails event={event} /></details></li>)}</ol></>}</div>;
}
