import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { LookupAddress } from 'node:dns';

interface DnsDependencies {
  lookup: (hostname: string) => Promise<LookupAddress[]>;
  query: (hostname: string, signal: AbortSignal) => Promise<unknown>;
}
const fakeIp = (address: string) => /^198\.(18|19)\./.test(address);
export function createMediaResolver(dependencies: DnsDependencies = {
  lookup: hostname => lookup(hostname, { all: true, verbatim: true }),
  query: async (hostname, signal) => {
    const url = new URL('https://dns.alidns.com/resolve');
    url.searchParams.set('name', hostname); url.searchParams.set('type', 'A');
    const response = await fetch(url, { signal, redirect: 'error' });
    if (!response.ok) throw new Error('公网 DNS 查询失败');
    const text = await response.text();
    if (text.length > 65536) throw new Error('公网 DNS 响应过大');
    return JSON.parse(text) as unknown;
  }
}): (hostname: string, signal: AbortSignal) => Promise<LookupAddress[]> {
  const pinned = new Map<string, LookupAddress[]>();
  return async (hostname, signal) => {
    signal.throwIfAborted();
    const cached = pinned.get(hostname);
    if (cached) return structuredClone(cached);
    const addresses = await dependencies.lookup(hostname);
    signal.throwIfAborted();
    if (!addresses.some(address => fakeIp(address.address))) { pinned.set(hostname, structuredClone(addresses)); return addresses; }
    const answer = await dependencies.query(hostname, signal) as { Status?: number; Answer?: { type?: number; data?: string }[] };
    signal.throwIfAborted();
    if (answer?.Status !== 0 || !Array.isArray(answer.Answer) || answer.Answer.length > 64) throw new Error('公网 DNS 没有返回有效地址');
    const resolved = answer.Answer.filter(record => record.type === 1 && typeof record.data === 'string' && isIP(record.data) === 4)
      .map(record => ({ address: record.data!, family: 4 }));
    if (!resolved.length) throw new Error('公网 DNS 没有返回 IPv4 地址');
    // HttpTransport's existing address policy still validates every returned address before connection.
    pinned.set(hostname, structuredClone(resolved));
    return resolved;
  };
}
