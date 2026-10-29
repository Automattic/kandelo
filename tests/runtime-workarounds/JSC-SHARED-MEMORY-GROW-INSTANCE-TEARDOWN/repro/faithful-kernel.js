// The kernel worker. Owns every process memory, creates each process and each
// pthread as a nested Worker, grows process memory from JavaScript in async
// message handlers (thread slots, brk/mmap), and terminates exited threads
// as soon as they report quiescence. Workers and memories are never reused.
const WASM_PAGE = 65536;
const PAGES_PER_THREAD = 4;
const MAXIMUM = 16384;   // desktop processMaxPages (1 GiB)
const INITIAL = 256;     // 16 MiB
let config;
const stats = { processes: 0, threadsStarted: 0, threadsTerminated: 0, jsGrows: 0, wasmGrows: 0 };

const growToCover = (memory, endBytes) => {
  const delta = Math.ceil(endBytes / WASM_PAGE) - memory.buffer.byteLength / WASM_PAGE;
  if (delta <= 0) return true;
  try { memory.grow(delta); stats.jsGrows++; return true; } catch { return false; }
};

async function runProcess() {
  stats.processes++;
  const memory = new WebAssembly.Memory({ initial: INITIAL, maximum: MAXIMUM, shared: true });
  if (config.pregrow) memory.grow(MAXIMUM - INITIAL);
  // Thread slots below the top, reused through a free list like
  // ThreadPageAllocator; a new slot grows memory to cover it.
  const freeSlots = [];
  let nextSlotPage = INITIAL;
  const live = new Set();
  const idle = [];
  let exited = false;
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  const proc = new Worker('faithful-process.js', { type: 'module' });

  const exit = () => {
    if (exited) return;
    exited = true;
    proc.terminate();
    for (const t of [...live, ...idle]) { t.worker.terminate(); stats.threadsTerminated++; }
    live.clear();
    done();
  };

  const startThread = async () => {
    if (exited) return;
    let slot = freeSlots.pop();
    if (slot === undefined) {
      slot = nextSlotPage;
      nextSlotPage += PAGES_PER_THREAD;
      if (!config.pregrow && !growToCover(memory, (slot + PAGES_PER_THREAD) * WASM_PAGE)) { exit(); return; }
    }
    const worker = new Worker('faithful-thread.js', { type: 'module' });
    const thread = { worker, slot };
    live.add(thread);
    stats.threadsStarted++;
    worker.onmessage = async ({ data }) => {
      if (data.type !== 'memory_quiescent' || exited) return;
      live.delete(thread);
      if (config.idleThreads) idle.push(thread);
      else { worker.terminate(); stats.threadsTerminated++; }
      freeSlots.push(slot);
      await null;
      startThread();
    };
    worker.postMessage({ memory, slotOffset: slot * WASM_PAGE, retain: config.retain });
  };

  proc.onmessage = async ({ data }) => {
    if (exited) return;
    if (data.type === 'exit') { exit(); return; }
    if (data.type === 'wasm_grow') { stats.wasmGrows++; return; }
    if (data.type === 'brk') {
      await null;
      if (memory.buffer.byteLength / WASM_PAGE + data.pages > MAXIMUM) { exit(); return; }
      growToCover(memory, memory.buffer.byteLength + data.pages * WASM_PAGE);
    }
  };
  proc.postMessage({ memory, wasmGrows: !config.pregrow });
  for (let i = 0; i < config.threads; i++) startThread();
  // A pre-grown process never fills, so end it after a bounded lifetime.
  const lifetime = setTimeout(exit, config.processMs);
  await finished;
  clearTimeout(lifetime);
}

onmessage = async ({ data }) => {
  config = data;
  const deadline = performance.now() + config.seconds * 1000;
  const report = setInterval(() => postMessage({ type: 'stats', stats }), 500);
  while (performance.now() < deadline) await runProcess();
  clearInterval(report);
  postMessage({ type: 'done', stats });
};
