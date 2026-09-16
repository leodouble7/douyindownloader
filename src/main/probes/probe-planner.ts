import type { MediaTrack, RunMode } from '../../shared/contracts';

export const SHORT_PROBE_BYTES = 4096;
export type ProbeId = 'baseline' | 'without-cookie' | 'without-query' | 'without-referer' | 'without-origin' | 'range-head' | 'range-middle' | 'range-tail' | 'range-full' | 'range-concurrent' | 'expiry-replay';
export interface ProbePlan {
  id: ProbeId;
  trackId: string;
  sourceRequestId: string;
  purpose: string;
  byteCap: number;
  requiresShortSuccess?: boolean;
  limitations: string[];
}
const purposes: Record<ProbeId, string> = {
  baseline: 'Verify bounded target byte access with observed credentials',
  'without-cookie': 'Measure access after omitting Cookie',
  'without-query': 'Measure access after omitting observed query data',
  'without-referer': 'Measure access after omitting Referer',
  'without-origin': 'Measure server access after omitting Origin; browser CORS is independent',
  'range-head': 'Sample the beginning of the selected media',
  'range-middle': 'Sample the middle of the selected media',
  'range-tail': 'Sample the end of the selected media',
  'range-full': 'Test an explicitly authorized full Range after short success',
  'range-concurrent': 'Test up to four concurrent bounded ranges of this same media',
  'expiry-replay': 'Replay the observed URL after its recognizable expiry, within the wait limit'
};
export function eligibleTrack(track: MediaTrack): boolean {
  return !track.encrypted && track.eligible !== false && !track.incomplete && track.sourceRequestIds.length > 0 && ['video', 'audio', 'muxed'].includes(track.kind);
}
export function planProbes(track: MediaTrack, mode: RunMode): ProbePlan[] {
  if (mode === 'observe' || !eligibleTrack(track)) return [];
  const ids: ProbeId[] = ['baseline', 'without-cookie', 'without-query', 'without-referer', 'without-origin', 'range-head', 'range-middle', 'range-tail'];
  if (mode === 'full-download') ids.push('range-full');
  ids.push('range-concurrent');
  const expiry = [...new URL(track.sanitizedUrl).searchParams.keys()].some(name => /^(expires|expiry|exp)$/i.test(name));
  if (expiry) ids.push('expiry-replay');
  return ids.map(id => ({ id, trackId: track.id, sourceRequestId: track.sourceRequestIds[0], purpose: purposes[id], byteCap: SHORT_PROBE_BYTES, requiresShortSuccess: id === 'range-full' || undefined, limitations: id === 'baseline' && !expiry ? ['No recognizable observed expiry; expiry replay unavailable'] : [] }));
}
