import { describe, expect, it } from 'vitest';
import { MediaCorrelator } from '../../src/main/media/media-correlator';
import type { CaptureObservation, MediaAsset } from '../../src/shared/contracts';

const runId = 'run-media';

function response(url: string, mimeType: string, contentLength: number, status = 200, overrides: Partial<CaptureObservation> = {}): CaptureObservation {
  const requestId = `request-${url}`;
  return {
    runId,
    targetId: 'page',
    targetType: 'page',
    frameId: 'frame-main',
    kind: 'network',
    stage: 'response',
    requestId,
    timestamp: 10,
    request: {
      id: requestId,
      runId,
      sanitizedUrl: url,
      method: 'GET',
      mimeType,
      status,
      contentLength,
      receivedAt: '2026-09-15T00:00:00.000Z'
    },
    ...overrides
  } as CaptureObservation;
}

function mseBuffer(mimeType: string, sourceBufferId = `buffer-${mimeType}`, observationRunId = runId): CaptureObservation {
  return {
    runId: observationRunId,
    targetId: 'page',
    targetType: 'page',
    frameId: 'frame-main',
    kind: 'mse',
    metadata: { type: 'source-buffer', objectId: 'mse-1', sourceBufferId, mimeType, timestamp: 11 }
  };
}

function correlate(observations: CaptureObservation[]) {
  const correlator = new MediaCorrelator();
  let assets: MediaAsset[] = [];
  for (const observation of observations) {
    assets = correlator.ingest(observation);
    if (observation.kind === 'network' && observation.stage === 'response') assets = correlator.ingest({ ...observation, stage: 'finished' });
  }
  return assets;
}

function mseAppend(source: CaptureObservation, end = 12, timestamp = 12): CaptureObservation {
  if (source.kind !== 'mse' || source.metadata.type !== 'source-buffer') throw new Error('Expected SourceBuffer fixture');
  return { ...source, metadata: { type: 'append', objectId: source.metadata.objectId, sourceBufferId: source.metadata.sourceBufferId, byteLength: 100, timestamp, buffered: [[0, end]] } };
}

function assertOwnedAndSelected(assets: MediaAsset[]): void {
  for (const asset of assets) {
    expect(asset.trackIds).toEqual(asset.tracks.map((track) => track.id));
    for (const track of asset.tracks) expect(track.assetId).toBe(asset.id);
    for (const selected of asset.selectedTrackIds ?? []) expect(asset.trackIds).toContain(selected);
  }
}

describe('MediaCorrelator', () => {
  it('pairs Douyin CDN tracks by video_id without merging prefetched unrelated videos', () => {
    const assets = correlate([
      response('https://v3.douyinvod.com/media-video-hvc1/?video_id=v123', 'video/mp4', 62409, 206),
      response('https://v9.douyinvod.com/media-audio-und-mp4a/?video_id=v123', 'audio/mp4', 9478, 206),
      response('https://v3.douyinvod.com/media-video-hvc1/?video_id=v456', 'video/mp4', 90000, 206)
    ]);
    expect(assets).toHaveLength(2);
    expect(assets.find(a => a.tracks.length === 2)?.tracks.map(t => t.kind)).toEqual(['video', 'audio']);
  });
  it('pairs a split video and audio stream using MIME, codec and MSE evidence', () => {
    const assets = correlate([
      response('https://cdn.test/media-video-hvc1/', 'video/mp4', 62_409_109, 206),
      response('https://cdn.test/media-audio-und-mp4a/', 'audio/mp4', 9_478_113, 206),
      mseBuffer('video/mp4; codecs="hvc1.1.6.L120"'),
      mseBuffer('audio/mp4; codecs="mp4a.40.2"')
    ]);

    expect(assets).toHaveLength(1);
    expect(assets[0].tracks.map((track) => track.kind)).toEqual(['video', 'audio']);
    expect(assets[0].confidence).toBeGreaterThanOrEqual(0.8);
    expect(assets[0].tracks[0].detectionReasons).toContain('MIME type video/mp4 identifies a video track');
    expect(assets[0].tracks[1].detectionReasons).toContain('MSE SourceBuffer MIME confirms audio/mp4');
    expect(assets[0].sourceRequestIds).toEqual(expect.arrayContaining([
      'request-https://cdn.test/media-video-hvc1/',
      'request-https://cdn.test/media-audio-und-mp4a/'
    ]));
  });

  it('keeps a direct MP4 as a single muxed asset and rejects unrelated large files', () => {
    const assets = correlate([
      response('https://cdn.test/movie.mp4', 'video/mp4', 20_000_000),
      response('https://cdn.test/archive.iso', 'application/octet-stream', 900_000_000),
      response('https://cdn.test/poster.jpg', 'image/jpeg', 50_000_000)
    ]);

    expect(assets).toHaveLength(1);
    expect(assets[0].tracks).toHaveLength(1);
    expect(assets[0].tracks[0]).toMatchObject({ kind: 'muxed', sanitizedUrl: 'https://cdn.test/movie.mp4' });
  });

  it('uses a prior SourceBuffer MIME to classify an otherwise generic MP4 as a separate video track', () => {
    const assets = correlate([
      mseBuffer('video/mp4; codecs="avc1.640028"'),
      response('https://cdn.test/chunk.mp4', 'video/mp4', 2_000_000)
    ]);

    expect(assets[0].tracks[0].kind).toBe('video');
    expect(assets[0].tracks[0].codecs).toBe('avc1.640028');
  });

  it('does not use a SourceBuffer observation from a different run for correlation', () => {
    const assets = correlate([
      mseBuffer('video/mp4; codecs="avc1.640028"', 'buffer-other-run', 'other-run'),
      response('https://cdn.test/chunk.mp4', 'video/mp4', 2_000_000)
    ]);

    expect(assets[0].tracks[0].kind).toBe('muxed');
  });

  it('deduplicates byte ranges by canonical URL while retaining stable request references', () => {
    const assets = correlate([
      response('https://cdn.test/segment.mp4?quality=720', 'video/mp4', 1_000, 206, {
        request: { id: 'range-a', runId, sanitizedUrl: 'https://cdn.test/segment.mp4?quality=720', method: 'GET', mimeType: 'video/mp4', status: 206, contentLength: 1_000, contentRange: 'bytes 0-999/5000', receivedAt: '2026-09-15T00:00:00.000Z' }
      }),
      response('https://cdn.test/segment.mp4?quality=720', 'video/mp4', 1_000, 206, {
        request: { id: 'range-b', runId, sanitizedUrl: 'https://cdn.test/segment.mp4?quality=720', method: 'GET', mimeType: 'video/mp4', status: 206, contentLength: 1_000, contentRange: 'bytes 1000-1999/5000', receivedAt: '2026-09-15T00:00:01.000Z' }
      })
    ]);

    expect(assets).toHaveLength(1);
    expect(assets[0].tracks).toHaveLength(1);
    expect(assets[0].tracks[0].sourceRequestIds).toEqual(['range-a', 'range-b']);
    expect(assets[0].tracks[0].detectionReasons).toContain('HTTP 206 Range response is part of the same representation');
  });

  it('keeps bitrate variants and auto-selects the highest compatible video candidate', () => {
    const assets = correlate([
      response('https://cdn.test/video-720.mp4?media_id=clip&quality=720', 'video/mp4', 20_000_000),
      response('https://cdn.test/video-1080.mp4?media_id=clip&quality=1080', 'video/mp4', 40_000_000),
      response('https://cdn.test/audio.m4a?media_id=clip', 'audio/mp4', 4_000_000)
    ]);

    expect(assets).toHaveLength(1);
    expect(assets[0].tracks.map((track) => track.kind)).toEqual(['video', 'video', 'audio']);
    expect(assets[0].selectedTrackIds).toEqual([
      assets[0].tracks.find((track) => track.sanitizedUrl.includes('quality=1080'))?.id,
      assets[0].tracks.find((track) => track.kind === 'audio')?.id
    ]);
  });

  it('classifies DRM indicators without treating encrypted media as playable', () => {
    const assets = correlate([response('https://cdn.test/video-widevine.mp4', 'video/mp4', 20_000_000)]);

    expect(assets[0].encrypted).toBe(true);
    expect(assets[0].tracks[0]).toMatchObject({ encrypted: true });
    expect(assets[0].tracks[0].detectionReasons).toContain('DRM or encryption indicator observed; payload is not classified as playable');
  });

  it('preserves iframe and worker request identity without conflating equal request IDs', () => {
    const assets = correlate([
      response('https://cdn.test/iframe.mp4', 'video/mp4', 8_000_000, 200, { targetId: 'iframe-target', frameId: 'iframe', sessionId: 'iframe-session', requestId: 'same' }),
      response('https://cdn.test/worker.m4a', 'audio/mp4', 1_000_000, 200, { targetId: 'worker-target', targetType: 'worker', sessionId: 'worker-session', requestId: 'same' })
    ]);

    expect(assets).toHaveLength(2);
    expect(assets.flatMap((asset) => asset.sourceRequestIds)).toEqual(expect.arrayContaining(['request-https://cdn.test/iframe.mp4', 'request-https://cdn.test/worker.m4a']));
    expect(assets.flatMap((asset) => asset.tracks).find((track) => track.sourceRequestIds.includes('request-https://cdn.test/worker.m4a'))?.detectionReasons)
      .toContain('Observed from worker target worker-target (session worker-session)');
  });

  it('pairs only a stable content identity on the same capture identity across time buckets', () => {
    const assets = correlate([
      response('https://cdn.test/video.mp4?media_id=clip-1&quality=720', 'video/mp4', 2_000_000, 200, { timestamp: 29 }),
      response('https://cdn.test/audio.m4a?media_id=clip-1', 'audio/mp4', 200_000, 200, { timestamp: 31 }),
      response('https://cdn.test/ad.m4a?media_id=ad', 'audio/mp4', 900_000, 200, { targetId: 'ad', frameId: 'ad-frame', timestamp: 30 })
    ]);
    expect(assets).toHaveLength(2);
    expect(assets.find((asset) => asset.tracks.some((track) => track.sanitizedUrl.includes('clip-1')))?.selectedTrackIds).toHaveLength(2);
  });

  it('converges after response/source-buffer/append reordering and rejects cross-frame collisions', () => {
    const video = response('https://cdn.test/chunk.mp4?media_id=clip', 'video/mp4', 2_000_000);
    const source: CaptureObservation = { runId, targetId: 'page', targetType: 'page', frameId: 'frame-main', executionContextId: 7, kind: 'mse', metadata: { type: 'source-buffer', objectId: 'mse-2', sourceBufferId: 'buffer-2', mimeType: 'video/mp4; codecs="avc1.640028"', timestamp: 1 } };
    const append: CaptureObservation = { ...source, metadata: { type: 'append', objectId: 'mse-2', sourceBufferId: 'buffer-2', byteLength: 10, timestamp: 2, buffered: [[0, 12]] } };
    const wrongFrame: CaptureObservation = { ...append, frameId: 'other-frame', executionContextId: 9, metadata: { ...append.metadata, buffered: [[0, 99]] } } as CaptureObservation;
    const first = correlate([video, source, append, wrongFrame]);
    const second = correlate([source, append, video, wrongFrame]);
    expect(first[0].tracks[0]).toMatchObject({ kind: 'video', codecs: 'avc1.640028', durationSeconds: 12 });
    expect(second[0].tracks[0]).toMatchObject({ kind: 'video', codecs: 'avc1.640028', durationSeconds: 12 });
  });

  it('monotonically classifies deduplicated DRM updates and excludes failed candidates from selection', () => {
    const first = response('https://cdn.test/video.mp4?media_id=clip', 'video/mp4', 2_000_000, 200, { request: { id: 'same', runId, sanitizedUrl: 'https://cdn.test/video.mp4?media_id=clip', method: 'GET', mimeType: 'video/mp4', status: 200, contentLength: 2_000_000, receivedAt: '2026-09-15T00:00:00.000Z' } });
    const firstNetwork = first as Extract<CaptureObservation, { kind: 'network' }>;
    const drm = { ...firstNetwork, stage: 'redirect', request: { ...firstNetwork.request, sanitizedResponseHeaders: { 'x-drm': 'widevine' } } } as CaptureObservation;
    const failed = { ...first, stage: 'failed', failure: 'net::ERR_FAILED' } as CaptureObservation;
    const alternative = response('https://cdn.test/video-alt.mp4?media_id=clip&quality=1080', 'video/mp4', 3_000_000, 200, { request: { id: 'alt', runId, sanitizedUrl: 'https://cdn.test/video-alt.mp4?media_id=clip&quality=1080', method: 'GET', mimeType: 'video/mp4', status: 200, contentLength: 3_000_000, receivedAt: '2026-09-15T00:00:00.000Z' } });
    const assets = correlate([first, drm, failed, alternative]);
    const tracks = assets[0].tracks;
    expect(tracks.find((track) => track.sourceRequestIds.includes('same'))).toMatchObject({ encrypted: true, eligible: false, incomplete: true });
    expect(assets[0].encrypted).toBe(true);
    expect(assets[0].selectedTrackIds).toEqual([tracks.find((track) => track.sourceRequestIds.includes('alt'))?.id]);
  });

  it('keeps lifecycle failures terminal until an observed finished success and preserves asset ownership', () => {
    const raw = new MediaCorrelator();
    const pending = response('https://cdn.test/v.mp4?media_id=x', 'video/mp4', 1, 200, { request: { id: 'life', runId, sanitizedUrl: 'https://cdn.test/v.mp4?media_id=x', method: 'GET', mimeType: 'video/mp4', status: 200, receivedAt: 'x' } });
    expect(raw.ingest(pending)[0].tracks[0]).toMatchObject({ eligible: false, incomplete: true });
    expect(raw.ingest({ ...(pending as Extract<CaptureObservation, { kind: 'network' }>), stage: 'finished' })[0].tracks[0]).toMatchObject({ eligible: true });
    const failedFirst = new MediaCorrelator();
    failedFirst.ingest({ ...(pending as Extract<CaptureObservation, { kind: 'network' }>), stage: 'failed' });
    const failedAssets = failedFirst.ingest(pending);
    expect(failedAssets[0].tracks[0]).toMatchObject({ eligible: false, incomplete: true });
    for (const asset of failedAssets) for (const track of asset.tracks) expect(track.assetId).toBe(asset.id);
  });

  it('does not assign an ambiguous same-kind SourceBuffer realm to multiple candidates', () => {
    const raw = new MediaCorrelator();
    const a = response('https://cdn.test/a.mp4', 'video/mp4', 1);
    const b = response('https://cdn.test/b.mp4', 'video/mp4', 1);
    const source = mseBuffer('video/mp4; codecs="avc1"', 'shared');
    const assets = [a, b, source].reduce((_, observation) => raw.ingest(observation), [] as MediaAsset[]);
    expect(assets).toHaveLength(2);
    expect(assets.flatMap((asset) => asset.tracks).every((track) => !track.detectionReasons.some((reason) => reason.startsWith('MSE SourceBuffer')))).toBe(true);
  });

  it('isolates candidate identity across capture realms', () => {
    const raw = new MediaCorrelator(); let assets: MediaAsset[] = [];
    for (const [field, value] of [['runId', 'other'], ['targetId', 'other-target'], ['sessionId', 'other-session'], ['frameId', 'other-frame']] as const) {
      const item = response('https://cdn.test/same.mp4?media_id=same', 'video/mp4', 1, 200, { [field]: value, request: { id: 'same', runId: field === 'runId' ? value : runId, sanitizedUrl: 'https://cdn.test/same.mp4?media_id=same', method: 'GET', mimeType: 'video/mp4', status: 200, receivedAt: 'x' } } as Partial<CaptureObservation>);
      assets = raw.ingest(item); assets = raw.ingest({ ...(item as Extract<CaptureObservation, { kind: 'network' }>), stage: 'finished' });
    }
    expect(assets).toHaveLength(4);
  });

  it('preserves sanitized session-scoped source references', () => {
    const assets = correlate([response('https://cdn.test/v.mp4?token=%5BREDACTED%5D', 'video/mp4', 1, 200, { sessionId: 's', frameId: 'f', request: { id: '["s","r"]', runId, sanitizedUrl: 'https://cdn.test/v.mp4?token=%5BREDACTED%5D', method: 'GET', mimeType: 'video/mp4', status: 200, receivedAt: 'x' } })]);
    expect(assets[0].sourceRequestIds).toEqual(['["s","r"]']);
    expect(JSON.stringify(assets)).not.toContain('secret');
  });

  it('converges to identical public outputs for all six response/source-buffer/append permutations', () => {
    const video = response('https://cdn.test/chunk.mp4', 'video/mp4', 2_000);
    const source = { ...mseBuffer('video/mp4; codecs="avc1.640028"'), executionContextId: 7 };
    const append = mseAppend(source);
    const orders = [[video, source, append], [video, append, source], [source, video, append], [source, append, video], [append, video, source], [append, source, video]];
    const outputs = orders.map(correlate);
    for (const assets of outputs) {
      expect(assets).toHaveLength(1);
      expect(assets[0].tracks[0]).toMatchObject({ kind: 'video', codecs: 'avc1.640028', durationSeconds: 12, byteLength: 2_000, eligible: true, incomplete: false, encrypted: false });
      expect(assets[0].selectedTrackIds).toEqual([assets[0].tracks[0].id]);
      expect(assets[0].confidence).toBeGreaterThanOrEqual(.8);
      expect(assets[0].sourceRequestIds).toEqual(['request-https://cdn.test/chunk.mp4']);
      assertOwnedAndSelected(assets);
      // Compare the complete public contract, including array order, reasons and references.
      expect(assets).toEqual(outputs[0]);
    }
  });

  it('retains append-before-buffer evidence across repeated metadata and deduplicates append observations', () => {
    const video = response('https://cdn.test/chunk.mp4', 'video/mp4', 2_000);
    const source = mseBuffer('video/mp4; codecs="avc1"', 'buffer');
    const append = mseAppend(source, 12);
    const laterAppend = mseAppend(source, 20, 13);
    const updated = mseBuffer('video/mp4; codecs="hvc1"', 'buffer');
    const expected = correlate([video, updated, append, laterAppend]);
    const actual = correlate([append, video, source, source, laterAppend, append, updated, updated, laterAppend]);
    expect(actual[0].tracks[0]).toMatchObject({ durationSeconds: 20, codecs: 'hvc1', kind: 'video', byteLength: 2_000 });
    expect(actual).toEqual(expected);
  });

  it('rejects colliding MSE IDs from distinct execution contexts without contaminating public evidence', () => {
    const video = response('https://cdn.test/chunk.mp4', 'video/mp4', 2_000);
    const first = { ...mseBuffer('video/mp4; codecs="avc1"', 'same-buffer'), executionContextId: 7 };
    for (const mime of ['video/mp4; codecs="hvc1"', 'audio/mp4; codecs="mp4a"']) {
      const second = { ...mseBuffer(mime, 'same-buffer'), executionContextId: 8 };
      for (const sources of [[first, second], [second, first]]) {
        const actual = correlate([video, sources[0], mseAppend(sources[0], 12), sources[1], mseAppend(sources[1], 99)]);
        expect(actual).toEqual(correlate([video]));
        expect(actual[0].tracks[0].kind).toBe('muxed');
        expect(actual[0].tracks[0].codecs).toBeUndefined();
        expect(actual[0].tracks[0].durationSeconds).toBeUndefined();
      }
    }
    const typedVideo = response('https://cdn.test/video.mp4', 'video/mp4', 2_000);
    const audio = response('https://cdn.test/audio.m4a', 'audio/mp4', 1_000);
    const otherContextAudio = { ...mseBuffer('audio/mp4; codecs="mp4a"', 'same-buffer'), executionContextId: 8 };
    const separated = correlate([typedVideo, audio, first, mseAppend(first, 12), otherContextAudio, mseAppend(otherContextAudio, 99)]);
    expect(separated).toHaveLength(2);
    expect(separated.flatMap((asset) => asset.tracks).find((track) => track.kind === 'video')).toMatchObject({ codecs: 'avc1', durationSeconds: 12 });
    expect(separated.flatMap((asset) => asset.tracks).find((track) => track.kind === 'audio')).toMatchObject({ codecs: 'mp4a', durationSeconds: 99 });
    expect(separated.every((asset) => asset.selectedTrackIds?.length === 1)).toBe(true);
    assertOwnedAndSelected(separated);
  });

  it('keeps completed unrelated same-kind candidates separate and retracts ambiguous MSE evidence', () => {
    const a = response('https://cdn.test/video-a.mp4', 'video/mp4', 2_000);
    const b = response('https://cdn.test/video-b.mp4', 'video/mp4', 3_000);
    const source = mseBuffer('video/mp4; codecs="avc1"');
    const baseline = correlate([a, b]);
    for (const observations of [[a, source, mseAppend(source), b], [b, a, source, mseAppend(source)]]) {
      const actual = correlate(observations);
      expect(actual).toHaveLength(2);
      expect(actual.every((asset) => asset.selectedTrackIds?.length === 1)).toBe(true);
      expect(actual.flatMap((asset) => asset.tracks).every((track) => track.eligible)).toBe(true);
      expect(actual).toEqual(baseline);
    }
  });

  it('pairs completed split tracks only while both MediaSource buffer matches remain unique', () => {
    const video = response('https://cdn.test/video.mp4', 'video/mp4', 2_000);
    const audio = response('https://cdn.test/audio.m4a', 'audio/mp4', 1_000);
    const videoBuffer = mseBuffer('video/mp4; codecs="avc1"');
    const audioBuffer = mseBuffer('audio/mp4; codecs="mp4a"');
    const evidence = [videoBuffer, mseAppend(videoBuffer, 12), audioBuffer, mseAppend(audioBuffer, 11)];
    const split = correlate([video, audio, ...evidence]);
    expect(split).toHaveLength(1);
    expect(split[0].tracks.map((track) => [track.kind, track.codecs, track.durationSeconds])).toEqual([['video', 'avc1', 12], ['audio', 'mp4a', 11]]);
    expect(split[0].selectedTrackIds).toEqual(split[0].trackIds);
    assertOwnedAndSelected(split);
    for (const kind of ['video', 'audio']) {
      const alternative = response(`https://cdn.test/${kind}-alternative.mp4`, `${kind}/mp4`, 3_000);
      const after = correlate([video, audio, ...evidence, alternative]);
      const before = correlate([alternative, audio, video, ...evidence]);
      expect(after).toHaveLength(3);
      expect(after).toEqual(before);
      expect(after.every((asset) => asset.selectedTrackIds?.length === 1)).toBe(true);
      for (const track of after.flatMap((asset) => asset.tracks).filter((track) => track.kind === kind)) {
        expect(track.codecs).toBeUndefined();
        expect(track.durationSeconds).toBeUndefined();
        expect(track.detectionReasons.some((reason) => reason.startsWith('MSE SourceBuffer'))).toBe(false);
      }
      assertOwnedAndSelected(after);
    }
  });

  it('keeps later DRM and protection evidence encrypted across subsequent clear-looking deduplicated updates', () => {
    const protectionHeaders: Record<string, string>[] = [{ 'x-drm': 'widevine' }, { 'x-content-protection': 'required' }];
    for (const headers of protectionHeaders) {
      const raw = new MediaCorrelator();
      const clear = response('https://cdn.test/video.mp4', 'video/mp4', 2_000) as Extract<CaptureObservation, { kind: 'network' }>;
      raw.ingest(clear);
      const completed = raw.ingest({ ...clear, stage: 'finished' });
      expect(completed[0].tracks[0].encrypted).toBe(false);
      const protectedUpdate = { ...clear, request: { ...clear.request, sanitizedResponseHeaders: headers } };
      const encrypted = raw.ingest(protectedUpdate);
      const later = raw.ingest(clear);
      expect(encrypted[0].encrypted).toBe(true);
      expect(encrypted[0].tracks[0].encrypted).toBe(true);
      expect(later).toEqual(encrypted);
      expect(later[0].tracks[0].detectionReasons).toContain('DRM or encryption indicator observed; payload is not classified as playable');
      expect(later[0].tracks[0]).not.toHaveProperty('playable');
      expect(later[0].tracks[0]).not.toHaveProperty('decrypted');
    }
  });


  it('keeps failed and HTTP-error lifecycles ineligible in every completion ordering', () => {
    const ok = response('https://cdn.test/video.mp4', 'video/mp4', 2_000) as Extract<CaptureObservation, { kind: 'network' }>;
    const finish = { ...ok, stage: 'finished' as const, request: { ...ok.request, status: undefined } };
    const failure = { ...ok, stage: 'failed' as const };
    const httpError = { ...ok, request: { ...ok.request, status: 404 } };
    const cases = [
      { events: [ok], eligible: false },
      { events: [failure, ok, finish], eligible: false },
      { events: [ok, failure, finish], eligible: false },
      { events: [ok, finish, failure, ok], eligible: false },
      { events: [httpError, finish], eligible: false },
      { events: [finish, httpError], eligible: false },
      { events: [ok, finish], eligible: true },
      { events: [finish, ok], eligible: true }
    ];
    for (const { events, eligible } of cases) {
      const raw = new MediaCorrelator();
      const assets = events.reduce((_, event) => raw.ingest(event), [] as MediaAsset[]);
      expect(assets[0].tracks[0]).toMatchObject({ eligible, incomplete: !eligible });
      expect(assets[0].selectedTrackIds).toHaveLength(eligible ? 1 : 0);
      assertOwnedAndSelected(assets);
    }
    const raw = new MediaCorrelator();
    raw.ingest(failure); raw.ingest(ok);
    const retry = { ...ok, requestId: 'retry', request: { ...ok.request, id: 'retry' } };
    raw.ingest(retry);
    const recovered = raw.ingest({ ...retry, stage: 'finished' });
    expect(recovered[0].tracks[0]).toMatchObject({ eligible: true, incomplete: true });
    expect(recovered[0].sourceRequestIds).toEqual(['request-https://cdn.test/video.mp4', 'retry']);
  });

});
