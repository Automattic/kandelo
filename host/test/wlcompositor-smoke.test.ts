/**
 * PR6 gate: the wlcompositor Wayland server composites a client's shared
 * buffer to card0 and routes libinput input to the focused client.
 *
 * Spawns TWO programs under one NodeKernelHost — the compositor
 * (programs/wlcompositor/wlcompositor.c) and a raw libwayland-client test
 * client (programs/wlcompositor/wlclient-test.c) — that talk over a real
 * AF_UNIX socket at /run/wayland-0. This is the first end-to-end exercise
 * of the whole top-of-stack:
 *
 *   - cross-process AF_UNIX pathname socket (bind/listen/accept ↔ connect)
 *   - the client's renderD128 dumb-bo pixels crossing the process boundary
 *     via prime-fd + SCM_RIGHTS, imported by the compositor with gbm and
 *     CPU-blitted onto the card0 scanout bo (plan §8.1 gbm_bo_import path);
 *     the compositor samples the composited pixel and we assert it is the
 *     client's red.
 *   - xdg_shell toplevel configure/ack + wl_surface.frame pacing (the
 *     client's frame callback only fires after a real KMS flip).
 *   - the wl_keyboard keymap fd built by the compositor's libxkbcommon.
 *   - host-injected libinput key + pointer button fanned out to the
 *     client's wl_keyboard / wl_pointer (the real libinput consumer).
 *
 * Both processes exit 0; the compositor shuts down when its last client
 * disconnects. Skips if the binaries aren't built (bare checkout).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const compositorBin = tryResolveBinary("programs/wlcompositor.wasm");
const clientBin = tryResolveBinary("programs/wlclient-test.wasm");
const hasBinaries = !!compositorBin && !!clientBin;

const CANVAS_W = 1920;
const CANVAS_H = 1080;

// linux/input-event-codes.h
const EV_SYN = 0x00;
const EV_KEY = 0x01;
const SYN_REPORT = 0x00;
const KEY_A = 30;
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

describe("wlcompositor — server composites + routes input to a client", () => {
  it.skipIf(!hasBinaries)(
    "client buffer lands on card0 red; injected key + button reach the client",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const clientBytes = loadBytes(clientBin!);

      // The compositor's and client's stdout markers are disjoint, so one
      // combined buffer is unambiguous and robust to pid attribution.
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

        // --- client ---
        const clientExit = host.spawn(clientBytes, ["wlclient-test"], {});

        // Client bound all globals, uploaded a buffer, and the compositor
        // flipped it (frame callback fired) before printing CLIENT_READY.
        await waitFor(out, "CLIENT_READY\n", 20_000, dump);

        // The compositor imported the client's prime-fd, mapped the shared
        // bytes, and composited them — the sampled pixel is the client's red.
        await waitFor(out, "COMPOSITE_SAMPLE", 5_000, dump);
        const sample = out.value.match(/COMPOSITE_SAMPLE x=\d+ y=\d+ px=0x([0-9a-f]{8})/);
        expect(sample, `no composite sample.\n${dump()}`).not.toBeNull();
        const px = parseInt(sample![1], 16);
        expect(px & 0xffffff, `composited pixel not red (0x${px.toString(16)})\n${dump()}`)
          .toBe(0xff0000);
        expect(out.value).toMatch(/FLIP fb=\d+ first=1/);

        // Inject a keyboard key on event0 and a pointer button on event1;
        // the compositor forwards both to the focused client.
        host.injectInputEvent(0, EV_KEY, KEY_A, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(1, EV_KEY, BTN_LEFT, 1);
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);

        const clientCode = await Promise.race([
          clientExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`client timed out.\n${dump()}`)), 25_000)),
        ]);
        expect(clientCode, `client exit.\n${dump()}`).toBe(0);

        // The client parsed the compositor's xkb keymap and saw both events.
        expect(out.value).toMatch(/KEYMAP format=1 size=\d+ ok=1/);
        expect(out.value).toMatch(new RegExp(`GOT_KEY key=${KEY_A} state=1`));
        expect(out.value).toMatch(new RegExp(`GOT_BTN button=${BTN_LEFT} state=1`));
        expect(out.value).toContain("CLIENT_OK");

        // The compositor exits cleanly once its last client disconnects.
        const compCode = await Promise.race([
          compExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`compositor timed out.\n${dump()}`)), 10_000)),
        ]);
        expect(compCode, `compositor exit.\n${dump()}`).toBe(0);
        expect(out.value).toContain("COMPOSITOR_LAST_CLIENT_GONE");
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
