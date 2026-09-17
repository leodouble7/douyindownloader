import type { DownloadArchiveMetadata } from '../../shared/desktop';

export function validArchiveMetadata(value: unknown): value is DownloadArchiveMetadata {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.workId === 'string' && /^\d{1,40}$/.test(item.workId)
    && typeof item.author === 'string' && item.author.length <= 4000
    && typeof item.title === 'string' && item.title.length <= 4000;
}

/** Leave room for extensions and collision suffixes on UTF-8 and Windows filesystems. */
export function archiveName(metadata?: DownloadArchiveMetadata): string | undefined {
  if (!validArchiveMetadata(metadata)) return undefined;
  return `${clean(metadata.author, '未知作者', 60)}_${clean(metadata.title, '未命名作品', 96)}_${metadata.workId}`;
}

function clean(value: string, fallback: string, maxBytes: number): string {
  let text = value.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '').trim();
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(text)) text = `_${text}`;
  let bounded = '';
  for (const character of text) {
    if (Buffer.byteLength(bounded + character) > maxBytes) break;
    bounded += character;
  }
  return bounded.replace(/[. ]+$/g, '') || fallback;
}
