import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createPinnedLookup, type NetworkPolicy } from './address-policy';

export interface OpenResponse { response: IncomingMessage; close(): void; progress(bytes: number): void }
/** The only socket-opening path for both bounded probes and streaming downloads. */
export async function openPinnedResponse(url: URL, headers: Record<string, string>, signal: AbortSignal, timeoutMs: number, policy: NetworkPolicy, streaming?: { bodyInactivityMs: number }): Promise<OpenResponse> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const aborted = () => Object.assign(new Error('HTTP request cancelled or timed out'), { code: signal.aborted ? 'ABORT_ERR' : 'ETIMEDOUT' });
  let destination: Awaited<ReturnType<typeof createPinnedLookup>>;
  try { destination = await createPinnedLookup(url, policy, bounded); }
  catch (error) { throw bounded.aborted ? aborted() : error; }
  if (bounded.aborted) throw aborted();
  return new Promise((resolve, reject) => {
    let response: IncomingMessage | undefined;
    let bodyTimer: ReturnType<typeof setTimeout> | undefined;
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', headers, agent: false, maxHeaderSize: 16384, lookup: destination.lookup
    });
    const cleanup = () => { bounded.removeEventListener('abort', abort); signal.removeEventListener('abort', abort); clearTimeout(bodyTimer); };
    const close = () => { cleanup(); response?.destroy(); request.destroy(); };
    const abort = () => {
      const error = aborted();
      response?.destroy(error); request.destroy(error); cleanup(); reject(error);
    };
    const armInactivityTimer = () => {
      if (!streaming) return;
      clearTimeout(bodyTimer);
      bodyTimer = setTimeout(abort, streaming.bodyInactivityMs);
    };
    const progress = (bytes: number) => { if (bytes > 0) armInactivityTimer(); };
    request.once('response', incoming => {
      response = incoming;
      if (streaming) { bounded.removeEventListener('abort', abort); signal.addEventListener('abort', abort, { once: true }); armInactivityTimer(); }
      incoming.once('close', cleanup); resolve({ response: incoming, close, progress });
    });
    request.on('error', error => { cleanup(); reject(error); });
    bounded.addEventListener('abort', abort, { once: true });
    if (bounded.aborted) abort(); else request.end();
  });
}
export function normalizedHeaders(response: IncomingMessage): Record<string, string> {
  return Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value ?? '')]));
}
export function replayHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !/^(host|connection|content-length|transfer-encoding|accept-encoding|if-.*|range|proxy-.*|:.*)$/i.test(name)).map(([name, value]) => [name.toLowerCase(), value]));
}
export function prohibitedResource(url: URL): boolean {
  try { return /(?:^|\/)(?:keys?|licen[cs]es?)(?:\/|[.-]|$)/i.test(decodeURIComponent(url.pathname)); } catch { return true; }
}
export function allowedRedirect(next: URL, allowed: Set<string | undefined>, hops: number): boolean {
  return hops < 5 && ['http:', 'https:'].includes(next.protocol) && !next.username && !next.password && !prohibitedResource(next) && allowed.has(next.href);
}
export function redirectHeaders(headers: Record<string, string>, previous: URL, next: URL): Record<string, string> {
  if (previous.origin === next.origin) return headers;
  // Only caller-generated protocol fields survive; no observed credentials cross origins.
  return Object.fromEntries(Object.entries(headers).filter(([name]) => ['range', 'accept-encoding', 'if-range'].includes(name)));
}
