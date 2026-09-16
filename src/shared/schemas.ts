import { z } from 'zod';

const httpUrlSchema = z.string().trim().min(1, 'A target URL is required').superRefine((value, context) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'Target URL must be a valid HTTP(S) URL' });
    return;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    context.addIssue({ code: 'custom', message: 'Target URL must use HTTP or HTTPS' });
  }
  if (parsed.username || parsed.password) {
    context.addIssue({ code: 'custom', message: 'Target URL must not contain credentials' });
  }
});

const nonEmptyPathSchema = z.string().trim().min(1, 'An output directory is required');
const idSchema = z.string().trim().min(1, 'An identifier is required');

export const startRunInputSchema = z.object({
  targetUrl: httpUrlSchema,
  outputDirectory: nonEmptyPathSchema,
  mode: z.enum(['observe', 'standard', 'full-download']),
  maxConcurrency: z.number().int().min(1).max(4).default(4),
  authorizationConfirmed: z.literal(true, {
    error: 'You must confirm that you own or are authorized to test this target'
  })
}).strict();

export const cancelRunInputSchema = z.object({
  runId: idSchema
}).strict();

export const chooseOutputDirectoryInputSchema = z.undefined();

export const startDownloadInputSchema = z.object({
  runId: idSchema,
  trackIds: z.array(idSchema).min(1, 'Select at least one track to download')
}).strict();

export const exportReportInputSchema = z.object({
  runId: idSchema,
  format: z.enum(['json', 'markdown']),
  outputDirectory: nonEmptyPathSchema
}).strict();

export type StartRunInputSchema = z.infer<typeof startRunInputSchema>;
export type CancelRunInputSchema = z.infer<typeof cancelRunInputSchema>;
export type StartDownloadInputSchema = z.infer<typeof startDownloadInputSchema>;
export type ExportReportInputSchema = z.infer<typeof exportReportInputSchema>;

export const previewBoundsSchema = z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() }).strict();
export const setPreviewInputSchema = z.object({ runId: idSchema, bounds: previewBoundsSchema.nullable() }).strict();
export const emptyInputSchema = z.undefined();
