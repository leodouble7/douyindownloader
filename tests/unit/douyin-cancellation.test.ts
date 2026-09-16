import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fork } from 'node:child_process';
import { buildSync } from 'esbuild';
const posixIt = it.skipIf(process.platform === 'win32');
posixIt.each(['SIGINT', 'SIGTERM'] as const)('finishes async cleanup when %s is delivered twice by terminal and wrapper', async signal => {
  await checkCleanup(child => { child.kill(signal); return setTimeout(() => child.kill(signal), 30); });
});
it('finishes async cleanup after repeated parent IPC cancellation', async () => {
  await checkCleanup(child => { child.send({ type: 'cancel' }); return setTimeout(() => child.send({ type: 'cancel' }), 30); });
});
async function checkCleanup(cancel: (child: ReturnType<typeof fork>) => NodeJS.Timeout) {
  const directory = await mkdtemp(join(tmpdir(), 'douyin-cancellation-'));
  const path = join(directory, 'child.cjs');
  buildSync({ stdin: { contents: `import { installCancellation } from ${JSON.stringify(resolve('src/main/douyin/cancellation.ts'))};
    const c = new AbortController(); installCancellation(c);
    c.signal.addEventListener('abort', () => setTimeout(() => { process.stdout.write('cleaned'); process.exit(0); }, 100));
    setInterval(() => {}, 1000); process.send({ready:true});`, resolveDir: process.cwd() }, outfile: path, bundle: true, platform: 'node', format: 'cjs' });
  const child = fork(path, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  child.stdout!.on('data', chunk => { output += String(chunk); });
  let timer: NodeJS.Timeout | undefined;
  try {
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    await new Promise<void>(resolve => child.once('message', () => resolve()));
    timer = cancel(child);
    expect(await exited).toBe(0);
    expect(output).toBe('cleaned');
  } finally { clearTimeout(timer); child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); }
}
