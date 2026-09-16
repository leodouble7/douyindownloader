import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { startLabServer } from '../../lab/server';

it('observes real Electron page, frame, Worker, ServiceWorker, network and MSE in a sandboxed WebContentsView', async () => {
  const lab = await startLabServer();
  const directory = await mkdtemp(join(tmpdir(), 'msl-browser-capture-'));
  try {
    const entry = join(directory, 'capture.cjs');
    const output = join(directory, 'result.json');
    await build({ entryPoints: [resolve('tests/helpers/electron-capture-runner.ts')], outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
    const executable = createRequire(import.meta.url)('electron') as string;
    const result = await new Promise<{ code: number | null; logs: string }>((resolveResult, reject) => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(executable, [entry, lab.baseUrl, output], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let logs = '';
      child.stdout.on('data', (chunk: Buffer) => { logs += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { logs += chunk.toString(); });
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Electron integration timed out: ${logs}`)); }, 30000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code) => { clearTimeout(timeout); resolveResult({ code, logs }); });
    });
    expect(result.code, result.logs).toBe(0);
    const data = JSON.parse(await readFile(output, 'utf8'));
    expect(data.error, result.logs).toBeUndefined();
    expect(data.summary, result.logs).toMatchObject({ externallyClosed: true, hls: true, partitionIsolated: true, sharedWorker: true, realPageIdentity: true, page: true, iframe: true, worker: true, serviceWorker: true, blob: true, sourceBuffers: 2, appends: true, direct: true, dash: true, isolated: true, closed: true });
    expect(data.events.some((event: { action: string }) => event.action === 'navigation:after')).toBe(true);
    expect(data.events.some((event: { action: string }) => event.action === 'browser-close:after')).toBe(true);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
}, 40000);
