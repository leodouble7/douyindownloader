import { describe, expect, it } from 'vitest';
import { createSanitizedMediaUrl, type MediaTrack } from '../../src/shared/contracts';
import { planProbes, SHORT_PROBE_BYTES } from '../../src/main/probes/probe-planner';

export const track: MediaTrack = { id: 'track', assetId: 'asset', kind: 'video', sourceRequestIds: ['["worker","42"]'], sanitizedUrl: createSanitizedMediaUrl('https://media.example/video.mp4?sig=[REDACTED]'), mimeType: 'video/mp4', byteLength: 100000, detectionReasons: [], eligible: true };
describe('bounded probe planning', () => {
  it('orders full-download mutations and gates the full range on short success', () => {
    const plans = planProbes(track, 'full-download');
    expect(plans.map(p => p.id)).toEqual(['baseline', 'without-cookie', 'without-query', 'without-referer', 'without-origin', 'range-head', 'range-middle', 'range-tail', 'range-full', 'range-concurrent']);
    expect(plans.find(p => p.id === 'range-full')?.requiresShortSuccess).toBe(true);
    expect(plans.every(p => p.sourceRequestId === track.sourceRequestIds[0])).toBe(true);
    expect(JSON.stringify(plans)).not.toContain('https://');
  });
  it('makes observe inert and standard always bounded', () => {
    expect(planProbes(track, 'observe')).toEqual([]);
    const plans = planProbes(track, 'standard');
    expect(plans.some(p => p.id === 'range-full')).toBe(false);
    expect(plans.every(p => p.byteCap === SHORT_PROBE_BYTES)).toBe(true);
    expect(plans.find(p => p.id === 'baseline')?.limitations).toContain('No recognizable observed expiry; expiry replay unavailable');
  });
  it('does not schedule encrypted, incomplete, failed or unobserved candidates', () => {
    for (const changes of [{ encrypted: true }, { incomplete: true }, { eligible: false }, { sourceRequestIds: [] }, { kind: 'manifest' as const }]) expect(planProbes({ ...track, ...changes }, 'standard')).toEqual([]);
  });
  it('describes expiry replay without retaining query values', () => {
    const plans = planProbes({ ...track, sanitizedUrl: createSanitizedMediaUrl('https://media.example/video.mp4?expires=2000000000&sig=[REDACTED]') }, 'standard');
    expect(plans.at(-1)?.id).toBe('expiry-replay');
    expect(JSON.stringify(plans)).not.toContain('2000000000');
  });
});
