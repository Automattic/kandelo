/** Load the disposable device realm before starting its presentation protocol.
 * Module fetching can outlast the relay's acknowledgement deadline. No kernel
 * relay or transferred canvas is published until that code is listening. */
export function startKmsBitmapDisplay(
  worker: Worker,
  canvases: OffscreenCanvas[],
  isActive: () => boolean,
  attach: (port: MessagePort) => void,
  fail: (error: Error) => void,
  loadTimeoutMs = 30_000,
): { terminate(): void } {
  const channel = new MessageChannel();
  let closed = false;
  let attached = false;
  const timer = setTimeout(() => stop(new Error('KMS bitmap display module did not load')), loadTimeoutMs);
  function terminate(): void {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    channel.port1.close();
    channel.port2.close();
    worker.terminate();
  }
  function stop(error: Error): void { if (closed) return; terminate(); fail(error); }
  worker.onerror = event => stop(new Error(event.message || 'KMS bitmap display module failed'));
  worker.onmessageerror = () => stop(new Error('Invalid KMS bitmap display bootstrap message'));
  worker.onmessage = event => {
    if (closed) return;
    if (event.data?.type !== 'loaded' || attached) {
      stop(new Error('Invalid KMS bitmap display bootstrap acknowledgement'));
      return;
    }
    clearTimeout(timer);
    if (!isActive()) { terminate(); return; }
    attached = true;
    try {
      worker.postMessage({ canvases, port: channel.port1 }, [...canvases, channel.port1]);
      attach(channel.port2);
    } catch (error) { stop(new Error('KMS bitmap display attachment failed', { cause: error })); }
  };
  return { terminate };
}
