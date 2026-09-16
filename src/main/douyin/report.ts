import { redactText, redactUrl } from '../security/redact';
import type { CaptureResult } from './capture-page';

export function sanitizeCaptureReport<T extends { pageUrl: string; summary: CaptureResult['summary'] }>(report: T): T {
  return { ...report, pageUrl: redactUrl(report.pageUrl), summary: { ...report.summary,
    title: redactText(report.summary.title), excerpt: redactText(report.summary.excerpt) } };
}
