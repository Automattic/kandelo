/**
 * Wayland desktop liveness gate: PAGE_FLIPs keep flowing at the
 * animation rate across drag-paint strokes.
 *
 * The other wl* smokes assert one-shot markers (STROKE, MOVE_GRAB), which
 * all still pass while the desktop is visibly frozen — they never notice
 * that compositing stopped. This test watches the kernel's KMS commit
 * counter (stats SAB slot 5) and demands a healthy flip rate, which is
 * exactly the signal that caught two real freezes:
 *
 *  1. Blocking-poll timeout starvation (kernel-worker.ts,
 *     blockingWaitDeadlines): the EAGAIN retry loop recomputed the
 *     poll/ppoll deadline on every 10 ms wake, so wlclock's
 *     `poll(fds, 1, 40)` self-pacing NEVER timed out on an otherwise
 *     idle desktop — the clock froze at ~0.5 fps instead of 10.
 *  2. munmap length-rounding leak (crates/kernel/src/memory.rs): the
 *     compositor maps/unmaps its 1920*1080*4-byte scanout bo every
 *     frame; the byte-exact (unrounded) munmap stranded a sub-page tail
 *     remnant that fragmented the gap, leaking ~8.3MB of address space
 *     per frame until gbm_bo_map hit ENOMEM at ~124 flips and the
 *     desktop froze for good.
 *
 * Pointer input uses the browser bridge's exact EV_REL peg(-4096)+jump
 * emulation (kernel-host.ts sendPointerAbs) rather than EV_ABS, so this
 * also exercises the injection pattern real browser users hit.
 *
 * Skips if the binaries aren't built (bare checkout).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const compositorBin = tryResolveBinary("programs/wlcompositor.wasm");
const clockBin = tryResolveBinary("programs/wlclock.wasm");
const paintBin = tryResolveBinary("programs/wlpaint.wasm");
const hasBinaries = !!compositorBin && !!clockBin && !!paintBin;

const CANVAS_W = 1920;
const CANVAS_H = 1080;

// linux/input-event-codes.h
const EV_SYN = 0x00;
const EV_KEY = 0x01;
const EV_REL = 0x02;
const SYN_REPORT = 0x00;
const REL_X = 0x00;
const REL_Y = 0x01;
const BTN_LEFT = 0x110;
const PEG = 4096;

// wlpaint at its placement slot; canvas below CSD bar (28) + toolbar (36).
const PAINT_X = 1080;
const PAINT_Y = 560;

// wlclock redraws every 100 ms → ~20 flips per 2 s window when healthy.
// The starved failure mode produced 0–2. Threshold 5 keeps headroom for
// slow CI without ever passing a starved desktop.
const WINDOW_MS = 2_000;
const MIN_FLIPS_PER_WINDOW = 5;

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function waitFor(
  ref: { value: string },
  pattern: string | RegExp,
  timeoutMs: number,
  context: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (typeof pattern === "string"
      ? ref.value.includes(pattern)
      : pattern.test(ref.value)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${String(pattern)}.\n${context()}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("wayland desktop liveness — flips keep flowing across drag strokes", () => {
  it.skipIf(!hasBinaries)(
    "PAGE_FLIP commits advance at animation rate before, during, and after drag-paints",
    async () => {
      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
      });
      const dump = () =>
        `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;

      // Browser sendPointerAbs emulation: peg to (0,0), then one jump.
      const moveAbs = (x: number, y: number) => {
        host.injectInputEvent(1, EV_REL, REL_X, -PEG);
        host.injectInputEvent(1, EV_REL, REL_Y, -PEG);
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(1, EV_REL, REL_X, Math.round(x));
        host.injectInputEvent(1, EV_REL, REL_Y, Math.round(y));
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
      };
      // >25 ms between button edges so libinput debounce forwards them.
      const DEBOUNCE_SETTLE_MS = 40;
      const button = async (state: 0 | 1) => {
        host.injectInputEvent(1, EV_KEY, BTN_LEFT, state);
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
        await sleep(DEBOUNCE_SETTLE_MS);
      };

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        const statsSab = new SharedArrayBuffer(7 * 4);
        const stats = new Int32Array(statsSab);
        host.kmsAttachStats(1, statsSab);
        const commits = () => Atomics.load(stats, 5);

        host.spawn(loadBytes(compositorBin!), ["wlcompositor"], {});
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);
        host.spawn(loadBytes(clockBin!), ["wlclock"], {});
        await waitFor(out, "WLCLOCK_READY", 20_000, dump);
        host.spawn(loadBytes(paintBin!), ["wlpaint"], {});
        await waitFor(out, "WLPAINT_READY", 20_000, dump);

        // Idle baseline: wlclock alone must drive a healthy flip rate.
        const c0 = commits();
        await sleep(WINDOW_MS);
        const c1 = commits();
        expect(
          c1 - c0,
          `idle desktop under-flipping (wlclock starved?).\n${dump()}`,
        ).toBeGreaterThanOrEqual(MIN_FLIPS_PER_WINDOW);

        // Repeated drag-paint strokes; the desktop must stay live after
        // each one. Four attempts kept the pre-fix failure reproduction
        // rate at 100% while staying CI-cheap.
        for (let attempt = 1; attempt <= 4; attempt++) {
          const x0 = PAINT_X + 70;
          const y0 = PAINT_Y + 100 + (attempt % 4) * 40;
          moveAbs(x0, y0);
          await button(1);
          await waitFor(out, /WLPAINT_STROKE x=\d+ y=\d+/, 10_000, dump);
          for (let i = 1; i <= 25; i++) {
            moveAbs(x0 + i * 14, y0 + i * 8);
            await sleep(8);
          }
          await button(0);

          const f0 = commits();
          await sleep(WINDOW_MS);
          const f1 = commits();
          expect(
            f1 - f0,
            `flips stalled after drag ${attempt} (frozen desktop).\n${dump()}`,
          ).toBeGreaterThanOrEqual(MIN_FLIPS_PER_WINDOW);
        }
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    120_000,
  );
});
