import { createSanitizedMediaUrl } from '../../src/shared/contracts';
import { describe, expect, it } from 'vitest';
import { redactEvidence, redactHeaders, redactText, redactUrl } from '../../src/main/security/redact';

describe('redactUrl', () => {
  it('replaces sensitive query values while preserving ordinary parameters', () => {
    expect(redactUrl('https://cdn.test/v.mp4?x-signature=secret&quality=720'))
      .toBe('https://cdn.test/v.mp4?x-signature=%5BREDACTED%5D&quality=720');
  });

  it.each(['token', 'signature', 'policy', 'credential', 'key', 'session', 'authorization', 'cookie'])(
    'redacts the %s query parameter case-insensitively',
    (name) => {
      expect(redactUrl(`https://cdn.test/v.mp4?X-${name.toUpperCase()}=secret`))
        .toBe(`https://cdn.test/v.mp4?X-${name.toUpperCase()}=%5BREDACTED%5D`);
    }
  );
});

describe('redactHeaders', () => {
  it('replaces sensitive values while retaining safe request context', () => {
    expect(redactHeaders({ Cookie: 'sid=secret', Range: 'bytes=0-15' }))
      .toEqual({ Cookie: '[REDACTED]', Range: 'bytes=0-15' });
  });

  it.each(['cookie', 'authorization', 'token', 'signature', 'policy', 'credential', 'key', 'session'])(
    'redacts the %s header case-insensitively',
    (name) => {
      expect(redactHeaders({ [`X-${name.toUpperCase()}`]: 'secret' }))
        .toEqual({ [`X-${name.toUpperCase()}`]: '[REDACTED]' });
    }
  );
});

describe('redactEvidence', () => {
  it('redacts raw URLs at generic nested keys and leaves the input unchanged', () => {
    const evidence = {
      metadata: [{ value: 'https://cdn.test/v.mp4?token=secret-marker&quality=720' }],
      nested: { value: 'https://cdn.test/manifest.m3u8?signature=secret-marker' }
    };

    expect(redactEvidence(evidence)).toEqual({
      metadata: [{ value: 'https://cdn.test/v.mp4?token=%5BREDACTED%5D&quality=720' }],
      nested: { value: 'https://cdn.test/manifest.m3u8?signature=%5BREDACTED%5D' }
    });
    expect(evidence).toEqual({
      metadata: [{ value: 'https://cdn.test/v.mp4?token=secret-marker&quality=720' }],
      nested: { value: 'https://cdn.test/manifest.m3u8?signature=secret-marker' }
    });
  });
});

describe('redactText', () => {
  it('redacts embedded URLs and credential fragments while preserving ordinary diagnostic prose', () => {
    const message = 'Request failed for https://cdn.test/v.mp4?token=url-secret-marker\nAuthorization: Bearer auth-secret-marker\nCookie: sid=cookie-secret-marker;theme=dark\nRetry later.';

    const redacted = redactText(message);

    expect(redacted).toContain('Request failed for https://cdn.test/v.mp4?token=%5BREDACTED%5D');
    expect(redacted).toContain('Authorization: [REDACTED]');
    expect(redacted).toContain('Cookie: [REDACTED]');
    expect(redacted).toContain('Retry later.');
    expect(redacted).not.toContain('url-secret-marker');
    expect(redacted).not.toContain('auth-secret-marker');
    expect(redacted).not.toContain('cookie-secret-marker');
  });

  it('leaves malformed URL-like text stable without throwing', () => {
    const message = 'Connection failed for https://[broken target; retry later.';

    expect(() => redactText(message)).not.toThrow();
    expect(redactText(message)).toBe(message);
  });

  it('leaves ordinary diagnostic prose stable', () => {
    expect(redactText('Network retry in 5 seconds after a timeout.'))
      .toBe('Network retry in 5 seconds after a timeout.');
  });

  it('redacts every mixed-case Cookie and Authorization value through the end of each header line', () => {
    const message = 'Request context follows\ncoOkie: sid=first-secret-marker; auth=second-secret-marker; theme=third-secret-marker\naUtHoRiZaTiOn: Bearer first-auth-marker additional-auth-marker\nRetry remains safe.';

    const redacted = redactText(message);

    expect(redacted).toBe('Request context follows\ncoOkie: [REDACTED]\naUtHoRiZaTiOn: [REDACTED]\nRetry remains safe.');
    expect(redacted).not.toContain('first-secret-marker');
    expect(redacted).not.toContain('second-secret-marker');
    expect(redacted).not.toContain('third-secret-marker');
    expect(redacted).not.toContain('first-auth-marker');
    expect(redacted).not.toContain('additional-auth-marker');
  });
});

it('redacts the short sig query alias and rejects it at the branded media boundary', () => {
  expect(redactUrl('https://example.test/video?sig=secret')).not.toContain('secret');
  expect(() => createSanitizedMediaUrl('https://example.test/video?sig=secret')).toThrow();
});
