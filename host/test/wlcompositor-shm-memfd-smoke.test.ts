/**
 * wlcompositor reads a wl_shm buffer from an ordinary memfd pool by
 * mapping the pool fd, as wl_shm specifies and as libwayland's own wl_shm
 * does, so clients need not allocate their pools as DRM buffers.
 *
 * The client (programs/wlcompositor/wlclient-test.c, WLC_MEMFD=1) makes a
 * memfd pool, places its 200x150 buffer 12352 bytes in (not page aligned,
 * as GTK packs buffers) behind green bytes, waits for a roundtrip so the
 * compositor has received and mapped the pool, and only then paints the
 * buffer red. The composited pixel the compositor samples (CPU path on
 * Node) is therefore red only if it read the client's later stores through
 * its own MAP_SHARED mapping, at the buffer's offset: green means it read
 * the pool from its start, black means it saw no pixels at all.
 *
 * Skips if the binaries aren't built (bare checkout).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const compositorBin = tryResolveBinary("programs/wayland-demo/wlcompositor.wasm");
const clientBin = tryResolveBinary("programs/wlclient-test.wasm");
const hasBinaries = !!compositorBin && !!clientBin;

const CANVAS_W = 1920;
const CANVAS_H = 1080;
// The unmatched app_id's first cascade slot is (160,120); the window is
// 200x150, so this point is inside it.
const POINT_X = 260;
const POINT_Y = 200;

// linux/input-event-codes.h
const EV_SYN = 0x00;
const EV_KEY = 0x01;
const EV_ABS = 0x03;
const SYN_REPORT = 0x00;
const ABS_X = 0x00;
const ABS_Y = 0x01;
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

function withTimeout<T>(p: Promise<T>, ms: number, what: () => string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(what())), ms)),
  ]);
}

describe("wlcompositor — wl_shm pools are mapped, not imported as DRM buffers", () => {
  it.skipIf(!hasBinaries)(
    "a memfd pool buffer at a nonzero offset composites with the client's later stores",
    async () => {
      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
      });
      const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        const compExit = host.spawn(loadBytes(compositorBin!), ["wlcompositor"], {});
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);
        const clientExit = host.spawn(loadBytes(clientBin!), ["wlclient-test"], {
          env: ["WLC_MEMFD=1"],
        });

        await waitFor(out, "CLIENT_READY\n", 20_000, dump);
        expect(out.value).toContain("BUFFER memfd offset=12352 stride=800");
        // The pool was accepted: no wl_shm protocol error killed the client.
        expect(err.value).not.toMatch(/failed mmap fd|protocol error/i);

        await waitFor(out, "COMPOSITE_SAMPLE", 5_000, dump);
        const sample = out.value.match(/COMPOSITE_SAMPLE x=\d+ y=\d+ px=0x([0-9a-f]{8})/);
        expect(sample, `no composite sample.\n${dump()}`).not.toBeNull();
        const px = parseInt(sample![1], 16) & 0xffffff;
        expect(px, `composited pixel 0x${px.toString(16)} is not the client's red ` +
          `(0x00ff00 = read the pool from its start, 0 = saw no pixels)\n${dump()}`)
          .toBe(0xff0000);

        // Let the client finish its input round so both processes exit 0.
        host.injectInputEvent(0, EV_KEY, KEY_A, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(1, EV_ABS, ABS_X, POINT_X);
        host.injectInputEvent(1, EV_ABS, ABS_Y, POINT_Y);
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(1, EV_KEY, BTN_LEFT, 1);
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);

        const clientCode = await withTimeout(clientExit, 25_000, () => `client timed out.\n${dump()}`);
        expect(clientCode, `client exit.\n${dump()}`).toBe(0);
        expect(out.value).toContain("CLIENT_OK");
        const compCode = await withTimeout(compExit, 10_000, () => `compositor timed out.\n${dump()}`);
        expect(compCode, `compositor exit.\n${dump()}`).toBe(0);
        expect(out.value).toContain("COMPOSITOR_LAST_CLIENT_GONE");
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
