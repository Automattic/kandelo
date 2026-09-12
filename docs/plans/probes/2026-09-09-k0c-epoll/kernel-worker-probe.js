// Run the same probe inside a dedicated Worker, and hand the kernel's
// SharedArrayBuffer to a SECOND worker that concurrently reads it — the
// production topology (kernel worker + process workers sharing memory),
// which is what the "shared Wasm memory" claim was about.
import { runEpollProbe } from './epoll-core.js';
self.onmessage = async (e) => {
  try {
    const bytes = new Uint8Array(await (await fetch('./kernel.wasm')).arrayBuffer());
    const r = await runEpollProbe(bytes, (mem) => {
      const peer = new Worker('./peer-worker.js');
      peer.postMessage(mem.buffer);   // share it, as process workers do
      return peer;
    });
    self.postMessage({ ok: true, ...r });
  } catch (err) {
    self.postMessage({ ok: false, fatal: String(err && err.stack || err) });
  }
};
