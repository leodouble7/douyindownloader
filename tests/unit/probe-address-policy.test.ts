import { describe, expect, it } from 'vitest';
import { createPinnedLookup, isPublicAddress } from '../../src/main/probes/address-policy';
import type { LookupFunction } from 'node:net';
function lookupAddress(lookup: LookupFunction): Promise<string> {
  return new Promise((resolve, reject) => lookup('public.example', { family: 4 }, (error, address) => error ? reject(error) : resolve(address as string)));
}
describe('connection-time address policy', () => {
  it.each(['0.0.0.0', '10.2.3.4', '100.64.1.2', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '192.0.0.5', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '::', '::1', '::ffff:127.0.0.1', '::ffff:a00:1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::1'])('blocks non-public address %s', address => expect(isPublicAddress(address)).toBe(false));
  it.each(['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111'])('allows public address %s', address => expect(isPublicAddress(address)).toBe(true));
  it('pins the single vetted DNS resolution into every actual socket lookup', async () => {
    let resolutions = 0;
    const pinned = await createPinnedLookup(new URL('https://public.example/video'), { resolveHostname: async () => { resolutions++; return [{ address: resolutions === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]; } }, new AbortController().signal);
    expect(await lookupAddress(pinned.lookup)).toBe('93.184.216.34');
    expect(await lookupAddress(pinned.lookup)).toBe('93.184.216.34');
    expect(resolutions).toBe(1);
  });
  it('blocks mixed public/private answers and a public hostname even with a mismatched lab exception', async () => {
    const url = new URL('http://public.example:8000/video');
    await expect(createPinnedLookup(url, { resolveHostname: async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }] }, new AbortController().signal)).rejects.toThrow(/address policy/);
    await expect(createPinnedLookup(url, { labLoopback: [{ origin: url.origin, address: '127.0.0.1' }], resolveHostname: async () => [{ address: '127.0.0.1', family: 4 }] }, new AbortController().signal)).rejects.toThrow(/address policy/);
  });
  it('allows only the exact explicitly authorized lab origin and loopback address', async () => {
    const policy = { labLoopback: [{ origin: 'http://127.0.0.1:8000', address: '127.0.0.1' }] };
    expect((await createPinnedLookup(new URL('http://127.0.0.1:8000/video'), policy, new AbortController().signal)).address).toBe('127.0.0.1');
    await expect(createPinnedLookup(new URL('http://127.0.0.1:8001/video'), policy, new AbortController().signal)).rejects.toThrow(/address policy/);
  });
  it('cancels a DNS resolver that does not finish', async () => {
    const controller = new AbortController();
    const pending = createPinnedLookup(new URL('http://public.example/video'), { resolveHostname: () => new Promise(() => {}) }, controller.signal);
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
