const { buildSync } = require('esbuild');
const { mkdirSync, copyFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const output = join(root, 'out/douyin');
mkdirSync(output, { recursive: true });
for (const [source, name] of [['cli.ts', 'cli.cjs'], ['capture-entry.ts', 'capture.cjs']]) {
  buildSync({ entryPoints: [join(root, 'src/main/douyin', source)], outfile: join(output, name), bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    define: { 'import.meta.url': '__moduleUrl' }, banner: { js: 'const __moduleUrl = require("node:url").pathToFileURL(__filename).href;' } });
}
for (const name of ['output-worker.cjs', 'output-names.cjs', 'windows-output.cjs']) copyFileSync(join(root, 'src/main/download', name), join(output, name));
if (process.platform === 'win32') {
  for (const [source, name] of [
    ['native/windows-output/build/Release/windows_output.node', 'windows_output.node'],
    ['native/windows-media-runner/build/Release/media_job_runner.exe', 'media-job-runner.exe']
  ]) {
    if (!existsSync(join(root, source))) throw new Error('请先执行 npm run build:windows-output 和 npm run build:windows-media-runner');
    copyFileSync(join(root, source), join(output, name));
  }
}
