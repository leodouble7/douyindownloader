import { expect, it } from 'vitest';
import { join } from 'node:path';
import { runMediaProcess, resolveWindowsMediaRunner } from '../../src/main/media/media-process';
const windowsIt = it.skipIf(process.platform !== 'win32');
const signal = () => new AbortController().signal;
windowsIt('starts a native child inside its Job before the child executes and forbids breakaway', async () => {
  const fixture = join(process.cwd(), 'native/windows-media-runner/build/Release/media_runner_fixture.exe');
  for (const mode of ['job-status', 'breakaway']) {
    const json = await runMediaProcess({ executable: fixture, args: [mode], signal: signal(), mode: 'probe', timeoutMs: 5000, killGraceMs: 100 });
    expect(JSON.parse(json)).toEqual(mode === 'job-status' ? { inJob: true } : { breakawayDenied: true });
  }
});
windowsIt('preserves Windows argument boundaries and stdio without invoking a shell', async () => {
  expect(resolveWindowsMediaRunner()).toMatch(/media[-_]job[-_]runner\.exe$/);
  const values = ['', 'a b', 'a"b', 'C:\\path with spaces\\', 'x\\\\"y', '&echo secret|whoami', '$([bad])', '中文 🎞'];
  const json = await runMediaProcess({ executable: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...values], signal: signal(), mode: 'probe', timeoutMs: 5000, killGraceMs: 100 });
  expect(JSON.parse(json)).toEqual(values);
});
