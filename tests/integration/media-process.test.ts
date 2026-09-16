import { afterEach, expect, it } from 'vitest';
import { open, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMediaProcess } from '../../src/main/media/media-process';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'media-process-')); cleanup.push(() => rm(path, { recursive: true, force: true })); return path; }
const signal = () => new AbortController().signal;
async function waitForFile(path: string) { for (let i = 0; i < 300; i++) { try { return await readFile(path, 'utf8'); } catch { await new Promise(r => setTimeout(r, 10)); } } throw new Error('fixture did not start'); }
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

it('streams large binary stdout to the owned handle despite temp-leaf substitution, with bounded writes', async () => {
  const directoryPath = await directory(); const path = join(directoryPath, 'private.tmp'); const victim = join(directoryPath, 'victim'); await writeFile(victim, 'untouched');
  const handle = await open(path, 'wx+', 0o600); cleanup.push(() => handle.close());
  unlinkSync(path); linkSync(victim, path);
  let largest = 0; let concurrent = 0; let maximumConcurrent = 0; let bytes = 0;
  const original = handle.write.bind(handle);
  handle.write = (async (data: Buffer, offset: number, length: number, position: number) => {
    largest = Math.max(largest, length); maximumConcurrent = Math.max(maximumConcurrent, ++concurrent);
    await new Promise(r => setTimeout(r, 1)); const result = await original(data, offset, Math.min(length, 8192), position);
    bytes += result.bytesWritten; concurrent--; return result;
  }) as typeof handle.write;
  await runMediaProcess({ executable: process.execPath, args: ['-e', `const block=Buffer.alloc(65536,171); let i=0; function write(){while(i++<64)if(!process.stdout.write(block)){process.stdout.once('drain',write);return;}}write(); process.stderr.write('out_time_us=6000000\\nprogress=end\\n');`], signal: signal(), mode: 'remux', output: handle, timeoutMs: 5000, killGraceMs: 100, onProgress: () => undefined });
  expect(bytes).toBe(4 * 1024 * 1024); expect(largest).toBeLessThanOrEqual(65536); expect(maximumConcurrent).toBe(1);
  expect((await handle.stat()).size).toBe(bytes); const first = Buffer.alloc(1); await handle.read(first, 0, 1, 0); expect(first[0]).toBe(171);
  expect(await readFile(victim, 'utf8')).toBe('untouched');
});

it.each(['timeout', 'cancel'] as const)('bounds %s when the leader exits and a descendant retains both output pipes', async action => {
  const root = await directory(); const pidFile = join(root, 'pid'); const outputPath = join(root, 'out.tmp'); const output = await open(outputPath, 'wx+'); cleanup.push(() => output.close());
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({pid:process.pid,parent:process.ppid})); process.on('SIGTERM',()=>{}); process.send('ready'); setInterval(()=>{},1000);`;
  const leader = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2,'ipc']}); child.on('message',()=>process.exit(0));`;
  const controller = new AbortController(); const start = Date.now();
  const pending = runMediaProcess({ executable: process.execPath, args: ['-e', leader], signal: controller.signal, mode: 'remux', output, timeoutMs: 2000, killGraceMs: 100 }).then(() => 'succeeded', error => error.code as string);
  const pid = JSON.parse(await waitForFile(pidFile)) as { pid: number; parent: number };
  cleanup.push(async () => { if (alive(pid.pid)) process.kill(pid.pid, 'SIGKILL'); });
  for (let i = 0; i < 100 && alive(pid.parent); i++) await new Promise(r => setTimeout(r, 10));
  expect(alive(pid.parent)).toBe(false);
  if (action === 'cancel') controller.abort();
  const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('unbounded'), 4000))]);
  expect(result).toBe(action === 'cancel' ? 'cancelled' : 'tool-timeout'); expect(Date.now() - start).toBeLessThan(4500);
  for (let i = 0; i < 100 && alive(pid.pid); i++) await new Promise(r => setTimeout(r, 10));
  expect(alive(pid.pid)).toBe(false);
  await output.close(); await rm(outputPath); expect(await readdir(root)).toEqual(['pid']);
});

it('reports spawn failure once and settles without waiting for timeout', async () => {
  const start = Date.now();
  await expect(runMediaProcess({ executable: join(await directory(), 'missing'), args: [], signal: signal(), mode: 'probe', timeoutMs: 5000, killGraceMs: 100 })).rejects.toMatchObject({ code: process.platform === 'win32' ? 'tool-exit-failed' : 'tool-spawn-failed', outcome: 'inconclusive' });
  expect(Date.now() - start).toBeLessThan(2000);
});
it.each([
  'stream_index=0|pts_time=NaN|duration_time=0.03\n',
  'stream_index=4|pts_time=0|duration_time=0.03\n',
  'stream_index=0|pts_time=0|duration_time=0\n',
  'stream_index=0|pts_time=999999999|duration_time=0.03\n'
])('rejects invalid streamed packet timing %s', async record => {
  await expect(runMediaProcess({ executable: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(record)})`], signal: signal(), mode: 'timing', timeoutMs: 3000, killGraceMs: 100 })).rejects.toMatchObject({ code: 'invalid-packet-timing' });
});
it('bounds an unterminated packet-timing record', async () => {
  await expect(runMediaProcess({ executable: process.execPath, args: ['-e', `process.stdout.write('stream_index=0|'+'9'.repeat(4096));setInterval(()=>{},1000)`], signal: signal(), mode: 'timing', timeoutMs: 3000, killGraceMs: 100 })).rejects.toMatchObject({ code: 'tool-output-limit' });
});
it('aggregates packet timing without buffering all packets', async () => {
  const records = 'stream_index=1|pts_time=-0.007|duration_time=0.02\nstream_index=0|pts_time=0|duration_time=0.033\nstream_index=0|pts_time=5.967|duration_time=0.033\nstream_index=1|pts_time=5.994|duration_time=0.02\n';
  const output = await runMediaProcess({ executable: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(records)})`], signal: signal(), mode: 'timing', timeoutMs: 3000, killGraceMs: 100 });
  const result = JSON.parse(output);
  expect(result['0']).toEqual({ first: 0, end: 6, packets: 2 }); expect(result['1']).toMatchObject({ first: -0.007, packets: 2 }); expect(result['1'].end).toBeCloseTo(6.014, 9);
});
