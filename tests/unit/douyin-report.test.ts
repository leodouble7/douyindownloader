import { expect, it } from 'vitest';
import { sanitizeCaptureReport } from '../../src/main/douyin/report';
it('removes signatures from the input page and text before analysis is written or printed', () => {
  const result = sanitizeCaptureReport({ pageUrl: 'https://www.douyin.com/video/123?sign=secret-page', summary: {
    network: 5, mse: 2, videoElements: 1, title: 'video https://cdn.test/v?token=secret-title', excerpt: 'Cookie: secret-cookie\nhttps://cdn.test/a?X-Bogus=secret-body'
  }, candidates: [] });
  expect(JSON.stringify(result)).not.toMatch(/secret-page|secret-title|secret-cookie|secret-body/);
  expect(result.summary.videoElements).toBe(1);
});
