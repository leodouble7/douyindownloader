import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ApiErrorCode, ApiResult, PreviewBounds, StartRunInput, StartDownloadInput, ExportReportInput, WorkbenchSnapshot, RunHistoryItem } from '../shared/contracts';
import { cancelRunInputSchema, chooseOutputDirectoryInputSchema, emptyInputSchema, exportReportInputSchema, previewBoundsSchema, setPreviewInputSchema, startDownloadInputSchema, startRunInputSchema } from '../shared/schemas';
export { projectEvent } from './ui-projection';
export class CommandError extends Error { constructor(readonly code: ApiErrorCode) { super(code); } }
const messages: Record<ApiErrorCode, string> = { INVALID_INPUT: '输入不符合要求，请检查字段后重试。', FORBIDDEN: '此窗口无权执行该操作。', BUSY: '当前操作仍在执行，请等待或取消。', NOT_FOUND: '运行不存在或已不可用。', OUTPUT_NOT_AUTHORIZED: '输出目录已变化，请重新选择目录。', REPORT_UNAVAILABLE: '报告信任验证不可用；请查看已保存的脱敏证据。', OPERATION_FAILED: '操作未完成，现有证据已保留，不能据此判定防护有效。' };
export interface DirectoryGrant { path: string; handle: FileHandle; ancestors: { path: string; dev: number; ino: number }[] }
export async function authorizeDirectory(selected: string): Promise<DirectoryGrant> {
  const path = await realpath(selected); const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try { const ancestors = []; for (let p = path;; p = dirname(p)) { const s = await lstat(p); if (!s.isDirectory() || s.isSymbolicLink()) throw new CommandError('OUTPUT_NOT_AUTHORIZED'); ancestors.push({ path: p, dev: s.dev, ino: s.ino }); if (dirname(p) === p) break; } const h = await handle.stat(); if (h.dev !== ancestors[0].dev || h.ino !== ancestors[0].ino) throw new CommandError('OUTPUT_NOT_AUTHORIZED'); return { path, handle, ancestors }; }
  catch (e) { await handle.close(); throw e; }
}
export async function assertAuthorizedDirectory(grant: DirectoryGrant, requested: string): Promise<string> {
  if (!isAbsolute(requested) || resolve(requested) !== grant.path || requested !== grant.path) throw new CommandError('OUTPUT_NOT_AUTHORIZED');
  for (const a of grant.ancestors) { const s = await lstat(a.path); if (!s.isDirectory() || s.isSymbolicLink() || s.dev !== a.dev || s.ino !== a.ino) throw new CommandError('OUTPUT_NOT_AUTHORIZED'); }
  const held = await grant.handle.stat(); if (held.dev !== grant.ancestors[0].dev || held.ino !== grant.ancestors[0].ino || await realpath(grant.path) !== grant.path) throw new CommandError('OUTPUT_NOT_AUTHORIZED'); return grant.path;
}
export async function assertOutputPath(grant: DirectoryGrant, file: string): Promise<void> {
  await assertAuthorizedDirectory(grant, grant.path); const rel = relative(grant.path, file); if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new CommandError('OUTPUT_NOT_AUTHORIZED');
  for (let p = file; p !== grant.path; p = dirname(p)) { const s = await lstat(p); if (s.isSymbolicLink() || (p !== file && !s.isDirectory())) throw new CommandError('OUTPUT_NOT_AUTHORIZED'); }
  if (await realpath(file) !== file) throw new CommandError('OUTPUT_NOT_AUTHORIZED');
}
/** The aperture sits below the fixed product header and leaves space for controls on all edges. */
export function validatePreviewBounds(value: unknown, area: { width: number; height: number }): PreviewBounds {
  const b = previewBoundsSchema.parse(value);
  if (b.x < 12 || b.y < 160 || b.width > Math.min(640, area.width - 24) || b.height > 420 || b.x + b.width > area.width - 12 || b.y + b.height > area.height - 12) throw new CommandError('INVALID_INPUT'); return b;
}
export interface WorkbenchCommands {
  start(input: StartRunInput): Promise<{ runId: string }>;
  cancel(runId: string): Promise<void>;
  finishObservation(runId: string): Promise<void>;
  finish(runId: string): Promise<void>;
  get(runId: string): Promise<WorkbenchSnapshot>;
  history(): RunHistoryItem[];
  preview(runId: string, bounds: PreviewBounds | null): void;
  download(input: StartDownloadInput): Promise<{ downloadId: string }>;
  export(input: ExportReportInput): Promise<{ path: string; content: string }>;
}
interface RouterOptions { ownerId: number; mainFrame: unknown; chooseDirectory(): Promise<string | null>; service: WorkbenchCommands; ownsRun(runId: string): boolean; contentSize(): { width: number; height: number } }
const schemas = { 'choose-output-directory': chooseOutputDirectoryInputSchema, 'start-run': startRunInputSchema, 'cancel-run': cancelRunInputSchema, 'finish-observation': cancelRunInputSchema, 'finish-run': cancelRunInputSchema, 'get-run': cancelRunInputSchema, 'list-history': emptyInputSchema, 'set-preview': setPreviewInputSchema, 'start-download': startDownloadInputSchema, 'export-report': exportReportInputSchema };
export const commandNames = Object.keys(schemas);
export class IpcRouter {
  constructor(private readonly options: RouterOptions) {}
  async invoke(sender: { senderId: number; frame: unknown }, command: string, payload: unknown): Promise<ApiResult<unknown>> {
    try {
      if (sender.senderId !== this.options.ownerId || sender.frame !== this.options.mainFrame) throw new CommandError('FORBIDDEN');
      const schema = schemas[command as keyof typeof schemas]; if (!schema) throw new CommandError('INVALID_INPUT'); const parsed = schema.safeParse(payload); if (!parsed.success) throw new CommandError('INVALID_INPUT');
      const input = parsed.data; if (input && 'runId' in input && !this.options.ownsRun(input.runId)) throw new CommandError('FORBIDDEN');
      let value: unknown;
      switch (command) {
        case 'choose-output-directory': value = await this.options.chooseDirectory(); break;
        case 'start-run': value = await this.options.service.start(input as StartRunInput); break;
        case 'list-history': value = this.options.service.history(); break;
        case 'cancel-run': value = await this.options.service.cancel((input as { runId: string }).runId); break;
        case 'finish-observation': value = await this.options.service.finishObservation((input as { runId: string }).runId); break;
        case 'finish-run': value = await this.options.service.finish((input as { runId: string }).runId); break;
        case 'get-run': value = await this.options.service.get((input as { runId: string }).runId); break;
        case 'start-download': value = await this.options.service.download(input as StartDownloadInput); break;
        case 'export-report': value = await this.options.service.export(input as ExportReportInput); break;
        case 'set-preview': { const p = input as { runId: string; bounds: PreviewBounds | null }; value = this.options.service.preview(p.runId, p.bounds ? validatePreviewBounds(p.bounds, this.options.contentSize()) : null); break; }
      }
      return { ok: true, value };
    } catch (error) { const code = error instanceof CommandError ? error.code : 'OPERATION_FAILED'; return { ok: false, error: { code, message: messages[code] } }; }
  }
}
