import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLabServer, type LabServer } from '../../lab/server';
import { LAB_SECRET } from '../../lab/scenarios';
import { signMediaRequest } from '../../src/main/security/signature';

let lab: LabServer;

beforeAll(async () => {
  lab = await startLabServer();
});

afterAll(async () => {
  if (lab !== undefined) {
    await lab.close();
    await lab.close();
  }
});

function futureExpiry(): number {
  return Math.floor(Date.now() / 1000) + 60;
}

describe('deterministic media security lab', () => {
  it('serves an exact partial response for the open Range endpoint', async () => {
    const response = await fetch(`${lab.baseUrl}/open-range/video.mp4`, {
      headers: { Range: 'bytes=10-19' }
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toMatch(/^bytes 10-19\/\d+$/);
    expect((await response.arrayBuffer()).byteLength).toBe(10);
  });

  it('serves prefix and suffix Ranges with their requested byte counts', async () => {
    const [prefix, suffix] = await Promise.all([
      fetch(`${lab.baseUrl}/open-range/video.mp4`, { headers: { Range: 'bytes=0-9' } }),
      fetch(`${lab.baseUrl}/open-range/video.mp4`, { headers: { Range: 'bytes=-10' } })
    ]);

    expect(prefix.status).toBe(206);
    expect(prefix.headers.get('content-range')).toMatch(/^bytes 0-9\/\d+$/);
    expect((await prefix.arrayBuffer()).byteLength).toBe(10);
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('content-range')).toMatch(/^bytes \d+-\d+\/\d+$/);
    expect((await suffix.arrayBuffer()).byteLength).toBe(10);
  });

  it('rejects an unsatisfiable Range with its total length', async () => {
    const response = await fetch(`${lab.baseUrl}/open-range/video.mp4`, {
      headers: { Range: 'bytes=999999999-' }
    });

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toMatch(/^bytes \*\/\d+$/);
  });

  it('ignores malformed Range syntax and gives HEAD the same complete-response headers', async () => {
    const malformed = await fetch(`${lab.baseUrl}/open-range/video.mp4`, {
      headers: { Range: 'bytes=ten-twenty' }
    });
    const malformedHead = await fetch(`${lab.baseUrl}/open-range/video.mp4`, {
      method: 'HEAD', headers: { Range: 'bytes=ten-twenty' }
    });

    expect(malformed.status).toBe(200);
    expect(malformed.headers.get('content-range')).toBeNull();
    expect((await malformed.arrayBuffer()).byteLength).toBeGreaterThan(4);
    expect(malformedHead.status).toBe(200);
    expect(malformedHead.headers.get('content-range')).toBeNull();
    expect(malformedHead.headers.get('content-length')).toBe(malformed.headers.get('content-length'));
    expect((await malformedHead.arrayBuffer()).byteLength).toBe(0);
  });

  it('falls back to a complete response for valid multi-ranges on open media', async () => {
    const multiRange = await fetch(`${lab.baseUrl}/open-range/video.mp4`, {
      headers: { Range: 'bytes=0-1,4-5' }
    });

    expect(multiRange.status).toBe(200);
    expect(multiRange.headers.get('content-range')).toBeNull();
    expect((await multiRange.arrayBuffer()).byteLength).toBeGreaterThan(4);
  });

  it('rejects a multi-range header when none of its ranges are satisfiable', async () => {
    const response = await fetch(`${lab.baseUrl}/open-range/video.mp4`, {
      headers: { Range: 'bytes=999999999-,1000000000-' }
    });

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toMatch(/^bytes \*\/\d+$/);
  });

  it('returns the same Range status and headers for HEAD without a body', async () => {
    const get = await fetch(`${lab.baseUrl}/open-range/video.mp4`, {
      headers: { Range: 'bytes=10-19' }
    });
    const head = await fetch(`${lab.baseUrl}/open-range/video.mp4`, {
      method: 'HEAD', headers: { Range: 'bytes=10-19' }
    });

    expect(head.status).toBe(get.status);
    expect(head.headers.get('content-range')).toBe(get.headers.get('content-range'));
    expect(head.headers.get('content-length')).toBe(get.headers.get('content-length'));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it('requires a same-scenario Referer only for the referer policy', async () => {
    const denied = await fetch(`${lab.baseUrl}/referer-only/video.mp4`);
    const permitted = await fetch(`${lab.baseUrl}/referer-only/video.mp4`, {
      headers: { Referer: `${lab.baseUrl}/referer-only/watch` }
    });

    expect(denied.status).toBe(403);
    expect(permitted.status).toBe(200);
  });

  it('accepts a valid signed URL and rejects malformed and correctly signed expired requests', async () => {
    const expires = futureExpiry();
    const sig = signMediaRequest({ mediaId: 'video.mp4', expires }, LAB_SECRET);
    const expiredSig = signMediaRequest({ mediaId: 'video.mp4', expires: 1 }, LAB_SECRET);
    const permitted = await fetch(`${lab.baseUrl}/signed-url/video.mp4?expires=${expires}&sig=${sig}`);
    const invalid = await fetch(`${lab.baseUrl}/signed-url/video.mp4?expires=${expires}&sig=bad`);
    const expired = await fetch(`${lab.baseUrl}/signed-url/video.mp4?expires=1&sig=${expiredSig}`);

    expect(permitted.status).toBe(200);
    expect(invalid.status).toBe(403);
    expect(expired.status).toBe(403);
  });

  it('binds a valid session signature to the matching local session cookie', async () => {
    const expires = futureExpiry();
    const sig = signMediaRequest({ mediaId: 'video.mp4', expires, sessionId: 'lab-session' }, LAB_SECRET);
    const permitted = await fetch(`${lab.baseUrl}/session-bound/video.mp4?expires=${expires}&sessionId=lab-session&sig=${sig}`, {
      headers: { Cookie: 'lab_session=lab-session' }
    });
    const mismatch = await fetch(`${lab.baseUrl}/session-bound/video.mp4?expires=${expires}&sessionId=lab-session&sig=${sig}`, {
      headers: { Cookie: 'lab_session=other-session' }
    });

    expect(permitted.status).toBe(200);
    expect(mismatch.status).toBe(403);
  });

  it('scopes server and page session cookies to the session-bound route', async () => {
    const response = await fetch(`${lab.baseUrl}/session-bound/watch`);
    const page = await response.text();

    expect(response.headers.get('set-cookie')).toContain('Path=/session-bound');
    expect(page).toContain('Path=/session-bound');
  });

  it('caps an oversized Range without changing the total length', async () => {
    const response = await fetch(`${lab.baseUrl}/range-capped/video.mp4`, {
      headers: { Range: 'bytes=0-4095' }
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toMatch(/^bytes 0-1023\/\d+$/);
    expect((await response.arrayBuffer()).byteLength).toBe(1024);
  });

  it('coalesces a valid multi-range into one capped response without a full-body bypass', async () => {
    const get = await fetch(`${lab.baseUrl}/range-capped/video.mp4`, {
      headers: { Range: 'bytes=0-4095,8192-12287' }
    });
    const head = await fetch(`${lab.baseUrl}/range-capped/video.mp4`, {
      method: 'HEAD', headers: { Range: 'bytes=0-4095,8192-12287' }
    });

    expect(get.status).toBe(206);
    expect(get.headers.get('content-range')).toMatch(/^bytes 0-1023\/\d+$/);
    expect(get.headers.get('content-length')).toBe('1024');
    expect((await get.arrayBuffer()).byteLength).toBe(1024);
    expect(head.status).toBe(206);
    expect(head.headers.get('content-range')).toBe(get.headers.get('content-range'));
    expect(head.headers.get('content-length')).toBe(get.headers.get('content-length'));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it('rejects capped multi-ranges when none of their members are satisfiable', async () => {
    const response = await fetch(`${lab.baseUrl}/range-capped/video.mp4`, {
      headers: { Range: 'bytes=999999999-,1000000000-' }
    });

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toMatch(/^bytes \*\/\d+$/);
  });

  it('permits only signed segments inside the prefetch window', async () => {
    const expires = futureExpiry();
    const permittedSig = signMediaRequest({ mediaId: 'segment-000.ts', expires, segmentId: '0' }, LAB_SECRET);
    const rejectedSig = signMediaRequest({ mediaId: 'segment-002.ts', expires, segmentId: '2' }, LAB_SECRET);
    const permitted = await fetch(`${lab.baseUrl}/segment-token/segment-000.ts?expires=${expires}&segmentId=0&sig=${permittedSig}`);
    const outsideWindow = await fetch(`${lab.baseUrl}/segment-token/segment-002.ts?expires=${expires}&segmentId=2&sig=${rejectedSig}`);

    expect(permitted.status).toBe(200);
    expect(outsideWindow.status).toBe(403);
  });

  it('changes validators on the stale-validator endpoint', async () => {
    const first = await fetch(`${lab.baseUrl}/stale-validator/video.mp4`, { headers: { Range: 'bytes=0-9' } });
    const second = await fetch(`${lab.baseUrl}/stale-validator/video.mp4`, { headers: { Range: 'bytes=10-19' } });

    expect(first.headers.get('etag')).toBe('"lab-v1"');
    expect(second.headers.get('etag')).toBe('"lab-v2"');
  });

  it('marks encrypted content as a placeholder without exposing a key endpoint', async () => {
    const response = await fetch(`${lab.baseUrl}/encrypted-placeholder/segment-000.m4s`);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-lab-encrypted-placeholder')).toBe('true');
    expect(response.headers.get('content-type')).toContain('application/octet-stream');
  });

  it('wires frame, Worker, and ServiceWorker requests into the open player page', async () => {
    const page = await (await fetch(`${lab.baseUrl}/open-range/watch`)).text();
    const [frame, worker, serviceWorker] = await Promise.all([
      fetch(`${lab.baseUrl}/open-range/frame`),
      fetch(`${lab.baseUrl}/open-range/worker.js`),
      fetch(`${lab.baseUrl}/open-range/service-worker.js`)
    ]);

    expect(page).toContain('/open-range/frame');
    expect(page).toContain('/open-range/worker.js');
    expect(page).toContain('/open-range/service-worker.js');
    expect(frame.status).toBe(200);
    expect(worker.headers.get('content-type')).toContain('application/javascript');
    expect(serviceWorker.headers.get('content-type')).toContain('application/javascript');
  });

  it('resolves HLS manifest media and exposes its bounded MSE pipeline contract', async () => {
    const page = await (await fetch(`${lab.baseUrl}/segment-token/watch`)).text();
    const manifest = await (await fetch(`${lab.baseUrl}/segment-token/manifest.m3u8`)).text();
    const segment = manifest.split('\n').find((line) => line.startsWith('segment-'));

    expect(page).toContain('resolveHlsResources');
    expect(page).toContain('appendSegmentPipeline');
    expect(segment).toBeDefined();
    const media = await fetch(`${lab.baseUrl}/segment-token/${segment}`);
    expect(media.status).toBe(200);
    expect((await media.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('resolves DASH init and media resources and exposes its bounded MSE pipeline contract', async () => {
    const page = await (await fetch(`${lab.baseUrl}/open-range/watch`)).text();
    const manifestResponse = await fetch(`${lab.baseUrl}/open-range/manifest.mpd`);
    const manifest = await manifestResponse.text();
    const init = await fetch(`${lab.baseUrl}/open-range/init-stream0.m4s`);
    const media = await fetch(`${lab.baseUrl}/open-range/chunk-stream0-00001.m4s`);

    expect(page).toContain('resolveDashResources');
    expect(page).toContain('appendSegmentPipeline');
    expect(manifestResponse.status).toBe(200);
    expect(manifest).toContain('initialization="init-stream$RepresentationID$.m4s"');
    expect(init.status).toBe(200);
    expect(media.status).toBe(200);
    expect((await media.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it.each([
    'open-range',
    'referer-only',
    'signed-url',
    'session-bound',
    'range-capped',
    'segment-token',
    'encrypted-placeholder'
  ])('renders a deterministic watch page for %s', async (scenario) => {
    const response = await fetch(`${lab.baseUrl}/${scenario}/watch`);
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(page).toContain(`data-scenario="${scenario}"`);
    expect(page).toContain('Expected protection:');
  });
});

describe('signMediaRequest', () => {
  it('uses the documented media, expiry, session, and segment HMAC order', () => {
    expect(signMediaRequest({ mediaId: 'video.mp4', expires: 2_000_000_000 }, LAB_SECRET))
      .toBe('04476034790b0ef31830d5b3e0ce05070760f392a5a629ae70473e6c50d12f88');
  });
});
