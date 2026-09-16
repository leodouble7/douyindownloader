export interface ByteRange { start: number; end: number }
/** Inclusive intervals; bounded allocation also rejects impractical materialized plans. */
export function createRangePlan(totalBytes: number, maxChunkBytes: number): ByteRange[] {
  if (![totalBytes, maxChunkBytes].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Range lengths must be positive safe integers');
  if (Math.ceil(totalBytes / maxChunkBytes) > 100000) throw new Error('Range plan exceeds interval limit');
  const ranges: ByteRange[] = [];
  for (let start = 0; start < totalBytes;) {
    const length = Math.min(maxChunkBytes, totalBytes - start);
    ranges.push({ start, end: start + length - 1 });
    start += length;
  }
  return ranges;
}
