import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';

/** Main-process configuration, never accepted from renderer probe plans. */
export interface NetworkPolicy {
  labLoopback?: readonly { origin: string; address: string }[];
  resolveHostname?: (hostname: string, signal: AbortSignal) => Promise<LookupAddress[]>;
}
export interface PinnedDestination { address: string; family: number; lookup: LookupFunction }
export async function createPinnedLookup(url: URL, policy: NetworkPolicy, signal: AbortSignal): Promise<PinnedDestination> {
  signal.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  const resolve = policy.resolveHostname ?? (async (name: string) => lookup(name, { all: true, verbatim: true }));
  const addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : await abortable(resolve(hostname, signal), signal);
  signal.throwIfAborted();
  if (!addresses.length || addresses.length > 64 || addresses.some(item => !isIP(item.address) || isIP(item.address) !== item.family || !allowed(url, hostname, item.address, policy))) {
    throw Object.assign(new Error('Connection address policy rejected a non-public or invalid destination'), { code: 'ERR_ADDRESS_POLICY' });
  }
  const selected = { ...addresses[0] };
  // Every Socket lookup, including an all-address lookup, receives this vetted snapshot.
  // Node never gets an opportunity to resolve the hostname again before connecting.
  const pinned: LookupFunction = (_hostname, options, callback) => {
    if (signal.aborted) { callback(Object.assign(new Error('Connection cancelled'), { code: 'ABORT_ERR' }), '', 0); return; }
    if (options.all) callback(null, [{ ...selected }]); else callback(null, selected.address, selected.family);
  };
  return { ...selected, lookup: pinned };
}
function allowed(url: URL, hostname: string, address: string, policy: NetworkPolicy): boolean {
  if (isPublicAddress(address)) return true;
  // An exception cannot turn a public DNS name, another port, or another IP into a lab endpoint.
  return (hostname === '127.0.0.1' || hostname === '::1') && address === hostname && Boolean(policy.labLoopback?.some(item => item.origin === url.origin && item.address === address));
}
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes('%')) return false;
  const words = ipv6Words(address);
  if (!words) return false;
  // Only native global unicast is eligible. This rejects mapped IPv4, unique-local,
  // link-local, multicast, unspecified, loopback and translation/tunnel prefixes.
  if ((words[0] & 0xe000) !== 0x2000) return false;
  if (words[0] === 0x2002) return false; // 6to4 can embed a prohibited IPv4 endpoint.
  if (words[0] === 0x2001 && (words[1] < 0x0200 || words[1] === 0x0db8)) return false;
  if (words[0] === 0x3fff && words[1] < 0x1000) return false; // documentation prefix
  return true;
}
function ipv6Words(address: string): number[] | undefined {
  // WHATWG canonicalization converts dotted IPv4-mapped suffixes into hexadecimal.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const sides = canonical.split('::');
  const left = sides[0] ? sides[0].split(':').map(value => parseInt(value, 16)) : [];
  const right = sides[1] ? sides[1].split(':').map(value => parseInt(value, 16)) : [];
  const words = sides.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  return words.length === 8 ? words : undefined;
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}
