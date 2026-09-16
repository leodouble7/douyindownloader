/** Conservative structural recognition of bounded media prefixes, not playback verification. */
export function recognizableMedia(bytes: Buffer): boolean {
  return mp4(bytes) || transportStream(bytes) || ebml(bytes) || ogg(bytes) || adts(bytes);
}
function mp4(b: Buffer): boolean {
  if (b.length < 16) return false;
  const size = b.readUInt32BE(0), type = b.toString('ascii', 4, 8);
  if (size < 16 || size > b.length) return false;
  if (type === 'ftyp' || type === 'styp') {
    if (size < 20 || (size - 16) % 4 !== 0) return false;
    const brand = (offset: number) => /^(isom|iso[2-9]|mp4[12]|avc1|dash|cmf[acsv]|msdh|msix|M4[AVB ]|qt  )$/.test(b.toString('ascii', offset, offset + 4));
    return brand(8) && Array.from({ length: (size - 16) / 4 }, (_, i) => 16 + i * 4).some(brand);
  }
  if (type !== 'moof') return false;
  // A fragment must contain a complete, plausible mfhd child and a traf container.
  let offset = 8, header = false, track = false;
  while (offset + 8 <= size) {
    const length = b.readUInt32BE(offset), child = b.toString('ascii', offset + 4, offset + 8);
    if (length < 8 || offset + length > size) return false;
    if (child === 'mfhd') header = length === 16 && b.readUInt32BE(offset + 8) === 0;
    if (child === 'traf') track = length >= 24;
    offset += length;
  }
  return offset === size && header && track;
}
function transportStream(b: Buffer): boolean {
  if (b.length < 188 * 3) return false;
  const last = new Map<number, number>();
  for (let offset = 0; offset + 188 <= b.length; offset += 188) {
    if (b[offset] !== 0x47 || (b[offset + 1] & 0x80) !== 0) return false;
    const control = (b[offset + 3] >> 4) & 3, pid = ((b[offset + 1] & 31) << 8) | b[offset + 2];
    if (!control || (b[offset + 3] & 0xc0) !== 0) return false;
    if ((control & 2) && b[offset + 4] > (control === 2 ? 183 : 182)) return false;
    const counter = b[offset + 3] & 15;
    if (pid !== 8191 && (control & 1) && last.has(pid) && counter !== ((last.get(pid)! + 1) & 15)) return false;
    if (control & 1) last.set(pid, counter);
  }
  return true;
}
function vint(b: Buffer, offset: number, keepMarker = false): { value: number; length: number } | undefined {
  if (offset >= b.length || b[offset] === 0) return undefined;
  let length = 1, mask = 128;
  while (!(b[offset] & mask)) { length++; mask >>= 1; }
  if (length > 4 || offset + length > b.length) return undefined;
  let value = keepMarker ? b[offset] : b[offset] & (mask - 1);
  for (let i = 1; i < length; i++) value = value * 256 + b[offset + i];
  return { value, length };
}
function ebml(b: Buffer): boolean {
  if (b.length < 8 || b.readUInt32BE(0) !== 0x1a45dfa3) return false;
  const size = vint(b, 4); if (!size || size.value < 8) return false;
  const end = 4 + size.length + size.value; if (end > b.length) return false;
  let offset = 4 + size.length, docType = false, version = false;
  while (offset < end) {
    const id = vint(b, offset, true); if (!id) return false; offset += id.length;
    const length = vint(b, offset); if (!length) return false; offset += length.length;
    if (offset + length.value > end) return false;
    if (id.value === 0x4282) docType = /^(webm|matroska)$/.test(b.toString('ascii', offset, offset + length.value));
    if (id.value === 0x4286) version = length.value === 1 && b[offset] === 1;
    offset += length.value;
  }
  return docType && version && offset === end;
}
function ogg(b: Buffer): boolean {
  if (b.length < 28 || b.toString('ascii', 0, 4) !== 'OggS' || b[4] !== 0 || (b[5] & 0xf8) !== 0 || b[26] === 0) return false;
  const count = b[26], start = 27 + count; if (start > b.length) return false;
  let payload = 0; for (let i = 27; i < start; i++) payload += b[i];
  if (payload < 19 || start + payload > b.length) return false;
  return b.toString('ascii', start, start + 8) === 'OpusHead' && b[start + 8] === 1 && b[start + 9] > 0;
}
function adts(b: Buffer): boolean {
  let offset = 0, frames = 0;
  while (offset + 7 <= b.length) {
    if (b[offset] !== 0xff || (b[offset + 1] & 0xf6) !== 0xf0 || ((b[offset + 2] >> 2) & 15) > 12) return false;
    const length = ((b[offset + 3] & 3) << 11) | (b[offset + 4] << 3) | (b[offset + 5] >> 5);
    if (length < 7 || offset + length > b.length) break;
    frames++; offset += length;
  }
  return frames >= 2;
}
