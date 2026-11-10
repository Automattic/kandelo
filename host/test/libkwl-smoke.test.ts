/**
 * The libkwl toolkit (examples/libs/libkwl) drives a real client window
 * under cage, the wlroots kiosk compositor — connect, map, and route input
 * — through its create/draw/commit/dispatch API.
 *
 * cage runs a libkwl app (programs/kwldemo.c) as its session client over
 * the AF_UNIX socket at /tmp/wayland-0. Where host/test/cage-smoke.test.ts
 * uses a hand-written raw libwayland-client, this one exercises the toolkit:
 *
 *   - kwl_window_create() binds the globals, maps a toplevel, and allocates
 *     its double-buffered wl_shm buffer over a gbm prime-fd; cage maximizes
 *     it to the output and maps it once a committed buffer imports;
 *   - a host-injected key A is compiled through libkwl's xkb path to
 *     KWL_TEXT "a" → GOT_TEXT, with and without shift;
 *   - a host-injected absolute pointer motion moves the cursor to a point
 *     inside the button, and a button press there is routed through libkwl
 *     to KWL_POINTER_BUTTON → ON_CLICK.
 *
 * kwldemo exits 0, and cage exits with its status. Required artifacts are resolved before the test runs.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";
import { WLROOTS_ENV, compositorBytes, requireSession, sessionRootfs } from "./wlroots-session";

const kwldemoBin = resolveBinary("programs/kwldemo.wasm");
requireSession("cage");

// The input canvas matches card0's output (1920x1080) so an injected
// absolute pointer coordinate maps 1:1 to the cursor position. cage places
// the maximized window at (0,0), and libkwl adds a KWL_TITLEBAR_H (28px)
// CSD bar above the content.
const CANVAS_W = 1920;
const CANVAS_H = 1080;
// Output-space point mapping to content-local (100,72) — inside the
// kwldemo button rect (8,8)–(312,232).
const POINT_X = 100;
const POINT_Y = 100;

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

describe("libkwl — toolkit window maps and routes input", () => {
  it(
    "kwldemo maps; injected button + key reach the app",
    async () => {
      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        rootfsImage: await sessionRootfs("cage", [
          { path: "/usr/bin/kwldemo", bytes: new Uint8Array(readFileSync(kwldemoBin!)), mode: 0o755 },
        ]),
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
      });

      const dump = () =>
        `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        const cageExit = host.spawn(compositorBytes("cage"), ["cage", "--", "/usr/bin/kwldemo"], {
          env: WLROOTS_ENV,
        });

        // The toolkit bound globals, mapped the toplevel, drew + committed a
        // frame, and the compositor presented it before printing KWLDEMO_READY.
        await waitFor(out, "KWLDEMO_READY", 20_000, dump);

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

        // The app saw both events and exits cleanly; cage exits with its
        // status.
        const cageCode = await Promise.race([
          cageExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`cage timed out.\n${dump()}`)), 25_000)),
        ]);
        expect(cageCode, `cage exit.\n${dump()}`).toBe(0);
        expect(out.value).toContain("KWLDEMO_OK");
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
