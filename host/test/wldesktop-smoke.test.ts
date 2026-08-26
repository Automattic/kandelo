/**
 * Wayland desktop gate: the v2 wlcompositor multiplexes MULTIPLE
 * concurrent clients as floating windows — per-client input routing,
 * click-to-focus, and interactive xdg_toplevel.move grabs.
 *
 * Spawns THREE programs under one NodeKernelHost — the compositor plus the
 * two desktop demo clients, wlclock (animated analog clock) and wlpaint
 * (palette + pointer painting) — and drives the desktop the way the
 * browser demo's user would:
 *
 *   - both clients connect, map, and composite (CLIENT_CONNECTED count=2,
 *     both READY markers, non-black COMPOSITE_SAMPLE);
 *   - a pointer press inside wlpaint's canvas reaches wlpaint (and only
 *     wlpaint) with surface-local coordinates → WLPAINT_STROKE. With two
 *     clients bound to the seat this is the regression gate for
 *     cross-client input isolation: the v1 compositor broadcast events to
 *     every client's resources, which libwayland aborts on at enter time
 *     ("compositor bug: … for a different client");
 *   - toolbar clicks land content-local: a click on palette swatch 1 →
 *     WLPAINT_COLOR i=1, a click on the clear button → WLPAINT_CLEAR;
 *   - the implicit pointer grab holds for a whole stroke: a press inside
 *     wlpaint's canvas followed by a release with the cursor OUTSIDE the
 *     window (over the wallpaper) still delivers the release to wlpaint
 *     (WLPAINT_STROKE_END). Pre-fix the compositor re-focused the surface
 *     under the cursor on every motion, so the release was swallowed and
 *     the stroke stayed stuck "drawing". A second variant releases over
 *     wlpaint's OWN CSD titlebar — libkwl must forward that release to
 *     the app (content y < 0) instead of consuming it as a titlebar click;
 *   - a press on wlclock's CSD titlebar makes libkwl request
 *     xdg_toplevel.move; the compositor grabs (MOVE_GRAB "wlclock"),
 *     drags the window with the cursor, and drops the grab on release
 *     (MOVE_END with the window moved left of its placement slot);
 *   - clicking each window's close box emits KWL_CLOSE → both clients
 *     exit 0 and the compositor follows its last client out.
 *
 * Window geometry driven by the compositor's placement rules
 * (wlcompositor.c placement_rules) and libkwl's KWL_TITLEBAR_H=28 CSD bar:
 *   wlclock: slot (1240,110), surface 340×388 (content 340×360)
 *   wlpaint: slot (1080,560), surface 640×448 (content 640×420)
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
const EV_ABS = 0x03;
const SYN_REPORT = 0x00;
const ABS_X = 0x00;
const ABS_Y = 0x01;
const BTN_LEFT = 0x110;

// wlclock at its placement slot.
const CLOCK_X = 1240;
const CLOCK_Y = 110;
const CLOCK_W = 340;
// wlpaint at its placement slot.
const PAINT_X = 1080;
const PAINT_Y = 560;
const PAINT_W = 640;
const TITLEBAR_H = 28;
const PAINT_TOOLBAR_H = 36;
// libkwl close box: 16×16, right margin 8, vertically centred in the bar.
const CLOSE_OFF_X = 8 + 16 / 2;   // from the window's right edge
const CLOSE_OFF_Y = TITLEBAR_H / 2;

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Waits for `pattern` in ref.value at/after offset `from` — repeated
 *  markers (WLPAINT_STROKE, WLPAINT_STROKE_END) would otherwise match a
 *  previous gate's output instantly. */
async function waitFor(
  ref: { value: string },
  pattern: string | RegExp,
  timeoutMs: number,
  context: () => string,
  from = 0,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = ref.value.slice(from);
    if (typeof pattern === "string" ? s.includes(pattern) : pattern.test(s))
      return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${String(pattern)}.\n${context()}`);
}

describe("wayland desktop — multi-client compositing, routing, move grabs", () => {
  it.skipIf(!hasBinaries)(
    "two clients composite; input routes per-client; titlebar drag moves a window",
    async () => {
      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
      });
      const dump = () =>
        `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;

      const moveTo = (x: number, y: number) => {
        host.injectInputEvent(1, EV_ABS, ABS_X, x);
        host.injectInputEvent(1, EV_ABS, ABS_Y, y);
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
      };
      // libinput's button debounce (evdev-debounce.c) treats a
      // release→press pair spaced <25 ms apart as switch bounce and
      // annihilates BOTH events — correct behavior for real hardware,
      // fatal for back-to-back injected clicks. Every button edge must
      // therefore be separated by more than DEBOUNCE_TIMEOUT_BOUNCE.
      // The 40 ms settle also exercises the debounce timer's timerfd
      // (IS_DOWN_WAITING → TIMEOUT → IS_DOWN), which only fires if the
      // kernel evaluates timerfd expiry against the timer's own clock
      // (CLOCK_MONOTONIC) in the poll path.
      const DEBOUNCE_SETTLE_MS = 40;
      const button = async (state: 0 | 1) => {
        host.injectInputEvent(1, EV_KEY, BTN_LEFT, state);
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
        await new Promise((r) => setTimeout(r, DEBOUNCE_SETTLE_MS));
      };

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        const compExit = host.spawn(loadBytes(compositorBin!), ["wlcompositor"], {});
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);
        // Node has no WebGL backing: the GL probe must fail cleanly and
        // land on the CPU compositing path (the browser gate asserts the
        // inverse, WLC_RENDERER gpu).
        expect(out.value).toContain("WLC_RENDERER cpu");

        const clockExit = host.spawn(loadBytes(clockBin!), ["wlclock"], {});
        await waitFor(out, "WLCLOCK_READY", 20_000, dump);
        const paintExit = host.spawn(loadBytes(paintBin!), ["wlpaint"], {});
        await waitFor(out, "WLPAINT_READY", 20_000, dump);

        // Both clients are connected at once and something composited.
        expect(out.value).toContain("CLIENT_CONNECTED count=2");
        await waitFor(out, "COMPOSITE_SAMPLE", 5_000, dump);
        const sample = out.value.match(/COMPOSITE_SAMPLE x=\d+ y=\d+ px=0x([0-9a-f]{8})/);
        expect(sample, `no composite sample.\n${dump()}`).not.toBeNull();
        expect(parseInt(sample![1], 16) & 0xffffff).not.toBe(0);

        // --- per-client pointer routing: paint a dot in wlpaint ---------
        // Output point inside wlpaint's canvas (below CSD bar + toolbar),
        // clear of wlclock. Content-local ≈ (420, 112).
        moveTo(PAINT_X + 420, PAINT_Y + TITLEBAR_H + PAINT_TOOLBAR_H + 76);
        await button(1);
        await waitFor(out, /WLPAINT_STROKE x=\d+ y=\d+/, 10_000, dump);
        await button(0);
        const stroke = out.value.match(/WLPAINT_STROKE x=(\d+) y=(\d+)/)!;
        // Bracket loosely (±10): libinput's abs transform can drift a few
        // px, and the point only needs to prove per-client routing —
        // wlclock's window is >150 px away.
        expect(Number(stroke[1])).toBeGreaterThan(410);
        expect(Number(stroke[1])).toBeLessThan(430);
        expect(Number(stroke[2])).toBeGreaterThan(102);
        expect(Number(stroke[2])).toBeLessThan(122);

        // --- toolbar clicks: swatch select + clear ----------------------
        // wlpaint's toolbar is content rows 0..35; content-local x/y =
        // screen − (PAINT_X, PAINT_Y + TITLEBAR_H). Swatch 1 spans content
        // x 40..64 (SWATCH_X0 + 1·SWATCH_STEP, 24 px wide) — aim for its
        // center so libinput's few-px abs drift stays inside.
        let mark = out.value.length;
        moveTo(PAINT_X + 52, PAINT_Y + TITLEBAR_H + 18);
        await button(1);
        await waitFor(out, "WLPAINT_COLOR i=1", 10_000, dump, mark);
        await button(0);

        // Clear button spans content x 244..300 (CLEAR_X .. +CLEAR_W).
        mark = out.value.length;
        moveTo(PAINT_X + 272, PAINT_Y + TITLEBAR_H + 18);
        await button(1);
        await waitFor(out, "WLPAINT_CLEAR", 10_000, dump, mark);
        await button(0);

        // --- implicit pointer grab: release off-window ------------------
        // Press inside wlpaint's canvas, drag onto the wallpaper, release.
        // The release must still reach wlpaint (WLPAINT_STROKE_END): the
        // compositor's implicit grab pins delivery to the pressed surface
        // while any button is down. Pre-fix, motion re-focused whatever
        // was under the cursor and the release was swallowed.
        mark = out.value.length;
        moveTo(PAINT_X + 420, PAINT_Y + TITLEBAR_H + PAINT_TOOLBAR_H + 76);
        await button(1);
        await waitFor(out, /WLPAINT_STROKE x=\d+ y=\d+/, 10_000, dump, mark);
        moveTo(400, 300);   // wallpaper — outside every window
        await button(0);
        await waitFor(out, "WLPAINT_STROKE_END", 10_000, dump, mark);

        // --- implicit grab, release over wlpaint's OWN titlebar ---------
        // Same grab, but the release lands on the CSD bar (clear of the
        // close box). libkwl consumes only PRESSES there; a RELEASE is
        // forwarded to the app with content y < 0 — pre-fix it was eaten
        // and the stroke stayed stuck "drawing".
        mark = out.value.length;
        moveTo(PAINT_X + 420, PAINT_Y + TITLEBAR_H + PAINT_TOOLBAR_H + 76);
        await button(1);
        await waitFor(out, /WLPAINT_STROKE x=\d+ y=\d+/, 10_000, dump, mark);
        moveTo(PAINT_X + 300, PAINT_Y + 14);   // wlpaint's titlebar
        await button(0);
        await waitFor(out, "WLPAINT_STROKE_END", 10_000, dump, mark);

        // --- interactive move: drag wlclock's titlebar left+down --------
        moveTo(CLOCK_X + 60, CLOCK_Y + 14);   // titlebar, clear of close box
        await button(1);
        await waitFor(out, 'MOVE_GRAB "wlclock"', 10_000, dump);
        moveTo(940, 400);
        await button(0);
        await waitFor(out, /MOVE_END "wlclock" x=-?\d+ y=-?\d+/, 10_000, dump);
        const moved = out.value.match(/MOVE_END "wlclock" x=(-?\d+) y=(-?\d+)/)!;
        // Started at (1240,110); dragged well left and down.
        expect(Number(moved[1])).toBeLessThan(1000);
        expect(Number(moved[2])).toBeGreaterThan(300);
        const clockX = Number(moved[1]);
        const clockY = Number(moved[2]);

        // --- close boxes: wlpaint first, then the (moved) wlclock -------
        moveTo(PAINT_X + PAINT_W - CLOSE_OFF_X, PAINT_Y + CLOSE_OFF_Y);
        await button(1);
        await button(0);
        await waitFor(out, "WLPAINT_EXIT", 10_000, dump);

        moveTo(clockX + CLOCK_W - CLOSE_OFF_X, clockY + CLOSE_OFF_Y);
        await button(1);
        await button(0);
        await waitFor(out, "WLCLOCK_EXIT", 10_000, dump);

        // Everyone exits cleanly; the compositor follows its last client.
        const timeoutIn = <T>(p: Promise<T>, ms: number, what: string) =>
          Promise.race([
            p,
            new Promise<T>((_, reject) =>
              setTimeout(() => reject(new Error(`${what} timed out.\n${dump()}`)), ms)),
          ]);
        expect(await timeoutIn(paintExit, 15_000, "wlpaint"), dump()).toBe(0);
        expect(await timeoutIn(clockExit, 15_000, "wlclock"), dump()).toBe(0);
        expect(await timeoutIn(compExit, 15_000, "compositor"), dump()).toBe(0);
        expect(out.value).toContain("COMPOSITOR_LAST_CLIENT_GONE");
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    120_000,
  );
});
