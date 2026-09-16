import type { UiProbe } from '../../shared/contracts';
import { actionLabel, Empty, Status } from './ui';
export function ProbeMatrix({ probes, onEvidence }: { probes: UiProbe[]; onEvidence?: (eventId: string) => void }) {
  return probes.length ? <div className="matrix-scroll"><table className="probe-matrix"><caption className="sr-only">有界请求与服务端证据</caption><thead><tr><th scope="col">请求变体</th><th scope="col">服务端结果</th><th scope="col">证据</th></tr></thead><tbody>{probes.map(p => <tr key={p.id}><th scope="row">{actionLabel(p.name)}</th><td><Status value={p.outcome} /><small>{p.status ? `HTTP ${p.status}` : '无有效 HTTP 响应'}</small></td><td><button className="evidence-link" disabled={!p.eventIds.length} aria-label={`查看证据：${actionLabel(p.name)}`} onClick={() => onEvidence?.(p.eventIds[0])}>↗</button></td></tr>)}</tbody></table></div> : <Empty title="尚无探针结果">观察结束后，使用已捕获请求进行有界验证。只观察模式不会重放请求。</Empty>;
}
