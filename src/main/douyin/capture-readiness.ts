import type { MediaAsset } from '../../shared/contracts';
import type { EphemeralRequest } from '../runs/run-orchestrator';
import type { DouyinWorkIndex } from './target-work';

/** Snapshot only completed immutable references; never change the live correlator's tracks. */
export function completedMedia(assets: MediaAsset[], requests: ReadonlyMap<string, EphemeralRequest>, completed: ReadonlySet<string>) {
  const filtered = assets.map(asset => {
    const tracks = asset.tracks.map(track => {
      const sourceRequestIds = track.sourceRequestIds.filter(id => completed.has(id) && requests.has(id));
      return { ...track, sourceRequestIds, eligible: sourceRequestIds.length > 0, incomplete: sourceRequestIds.length === 0 };
    });
    return { ...asset, tracks, sourceRequestIds: tracks.flatMap(track => track.sourceRequestIds) };
  });
  const ids = new Set(filtered.flatMap(asset => asset.sourceRequestIds));
  return { assets: filtered, requests: [...requests.values()].filter(request => ids.has(request.id)) };
}

export function targetReadinessKey(index: DouyinWorkIndex, original: string, final: string, assets: MediaAsset[], requests: ReadonlyMap<string, EphemeralRequest>, completed: ReadonlySet<string>): string | undefined {
  const snapshot = completedMedia(assets, requests, completed);
  // The work selector requires exact ownership and either muxed media or its declared audio pair.
  const selected = index.select(original, final, snapshot.assets, snapshot.requests);
  if (selected.target.status !== 'matched' || !selected.assets.length) return;
  // Repeated completed ranges do not constitute a new representation. New variants restart grace.
  return JSON.stringify([selected.target.workId, selected.assets.map(asset => asset.tracks.map(track =>
    [track.id, track.kind, track.width, track.height, track.bitrate, track.durationSeconds]))]);
}

/** Let discovered variants settle briefly, while retaining the original hard observation deadline. */
export function waitForCapture(timeoutMs: number, signal: AbortSignal, readiness?: () => string | undefined): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    let interval: ReturnType<typeof setInterval> | undefined;
    let lastKey: string | undefined, stableSince = 0;
    const finish = (error?: unknown) => {
      clearTimeout(deadline); clearInterval(interval); signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(signal.reason ?? new DOMException('Capture cancelled', 'AbortError'));
    const deadline = setTimeout(() => finish(), Math.max(0, timeoutMs));
    signal.addEventListener('abort', abort, { once: true });
    if (!readiness) return;
    const check = () => {
      try {
        const key = readiness(), now = performance.now();
        if (key !== lastKey) { lastKey = key; stableSince = now; }
        if (key !== undefined && now - stableSince >= 1750) finish();
      } catch (error) { finish(error); }
    };
    interval = setInterval(check, 250);
    check();
  });
}
