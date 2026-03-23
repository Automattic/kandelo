import type { TimeProvider } from "./types";

export class NodeTimeProvider implements TimeProvider {
  // Offset from hrtime (monotonic) to epoch, computed once at startup.
  private readonly _epochOffsetNs: bigint;
  // hrtime at provider creation, used as process start for CPUTIME clocks.
  private readonly _startNs: bigint;

  constructor() {
    // hrtime.bigint() is monotonic from process start.
    // Compute the offset to convert it to wall-clock (epoch) time.
    const hrt = process.hrtime.bigint();
    const wallNs = BigInt(Date.now()) * 1_000_000n;
    this._epochOffsetNs = wallNs - hrt;
    this._startNs = hrt;
  }

  clockGettime(clockId: number): { sec: number; nsec: number } {
    const ns = process.hrtime.bigint();
    if (clockId === 2 || clockId === 3) {
      // CLOCK_PROCESS_CPUTIME_ID / CLOCK_THREAD_CPUTIME_ID
      // Return time since process start (in Wasm, CPU ≈ elapsed)
      const elapsed = ns - this._startNs;
      return { sec: Number(elapsed / 1000000000n), nsec: Number(elapsed % 1000000000n) };
    }
    if (clockId === 1) {
      // CLOCK_MONOTONIC
      return { sec: Number(ns / 1000000000n), nsec: Number(ns % 1000000000n) };
    }
    // CLOCK_REALTIME — use hrtime + epoch offset for nanosecond resolution
    const realNs = ns + this._epochOffsetNs;
    return { sec: Number(realNs / 1000000000n), nsec: Number(realNs % 1000000000n) };
  }

  nanosleep(sec: number, nsec: number): void {
    const ms = sec * 1000 + Math.floor(nsec / 1_000_000);
    if (ms > 0) {
      const sab = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sab), 0, 0, ms);
    }
  }
}

export class BrowserTimeProvider implements TimeProvider {
  clockGettime(clockId: number): { sec: number; nsec: number } {
    if (clockId === 1 || clockId === 2 || clockId === 3) {
      // CLOCK_MONOTONIC / CLOCK_PROCESS_CPUTIME_ID / CLOCK_THREAD_CPUTIME_ID
      const ms = performance.now();
      return { sec: Math.floor(ms / 1000), nsec: Math.floor((ms % 1000) * 1_000_000) };
    }
    // CLOCK_REALTIME
    const now = Date.now();
    return { sec: Math.floor(now / 1000), nsec: (now % 1000) * 1_000_000 };
  }

  nanosleep(sec: number, nsec: number): void {
    const ms = sec * 1000 + Math.floor(nsec / 1_000_000);
    if (ms > 0) {
      const sab = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sab), 0, 0, ms);
    }
  }
}
