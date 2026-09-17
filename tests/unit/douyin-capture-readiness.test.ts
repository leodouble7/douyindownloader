import { afterEach, describe, expect, it, vi } from 'vitest';
import { completedMedia, targetReadinessKey, waitForCapture } from '../../src/main/douyin/capture-readiness';
import { DouyinWorkIndex } from '../../src/main/douyin/target-work';
import type { MediaAsset } from '../../src/shared/contracts';
import type { EphemeralRequest } from '../../src/main/runs/run-orchestrator';
import { createSanitizedCapturedUrl } from '../../src/main/security/redact';

const page = 'https://www.douyin.com/video/123';
const video = 'https://cdn.test/video.mp4', audio = 'https://cdn.test/audio.mp4';
function fixture(split = false, workId = '123') {
  const index = new DouyinWorkIndex();
  index.ingest(JSON.stringify({ awemeId: workId, video: { bitRateList: [{ fileId: 'v', videoFormat: split ? 'dash' : 'mp4', audioFileId: split ? 'a' : undefined, playAddr: [{ src: video }] }], bitRateAudioList: [{ fileId: 'a', urlList: [{ src: audio }] }] } }), 'json');
  const requests: EphemeralRequest[] = [video, audio].map((url, i) => ({ id: `s${i}`, url, method: 'GET', requestHeaders: {} }));
  const assets: MediaAsset[] = requests.map((request, i) => ({ id: `a${i}`, runId: 'run', sourceRequestIds: [request.id], trackIds: [`t${i}`], selectedTrackIds: [`t${i}`], confidence: 1, detectedAt: '', detectionReasons: [], tracks: [{ id: `t${i}`, assetId: `a${i}`, kind: i ? 'audio' : 'video', eligible: true, sourceRequestIds: [request.id], sanitizedUrl: createSanitizedCapturedUrl(request.url), detectionReasons: [] }] }));
  const completed = new Set<string>();
  const requestMap = new Map(requests.map(request => [request.id, request]));
  const key = () => targetReadinessKey(index, page, page, assets, requestMap, completed);
  return { index, requests, assets, completed, requestMap, key };
}

afterEach(() => vi.useRealTimers());
describe('exact target capture readiness', () => {
  it('requires completed immutable source references, without mutating active tracks', () => {
    const f = fixture();
    expect(f.key()).toBeUndefined();
    f.completed.add('s0');
    expect(f.key()).toBeTypeOf('string');
    f.assets[0].tracks[0].sourceRequestIds.push('pending-range');
    f.assets[0].tracks[0].incomplete = true;
    const before = structuredClone(f.assets);
    expect(f.key()).toBeTypeOf('string');
    expect(completedMedia(f.assets, f.requestMap, f.completed).assets[0].tracks[0].sourceRequestIds).toEqual(['s0']);
    expect(f.assets).toEqual(before);
    f.requestMap.delete('s0');
    expect(f.key()).toBeUndefined();
  });
  it('waits for declared audio and ignores recommendations and encrypted tracks', () => {
    const f = fixture(true);
    f.completed.add('s0');
    expect(f.key()).toBeUndefined();
    f.completed.add('s1');
    expect(f.key()).toBeTypeOf('string');
    f.assets[1].tracks[0].encrypted = true;
    expect(f.key()).toBeUndefined();
    const other = fixture(false, '999'); other.completed.add('s0');
    expect(other.key()).toBeUndefined();
  });
  it('does not reset stability for later ranges of the same representation', () => {
    const f = fixture(); f.completed.add('s0'); const first = f.key();
    f.requestMap.set('later', { ...f.requests[0], id: 'later' });
    f.completed.add('later'); f.assets[0].tracks[0].sourceRequestIds.push('later');
    expect(f.key()).toBe(first);
  });
});

describe('capture observation window', () => {
  it('finishes early only after a stable target, resetting grace for new variants', async () => {
    vi.useFakeTimers(); let key: string | undefined; const done = vi.fn();
    const task = waitForCapture(30000, new AbortController().signal, () => key).then(done);
    await vi.advanceTimersByTimeAsync(1000); key = '720';
    await vi.advanceTimersByTimeAsync(1500); expect(done).not.toHaveBeenCalled(); key = '720,1080';
    await vi.advanceTimersByTimeAsync(1750); expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250); await task; expect(done).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([false, true])('preserves the upper bound when ready=%s', async ready => {
    vi.useFakeTimers(); const done = vi.fn();
    const task = waitForCapture(1000, new AbortController().signal, () => ready ? 'ready' : undefined).then(done);
    await vi.advanceTimersByTimeAsync(999); expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await task; expect(done).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps the full window for ordinary non-Douyin capture', async () => {
    vi.useFakeTimers(); const done = vi.fn();
    const task = waitForCapture(30000, new AbortController().signal).then(done);
    await vi.advanceTimersByTimeAsync(29999); expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await task; expect(done).toHaveBeenCalledOnce();
  });
  it('cancels promptly and clears timers', async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    const task = waitForCapture(30000, controller.signal, () => 'ready');
    const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(500); controller.abort(); await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
