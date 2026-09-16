import { describe, expect, it } from 'vitest';
import { createSanitizedMediaUrl, type MediaTrack } from '../../src/shared/contracts';
import { startRunInputSchema } from '../../src/shared/schemas';

describe('startRunInputSchema', () => {
  it('accepts one authorized public HTTP target', () => {
    expect(startRunInputSchema.parse({
      targetUrl: 'https://media.example.test/watch/1',
      outputDirectory: '/tmp/media-lab',
      mode: 'standard',
      maxConcurrency: 4,
      authorizationConfirmed: true
    }).mode).toBe('standard');
  });

  it('defaults probe concurrency to four when omitted', () => {
    expect(startRunInputSchema.parse({
      targetUrl: 'https://media.example.test/watch/1',
      outputDirectory: '/tmp/media-lab',
      mode: 'standard',
      authorizationConfirmed: true
    }).maxConcurrency).toBe(4);
  });

  it('rejects probe concurrency outside the allowed range', () => {
    const authorizedInput = {
      targetUrl: 'https://media.example.test/watch/1',
      outputDirectory: '/tmp/media-lab',
      mode: 'standard' as const,
      authorizationConfirmed: true as const
    };

    expect(() => startRunInputSchema.parse({ ...authorizedInput, maxConcurrency: 0 })).toThrow();
    expect(() => startRunInputSchema.parse({ ...authorizedInput, maxConcurrency: 5 })).toThrow();
  });

  it('rejects credentials in the target URL and missing authorization', () => {
    expect(() => startRunInputSchema.parse({
      targetUrl: 'https://user:secret@example.test/watch/1',
      outputDirectory: '/tmp/media-lab',
      mode: 'standard',
      maxConcurrency: 4,
      authorizationConfirmed: false
    })).toThrow();
  });
});

describe('MediaTrack contract', () => {
  it('accepts a clean HTTP(S) media URL as a validated value', () => {
    const sanitizedUrl = createSanitizedMediaUrl('https://cdn.example.test/video.mp4?quality=720');

    expect(sanitizedUrl).toBe('https://cdn.example.test/video.mp4?quality=720');
  });

  it('rejects a signed URL with a plaintext sensitive query value', () => {
    expect(() => createSanitizedMediaUrl('https://cdn.example.test/video.mp4?signature=secret'))
      .toThrow();
  });

  it('accepts sensitive query values only when they are redacted', () => {
    expect(createSanitizedMediaUrl('https://cdn.example.test/video.mp4?signature=%5BREDACTED%5D'))
      .toBe('https://cdn.example.test/video.mp4?signature=%5BREDACTED%5D');
  });

  it('handles mixed-case sensitive query names', () => {
    expect(() => createSanitizedMediaUrl('https://cdn.example.test/video.mp4?X-ToKeN=secret'))
      .toThrow();
    expect(createSanitizedMediaUrl('https://cdn.example.test/video.mp4?X-ToKeN=%5BREDACTED%5D'))
      .toBe('https://cdn.example.test/video.mp4?X-ToKeN=%5BREDACTED%5D');
  });

  it('rejects embedded credentials and non-HTTP(S) media URLs', () => {
    expect(() => createSanitizedMediaUrl('https://user:secret@cdn.example.test/video.mp4')).toThrow();
    expect(() => createSanitizedMediaUrl('file:///tmp/video.mp4')).toThrow();
  });

  it('requires a validated URL and carries no raw URL property', () => {
    const track = {
      id: 'track-1',
      assetId: 'asset-1',
      kind: 'video',
      sourceRequestIds: ['request-1'],
      sanitizedUrl: createSanitizedMediaUrl('https://cdn.example.test/video.mp4?token=%5BREDACTED%5D'),
      detectionReasons: ['response MIME type']
    } satisfies MediaTrack;

    expect(track).toHaveProperty('sanitizedUrl');
    expect(track).not.toHaveProperty('url');
  });
});
