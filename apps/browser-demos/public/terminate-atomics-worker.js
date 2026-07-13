// Worker for terminate-atomics-test.html. Commits a chunk of shared memory,
// then either sits idle in its event loop or BLOCKS in Atomics.wait on a
// SharedArrayBuffer — mimicking a Kandelo daemon parked on the syscall channel.
// The point: can Worker.terminate() actually kill (and free) a worker that is
// blocked in Atomics.wait on WebKit?
const WASM_PAGE = 64 * 1024;
self.onmessage = (e) => {
  const { committedMiB, block, waitSab } = e.data;
  // Commit real memory in a shared WebAssembly.Memory (like a process worker).
  const pages = Math.max(1, Math.round((committedMiB * 1024 * 1024) / WASM_PAGE));
  const mem = new WebAssembly.Memory({ initial: pages, maximum: 16384, shared: true });
  const view = new Int32Array(mem.buffer);
  const stride = WASM_PAGE / 4;
  for (let i = 0; i < pages * stride; i += stride) view[i] = i;
  // Keep a strong ref so it isn't collected while the worker lives.
  self.__mem = mem;
  self.postMessage({ ready: true });
  if (block) {
    // Park forever in Atomics.wait on the shared control buffer — exactly the
    // state a blocked syscall / accept() leaves a Kandelo process worker in.
    const ctrl = new Int32Array(waitSab);
    Atomics.wait(ctrl, 0, 0); // blocks until value at index 0 changes (never)
  }
  // else: return to the event loop and sit idle.
};
