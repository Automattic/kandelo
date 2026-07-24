// Worker for wasm-memory-reclaim-test.html.
//
// Allocates a large shared WebAssembly.Memory, grows it to a requested
// committed size, and touches every page so the pages are actually
// committed (not just reserved). Then, depending on the requested
// variant, either keeps the memory worker-local, ships it back to the
// main thread, or shares it onward to a nested sub-worker.
//
// This same script serves both the top-level worker and the nested
// sub-worker (role selected by the `role` field of the alloc message).

const WASM_PAGE = 64 * 1024; // 64 KiB
const MAX_PAGES = 16384; // 1 GiB — matches Kandelo's kernel/process memory maximum

/** Commit `committedPages` worth of a fresh shared WebAssembly.Memory. */
function makeCommittedSharedMemory(committedPages) {
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: MAX_PAGES,
    shared: true,
  });
  if (committedPages > 1) {
    memory.grow(committedPages - 1);
  }
  // Touch one i32 per page so the OS actually backs the pages with
  // physical memory. A pure grow() on a reserved region may not commit.
  const view = new Int32Array(memory.buffer);
  const stride = WASM_PAGE / 4;
  for (let i = 0; i < view.length; i += stride) {
    view[i] = i;
  }
  return memory;
}

// Keep the sub-worker's shared-memory reference alive for the lifetime of
// the nested worker so it is a genuine co-owner of the backing store.
let heldSharedMemory = null;
let nested = null;

self.onmessage = (e) => {
  const msg = e.data;

  // Nested sub-worker role: hold + touch the memory shared from the parent
  // worker, then acknowledge. This makes the sub-worker a real co-owner.
  if (msg.cmd === "alloc" && msg.role === "nested") {
    try {
      heldSharedMemory = msg.sharedMemory;
      const view = new Int32Array(heldSharedMemory.buffer);
      const stride = WASM_PAGE / 4;
      for (let i = 0; i < view.length; i += stride) {
        view[i] = view[i] + 1;
      }
    } catch (err) {
      self.postMessage({ cmd: "error", error: String(err && err.message || err) });
      return;
    }
    self.postMessage({ cmd: "done" });
    return;
  }

  if (msg.cmd === "alloc") {
    let memory;
    try {
      memory = makeCommittedSharedMemory(msg.committedPages);
    } catch (err) {
      self.postMessage({ cmd: "error", error: String(err && err.message || err) });
      return;
    }

    if (msg.variant === "worker-shared" && msg.role !== "nested") {
      // Share the memory onward to a nested sub-worker, then report done
      // once the sub-worker has also touched it. Neither this worker nor
      // the main thread will be a long-lived holder after teardown — only
      // the two (ephemeral) workers reference the backing store.
      heldSharedMemory = memory; // parent stays a co-owner too
      nested = new Worker("./wasm-memory-reclaim-worker.js", { type: "classic" });
      nested.onmessage = (ne) => {
        if (ne.data && ne.data.cmd === "done") {
          self.postMessage({ cmd: "done" });
        }
      };
      nested.postMessage({
        cmd: "alloc",
        variant: "worker-shared",
        role: "nested",
        committedPages: 1, // nested just needs to hold + touch the shared mem
        sharedMemory: memory,
      });
      return;
    }

    if (msg.variant === "main-held") {
      // Ship the memory back so the (persistent) main thread becomes a
      // co-owner. This is the leak shape we expect NOT to reclaim.
      self.postMessage({ cmd: "done", memory });
      return;
    }

    // worker-exclusive, or the nested role of worker-shared: keep the
    // reference worker-local and just acknowledge.
    self.postMessage({ cmd: "done" });
    return;
  }
};
