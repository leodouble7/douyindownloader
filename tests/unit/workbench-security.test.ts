import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePreviewBounds, projectEvent, authorizeDirectory, assertAuthorizedDirectory, IpcRouter } from '../../src/main/ipc';
describe('workbench trust boundaries', () => {
  it('rejects overflow, fractional and product-control-covering preview rectangles', () => {
    expect(validatePreviewBounds({ x: 24, y: 200, width: 300, height: 200 }, { width: 1280, height: 800 })).toEqual({ x: 24, y: 200, width: 300, height: 200 });
    for (const bounds of [{ x: 0, y: 0, width: 1280, height: 800 }, { x: -1, y: 200, width: 20, height: 20 }, { x: 24, y: 200, width: 1400, height: 200 }, { x: 24.5, y: 200, width: 300, height: 200 }]) expect(() => validatePreviewBounds(bounds, { width: 1280, height: 800 })).toThrow();
  });
  it('never sends internal source identities, raw URLs, headers or attacker prose through event projection', () => {
    const e = projectEvent({ id: 'e', runId: 'r', sequence: 1, timestamp: '2026-09-15T10:00:00Z', phase: 'capture', action: 'capture-network:after', purpose: 'https://x/?token=SECRET', status: 'succeeded', relatedIds: ['["run","target","session","frame","raw-request",1]'], evidence: { observation: { kind: 'network', requestId: 'raw-request', request: { sourceIdentity: { requestId: 'raw-request' }, sanitizedUrl: 'https://x/?token=SECRET', status: 206, mimeType: 'video/mp4', sanitizedResponseHeaders: { 'set-cookie': 'SECRET' } } } }, conclusion: '<img onerror=SECRET>' });
    expect(JSON.stringify(e)).not.toMatch(/SECRET|raw-request|sourceIdentity|https:\/\//); expect(JSON.stringify(e)).toContain('206');
  });
  it('pins the selected directory identity and rejects symlink and replacement ancestry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ipc-output-'));
    try { const selected = join(dir, 'root'); await mkdir(selected); const grant = await authorizeDirectory(selected); const root = grant.path; expect(await assertAuthorizedDirectory(grant, root)).toBe(root); await symlink(root, join(dir, 'alias')); await expect(assertAuthorizedDirectory(grant, join(dir, 'alias'))).rejects.toThrow(); await rm(root, { recursive: true }); await mkdir(root); await expect(assertAuthorizedDirectory(grant, root)).rejects.toThrow(); await grant.handle.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('strictly validates commands and prevents unowned or subframe IPC without leaking exceptions', async () => {
    const router = new IpcRouter({ ownerId: 10, mainFrame: 'main', chooseDirectory: async () => { throw new Error('PRIVATE STACK SECRET'); } } as never);
    expect(await router.invoke({ senderId: 20, frame: 'main' }, 'choose-output-directory', undefined)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await router.invoke({ senderId: 10, frame: 'subframe' }, 'choose-output-directory', undefined)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await router.invoke({ senderId: 10, frame: 'main' }, 'choose-output-directory', { extra: 1 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const result = await router.invoke({ senderId: 10, frame: 'main' }, 'choose-output-directory', undefined); expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } }); expect(JSON.stringify(result)).not.toContain('SECRET');
  });
});
