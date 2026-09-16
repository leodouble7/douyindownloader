import { expect, it } from 'vitest';
import { StreamingEncryptionClassifier } from '../../src/main/download/streaming-encryption';
const box = (type: string, bytes = Buffer.alloc(0)) => { const header = Buffer.alloc(8); header.writeUInt32BE(bytes.length + 8); header.write(type, 4); return Buffer.concat([header, bytes]); };
const ftyp = box('ftyp', Buffer.from('isom0000isom'));
it('detects a structural MP4 protection box with single-byte chunks and across range snapshots', () => {
  const bytes = Buffer.concat([ftyp, box('free', Buffer.alloc(5000)), box('moov', box('pssh', Buffer.alloc(24)))]);
  let detector = new StreamingEncryptionClassifier();
  for (let i = 0; i < bytes.length; i++) {
    if (i === bytes.length - 27) detector = detector.copy();
    detector.push(bytes.subarray(i, i + 1));
  }
  expect(detector.encrypted).toBe(true);
});
it('does not label an innocent MP4 payload substring as encryption', () => {
  const detector = new StreamingEncryptionClassifier();
  detector.push(Buffer.concat([ftyp, box('mdat', Buffer.from('innocent pssh cenc encv enca data'))]));
  expect(detector.encrypted).toBe(false);
});
it('restores the prior detector state when a network range is retried', () => {
  const initial = new StreamingEncryptionClassifier(); initial.push(ftyp);
  const failedAttempt = initial.copy(); failedAttempt.push(box('pssh', Buffer.alloc(24)));
  expect(failedAttempt.encrypted).toBe(true);
  const retry = initial.copy(); retry.push(box('mdat', Buffer.from('normal')));
  expect(retry.encrypted).toBe(false);
});
it.each([
  Buffer.from('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n'),
  Buffer.from('<MPD><Period><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/></Period></MPD>'),
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67, 0xff, 0x16, 0x54, 0xae, 0x6b, 0xff, 0xae, 0xff, 0x6d, 0x80, 0xff, 0x62, 0x40, 0xff, 0x50, 0x35, 0x80])
])('detects structural playlist/WebM protection across one-byte chunks', bytes => {
  const detector = new StreamingEncryptionClassifier();
  for (const byte of bytes) detector.push(Buffer.from([byte]));
  expect(detector.encrypted).toBe(true);
});
it('does not misclassify METHOD=NONE arriving one byte at a time', () => {
  const detector = new StreamingEncryptionClassifier();
  for (const byte of Buffer.from('#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n')) detector.push(Buffer.from([byte]));
  expect(detector.encrypted).toBe(false);
});
it('recognizes the exact deterministic lab placeholder across one-byte chunks', () => {
  const detector = new StreamingEncryptionClassifier();
  for (const byte of Buffer.from('local-lab-encrypted-placeholder-v1')) detector.push(Buffer.from([byte]));
  expect(detector.encrypted).toBe(true);
});
it.each([
  '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="clé,key"\n' + 'x'.repeat(40000),
  '<MPD><ContentProtection schemeIdUri="保护"/></MPD>' + ' '.repeat(40000)
])('processes protection at the head before compacting a large input', text => {
  const bytes = Buffer.from(text);
  for (const size of [bytes.length, 100, 1]) {
    let classifier = new StreamingEncryptionClassifier();
    for (let offset = 0; offset < bytes.length; offset += size) { classifier.push(bytes.subarray(offset, offset + size)); classifier = classifier.copy(); }
    expect(classifier.encrypted).toBe(true);
  }
});
it.each([
  '<MPD><!-- <ContentProtection/> --></MPD>',
  '<MPD><![CDATA[<ContentProtection/>]]></MPD>',
  '<?note <ContentProtection/>?><MPD/>',
  '<MPD text="literal <ContentProtection/> and 保护"/>',
  '<!DOCTYPE MPD [<!ENTITY note "<ContentProtection/>">]><MPD/>',
  '#EXTM3U\n#EXT-X-KEY:URI="note,METHOD=AES-128,other",METHOD=NONE\n',
  '#EXTM3U\n#EXT-X-DATERANGE:CLASS="METHOD=AES-128"\n',
  '<MPD><!-- ' + 'x'.repeat(40000) + '<ContentProtection/> --></MPD>'
])('ignores inert text, markup, and quoted HLS attribute content', text => {
  const bytes = Buffer.from(text);
  for (const size of [bytes.length, 100, 1]) {
    let classifier = new StreamingEncryptionClassifier();
    for (let offset = 0; offset < bytes.length; offset += size) { classifier.push(bytes.subarray(offset, offset + size)); classifier = classifier.copy(); }
    expect(classifier.encrypted).toBe(false);
  }
});
it.each([
  '<MPD><!--无保护--><cenc:ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/></MPD>',
  '#EXTM3U\n#EXT-X-SESSION-KEY:URI="clé,a",METHOD=SAMPLE-AES-CTR\n'
])('recognizes a real declaration at every byte split and preserves UTF-8 snapshots', text => {
  const bytes = Buffer.from(text);
  for (let split = 0; split <= bytes.length; split++) {
    let classifier = new StreamingEncryptionClassifier(); classifier.push(bytes.subarray(0, split)); classifier = classifier.copy(); classifier.push(bytes.subarray(split));
    expect(classifier.encrypted).toBe(true);
  }
});
it('retains initial whitespace and BOM state and recognizes a final HLS METHOD without a newline', () => {
  for (const text of ['\ufeff#EXTM3U\n#EXT-X-KEY:METHOD=AES-128', ' '.repeat(1000) + '<MPD><ContentProtection/></MPD>']) {
    const detector = new StreamingEncryptionClassifier();
    for (const byte of Buffer.from(text)) detector.push(Buffer.from([byte]));
    detector.finish();
    expect(detector.encrypted).toBe(true);
  }
});
it('rolls back HLS attribute and UTF-8 state together when a range attempt is discarded', () => {
  const committed = new StreamingEncryptionClassifier(); committed.push(Buffer.from('#EXTM3U\n#EXT-X-KEY:URI="'));
  const attempt = committed.copy(); attempt.push(Buffer.from('clé",METHOD=AES-128\n')); expect(attempt.encrypted).toBe(true);
  const retry = committed.copy();
  for (const byte of Buffer.from('清晰",METHOD=NONE\n')) retry.push(Buffer.from([byte]));
  retry.finish(); expect(retry.encrypted).toBe(false);
});
it('ignores delimiters and fake protection markup inside a DTD comment', () => {
  const detector = new StreamingEncryptionClassifier();
  for (const byte of Buffer.from('<!DOCTYPE MPD [<!-- ]><ContentProtection/> -->]><MPD/>')) detector.push(Buffer.from([byte]));
  expect(detector.encrypted).toBe(false);
});
it.each([
  ['<!DOCTYPE MPD [<?note [ ?>]><MPD><ContentProtection/></MPD>', true],
  ['<!DOCTYPE MPD [<?note ]><ContentProtection/> ?>]><MPD/>', false],
  ['<!DOCTYPE MPD SYSTEM "external.dtd" [<?note [ ] < > <ContentProtection/> ?>]><MPD/>', false]
] as const)('keeps DTD processing instructions lexically inert across chunk boundaries', (text, encrypted) => {
  const bytes = Buffer.from(text);
  for (const size of [bytes.length, 1, 7, 31]) {
    let detector = new StreamingEncryptionClassifier();
    for (let offset = 0; offset < bytes.length; offset += size) { detector.push(bytes.subarray(offset, offset + size)); detector = detector.copy(); }
    detector.finish(); expect(detector.encrypted).toBe(encrypted);
  }
});
it.each(['é', '保护', 'e\u0301', '\u{10400}'])('detects exact protection local names with legal Unicode namespace prefix %s', prefix => {
  const bytes = Buffer.from(`<MPD xmlns:${prefix}="urn:mpeg:dash:schema:mpd:2011"><${prefix}:ContentProtection/></MPD>`);
  for (let split = 0; split <= bytes.length; split++) {
    let detector = new StreamingEncryptionClassifier(); detector.push(bytes.subarray(0, split)); detector = detector.copy(); detector.push(bytes.subarray(split)); detector.finish();
    expect(detector.encrypted).toBe(true);
  }
});
it.each([
  Buffer.from('<!DOCTYPE MPD [<?note [ ] >'),
  Buffer.from('<MPD><!-- unfinished'),
  Buffer.from('<MPD>'),
  Buffer.from('<MPD><é:'),
  Buffer.from('<MPD>' + '<x>'.repeat(65)),
  Buffer.from('<!DOCTYPE MPD [<?note ' + 'x'.repeat(65537) + ' ?>]><MPD/>'),
  Buffer.from('<MPD><\u0301:ContentProtection/></MPD>'),
  Buffer.concat([Buffer.from('<MPD '), Buffer.from([0xc0, 0xaf]), Buffer.from('="x"/>')]),
  Buffer.concat([Buffer.from('<MPD '), Buffer.from([0xe9])])
])('fails inconclusively for unfinished, oversized or invalid UTF-8 XML', bytes => {
  for (const size of [bytes.length, 1, 7]) {
    expect(() => { let detector = new StreamingEncryptionClassifier(); for (let offset = 0; offset < bytes.length; offset += size) { detector.push(bytes.subarray(offset, offset + size)); detector = detector.copy(); } detector.finish(); }).toThrow('invalid-media-structure');
  }
});
it.each(['contentProtection', 'ContentProtectiоn', 'ＣontentProtection'])('does not normalize or case-fold XML local name %s', name => {
  const detector = new StreamingEncryptionClassifier(); detector.push(Buffer.from(`<MPD><é:${name}/></MPD>`)); detector.finish(); expect(detector.encrypted).toBe(false);
});
