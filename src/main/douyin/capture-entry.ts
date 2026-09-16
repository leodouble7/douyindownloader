import { app } from 'electron';
import { captureSession } from './capture-session';
import type { CaptureInput, CaptureResult } from './capture-page';

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// The CLI child owns its process lifetime until capture cleanup and result delivery finish.
app.on('window-all-closed', () => undefined);
const controller = new AbortController();
let started = false;
process.once('disconnect', () => { controller.abort(); app.quit(); });
process.on('message', (message: CaptureInput & { cancel?: boolean }) => {
  if (message.cancel) controller.abort();
  else if (message.pageUrl && !started) { started = true; void run(message); }
});
process.send?.({ ready: true });
async function run(input: CaptureInput): Promise<void> {
  let payload: { result: CaptureResult } | { error: string };
  try { payload = { result: await captureSession(input, controller.signal) }; }
  catch (error) { payload = { error: error instanceof Error ? error.message : '页面捕获失败' }; }
  if (process.connected) process.send?.(payload, () => app.exit('error' in payload ? 1 : 0));
  else app.exit(1);
}
