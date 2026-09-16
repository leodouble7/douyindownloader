import { describe, expect, it, vi } from 'vitest';
import { observeDouyinWork } from '../../src/main/douyin/work-observer';
import { DouyinWorkIndex } from '../../src/main/douyin/target-work';
import type { CdpMessage, DebuggerPort } from '../../src/main/browser/debugger-port';

function harness(body: () => Promise<Record<string, unknown>> = async () => ({ body: '{}' })) {
  let listener: ((message: CdpMessage) => void) | undefined;
  const port: DebuggerPort = { attach: async () => undefined, detach: async () => undefined, send: vi.fn(body), onMessage: fn => { listener = fn; return () => { listener = undefined; }; } };
  const index = new DouyinWorkIndex(), ingest = vi.spyOn(index, 'ingest');
  const observer = observeDouyinWork(port, index);
  const emit = (method: string, params: Record<string, unknown>, sessionId?: string) => listener?.({ method, params, sessionId });
  const response = (requestId: string, url = 'https://www.douyin.com/aweme/v1/web/detail/', sessionId?: string) => emit('Network.responseReceived', { requestId, type: 'Fetch', response: { url, mimeType: 'application/json', status: 200 } }, sessionId);
  const finish = (requestId: string, size = 100) => emit('Network.loadingFinished', { requestId, encodedDataLength: size });
  return { port, ingest, observer, response, finish };
}
describe('bounded work metadata observation', () => {
  it('reads only completed trusted root JSON/document responses and detaches after flush', async () => {
    const h = harness();
    h.response('trusted'); h.finish('trusted');
    h.response('evil', 'https://douyin.com.evil.test/aweme/detail/'); h.finish('evil');
    h.response('frame', undefined, 'child'); h.finish('frame');
    h.response('large'); h.finish('large', 9_000_000);
    await h.observer.flush();
    expect(h.port.send).toHaveBeenCalledTimes(1); expect(h.ingest).toHaveBeenCalledWith('{}', 'json');
    h.response('late'); h.finish('late'); expect(h.port.send).toHaveBeenCalledTimes(1);
  });
  it('bounds a hung response body and does not ingest after disposal', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(() => new Promise(() => undefined)); h.response('hung'); h.finish('hung');
      const done = h.observer.flush(); await vi.advanceTimersByTimeAsync(5000); await done;
      expect(h.ingest).not.toHaveBeenCalled();
      const late = harness(); late.response('one'); late.finish('one'); late.observer.stop();
      await Promise.resolve(); expect(late.ingest).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});


it('settles pending reads immediately on stop, even while flush is waiting', async () => {
  const h = harness(() => new Promise(() => undefined)); h.response('hung'); h.finish('hung');
  const flushed = h.observer.flush(); h.observer.stop();
  await flushed;
  expect(h.ingest).not.toHaveBeenCalled();
}, 1000);
