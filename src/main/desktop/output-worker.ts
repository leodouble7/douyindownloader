import { utilityProcess } from 'electron';
import type { OutputWorkerLauncher } from '../download/output-workspace';

/** Electron's Node utility process preserves the cwd-anchored actor and structured byte messages. */
export const electronOutputWorkerLauncher: OutputWorkerLauncher = options => {
  const child = utilityProcess.fork(options.modulePath, [], { cwd: options.cwd, stdio: 'ignore', serviceName: '媒体文件写入' });
  let exited = false;
  const exit = new Promise<void>(resolve => { child.once('exit', () => { exited = true; resolve(); }); });
  return {
    send: message => { if (exited) throw new Error('output-worker-unavailable'); child.postMessage(message); },
    onMessage: callback => { child.on('message', callback); },
    onExit: callback => { child.once('exit', callback); },
    terminate: () => { if (!exited) child.kill(); },
    whenExited: () => exit
  };
};
