const { mkdirSync, copyFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const destination = join(__dirname, '../out/main');
mkdirSync(destination, { recursive: true });
for (const file of ['electron-output-bootstrap.cjs', 'output-worker.cjs', 'windows-output.cjs', 'output-names.cjs']) copyFileSync(join(__dirname, '../src/main/download', file), join(destination, file));
if (process.platform === 'win32') {
  const binary = join(__dirname, '../native/windows-output/build/Release/windows_output.node');
  if (!existsSync(binary)) throw new Error('Run npm run build:windows-output before building Windows');
  copyFileSync(binary, join(destination, 'windows-output.node'));
  const mediaRunner = join(__dirname, '../native/windows-media-runner/build/Release/media_job_runner.exe');
  if (!existsSync(mediaRunner)) throw new Error('Run npm run build:windows-media-runner before building Windows');
  copyFileSync(mediaRunner, join(destination, 'media-job-runner.exe'));
}
