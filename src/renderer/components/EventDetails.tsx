import type { RunEvent } from '../../shared/contracts';
import { actionLabel } from './ui';
export function EventDetails({ event }: { event: RunEvent }) {
  const diff = event.evidence?.requestDiff ?? event.inputSummary;
  return <dl className="event-details"><dt>准备做什么</dt><dd>{actionLabel(event.action)}</dd><dt>为什么</dt><dd>{event.purpose}</dd><dt>修改了什么</dt><dd><pre>{diff && Object.keys(diff).length ? JSON.stringify(diff, null, 2) : '保留原始条件；敏感值已脱敏'}</pre></dd><dt>服务端返回</dt><dd><pre>{event.evidence && Object.keys(event.evidence).length ? JSON.stringify(event.evidence, null, 2) : '此步骤没有服务端响应，或响应尚未到达'}</pre></dd><dt>如何判定</dt><dd>{event.conclusion ?? '等待关联证据；工具异常不代表防护有效。'}</dd></dl>;
}
