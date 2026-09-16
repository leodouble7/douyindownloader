import { createHmac, timingSafeEqual } from 'node:crypto';

export interface MediaSignatureInput {
  mediaId: string;
  expires: number | string;
  sessionId?: string;
  segmentId?: string;
}

/** Signs only local lab request inputs; callers must not persist the resulting token. */
export function signMediaRequest(input: MediaSignatureInput, secret: string): string {
  const payload = [input.mediaId, input.expires, input.sessionId ?? '', input.segmentId ?? ''].join('|');
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function signaturesMatch(provided: string | null, expected: string): boolean {
  if (provided === null || !/^[a-f0-9]{64}$/i.test(provided)) {
    return false;
  }

  const actual = Buffer.from(provided, 'hex');
  const wanted = Buffer.from(expected, 'hex');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
