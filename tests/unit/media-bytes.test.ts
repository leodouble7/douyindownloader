import { describe, expect, it } from 'vitest';
import { recognizableMedia } from '../../src/main/probes/media-bytes';
describe('bounded structural media signatures', () => {
  it('requires a complete EBML header with version and media document type', () => {
    const webm = Buffer.from('1a45dfa38b428681014282847765626d', 'hex');
    expect(recognizableMedia(webm)).toBe(true);
    expect(recognizableMedia(webm.subarray(0, -1))).toBe(false);
    const bad = Buffer.from(webm); bad[8] = 2;
    expect(recognizableMedia(bad)).toBe(false);
  });
  it('requires three sync-aligned MPEG-TS packets with valid headers and continuity', () => {
    const ts = Buffer.alloc(188 * 3, 0xff);
    for (let i = 0; i < 3; i++) { ts[i * 188] = 0x47; ts[i * 188 + 1] = 0; ts[i * 188 + 2] = 32; ts[i * 188 + 3] = 0x10 + i; }
    expect(recognizableMedia(ts)).toBe(true);
    expect(recognizableMedia(ts.subarray(0, 188))).toBe(false);
    ts[188 + 3] = 0x15; expect(recognizableMedia(ts)).toBe(false);
  });
  it('does not recognize random error prefixes or malformed MP4 boxes', () => {
    for (const b of [Buffer.from('Gateway unavailable'), Buffer.from('OggS'), Buffer.from('ID3'), Buffer.from('<html>failure'), Buffer.from('{"error":true}'), Buffer.alloc(4096, 0x47), Buffer.from('000000086674797069736f6d00000200', 'hex')]) expect(recognizableMedia(b)).toBe(false);
  });
});
