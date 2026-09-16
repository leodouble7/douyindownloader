import { describe, expect, it } from 'vitest';
import { buildMediaCatalog, selectCatalogJobs } from '../../src/main/desktop/media-catalog';
import type { MediaAsset, MediaTrack } from '../../src/shared/contracts';
import type { DownloadSelection } from '../../src/shared/desktop';
import { createSourceRequestReference } from '../../src/shared/contracts';
import { createSanitizedCapturedUrl } from '../../src/main/security/redact';

function track(id: string, kind: MediaTrack['kind'] = 'video', changes: Partial<MediaTrack> = {}): MediaTrack {
  return { id, assetId: '', kind, sourceRequestIds: [`source-${id}`], sanitizedUrl: createSanitizedCapturedUrl(`https://cdn.test/${id}.mp4`), byteLength: 1000, eligible: true, incomplete: false, detectionReasons: [], ...changes };
}
function asset(id: string, tracks: MediaTrack[], changes: Partial<MediaAsset> = {}): MediaAsset {
  return { id, runId: 'capture', title: '相同页面标题', detectedAt: '2026-09-16T00:00:00Z', sourceRequestIds: tracks.flatMap(item => item.sourceRequestIds), trackIds: tracks.map(item => item.id), tracks: tracks.map(item => ({ ...item, assetId: id })), selectedTrackIds: tracks.slice(0, 1).map(item => item.id), confidence: 1, detectionReasons: [], ...changes };
}
const content = (path: string, id: string) => createSanitizedCapturedUrl(`https://cdn.test/${path}?media_id=${id}`);

describe('media catalog', () => {
  it('preserves equal-size unrelated resources as separate unconfirmed groups', () => {
    const catalog = buildMediaCatalog([asset('one', [track('one')]), asset('two', [track('two')])]);
    expect(catalog).toHaveLength(2);
    expect(new Set(catalog.map(entry => entry.candidate.groupKey)).size).toBe(2);
    expect(catalog.map(entry => entry.candidate.index)).toEqual([1, 2]);
    for (const { candidate } of catalog) {
      expect(candidate).toMatchObject({ grouping: 'unconfirmed', duplicateCount: 0 });
      expect(candidate.groupLabel).toContain('待确认资源');
      expect(candidate.variantLabel).toContain('清晰度未知');
      expect(candidate.height).toBeUndefined();
    }
  });

  it('folds repeated resource observations while retaining all exact request references without mutating inputs', () => {
    const first = track('same');
    const second = track('same', 'video', { sourceRequestIds: ['another-request'] });
    const input = [asset('first', [first]), asset('second', [second])];
    const original = structuredClone(input);
    const catalog = buildMediaCatalog(input);
    expect(catalog).toHaveLength(1);
    expect(catalog[0].tracks[0].sourceRequestIds).toEqual(['source-same', 'another-request']);
    expect(catalog[0].candidate.duplicateCount).toBe(1);
    expect(input).toEqual(original);
  });

  it('does not equate different identities just because redacted signed URLs collide', () => {
    const first = track('a', 'video', { sanitizedUrl: createSanitizedCapturedUrl('https://cdn.test/play?sign=first') });
    const second = track('b', 'video', { sanitizedUrl: createSanitizedCapturedUrl('https://cdn.test/play?sign=second') });
    expect(first.sanitizedUrl).toBe(second.sanitizedUrl);
    expect(buildMediaCatalog([asset('a', [first]), asset('b', [second])])).toHaveLength(2);
  });

  it('deduplicates an exact credential-free resource URL while preserving immutable request versions', () => {
    const source = (version: number) => createSourceRequestReference({ runId: 'capture', targetId: 'page', sessionId: 'session', frameId: 'frame', requestId: 'range', version });
    const sanitizedUrl = createSanitizedCapturedUrl('https://cdn.test/static/video.mp4');
    const catalog = buildMediaCatalog([
      asset('a', [track('a', 'video', { sanitizedUrl, sourceRequestIds: [source(1)] })]),
      asset('b', [track('b', 'video', { sanitizedUrl, sourceRequestIds: [source(2)] })])
    ]);
    expect(catalog).toHaveLength(1);
    expect(catalog[0].tracks[0].sourceRequestIds).toEqual([source(1), source(2)]);
  });

  it('exposes every video variant within an explicit asset and pairs its preferred audio', () => {
    const small = track('small', 'video', { width: 1280, height: 720 });
    const large = track('large', 'video', { width: 1920, height: 1080 });
    const audio = track('audio', 'audio');
    const catalog = buildMediaCatalog([asset('clip', [small, large, audio], { selectedTrackIds: ['large', 'audio'] })]);
    expect(catalog).toHaveLength(2);
    expect(new Set(catalog.map(entry => entry.candidate.groupKey)).size).toBe(1);
    expect(catalog.map(entry => entry.tracks.map(item => item.id))).toEqual([['small', 'audio'], ['large', 'audio']]);
    expect(catalog.map(entry => entry.candidate.kind)).toEqual(['pair', 'pair']);
    expect(catalog.map(entry => entry.candidate.variantLabel).join(' ')).toMatch(/1280.*720.*1920.*1080/);
    expect(catalog.every(entry => entry.candidate.grouping === 'confirmed')).toBe(true);
  });

  it('retains an explicit asset relationship after deduplicating its repeated observations', () => {
    const video = track('v'), audio = track('a', 'audio');
    const catalog = buildMediaCatalog([asset('paired', [video, audio]), asset('repeated-video', [video]), asset('repeated-audio', [audio])]);
    expect(catalog).toHaveLength(1);
    expect(catalog[0].candidate).toMatchObject({ kind: 'pair', grouping: 'confirmed', duplicateCount: 2 });
  });

  it('counts duplicated shared audio once across all quality variants', () => {
    const low = track('low'), high = track('high'), audio = track('audio', 'audio');
    const catalog = buildMediaCatalog([
      asset('clip', [track('muxed', 'muxed'), low, high, audio]),
      asset('repeat-low', [low]), asset('repeat-audio', [audio])
    ]);
    expect(catalog.map(entry => entry.candidate.kind)).toEqual(['muxed', 'pair', 'pair']);
    expect(catalog.filter(entry => entry.candidate.kind === 'pair').map(entry => entry.tracks[1].id)).toEqual(['audio', 'audio']);
    expect(catalog.reduce((sum, entry) => sum + (entry.candidate.duplicateCount ?? 0), 0)).toBe(2);
  });

  it.each([
    { width: 1920 }, { height: 1080 }, { byteLength: 2000 }, { bitrate: 2000000 }, { durationSeconds: 20 },
    { codecs: 'hvc1.1.6.L120' }, { mimeType: 'video/webm' }, { sanitizedUrl: createSanitizedCapturedUrl('https://cdn.test/different-resource.mp4') }
  ])('does not let shared track/request IDs bridge contradictory representation metadata %j', changes => {
    const original = track('collision', 'video', { width: 1280, height: 720, bitrate: 1000000, durationSeconds: 10, codecs: 'avc1.640028', mimeType: 'video/mp4' });
    const conflicting = { ...original, ...changes };
    const catalog = buildMediaCatalog([asset('paired', [original, track('audio', 'audio')]), asset('conflicting', [conflicting])]);
    expect(catalog.map(entry => entry.candidate.kind)).toEqual(['pair', 'video']);
    expect(catalog[1].candidate.groupKey).not.toBe(catalog[0].candidate.groupKey);
    expect(catalog[1].candidate.duplicateCount).toBe(0);
    expect(catalog[1].tracks).toHaveLength(1);
  });

  it('groups stable content IDs and confirms audio only for the same work', () => {
    const catalog = buildMediaCatalog([
      asset('low', [track('low', 'video', { sanitizedUrl: content('low.mp4', 'clip') })]),
      asset('high', [track('high', 'video', { sanitizedUrl: content('high.mp4', 'clip') })]),
      asset('audio', [track('audio', 'audio', { sanitizedUrl: content('audio.m4a', 'clip') })]),
      asset('ad', [track('ad', 'audio', { sanitizedUrl: content('ad.m4a', 'advert') })])
    ]);
    expect(catalog.map(entry => entry.tracks.map(item => item.id))).toEqual([['low', 'audio'], ['high', 'audio'], ['ad']]);
    expect(catalog[0].candidate.groupKey).toBe(catalog[1].candidate.groupKey);
    expect(catalog[2].candidate.groupKey).not.toBe(catalog[0].candidate.groupKey);
  });

  it('honors Douyin video_id across CDN hosts but not arbitrary third-party video_id', () => {
    const input = ['https://v3.douyinvod.com/video?video_id=clip', 'https://v9.douyinvod.com/audio?video_id=clip', 'https://elsewhere.test/audio?video_id=clip'];
    const catalog = buildMediaCatalog(input.map((url, i) => asset(String(i), [track(String(i), i === 0 ? 'video' : 'audio', { sanitizedUrl: createSanitizedCapturedUrl(url) })])));
    expect(catalog.map(entry => entry.tracks.map(item => item.id))).toEqual([['0', '1'], ['2']]);
  });

  it('does not confuse runs or immutable source capture scopes with equal content IDs', () => {
    const source = (requestId: string, targetId: string) => createSourceRequestReference({ runId: 'capture', targetId, sessionId: '', frameId: '', requestId, version: 1 });
    const catalog = buildMediaCatalog([
      asset('a', [track('a', 'video', { sanitizedUrl: content('a', 'clip'), sourceRequestIds: [source('same', 'page')] })]),
      asset('b', [track('b', 'audio', { sanitizedUrl: content('b', 'clip'), sourceRequestIds: [source('same', 'worker')] })]),
      asset('c', [track('c', 'audio', { sanitizedUrl: content('c', 'clip') })], { runId: 'other-run' })
    ]);
    expect(catalog).toHaveLength(3);
    expect(catalog.map(entry => entry.candidate.kind)).toEqual(['video', 'audio', 'audio']);
  });

  it('offers independent audio for explicit manual selection without auto-pairing unknown work', () => {
    const catalog = buildMediaCatalog([asset('v', [track('video')]), asset('a', [track('audio', 'audio')])]);
    expect(catalog[0].candidate).toMatchObject({ kind: 'video', grouping: 'unconfirmed', audioOptions: [2] });
    expect(catalog[0].tracks.map(item => item.id)).toEqual(['video']);
    expect(selectCatalogJobs(catalog, [{ candidateIndex: 1, audioIndex: 2 }], 'single')[0].tracks.map(item => item.id)).toEqual(['video', 'audio']);
    expect(selectCatalogJobs(catalog, [{ candidateIndex: 2 }], 'single')[0].tracks.map(item => item.id)).toEqual(['audio']);
  });

  it('never offers or accepts an explicitly different work as manual audio', () => {
    const catalog = buildMediaCatalog([
      asset('v', [track('video', 'video', { sanitizedUrl: content('v', 'one') })]),
      asset('a', [track('audio', 'audio', { sanitizedUrl: content('a', 'two') })])
    ]);
    expect(catalog[0].candidate.audioOptions ?? []).toEqual([]);
    expect(() => selectCatalogJobs(catalog, [{ candidateIndex: 1, audioIndex: 2 }], 'single')).toThrow();
  });

  it('excludes encrypted, incomplete, non-media and sourceless tracks even if preselected', () => {
    const input = [
      asset('encrypted', [track('encrypted')], { encrypted: true }),
      asset('incomplete', [track('incomplete', 'video', { incomplete: true })]),
      asset('ineligible', [track('ineligible', 'video', { eligible: false })]),
      asset('manifest', [track('manifest', 'manifest')]),
      asset('sourceless', [track('sourceless', 'video', { sourceRequestIds: [] })]),
      asset('valid', [track('valid', 'muxed')])
    ];
    expect(buildMediaCatalog(input).map(entry => entry.tracks.map(item => item.id))).toEqual([['valid']]);
  });

  it('projects safe display metadata without URLs, credentials or source identities', () => {
    const input = asset('secret-asset', [track('secret-track', 'video', {
      sanitizedUrl: createSanitizedCapturedUrl('https://media.example/private.mp4?media_id=secret-content&sign=secret-sign'),
      codecs: 'avc1 https://codec.example/?sign=secret-codec Cookie: secret-cookie', width: Infinity, height: -1
    })], { title: 'https://title.example/?token=secret-title' });
    const projection = JSON.stringify(buildMediaCatalog([input]).map(entry => entry.candidate));
    expect(projection).not.toMatch(/secret|https:|example|source-|sanitizedUrl|requestHeaders|Cookie/);
    expect(buildMediaCatalog([input])[0].candidate).toMatchObject({ grouping: 'confirmed' });
    expect(buildMediaCatalog([input])[0].candidate.width).toBeUndefined();
    expect(buildMediaCatalog([input])[0].candidate.height).toBeUndefined();
  });
});

describe('catalog job selection', () => {
  const standalone = () => buildMediaCatalog([asset('one', [track('one', 'muxed')]), asset('two', [track('two', 'audio')]), asset('three', [track('three')])]);

  it('creates separate ordered jobs for a batch and copies the selection', () => {
    const catalog = standalone();
    const selection = { candidateIndex: 3, audioIndex: 2 };
    const jobs = selectCatalogJobs(catalog, [{ candidateIndex: 1 }, selection], 'batch');
    expect(jobs.map(job => job.tracks.map(item => item.id))).toEqual([['one'], ['three', 'two']]);
    expect(jobs[1].selection).toEqual(selection);
    expect(jobs[1].selection).not.toBe(selection);
    expect(jobs.every(job => job.label.length > 0 && !job.label.includes('https:'))).toBe(true);
  });

  it('rejects selecting two variants of one group', () => {
    const catalog = buildMediaCatalog([asset('clip', [track('low'), track('high')])]);
    expect(() => selectCatalogJobs(catalog, [{ candidateIndex: 1 }, { candidateIndex: 2 }], 'batch')).toThrow();
  });

  it('rejects duplicating an audio group as both a standalone task and a manual companion', () => {
    expect(() => selectCatalogJobs(standalone(), [{ candidateIndex: 2 }, { candidateIndex: 3, audioIndex: 2 }], 'batch')).toThrow();
  });

  it('bounds single and batch modes without silently dropping choices', () => {
    const catalog = standalone();
    expect(() => selectCatalogJobs(catalog, [], 'single')).toThrow();
    expect(() => selectCatalogJobs(catalog, [], 'batch')).toThrow();
    expect(() => selectCatalogJobs(catalog, [{ candidateIndex: 1 }, { candidateIndex: 2 }], 'single')).toThrow();
    const many = buildMediaCatalog(Array.from({ length: 101 }, (_, i) => asset(String(i), [track(String(i), 'muxed')])));
    expect(selectCatalogJobs(many, many.slice(0, 100).map(entry => ({ candidateIndex: entry.candidate.index })), 'batch')).toHaveLength(100);
    expect(() => selectCatalogJobs(many, many.map(entry => ({ candidateIndex: entry.candidate.index })), 'batch')).toThrow();
    expect(() => selectCatalogJobs(catalog, [{ candidateIndex: 1 }], 'invalid' as 'single')).toThrow();
  });

  it.each([
    [{ candidateIndex: 0 }], [{ candidateIndex: -1 }], [{ candidateIndex: 1.5 }], [{ candidateIndex: NaN }], [{ candidateIndex: 4 }], [{ candidateIndex: '1' }],
    [{ candidateIndex: 1 }, { candidateIndex: 1 }], [{ candidateIndex: 1, audioIndex: 2 }], [{ candidateIndex: 2, audioIndex: 3 }],
    [{ candidateIndex: 3, audioIndex: 0 }], [{ candidateIndex: 3, audioIndex: 1 }], [{ candidateIndex: 3, audioIndex: 3 }],
    [{ candidateIndex: 3, audioIndex: '2' }], [{ candidateIndex: 3, audioIndex: null }], [{ candidateIndex: 3, extra: true }], [null], [{}]
  ])('rejects invalid selection %j', (...selections) => {
    expect(() => selectCatalogJobs(standalone(), selections as DownloadSelection[], 'batch')).toThrow();
  });

  it('rejects non-array selections and overrides on automatic pairs', () => {
    const pair = buildMediaCatalog([asset('pair', [track('video'), track('audio', 'audio')]), asset('other', [track('other', 'audio')])]);
    expect(() => selectCatalogJobs(pair, { candidateIndex: 1 } as unknown as DownloadSelection[], 'single')).toThrow();
    expect(() => selectCatalogJobs(pair, [{ candidateIndex: 1, audioIndex: 2 }], 'single')).toThrow();
  });

  it('rejects sparse arrays and inherited index properties instead of queuing empty tasks', () => {
    expect(() => selectCatalogJobs(standalone(), new Array<DownloadSelection>(1), 'single')).toThrow();
    expect(() => selectCatalogJobs(standalone(), [Object.create({ candidateIndex: 1 }) as DownloadSelection], 'single')).toThrow();
  });
});
