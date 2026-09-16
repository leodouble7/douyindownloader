const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 build host required');
const result = spawnSync(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild', '--arch=x64', '--directory', join(__dirname, '../native/windows-media-runner')], { stdio: 'inherit', shell: false });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
