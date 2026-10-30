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
    if (clockId === 1 || clockId === 7) {
      // CLOCK_MONOTONIC / CLOCK_BOOTTIME
      return { sec: Number(ns / 1000000000n), nsec: Number(ns % 1000000000n) };
    }
    // CLOCK_REALTIME — use hrtime + epoch offset for nanosecond resolution
    const realNs = ns + this._epochOffsetNs;
    return { sec: Number(realNs / 1000000000n), nsec: Number(realNs % 1000000000n) };
  }
}

export class BrowserTimeProvider implements TimeProvider {
  clockGettime(clockId: number): { sec: number; nsec: number } {
    const ms = performance.now();
    if (clockId === 1 || clockId === 2 || clockId === 3 || clockId === 7) {
      // CLOCK_MONOTONIC / CPU-time clocks / CLOCK_BOOTTIME
      return { sec: Math.floor(ms / 1000), nsec: Math.floor((ms % 1000) * 1_000_000) };
    }
    // CLOCK_REALTIME: the same high-resolution timer plus the wall-clock
    // time it started at, as NodeTimeProvider does with hrtime. Date.now()
    // counts whole milliseconds, so two readings a few microseconds apart
    // were equal while CLOCK_MONOTONIC had already moved.
    const wallMs = performance.timeOrigin + ms;
    const sec = Math.floor(wallMs / 1000);
    return { sec, nsec: Math.min(999_999_999, Math.floor((wallMs - sec * 1000) * 1_000_000)) };
  }
}
