import { createHash } from 'node:crypto';
import type { RunEvent, RunPhase } from '../shared/contracts';
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const alias = (id: string): string => `ref-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`;
export const purposes: Record<RunPhase, string> = { browser: '在隔离环境中观察获授权的页面', capture: '记录页面、Worker 与 MSE 媒体行为', correlate: '根据已观察证据关联资产与轨道', probe: '验证服务端对有界媒体请求的访问条件', download: '获取并校验连续媒体字节', ffmpeg: '复制音视频流并验证无损封装', verify: '使用 ffprobe 检查文件结构和轨道参数', report: '生成可复核的脱敏证据报告' };
const conclusions: Record<RunEvent['status'], string> = { queued: '等待执行', running: '正在执行，尚无最终判定', succeeded: '动作完成；仅关联证据支持相应结论', denied: '服务端明确拒绝本次请求，其他条件可能不同', warning: '证据不足，无法判定', failed: '执行异常，不能据此证明防护有效', cancelled: '已取消；未完成测试无法判定' };
export function safeEvidence(value: unknown): Record<string, unknown> {
  const e = object(value), observation = object(e.observation), request = object(observation.request), metadata = object(observation.metadata);
  const out: Record<string, unknown> = {};
  for (const k of ['status', 'bytesReceived', 'completedBytes', 'totalBytes', 'contentLength', 'durationMs', 'byteLength', 'outTimeUs', 'frame', 'speed', 'retry']) { const v = e[k] ?? request[k] ?? metadata[k]; if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v; }
  for (const k of ['contentRange', 'range']) { const v = e[k] ?? request[k]; if (typeof v === 'string' && /^bytes[ =][\d*/ -]+$/.test(v) && v.length < 100) out[k] = v; }
  const mime = e.responseMimeType ?? request.mimeType; if (typeof mime === 'string' && /^(video|audio|application|text)\/[a-z0-9.+-]+$/.test(mime)) out.mimeType = mime;
  const enums: Record<string, string[]> = { outcome: ['accessible', 'denied', 'encrypted', 'inconclusive'], transportOutcome: ['http', 'dns', 'tls', 'timeout', 'parser', 'network', 'cancelled', 'limitation'], targetType: ['page', 'iframe', 'worker', 'service_worker', 'shared_worker'], kind: ['network', 'mse', 'target', 'frame'], stage: ['request', 'response', 'redirect', 'cache', 'finished', 'failed', 'attached', 'detached', 'navigated'], type: ['append', 'source-buffer', 'object-url'] };
  for (const [k, choices] of Object.entries(enums)) { const v = e[k] ?? observation[k] ?? metadata[k]; if (typeof v === 'string' && choices.includes(v)) out[k] = v; }
  const diff = object(e.requestDiff); if (Object.keys(diff).length) {
    const headers = (v: unknown) => Object.fromEntries(['cookie', 'authorization', 'origin', 'referer', 'range', 'accept-encoding'].filter(k => Object.hasOwn(object(v), k)).map(k => [k, k === 'range' && /^bytes=[\d-]+$/.test(String(object(v)[k])) ? object(v)[k] : '[已脱敏]']));
    out.requestDiff = { beforeHeaders: headers(diff.beforeHeaders), afterHeaders: headers(diff.afterHeaders), query: diff.query === 'all observed query fields omitted' ? '删除全部查询参数' : '保留已观察的查询参数' };
  }
  if (object(e.probe).container === 'mp4' || object(e.probe).container === 'webm') out.container = object(e.probe).container;
  if (e.committed === true) out.committed = true;
  return out;
}
export function projectEvent(e: RunEvent): RunEvent {
  const action = /^(?:[a-zA-Z][a-zA-Z0-9.-]*):(?:before|after|queued|progress|result|command|failed|cancelled)$/.test(e.action) && e.action.length < 100 ? e.action : `${e.phase}:observation`;
  return { id: e.id, runId: e.runId, sequence: e.sequence, timestamp: e.timestamp, phase: e.phase, action, purpose: purposes[e.phase], status: e.status, inputSummary: safeEvidence(e.inputSummary), evidence: safeEvidence(e.evidence), conclusion: conclusions[e.status], relatedIds: e.relatedIds.map(alias) };
}
