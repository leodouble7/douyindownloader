import { describe, expect, it } from 'vitest';
import { parseDash, parseHls } from '../../src/main/media/playlist-parser';

describe('playlist parsers', () => {
  it('parses an HLS master playlist with alternate audio and sanitized references only', () => {
    const playlist = parseHls(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio/en.m3u8",DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"
video/720.m3u8?token=%5BREDACTED%0Ahttps://not-followed.test/x.m3u8
`, 'https://cdn.test/master/index.m3u8?signature=%5BREDACTED%5D');

    expect(playlist.type).toBe('master');
    expect(playlist.variants).toEqual([expect.objectContaining({
      sanitizedUrl: 'https://cdn.test/master/video/720.m3u8?token=%5BREDACTED%5D',
      bandwidth: 1_200_000,
      width: 1280,
      height: 720,
      audioGroupId: 'aud'
    })]);
    expect(playlist.alternateAudio).toEqual([expect.objectContaining({ sanitizedUrl: 'https://cdn.test/master/audio/en.m3u8', groupId: 'aud' })]);
  });

  it('parses an HLS media playlist with initialization, segments and AES encryption classification', () => {
    const playlist = parseHls(`#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",KEYFORMAT="identity"
#EXTINF:4.0,
seg-1.m4s
#EXTINF:4.0,
seg-2.m4s
`, 'https://cdn.test/v/playlist.m3u8');

    expect(playlist.type).toBe('media');
    expect(playlist.initializationSegmentUrl).toBe('https://cdn.test/v/init.mp4');
    expect(playlist.segments.map((segment) => segment.sanitizedUrl)).toEqual([
      'https://cdn.test/v/seg-1.m4s', 'https://cdn.test/v/seg-2.m4s'
    ]);
    expect(playlist.encryption).toEqual({ encrypted: true, method: 'AES-128', keyFormat: 'identity' });
  });

  it('parses DASH adaptation sets, representations, initialization and CENC classification', () => {
    const manifest = parseDash(`<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT12S"><Period><AdaptationSet mimeType="video/mp4" codecs="avc1.640028"><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/><Representation id="v1080" bandwidth="5000000" width="1920" height="1080"><SegmentTemplate initialization="init-$RepresentationID$.mp4" media="chunk-$Number$.m4s" startNumber="1"/></Representation></AdaptationSet><AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2"><Representation id="a1" bandwidth="128000"><BaseURL>audio/a1/</BaseURL><SegmentTemplate initialization="init.mp4" media="s-$Number$.m4s" startNumber="3"/></Representation></AdaptationSet></Period></MPD>`, 'https://cdn.test/dash/manifest.mpd');

    expect(manifest.representations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'v1080', kind: 'video', width: 1920, height: 1080, initializationUrl: 'https://cdn.test/dash/init-v1080.mp4', mediaUrlTemplate: 'https://cdn.test/dash/chunk-$Number$.m4s', encrypted: true }),
      expect.objectContaining({ id: 'a1', kind: 'audio', initializationUrl: 'https://cdn.test/dash/audio/a1/init.mp4', mediaUrlTemplate: 'https://cdn.test/dash/audio/a1/s-$Number$.m4s' })
    ]));
  });

  it('does not follow manifest references outside the supplied text', () => {
    const playlist = parseHls('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://elsewhere.test/next.m3u8\n', 'https://cdn.test/root.m3u8');
    expect(playlist.variants[0].sanitizedUrl).toBe('https://elsewhere.test/next.m3u8');
    expect(playlist.segments).toEqual([]);
  });

  it('skips malformed or non-HTTP references without escaping the supplied manifest', () => {
    const playlist = parseHls('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\njavascript:alert(1)\n', 'https://cdn.test/root.m3u8');
    expect(playlist.variants).toEqual([]);
    expect(playlist.segments).toEqual([]);
  });

  it('retains per-segment ranges and active initialization maps while classifying session keys', () => {
    const playlist = parseHls(`#EXTM3U
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.widevine"
#EXT-X-MAP:URI="init-a.mp4",BYTERANGE="100@0"
#EXT-X-BYTERANGE:50@10
#EXTINF:4,
a.m4s
#EXT-X-MAP:URI="init-b.mp4"
#EXT-X-BYTERANGE:50
#EXTINF:4,
b.m4s
`, 'https://cdn.test/v/master.m3u8');

    expect(playlist.encryption).toMatchObject({ encrypted: true, method: 'SAMPLE-AES' });
    expect(playlist.segments).toEqual([
      expect.objectContaining({ byteRange: { length: 50, offset: 10 }, initializationSegmentUrl: 'https://cdn.test/v/init-a.mp4' }),
      expect.objectContaining({ byteRange: { length: 50 }, initializationSegmentUrl: 'https://cdn.test/v/init-b.mp4' })
    ]);
  });

  it('preserves namespaced DASH inheritance and truncates one shared output budget', () => {
    const representations = Array.from({ length: 101 }, (_, index) => `<d:Representation id="r${index}"/>`).join('');
    const segments = Array.from({ length: 101 }, (_, index) => `<d:SegmentURL media="s${index}.m4s"/>`).join('');
    const manifest = parseDash(`<d:MPD xmlns:d="urn:mpeg:dash:schema:mpd:2011"><d:BaseURL serviceLocation="origin">root/</d:BaseURL><d:Period><d:BaseURL>period/</d:BaseURL><d:AdaptationSet mimeType="video/mp4" codecs="avc1.4d401f" width="1920" height="1080"><d:BaseURL>set/</d:BaseURL><d:SegmentTemplate timescale="1000" media="v-$Number$.m4s"><d:SegmentTimeline><d:S t="0" d="2000" r="4"/></d:SegmentTimeline></d:SegmentTemplate><d:SegmentList>${segments}</d:SegmentList>${representations}</d:AdaptationSet></d:Period></d:MPD>`, 'https://cdn.test/dash/manifest.mpd');

    expect(manifest.truncated).toBe(true);
    expect(manifest.outputBudgetUsed).toBeLessThanOrEqual(manifest.outputBudget);
    expect(manifest.representations.length).toBeLessThan(101);
    expect(manifest.segmentLists).toHaveLength(1);
    expect(manifest.segmentLists[0].segmentUrls.length).toBeGreaterThan(0);
    expect(manifest.segmentLists[0].segmentUrls[0]).toBe('https://cdn.test/dash/root/period/set/s0.m4s');
    expect(manifest.segmentTimelines.find((timeline) => timeline.id === manifest.representations[0].segmentTimelineId)?.entries).toEqual([{ t: 0, d: 2000, r: 4 }]);
    expect(manifest.representations[0]).toMatchObject({ mimeType: 'video/mp4', codecs: 'avc1.4d401f', width: 1920, height: 1080, initializationUrl: undefined, mediaUrlTemplate: 'https://cdn.test/dash/root/period/set/v-$Number$.m4s' });
  });

  it('recognizes UUID DRM declarations and merges partial DASH templates without expanding a timeline', () => {
    const manifest = parseDash(`<MPD><Period><BaseURL>p/</BaseURL><AdaptationSet mimeType="audio/mp4"><SegmentTemplate timescale="48000" initialization="init-$RepresentationID$.mp4" media="a-$Time$.m4s" startNumber="7"/><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><Representation id="audio"><BaseURL>rep/</BaseURL><SegmentTemplate media="override-$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>`, 'https://cdn.test/m.mpd');
    expect(manifest.encrypted).toBe(true);
    expect(manifest.representations[0]).toMatchObject({ encrypted: true, initializationUrl: 'https://cdn.test/p/rep/init-audio.mp4', mediaUrlTemplate: 'https://cdn.test/p/rep/override-$Number$.m4s', addressing: { timescale: 48000, startNumber: 7 } });
  });

  it('classifies PlayReady, ClearKey, generic protections and HLS session/segment keys as encrypted', () => {
    for (const scheme of ['urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95', 'urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e', 'urn:vendor:custom', 'urn:mpeg:dash:mp4protection:2011']) {
      expect(parseDash(`<MPD><Period><AdaptationSet><ContentProtection schemeIdUri="${scheme}"/><Representation id="r"/></AdaptationSet></Period></MPD>`, 'https://cdn.test/m.mpd').encrypted).toBe(true);
    }
    expect(parseHls('#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES\n#EXT-X-KEY:METHOD=AES-128\n', 'https://cdn.test/m.m3u8').encryption.encrypted).toBe(true);
  });

  it('scopes implicit HLS media and map ranges to their resolved URI', () => {
    const p = parseHls(`#EXTM3U
#EXT-X-MAP:URI="i.mp4",BYTERANGE="10@4"
#EXT-X-MAP:URI="i.mp4",BYTERANGE="10"
#EXT-X-BYTERANGE:5@10
a.m4s
#EXT-X-BYTERANGE:5
a.m4s
b.m4s
#EXT-X-BYTERANGE:5
a.m4s
#EXT-X-MAP:URI="j.mp4",BYTERANGE="10"
`, 'https://cdn.test/v/p.m3u8');
    expect(p.segments.map((s) => s.byteRange)).toEqual([{ length: 5, offset: 10 }, { length: 5, offset: 15 }, undefined, { length: 5 }]);
    expect(p.segments[0].initializationByteRange).toEqual({ length: 10, offset: 14 });
    expect(p.initializationSegmentUrl).toBe('https://cdn.test/v/j.mp4');
  });

  it('retains r=-1 and standalone representation BaseURL addressing', () => {
    const p = parseDash('<MPD><Period><Representation id="r"><BaseURL>file.mp4</BaseURL><SegmentTemplate><SegmentTimeline><S d="2" r="-1"/></SegmentTimeline></SegmentTemplate></Representation></Period></MPD>', 'https://cdn.test/m.mpd');
    expect(p.representations[0]).toMatchObject({ mediaUrlTemplate: 'https://cdn.test/file.mp4' });
    expect(p.segmentTimelines.find((timeline) => timeline.id === p.representations[0].segmentTimelineId)?.entries).toEqual([{ d: 2, r: -1 }]);
  });

  it('uses one configured DASH budget for empty, initialization, timeline and cross-product work', () => {
    const p = parseDash('<MPD><Period><AdaptationSet><SegmentList><Initialization sourceURL="i.mp4"/></SegmentList><SegmentTemplate><SegmentTimeline><S d="1"/><S d="1"/></SegmentTimeline></SegmentTemplate><Representation id="a"/><Representation id="b"/><Representation id="c"/></AdaptationSet></Period></MPD>', 'https://cdn.test/m.mpd', { maxOutputItems: 3 });
    expect(p).toMatchObject({ outputBudget: 3, truncated: true });
    expect(p.outputBudgetUsed).toBeLessThanOrEqual(3);
  });

  it('deduplicates same-base inherited DASH lists and separates different representation bases', () => {
    const p = parseDash('<MPD><Period><AdaptationSet><SegmentList><Initialization sourceURL="i.mp4"/><SegmentURL media="s.m4s"/></SegmentList><Representation id="a"><BaseURL>a/</BaseURL></Representation><Representation id="b"><BaseURL>b/</BaseURL></Representation><Representation id="c"><BaseURL>a/</BaseURL></Representation></AdaptationSet></Period></MPD>', 'https://cdn.test/m.mpd');
    const a = p.representations.find((r) => r.id === 'a')!, b = p.representations.find((r) => r.id === 'b')!, c = p.representations.find((r) => r.id === 'c')!;
    expect(a.segmentListId).not.toBe(b.segmentListId); expect(a.segmentListId).toBe(c.segmentListId);
    expect(p.segmentLists.find((l) => l.id === a.segmentListId)?.segmentUrls).toEqual(['https://cdn.test/a/s.m4s']);
    expect(p.segmentLists.find((l) => l.id === b.segmentListId)?.initializationUrl).toBe('https://cdn.test/b/i.mp4');
  });

  it('deduplicates inherited DASH timelines within the serialized output budget', () => {
    const entries = Array.from({ length: 64 }, (_, index) => `<S t="${index * 2}" d="2"/>`).join('');
    const representations = Array.from({ length: 64 }, (_, index) => `<Representation id="r${index}"/>`).join('');
    const xml = `<MPD><Period><AdaptationSet><SegmentTemplate><SegmentTimeline>${entries}</SegmentTimeline></SegmentTemplate>${representations}</AdaptationSet></Period></MPD>`;
    const manifest = parseDash(xml, 'https://cdn.test/m.mpd', { maxOutputItems: 96 });
    expect((JSON.stringify(manifest).match(/"d":2/g) ?? []).length).toBeLessThanOrEqual(manifest.outputBudgetUsed);
    expect(manifest.segmentTimelines).toHaveLength(1);
    expect(manifest.segmentTimelines[0].entries).toHaveLength(64);
    expect(manifest.representations).toHaveLength(31);
    expect(manifest.outputBudgetUsed).toBe(96); // one registry + 64 entries + 31 representations
    expect(manifest.truncated).toBe(true);
    for (const rep of manifest.representations) {
      expect(rep.segmentTimelineId).toBe(manifest.segmentTimelines[0].id);
      expect(rep).not.toHaveProperty('segmentTimeline');
    }
    expect(JSON.stringify(manifest).match(/"d":2/g)).toHaveLength(64);
    const complete = parseDash(xml, 'https://cdn.test/m.mpd', { maxOutputItems: 129 });
    expect(complete.representations).toHaveLength(64);
    expect(complete.outputBudgetUsed).toBe(129);
    expect(complete.truncated).toBe(false);
    expect(parseDash(xml, 'https://cdn.test/m.mpd', { maxOutputItems: 96 })).toEqual(manifest);

    const distinct = parseDash('<MPD><Period><AdaptationSet><Representation id="a"><SegmentTemplate><SegmentTimeline><S d="2" r="-1"/></SegmentTimeline></SegmentTemplate></Representation><Representation id="b"><SegmentTemplate><SegmentTimeline><S d="2" r="-1"/></SegmentTimeline></SegmentTemplate></Representation><Representation id="c"><SegmentTemplate><SegmentTimeline><S d="3" r="-1"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>', 'https://cdn.test/m.mpd');
    expect(distinct.segmentTimelines.map((timeline) => timeline.entries)).toEqual([[{ d: 2, r: -1 }], [{ d: 3, r: -1 }]]);
    expect(distinct.representations.map((rep) => rep.segmentTimelineId)).toEqual([distinct.segmentTimelines[0].id, distinct.segmentTimelines[0].id, distinct.segmentTimelines[1].id]);
    expect(distinct.outputBudgetUsed).toBe(7); // three representations, two registries and two entries
  });

  it('classifies late DASH protection independently of retained representations', () => {
    for (const scheme of ['urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', 'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95', 'urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e', 'urn:vendor:custom']) {
      const xml = `<MPD><Period><AdaptationSet><Representation id="clear"/></AdaptationSet><AdaptationSet><ContentProtection schemeIdUri="${scheme}"/><Representation id="protected"/></AdaptationSet></Period></MPD>`;
      const manifest = parseDash(xml, 'https://cdn.test/m.mpd', { maxOutputItems: 1 });
      expect(manifest.representations.map((rep) => rep.id)).toEqual(['clear']);
      expect(manifest).toMatchObject({ encrypted: true, truncated: true, outputBudgetUsed: 1 });
    }
    const clear = '<MPD><Period><AdaptationSet><Representation id="clear"/></AdaptationSet><AdaptationSet><Representation id="also-clear"/></AdaptationSet></Period></MPD>';
    expect(parseDash(clear, 'https://cdn.test/m.mpd', { maxOutputItems: 1 })).toMatchObject({ encrypted: false, truncated: true });
    expect(parseDash(clear, 'https://cdn.test/m.mpd', { maxOutputItems: 1, maxScanNodes: 1 })).toMatchObject({ encrypted: true, truncated: true });
    expect(parseDash(' '.repeat(1_000_001), 'https://cdn.test/m.mpd')).toMatchObject({ encrypted: true, truncated: true });
  });

  it('rebases inherited Period SegmentLists through adaptation and representation bases', () => {
    const xml = '<MPD><BaseURL>root/</BaseURL><Period><BaseURL>period/</BaseURL><SegmentList><Initialization sourceURL="init.mp4?token=secret"/><SegmentURL media="seg.m4s"/></SegmentList><AdaptationSet><BaseURL>set/</BaseURL><Representation id="inherited"/><Representation id="same"><BaseURL>./</BaseURL></Representation><Representation id="nested"><BaseURL>nested/</BaseURL></Representation><Representation id="nested-again"><BaseURL>nested/</BaseURL></Representation></AdaptationSet></Period></MPD>';
    const manifest = parseDash(xml, 'https://cdn.test/manifest.mpd');
    expect(manifest.segmentLists).toHaveLength(2);
    const listFor = (id: string) => manifest.segmentLists.find((list) => list.id === manifest.representations.find((rep) => rep.id === id)?.segmentListId);
    expect(listFor('inherited')).toMatchObject({ initializationUrl: 'https://cdn.test/root/period/set/init.mp4?token=%5BREDACTED%5D', segmentUrls: ['https://cdn.test/root/period/set/seg.m4s'] });
    expect(listFor('nested')).toMatchObject({ initializationUrl: 'https://cdn.test/root/period/set/nested/init.mp4?token=%5BREDACTED%5D', segmentUrls: ['https://cdn.test/root/period/set/nested/seg.m4s'] });
    expect(listFor('same')?.id).toBe(listFor('inherited')?.id);
    expect(listFor('nested-again')?.id).toBe(listFor('nested')?.id);
    expect(listFor('nested')?.id).not.toBe(listFor('inherited')?.id);
    expect(JSON.stringify(manifest)).not.toContain('secret');
  });

  it('resets same-URI HLS map range continuity after a whole-resource map', () => {
    const interrupted = parseHls('#EXTM3U\n#EXT-X-MAP:URI="i.mp4",BYTERANGE="10@4"\na.m4s\n#EXT-X-MAP:URI="i.mp4"\nb.m4s\n#EXT-X-MAP:URI="i.mp4",BYTERANGE="10"\nc.m4s\n', 'https://cdn.test/m.m3u8');
    expect(interrupted.segments.map((segment) => segment.initializationByteRange)).toEqual([{ length: 10, offset: 4 }, undefined, { length: 10, offset: undefined }]);
    const contiguous = parseHls('#EXTM3U\n#EXT-X-MAP:URI="i.mp4",BYTERANGE="10@4"\na.m4s\n#EXT-X-MAP:URI="i.mp4",BYTERANGE="10"\nb.m4s\n', 'https://cdn.test/m.m3u8');
    expect(contiguous.segments.map((segment) => segment.initializationByteRange)).toEqual([{ length: 10, offset: 4 }, { length: 10, offset: 14 }]);
  });

  it('never emits dangling DASH registry references at tiny budget boundaries', () => {
    const exhausted = parseDash('<MPD><Period><SegmentList><Initialization sourceURL="i.mp4"/></SegmentList><Representation id="a"><BaseURL>rep/</BaseURL></Representation></Period></MPD>', 'https://cdn.test/m.mpd', { maxOutputItems: 3 });
    for (const rep of exhausted.representations) if (rep.segmentListId) expect(exhausted.segmentLists.some((list) => list.id === rep.segmentListId)).toBe(true);
    const manifests = [
      '<MPD><Period><SegmentList/><Representation id="a"><BaseURL>rep/</BaseURL></Representation></Period></MPD>',
      '<MPD><Period><Representation id="a"><SegmentList><Initialization sourceURL="i.mp4"/><SegmentURL media="s.m4s"/></SegmentList></Representation></Period></MPD>',
      '<MPD><Period><SegmentTemplate initialization="i.mp4" media="s-$Number$.m4s"><SegmentTimeline><S d="1"/><S d="2"/></SegmentTimeline></SegmentTemplate><Representation id="a"/><Representation id="b"/></Period></MPD>',
      '<MPD><Period><SegmentList><Initialization sourceURL="i.mp4"/><SegmentURL media="s.m4s"/></SegmentList><SegmentTemplate media="s-$Time$.m4s"><SegmentTimeline><S d="1"/></SegmentTimeline></SegmentTemplate><Representation id="a"/><Representation id="b"/></Period></MPD>'
    ];
    for (const xml of manifests) for (let limit = 0; limit <= 12; limit++) {
      const manifest = parseDash(xml, 'https://cdn.test/m.mpd', { maxOutputItems: limit });
      expect(manifest.outputBudgetUsed).toBeLessThanOrEqual(limit);
      for (const rep of manifest.representations) {
        if (rep.segmentListId) expect(manifest.segmentLists.some((list) => list.id === rep.segmentListId)).toBe(true);
        if (rep.segmentTimelineId) expect(manifest.segmentTimelines.some((timeline) => timeline.id === rep.segmentTimelineId)).toBe(true);
      }
      // Count serialized variable-size records and URL occurrences independently of the parser.
      const actualItems = manifest.representations.reduce((count, rep) => count + 1 + Number(Boolean(rep.initializationUrl)) + Number(Boolean(rep.mediaUrlTemplate)) + rep.segmentUrls.length, 0)
        + manifest.segmentLists.reduce((count, list) => count + 1 + Number(Boolean(list.initializationUrl)) + list.segmentUrls.length, 0)
        + manifest.segmentTimelines.reduce((count, timeline) => count + 1 + timeline.entries.length, 0);
      expect(manifest.outputBudgetUsed).toBe(actualItems);
      if (limit === 0) expect(manifest.truncated).toBe(true);
    }
    // A representation can consume the final slot; unavailable addressing must then be omitted.
    const noAddressing = parseDash(manifests[1], 'https://cdn.test/m.mpd', { maxOutputItems: 1 });
    expect(noAddressing.representations).toHaveLength(1);
    expect(noAddressing.representations[0].segmentListId).toBeUndefined();
    expect(noAddressing.segmentLists).toEqual([]);
    expect(noAddressing.truncated).toBe(true);
  });

});
