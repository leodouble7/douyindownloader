import { expect, it } from 'vitest';
import { redactUrl } from '../../src/main/security/redact';
it('redacts Douyin signature parameters before download manifests are written', () => {
  const url = new URL(redactUrl('https://v3.douyinvod.com/media?video_id=123&sign=secret&a_bogus=secret2&X-Bogus=secret3'));
  expect(url.searchParams.get('video_id')).toBe('123');
  for (const key of ['sign', 'a_bogus', 'X-Bogus']) expect(url.searchParams.get(key)).toBe('[REDACTED]');
});
