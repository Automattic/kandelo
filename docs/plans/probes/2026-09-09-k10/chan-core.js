// K10 probe 2 — does a wasm `memory.atomic.wait32` inside the side module
// block and wake on the SAME channel status word that the kernel worker drives
// with `Atomics.notify`, and vice versa?
//
// This must run in an agent that is allowed to block, so the waiter always
// runs in a dedicated worker — which is also where the real shim runs
// (the process worker).
//
// Layout inside the shared memory, all relative to `base`:
//   base+0    the channel status word (CH_STATUS)
//   base+128  a word for the "expected value does not match" case
//   base+256  a word a JS `Atomics.wait` waiter sleeps on, woken by wasm
//
// CHANNEL_STATUS_IDLE = 0, PENDING = 1, COMPLETE = 2 (generated/abi.ts:892).

export const CH_PENDING = 1;
export const CH_COMPLETE = 2;

export const WAIT_OK = 0;        // woken by a notify
export const WAIT_NOT_EQUAL = 1; // word already moved
export const WAIT_TIMED_OUT = 2;

/** Runs in the WAITER worker. `post` sends a message back to the driver. */
export async function runWaiter({ memory, bytes, base, post }) {
  const inst = new WebAssembly.Instance(await WebAssembly.compile(bytes), {
    env: { memory },
  });
  const i32 = new Int32Array(memory.buffer);
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  post({ phase: "ready", canBlock: true });

  // --- A: the full protocol. The module publishes CH_PENDING, notifies, then
  // re-waits until the word moves -- the exact shape of wasi-shim.ts:527-531.
  try {
    post({ phase: "A-start" });
    const t0 = now();
    const packed = inst.exports.chan_call(base, 3_000_000_000n);
    post({
      phase: "A-done",
      waitResult: packed & 0xffff,
      reSleeps: packed >>> 16,
      ms: Math.round(now() - t0),
      statusAfter: Atomics.load(i32, base / 4),
    });
  } catch (e) {
    post({ phase: "A-done", error: String((e && e.stack) || e) });
  }

  // --- B: control. Waiting for a value the word does not hold must return
  // NOT_EQUAL immediately rather than blocking.
  try {
    const t0 = now();
    const r = inst.exports.bare_wait(base + 128, 0xdead, 1_000_000_000n);
    post({ phase: "B-done", waitResult: r, ms: Math.round(now() - t0) });
  } catch (e) {
    post({ phase: "B-done", error: String((e && e.stack) || e) });
  }

  // --- C: reverse direction. A JS `Atomics.wait` waiter woken by the
  // module's `memory.atomic.notify`.
  try {
    post({ phase: "C-start" });
    const t0 = now();
    const r = Atomics.wait(i32, (base + 256) / 4, 0, 3000);
    post({
      phase: "C-done",
      waitResult: r,
      ms: Math.round(now() - t0),
      valueSeen: Atomics.load(i32, (base + 256) / 4),
    });
  } catch (e) {
    post({ phase: "C-done", error: String((e && e.stack) || e) });
  }

  post({ phase: "end" });
}

/**
 * Runs in the DRIVER (the stand-in for the kernel worker). Returns the
 * collected result once the waiter reports "end".
 *
 * `spawn(onMessage)` must start the waiter and deliver its messages.
 */
export async function driveProbe({ memory, bytes, base, spawn, sleep }) {
  const i32 = new Int32Array(memory.buffer);
  const results = {};
  const driver = new WebAssembly.Instance(await WebAssembly.compile(bytes), {
    env: { memory },
  });

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("probe 2 timed out waiting for the waiter")),
      15000,
    );
    const onMessage = async (msg) => {
      try {
        switch (msg.phase) {
          case "ready":
            results.waiterReady = true;
            break;
          case "A-start":
            // Give the waiter time to actually enter the wait, then do exactly
            // what the kernel worker does on completion.
            await sleep(200);
            Atomics.store(i32, base / 4, CH_COMPLETE);
            results.A_notified = Atomics.notify(i32, base / 4, 1);
            break;
          case "A-done":
            results.A = msg;
            break;
          case "B-done":
            results.B = msg;
            break;
          case "C-start":
            await sleep(200);
            // wasm-side notify waking a JS-side Atomics.wait waiter.
            results.C_wasmNotifyWoke = driver.exports.store_and_notify(base + 256, 5);
            break;
          case "C-done":
            results.C = msg;
            break;
          case "end":
            clearTimeout(timer);
            resolve(results);
            break;
        }
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    };
    spawn(onMessage);
  });
}
