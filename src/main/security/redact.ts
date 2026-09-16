import { createSanitizedMediaUrl, type SanitizedMediaUrl } from '../../shared/contracts';

export const REDACTED_VALUE = '[REDACTED]';
const SENSITIVE_NAME = /token|signature|^sig$|policy|credential|key|session|authorization|cookie/i;
const HTTP_URL_SUBSTRING = /https?:\/\/[^\s<>"'`;]+/gi;
const AUTHORIZATION_FRAGMENT = /(\bauthorization\s*:\s*)[^\r\n]*/gi;
const COOKIE_FRAGMENT = /(\bcookie\s*:\s*)[^\r\n]*/gi;

export function redactUrl(url: string): string {
  const parsed = new URL(url);

  parsed.username = '';
  parsed.password = '';
  for (const name of new Set(parsed.searchParams.keys())) {
    if (SENSITIVE_NAME.test(name)) {
      parsed.searchParams.set(name, REDACTED_VALUE);
    }
  }

  return parsed.toString();
}

export function createSanitizedCapturedUrl(url: string): SanitizedMediaUrl {
  return createSanitizedMediaUrl(redactUrl(url));
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, SENSITIVE_NAME.test(name)
      ? REDACTED_VALUE
      : /^(location|content-location|referer)$/i.test(name) ? redactUrlReference(value) : redactText(value)])
  );
}

/** URL-valued headers can contain relative references. Preserve their reference form
 * while applying the same query/credential rules as absolute observed URLs. */
function redactUrlReference(value: string): string {
  const reference = value.trim().replace(/[\t\r\n]/g, '');
  try {
    if (/^[a-z][a-z\d+.-]*:/i.test(reference)) return redactUrl(reference);
    const parsed = new URL(redactUrl(new URL(reference, 'https://redaction.invalid/').toString()));
    if (/^[\\/]{2}/.test(reference)) return `//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
    const path = reference.split(/[?#]/, 1)[0];
    return redactText(`${path}${parsed.search}${parsed.hash}`);
  } catch {
    return REDACTED_VALUE;
  }
}

/** Returns a redacted HTTP(S) URL when the value is a URL, otherwise preserves the value. */
export function redactUrlValue(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? redactUrl(value) : value;
  } catch {
    return value;
  }
}

/** Redacts URL and credential fragments embedded in otherwise useful diagnostic prose. */
export function redactText(value: string): string {
  return value
    .replace(HTTP_URL_SUBSTRING, (url) => {
      const trailing = trailingPunctuation(url);
      const candidate = trailing.length === 0 ? url : url.slice(0, -trailing.length);
      return `${redactUrlValue(candidate)}${trailing}`;
    })
    .replace(AUTHORIZATION_FRAGMENT, (_match, prefix: string) => `${prefix}${REDACTED_VALUE}`)
    .replace(COOKIE_FRAGMENT, (_match, prefix: string) => `${prefix}${REDACTED_VALUE}`);
}

/** Redacts event payloads before they can cross into SQLite or renderer IPC. */
export function redactEvidence(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactEvidenceValue(name, item)]));
}

function redactEvidenceValue(name: string, value: unknown): unknown {
  if (SENSITIVE_NAME.test(name)) {
    return REDACTED_VALUE;
  }
  if (/headers?/i.test(name) && isStringRecord(value)) {
    return redactHeaders(value);
  }
  if (/url/i.test(name) && typeof value === 'string') {
    try {
      return redactUrl(value);
    } catch {
      return REDACTED_VALUE;
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactEvidenceValue(name, item));
  }
  if (isRecord(value)) {
    return redactEvidence(value);
  }
  return typeof value === 'string' ? redactText(value) : value;
}

function trailingPunctuation(value: string): string {
  const match = value.match(/[.!?)]*$/);
  return match?.[0] ?? '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}
