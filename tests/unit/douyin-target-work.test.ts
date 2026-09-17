import { describe, expect, it } from 'vitest';
import { DouyinWorkIndex, DouyinWorkLink, resolveWorkId, capturePageUrl } from '../../src/main/douyin/target-work';
import { createSanitizedCapturedUrl } from '../../src/main/security/redact';
import type { MediaAsset, MediaTrack } from '../../src/shared/contracts';
import type { EphemeralRequest } from '../../src/main/runs/run-orchestrator';

const workId = '7684438409082866998';
const page = `https://www.douyin.com/jingxuan?modal_id=${workId}`;
const video = 'https://v26-web.douyinvod.com/content/media-video-hvc1/?sign=secret&quality=720';
const audio = 'https://v26-web.douyinvod.com/content/media-audio-und-mp4a/?sign=audio-secret';
function work(id = workId) {
  return { awemeId: id, desc: '师徒四人', video: { duration: 390050, bitRateList: [
    { fileId: 'v720', audioFileId: 'a1', width: 1280, height: 720, bitRate: 1280000, videoFormat: 'dash', playAddr: [{ src: video }] }
  ], bitRateAudioList: [{ fileId: 'a1', mediaType: 'audio', urlList: [{ src: audio }] }] } };
}
function sources(urls = [video, audio, 'https://v26-web.douyinvod.com/other/media-video-hvc1/', 'https://cdn.test/effect.mp4']) {
  const requests: EphemeralRequest[] = urls.map((url, index) => ({ id: `s${index}`, url, method: 'GET', headers: {} }));
  const assets: MediaAsset[] = requests.map((request, index) => {
    const track: MediaTrack = { id: `t${index}`, assetId: `a${index}`, kind: index === 1 ? 'audio' : 'video', sourceRequestIds: [request.id], sanitizedUrl: createSanitizedCapturedUrl(request.url), eligible: true, byteLength: 1000, detectionReasons: [] };
    return { id: track.assetId, runId: 'run', tracks: [track], sourceRequestIds: [request.id], trackIds: [track.id], selectedTrackIds: [track.id], confidence: 1, detectionReasons: [], detectedAt: '' };
  });
  return { assets, requests };
}
function match(index: DouyinWorkIndex, input = sources()) { return index.select(page, page, input.assets, input.requests); }

describe('Douyin work ownership', () => {
  it('opens explicit search modal works through a direct work page without search parameters', () => {
    for (const path of ['/root/search/%E8%B7%B3%E8%88%9E', '/search/跳舞']) {
      expect(capturePageUrl(`https://www.douyin.com${path}?aid=search-session&modal_id=7355043530256977192&type=general`)).toBe('https://www.douyin.com/video/7355043530256977192');
    }
  });
  it('does not rewrite ambiguous, malformed, foreign or unrelated links', () => {
    for (const url of [
      'https://www.douyin.com/root/search/跳舞',
      'https://www.douyin.com/root/search/跳舞?modal_id=abc',
      'https://www.douyin.com/root/search/跳舞?modal_id=123&modal_id=456',
      'https://www.douyin.com/root/search/跳舞?modal_id=123&aweme_id=456',
      'https://douyin.com.evil.test/root/search/跳舞?modal_id=123',
      'https://www.douyin.com/video/123', 'https://v.douyin.com/abc/', page, 'not a URL'
    ]) expect(capturePageUrl(url)).toBe(url);
  });
  it('keeps the exact target author for archive naming, never the recommended work author', () => {
    const index = new DouyinWorkIndex();
    index.ingest(JSON.stringify({ items: [{ ...work('999'), author: { nickname: '推荐作者' } }, { ...work(), author: { nickname: '目标作者' } }] }), 'json');
    expect(match(index)).toMatchObject({ author: '目标作者', title: '师徒四人' });
    index.ingest(JSON.stringify(work()), 'json');
    expect(match(index).author).toBe('目标作者');
  });
  it('uses exact string IDs, original link before redirected selection, and only Douyin hosts', () => {
    expect(resolveWorkId(page, 'https://www.douyin.com/video/999')).toBe(workId);
    expect(resolveWorkId('https://v.douyin.com/abc/', `https://www.douyin.com/video/${workId}`)).toBe(workId);
    expect(resolveWorkId('https://douyin.com.evil.test/video/123')).toBeUndefined();
    expect(resolveWorkId('https://www.douyin.com/jingxuan')).toBeUndefined();
    expect(resolveWorkId(`${page}&modal_id=123`)).toBeUndefined();
  });
  it('reads URI-encoded SSR JSON without executing scripts, and excludes preloads/effects', () => {
    const index = new DouyinWorkIndex();
    index.ingest(`<script id="RENDER_DATA" type="application/json">${encodeURIComponent(JSON.stringify({ target: work(), feed: [work('999')] }))}</script>`, 'document');
    const result = match(index);
    expect(result.target).toMatchObject({ status: 'matched', workId });
    expect(result.title).toBe('师徒四人');
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].tracks.map(track => track.kind)).toEqual(['video', 'audio']);
    expect(result.assets[0].tracks[0]).toMatchObject({ width: 1280, height: 720, durationSeconds: 390.05 });
    expect(result.requests.map(request => request.id)).toEqual(['s0', 's1']);
  });
  it('reads pace push JSON as data and accepts only known player query additions', () => {
    const index = new DouyinWorkIndex();
    index.ingest(`self.__pace_f.push(${JSON.stringify([1, encodeURIComponent(JSON.stringify({ work: work() }))])});`, 'document');
    const result = match(index, sources([video + '&temp=1', audio + '&testst=2']));
    expect(result.target.status).toBe('matched');
    expect(match(index, sources([video.replace('quality=720', 'quality=1080'), audio])).assets).toEqual([]);
    expect(match(index, sources([video.replace('sign=secret', 'sign=wrong'), audio])).assets).toEqual([]);
  });
  it('never pairs a different audio file from the same work, or keeps a missing DASH audio', () => {
    const index = new DouyinWorkIndex(); const data = work(); data.video.bitRateAudioList[0].fileId = 'different';
    index.ingest(JSON.stringify(data), 'json');
    expect(match(index).assets).toEqual([]);
    const correct = new DouyinWorkIndex(); correct.ingest(JSON.stringify(work()), 'json');
    expect(match(correct, sources([video])).target.status).toBe('unresolved');
  });
  it('deduplicates repeated representations and retains completed exact request references', () => {
    const index = new DouyinWorkIndex(); index.ingest(JSON.stringify(work()), 'json'); index.ingest(JSON.stringify(work()), 'json');
    const input = sources([video, audio, video + '&temp=2']);
    const result = match(index, input);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].tracks[0].sourceRequestIds).toEqual(['s0', 's2']);
    input.assets[0].tracks[0].eligible = false; input.assets[2].tracks[0].eligible = false;
    expect(match(index, input).assets).toEqual([]);
  });
  it('supports raw API play_addr metadata and classifies a complete MP4 independently of MSE guesses', () => {
    const index = new DouyinWorkIndex();
    index.ingest(JSON.stringify({ aweme_detail: { aweme_id: workId, desc: '完整视频', video: { duration: 5000, bit_rate: [{ format: 'mp4', play_addr: { url_list: [video], width: 1920, height: 1080 }, bit_rate: 2000000 }] } } }), 'json');
    const result = match(index, sources([video]));
    expect(result.assets[0].tracks[0]).toMatchObject({ kind: 'muxed', height: 1080 });
  });
  it('fails closed for absent/wrong metadata, non-string unsafe IDs, malformed or oversized input', () => {
    const index = new DouyinWorkIndex();
    for (const body of ['not json', JSON.stringify(work('999')), JSON.stringify({ ...work(), awemeId: Number(workId) }), ' '.repeat(8_000_001)]) index.ingest(body, 'json');
    expect(match(index)).toMatchObject({ assets: [], requests: [], target: { status: 'unresolved' } });
  });
});


it('pins a short link to the first canonical work reached and honors encoded original parameters', () => {
  expect(resolveWorkId(`https://www.douyin.com/jingxuan?%6dodal_id=${workId}`, 'https://www.douyin.com/video/999')).toBe(workId);
  const link = new DouyinWorkLink('https://v.douyin.com/abc/');
  link.observe('https://www.douyin.com/jingxuan');
  link.observe(page);
  link.observe('https://www.douyin.com/video/999');
  expect(resolveWorkId('https://v.douyin.com/abc/', link.resolvedUrl)).toBe(workId);
});
it('does not label a declared split default address as a complete video when audio is absent', () => {
  const index = new DouyinWorkIndex();
  index.ingest(JSON.stringify({ awemeId: workId, video: { videoFormat: 'dash', audioFileId: 'a1', playAddr: [{ src: 'https://cdn.test/video.mp4' }] } }), 'json');
  expect(match(index, sources(['https://cdn.test/video.mp4'])).target.status).toBe('unresolved');
});
