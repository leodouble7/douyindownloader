const { spawn } = require('node:child_process');
const { join } = require('node:path');
require('./build-douyin.cjs');
const child = spawn(process.execPath, [join(__dirname, '../out/douyin/cli.cjs'), ...process.argv.slice(2)], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
const cancel = () => { if (child.connected) child.send({ type: 'cancel' }, () => undefined); };
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
child.once('error', () => { process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 130 : 1); });
