import { expect, it } from 'vitest';
import { parseOptions, selectMedia } from '../../src/main/douyin/options';
import { createSanitizedCapturedUrl } from '../../src/main/security/redact';
import type { MediaAsset, MediaTrack } from '../../src/shared/contracts';

it('extracts a Douyin URL from share text without including Chinese punctuation', () => {
  expect(parseOptions(['3.21 复制打开抖音 https://v.douyin.com/abc123/ ，看看这个作品', '--observe-seconds', '12']).pageUrl).toBe('https://v.douyin.com/abc123/');
});
it('accepts an explicit split pair, audio-only download and local merge', () => {
  expect(parseOptions(['--video-url', 'https://cdn.test/v?sign=abc&x=1', '--audio-url', 'https://cdn.test/a']).videoUrl).toBe('https://cdn.test/v?sign=abc&x=1');
  expect(parseOptions(['--audio-url', 'https://cdn.test/a']).audioUrl).toBe('https://cdn.test/a');
  expect(parseOptions(['--video-file', '/tmp/v.mp4', '--audio-file', '/tmp/a.m4a']).videoFile).toBe('/tmp/v.mp4');
});
it.each([
  [], ['--video-url', 'blob:https://douyin.com/a'], ['https://example.com/'],
  ['--video-file', 'v.mp4'], ['https://www.douyin.com/video/123', '--audio-url', 'https://cdn.test/a'],
  ['--video-url', 'https://cdn.test/v', '--observe-seconds', '-1'],
  ['--video-url', 'https://cdn.test/v', '--max-mb', 'NaN'],
  ['--video-url', 'https://cdn.test/v', '--bogus'],
  ['--video-url', 'https://cdn.test/v', '--video-file', 'v.mp4', '--audio-file', 'a.m4a']
].map(args => ({ args })))('rejects malformed or conflicting inputs $args', ({ args }) => { expect(() => parseOptions(args)).toThrow(); });

function asset(id: string, kinds: MediaTrack['kind'][]): MediaAsset {
  const tracks = kinds.map((kind, i): MediaTrack => ({ id: `${id}-${i}`, assetId: id, kind, sourceRequestIds: [`request-${id}-${i}`], eligible: true, sanitizedUrl: createSanitizedCapturedUrl(`https://cdn.test/${id}/${i}`), detectionReasons: [] }));
  return { id, runId: 'test', sourceRequestIds: tracks.flatMap(t => t.sourceRequestIds), detectedAt: '2026-09-15T00:00:00Z', trackIds: tracks.map(t => t.id), tracks, selectedTrackIds: tracks.map(t => t.id), confidence: 0.9, detectionReasons: [] };
}
it('selects a known pair and never guesses between different videos', () => {
  const pair = asset('a', ['video', 'audio']);
  expect(selectMedia([pair]).map(t => t.kind)).toEqual(['video', 'audio']);
  expect(() => selectMedia([pair, asset('b', ['muxed'])])).toThrow(/多个/);
  expect(selectMedia([pair, asset('b', ['muxed'])], 2)[0].id).toBe('b-0');
});
it('accepts an explicit video/audio pair from one capture but rejects duplicate or same-kind selections', () => {
  const assets = [asset('v', ['video']), asset('a', ['audio']), asset('other', ['video'])];
  expect(selectMedia(assets, [1, 2]).map(t => t.kind)).toEqual(['video', 'audio']);
  expect(() => selectMedia(assets, [1, 1])).toThrow();
  expect(() => selectMedia(assets, [1, 3])).toThrow();
  expect(parseOptions(['https://www.douyin.com/jingxuan?modal_id=123', '--select', '1,2']).selection).toEqual([1, 2]);
});
it('does not auto-pair unrelated audio and video or select incomplete/encrypted tracks', () => {
  expect(() => selectMedia([asset('a', ['video']), asset('b', ['audio'])])).toThrow();
  for (const invalid of [{ encrypted: true }, { incomplete: true }, { eligible: false }]) {
    const candidate = asset('a', ['muxed']); Object.assign(candidate.tracks[0], invalid);
    expect(() => selectMedia([candidate])).toThrow();
  }
});
