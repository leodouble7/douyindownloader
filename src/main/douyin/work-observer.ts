import type { DebuggerPort } from '../browser/debugger-port';
import { DouyinWorkIndex, isDouyinUrl } from './target-work';

/** Observes existing responses only; no additional fetch, script execution or credential persistence. */
export function observeDouyinWork(port: DebuggerPort, index: DouyinWorkIndex) {
  const responses = new Map<string, 'json' | 'document'>(), pending = new Set<Promise<void>>();
  const interrupts = new Set<() => void>();
  let active = true, count = 0, consumed = 0;
  const unsubscribe = port.onMessage(({ method, params, sessionId }) => {
    if (!active || sessionId || typeof params.requestId !== 'string') return;
    const requestId = params.requestId;
    if (method === 'Network.responseReceived') {
      const response = params.response as Record<string, unknown> | undefined;
      if (!response || typeof response.url !== 'string' || !isDouyinUrl(response.url) || response.status !== 200 || count >= 64) return;
      const type = params.type === 'Document' ? 'document' : typeof response.mimeType === 'string' && /json/i.test(response.mimeType) && /\/aweme\//.test(new URL(response.url).pathname) ? 'json' : undefined;
      if (type) { responses.set(requestId, type); count++; }
    }
    if (method === 'Network.loadingFailed') responses.delete(requestId);
    if (method !== 'Network.loadingFinished') return;
    const type = responses.get(requestId); responses.delete(requestId);
    if (!type || pending.size >= 8 || consumed >= 32_000_000 || Number(params.encodedDataLength) > 8_000_000) return;
    let timer: ReturnType<typeof setTimeout>;
    let interrupt = () => undefined as void;
    const timeout = new Promise<undefined>(resolve => { interrupt = () => { clearTimeout(timer); resolve(undefined); }; timer = setTimeout(interrupt, 5000); interrupts.add(interrupt); });
    const task = Promise.race([port.send('Network.getResponseBody', { requestId }), timeout]).then(result => {
      if (!active || !result || typeof result.body !== 'string' || result.body.length > 11_000_000) return;
      const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
      consumed += body.length;
      if (body.length <= 8_000_000 && consumed <= 32_000_000) index.ingest(body, type);
    }).catch(() => undefined).finally(() => { clearTimeout(timer); interrupts.delete(interrupt); pending.delete(task); });
    pending.add(task);
  });
  return {
    async flush(): Promise<void> { unsubscribe(); responses.clear(); await Promise.allSettled([...pending]); },
    stop(): void { active = false; unsubscribe(); responses.clear(); for (const interrupt of interrupts) interrupt(); interrupts.clear(); }
  };
}
