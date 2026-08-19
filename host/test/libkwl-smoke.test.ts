/**
 * PR7 Phase-2 gate: the libkwl toolkit (examples/libs/libkwl) drives a real
 * client window against the wlcompositor server — connect, map, composite,
 * and route input — through its create/draw/commit/dispatch API.
 *
 * Spawns TWO programs under one NodeKernelHost — the compositor
 * (programs/wlcompositor/wlcompositor.c) and a libkwl app
 * (programs/kwldemo.c) — talking over the AF_UNIX socket at /tmp/wayland-0,
 * the same harness as host/test/wlcompositor-smoke.test.ts. Where that test
 * uses a hand-written raw libwayland-client, this one exercises the toolkit:
 *
 *   - kwl_window_create() binds the globals, maps a 320x240 toplevel, and
 *     allocates its double-buffered wl_shm buffer over a gbm prime-fd;
 *   - the app clears the back buffer to a non-black bg, draws a button with
 *     libwpkdraw, and commits — the compositor imports + composites it, and
 *     its COMPOSITE_SAMPLE at (10,10) is the app's bg (asserted non-black);
 *   - a host-injected absolute pointer motion moves the cursor to a point
 *     inside the window, and a button press there is routed through libkwl
 *     to KWL_POINTER_BUTTON → ON_CLICK;
 *   - a host-injected key A is compiled through libkwl's xkb path to
 *     KWL_TEXT "a" → GOT_TEXT.
 *
 * Both processes exit 0. Skips if the binaries aren't built (bare checkout).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const compositorBin = tryResolveBinary("programs/wlcompositor.wasm");
const kwldemoBin = tryResolveBinary("programs/kwldemo.wasm");
const hasBinaries = !!compositorBin && !!kwldemoBin;

// The input canvas matches the compositor's card0 output (1920x1080) so an
// injected absolute pointer coordinate maps 1:1 to the compositor's cursor
// position (ABS_X.maximum = canvasW-1, scaled to g.width). We then move the
// cursor to a point inside the kwldemo window before pressing — the
// compositor's default cursor centre (960,540) is outside it. The v2
// compositor places an unmatched app_id at the first cascade slot
// (160,120), and libkwl adds a KWL_TITLEBAR_H (28px) CSD bar above the
// 320x240 content, so the content occupies (160,148)–(480,388) on the
// output.
const CANVAS_W = 1920;
const CANVAS_H = 1080;
// Output-space point mapping to content-local (160,152) — comfortably
// inside the kwldemo button rect (8,8)–(312,232).
const POINT_X = 320;
const POINT_Y = 300;

// linux/input-event-codes.h
const EV_SYN = 0x00;
const EV_KEY = 0x01;
const EV_ABS = 0x03;
const SYN_REPORT = 0x00;
const ABS_X = 0x00;
const ABS_Y = 0x01;
const KEY_A = 30;
const KEY_LEFTSHIFT = 42;
const BTN_LEFT = 0x110;

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function waitFor(
  ref: { value: string },
  needle: string,
  timeoutMs: number,
  context: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ref.value.includes(needle)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(needle)}.\n${context()}`);
}

describe("libkwl — toolkit window maps, composites, and routes input", () => {
  it.skipIf(!hasBinaries)(
    "kwldemo bg composites; injected button + key reach the app",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const kwldemoBytes = loadBytes(kwldemoBin!);

      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
      });

      const dump = () =>
        `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        // --- compositor (server) ---
        const compExit = host.spawn(compositorBytes, ["wlcompositor"], {});
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);

        // --- kwldemo (libkwl client) ---
        const demoExit = host.spawn(kwldemoBytes, ["kwldemo"], {});

        // The toolkit bound globals, mapped the toplevel, drew + committed a
        // frame, and the compositor presented it before printing KWLDEMO_READY.
        await waitFor(out, "KWLDEMO_READY", 20_000, dump);

        // The compositor imported the app's prime-fd and composited its bg;
        // the sampled pixel must be non-black (the app's WPK_RGB(30,30,40)).
        await waitFor(out, "COMPOSITE_SAMPLE", 5_000, dump);
        const sample = out.value.match(/COMPOSITE_SAMPLE x=\d+ y=\d+ px=0x([0-9a-f]{8})/);
        expect(sample, `no composite sample.\n${dump()}`).not.toBeNull();
        const px = parseInt(sample![1], 16);
        expect(px & 0xffffff, `composited pixel is black (0x${px.toString(16)})\n${dump()}`)
          .not.toBe(0);

        // Keyboard first — kwldemo's loop exits once it has seen both a
        // click and a text event, so all key assertions must precede the
        // click. Shifted key: the compositor must deliver
        // wl_keyboard.modifiers (its xkb state changed) before the key,
        // and libkwl's xkb state must apply it — 'a' arrives uppercase.
        host.injectInputEvent(0, EV_KEY, KEY_LEFTSHIFT, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, KEY_A, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        await waitFor(out, 'GOT_TEXT "A"', 10_000, dump);
        host.injectInputEvent(0, EV_KEY, KEY_A, 0);
        host.injectInputEvent(0, EV_KEY, KEY_LEFTSHIFT, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);

        // With shift released the same key reads lowercase again.
        host.injectInputEvent(0, EV_KEY, KEY_A, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        await waitFor(out, 'GOT_TEXT "a"', 10_000, dump);
        host.injectInputEvent(0, EV_KEY, KEY_A, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);

        // Move the cursor into the window (absolute motion on event1), then
        // press the left button there. libkwl reports the button at the
        // motion-updated position, inside the button rect.
        host.injectInputEvent(1, EV_ABS, ABS_X, POINT_X);
        host.injectInputEvent(1, EV_ABS, ABS_Y, POINT_Y);
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(1, EV_KEY, BTN_LEFT, 1);
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
        await waitFor(out, "ON_CLICK", 10_000, dump);

        // The app saw both events and exits cleanly.
        const demoCode = await Promise.race([
          demoExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`kwldemo timed out.\n${dump()}`)), 25_000)),
        ]);
        expect(demoCode, `kwldemo exit.\n${dump()}`).toBe(0);
        expect(out.value).toContain("KWLDEMO_OK");

        // The compositor exits once its last client disconnects.
        const compCode = await Promise.race([
          compExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`compositor timed out.\n${dump()}`)), 10_000)),
        ]);
        expect(compCode, `compositor exit.\n${dump()}`).toBe(0);
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
