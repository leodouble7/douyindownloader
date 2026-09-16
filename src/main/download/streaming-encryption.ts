import { TextEncryptionClassifier } from './text-encryption';
/** Incremental structural classifier. Copies are transaction snapshots at committed range boundaries. */
export class StreamingEncryptionClassifier {
  encrypted = false;
  private format: 'unknown' | 'mp4' | 'webm' | 'text' | 'other' = 'unknown';
  private pending: Buffer = Buffer.alloc(0);
  private position = 0;
  private skip = 0;
  private ends: number[] = [];
  private text = new TextEncryptionClassifier();
  copy(): StreamingEncryptionClassifier {
    const next = new StreamingEncryptionClassifier();
    next.encrypted = this.encrypted; next.format = this.format; next.pending = Buffer.from(this.pending);
    next.position = this.position; next.skip = this.skip; next.ends = [...this.ends]; next.text = this.text.copy();
    return next;
  }
  push(bytes: Buffer): void {
    if (this.encrypted || this.format === 'other') return;
    this.pending = Buffer.concat([this.pending, bytes]);
    if (this.format === 'unknown') {
      if (this.pending.length < 8) return;
      const prefix = this.pending.subarray(0, 64).toString('utf8');
      if (/^[\s\ufeff#<l]/.test(prefix)) this.format = 'text';
      else if (this.pending.readUInt32BE(0) === 0x1a45dfa3) this.format = 'webm';
      else if (/^(ftyp|styp|moov|moof|free|skip)$/.test(this.pending.toString('ascii', 4, 8))) this.format = 'mp4';
      else { this.format = 'other'; this.pending = Buffer.alloc(0); return; }
    }
    if (this.format === 'text') {
      this.text.push(this.pending); this.pending = Buffer.alloc(0);
      this.encrypted = this.text.encrypted;
      return;
    }
    while (this.pending.length && !this.encrypted) {
      if (this.skip > 0) { const consumed = Math.min(this.skip, this.pending.length); this.consume(consumed); this.skip -= consumed; continue; }
      while (this.ends.length && this.position >= this.ends[this.ends.length - 1]) this.ends.pop();
      const progressed = this.format === 'mp4' ? this.mp4() : this.webm();
      if (!progressed) break;
    }
  }
  finish(): void {
    if (this.format === 'unknown' && /^[\s\ufeff#<l]/.test(this.pending.toString('utf8'))) {
      this.format = 'text'; this.text.push(this.pending); this.pending = Buffer.alloc(0);
    }
    if (this.format === 'text') { this.text.finish(); this.encrypted = this.text.encrypted; }
  }
  private consume(count: number): void { this.pending = Buffer.from(this.pending.subarray(count)); this.position += count; }
  private mp4(): boolean {
    if (this.pending.length < 8) return false;
    const type = this.pending.toString('ascii', 4, 8);
    let length = this.pending.readUInt32BE(0), header = 8;
    if (length === 1) {
      if (this.pending.length < 16) return false;
      const large = this.pending.readBigUInt64BE(8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invalid-media-structure');
      length = Number(large); header = 16;
    }
    const end = length === 0 ? this.ends.at(-1) ?? Infinity : this.position + length;
    if ((length !== 0 && length < header) || end > (this.ends.at(-1) ?? Infinity)) throw new Error('invalid-media-structure');
    if (['pssh', 'senc', 'tenc', 'sinf', 'encv', 'enca'].includes(type)) { this.encrypted = true; return true; }
    if (type === 'uuid') {
      if (this.pending.length < header + 16) return false;
      const uuid = this.pending.subarray(header, header + 16).toString('hex');
      if (['8974dbce7be74c5184f97148f9882554', 'a2394f525a9b4f14a2446c427c648df4'].includes(uuid)) { this.encrypted = true; return true; }
    }
    this.consume(header);
    const containers = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts', 'dinf', 'schi'];
    const prefix = type === 'stsd' ? 8 : type === 'avc1' || type === 'hvc1' || type === 'hev1' ? 78 : type === 'mp4a' ? 28 : undefined;
    if (containers.includes(type) || prefix !== undefined) { this.ends.push(end); this.skip = prefix ?? 0; }
    else this.skip = end - this.position;
    return true;
  }
  private webm(): boolean {
    const id = vint(this.pending, 0, true);
    if (!id) return false;
    const size = vint(this.pending, id.length, false);
    if (!size) return false;
    if (id.value === 0x5035 || id.value === 0x47e2) { this.encrypted = true; return true; }
    const header = id.length + size.length;
    const end = size.value === Infinity ? this.ends.at(-1) ?? Infinity : this.position + header + size.value;
    if (end > (this.ends.at(-1) ?? Infinity)) throw new Error('invalid-media-structure');
    this.consume(header);
    if ([0x1a45dfa3, 0x18538067, 0x1654ae6b, 0xae, 0x6d80, 0x6240].includes(id.value)) this.ends.push(end);
    else this.skip = end - this.position;
    return true;
  }
}
function vint(buffer: Buffer, offset: number, retainMarker: boolean): { length: number; value: number } | undefined {
  if (offset >= buffer.length) return undefined;
  let length = 1, marker = 0x80;
  while (length <= 8 && !(buffer[offset] & marker)) { length++; marker >>= 1; }
  if (length > (retainMarker ? 4 : 8)) throw new Error('invalid-media-structure');
  if (buffer.length - offset < length) return undefined;
  let value = BigInt(retainMarker ? buffer[offset] : buffer[offset] & (marker - 1));
  for (let index = 1; index < length; index++) value = (value << 8n) | BigInt(buffer[offset + index]);
  if (!retainMarker && value === (1n << BigInt(7 * length)) - 1n) return { length, value: Infinity };
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invalid-media-structure');
  return { length, value: Number(value) };
}
