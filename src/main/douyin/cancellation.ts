export function installCancellation(controller: AbortController): void {
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());
  process.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'cancel') controller.abort();
  });
  // A parent cancellation channel must not keep a completed CLI alive.
  process.channel?.unref();
}
