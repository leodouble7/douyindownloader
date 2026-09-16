import { expect, it } from 'vitest';
import { createMediaResolver } from '../../src/main/douyin/public-dns';
import { createPinnedLookup } from '../../src/main/probes/address-policy';
it('uses public system DNS directly and only queries fallback DNS for Fake-IP answers', async () => {
  const requested: string[] = [];
  const resolver = createMediaResolver({ lookup: async host => [{ address: host === 'public.test' ? '8.8.8.8' : '198.18.0.9', family: 4 }],
    query: async host => { requested.push(host); return { Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] }; } });
  const signal = new AbortController().signal;
  expect(await resolver('public.test', signal)).toEqual([{ address: '8.8.8.8', family: 4 }]);
  expect(requested).toEqual([]);
  expect(await resolver('cdn.test', signal)).toEqual([{ address: '1.1.1.1', family: 4 }]);
  expect(requested).toEqual(['cdn.test']);
});
it('keeps private-address rejection and cancellation active after DNS fallback', async () => {
  const resolver = createMediaResolver({ lookup: async () => [{ address: '198.19.0.1', family: 4 }], query: async () => ({ Status: 0, Answer: [{ type: 1, data: '127.0.0.1' }] }) });
  await expect(createPinnedLookup(new URL('https://cdn.test/'), { resolveHostname: resolver }, new AbortController().signal)).rejects.toMatchObject({ code: 'ERR_ADDRESS_POLICY' });
  const controller = new AbortController(); controller.abort();
  await expect(resolver('cdn.test', controller.signal)).rejects.toThrow();
});
it('pins a hostname for one download run even when public DNS rotates CDN endpoints', async () => {
  let calls = 0;
  const resolver = createMediaResolver({ lookup: async () => [{ address: '198.18.0.9', family: 4 }],
    query: async () => ({ Status: 0, Answer: [{ type: 1, data: ++calls === 1 ? '1.1.1.1' : '8.8.8.8' }] }) });
  const signal = new AbortController().signal;
  const first = await resolver('cdn.test', signal);
  first[0].address = '127.0.0.1';
  expect(await resolver('cdn.test', signal)).toEqual([{ address: '1.1.1.1', family: 4 }]);
});
