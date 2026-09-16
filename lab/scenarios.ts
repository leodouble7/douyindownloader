import { signMediaRequest, signaturesMatch, type MediaSignatureInput } from '../src/main/security/signature';

export type LabScenario =
  | 'open-range'
  | 'referer-only'
  | 'signed-url'
  | 'session-bound'
  | 'range-capped'
  | 'segment-token'
  | 'encrypted-placeholder';

export const LAB_SCENARIOS: readonly LabScenario[] = [
  'open-range', 'referer-only', 'signed-url', 'session-bound', 'range-capped', 'segment-token', 'encrypted-placeholder'
];

/** This secret belongs only to the local lab and must never cross product event/report boundaries. */
export const LAB_SECRET = 'local-lab-secret';
export const LAB_SESSION_ID = 'lab-session';
export const RANGE_CAP_BYTES = 1_024;
export const SEGMENT_WINDOW_END = 1;

const EXPECTED_PROTECTION: Record<LabScenario, string> = {
  'open-range': 'Public content; arbitrary byte ranges are accepted.',
  'referer-only': 'A matching Referer is required, which is a weak browser-visible control.',
  'signed-url': 'An unexpired HMAC signature is required for the requested resource.',
  'session-bound': 'An unexpired HMAC signature and the matching local session are required.',
  'range-capped': 'Responses are limited to 1024 bytes per request; repeated requests remain possible.',
  'segment-token': 'Each HLS segment needs a separate signed token inside the small prefetch window.',
  'encrypted-placeholder': 'Encrypted placeholder media is classified for refusal; no key or decryption route exists.'
};

export function isLabScenario(value: string | null): value is LabScenario {
  return value !== null && (LAB_SCENARIOS as readonly string[]).includes(value);
}

export function expectedProtection(scenario: LabScenario): string {
  return EXPECTED_PROTECTION[scenario];
}

export function hasValidSignature(input: MediaSignatureInput, supplied: string | null): boolean {
  return signaturesMatch(supplied, signMediaRequest(input, LAB_SECRET));
}

export function segmentIndex(segmentId: string): number | undefined {
  if (!/^\d+$/.test(segmentId)) {
    return undefined;
  }
  return Number(segmentId);
}
