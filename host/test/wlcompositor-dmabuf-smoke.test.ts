/**
 * PR11 gate: the wlcompositor Wayland server accepts a client buffer via
 * zwp_linux_dmabuf_v1 (instead of wl_shm) and composites it to card0.
 *
 * Spawns the compositor (programs/wlcompositor/wlcompositor.c) and a dmabuf
 * client (programs/wlcompositor/wldmabuf-test.c) under one NodeKernelHost,
 * talking over the real AF_UNIX socket at /tmp/wayland-0. The client:
 *
 *   - binds zwp_linux_dmabuf_v1 and confirms it advertises XRGB8888 + LINEAR
 *     (the one format/modifier the GPU tier + gbm import path handle);
 *   - allocates a renderD128 dumb-bo, paints it red, and turns its prime-fd
 *     into a wl_buffer via zwp_linux_buffer_params_v1.create_immed;
 *   - attaches + commits, and its frame callback fires only after the
 *     compositor imported the dmabuf and flipped it.
 *
 * The compositor samples the composited pixel and we assert it is the
 * client's red — proving the dmabuf buffer traversed the same import +
 * composite path as wl_shm. Input routing is covered by the wl_shm gate
 * (wlcompositor-smoke.test.ts); this one is purely the dmabuf buffer path.
 *
 * Both processes exit 0. Skips if the binaries aren't built (bare checkout).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const compositorBin = tryResolveBinary("programs/wlcompositor.wasm");
const clientBin = tryResolveBinary("programs/wldmabuf-test.wasm");
const hasBinaries = !!compositorBin && !!clientBin;

const CANVAS_W = 1920;
const CANVAS_H = 1080;

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

describe("wlcompositor — composites a zwp_linux_dmabuf_v1 client buffer", () => {
  it.skipIf(!hasBinaries)(
    "dmabuf-imported buffer lands on card0 red",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const clientBytes = loadBytes(clientBin!);

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

        const compExit = host.spawn(compositorBytes, ["wlcompositor"], {});
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);

        const clientExit = host.spawn(clientBytes, ["wldmabuf-test"], {});

        // The client only prints DMABUF_CLIENT_OK after the compositor
        // imported its dmabuf and flipped it (frame callback fired).
        await waitFor(out, "DMABUF_CLIENT_OK", 20_000, dump);

        // The compositor imported the dmabuf prime-fd and composited it —
        // the sampled pixel is the client's red.
        await waitFor(out, "COMPOSITE_SAMPLE", 5_000, dump);
        const sample = out.value.match(/COMPOSITE_SAMPLE x=\d+ y=\d+ px=0x([0-9a-f]{8})/);
        expect(sample, `no composite sample.\n${dump()}`).not.toBeNull();
        const px = parseInt(sample![1], 16);
        expect(px & 0xffffff, `composited pixel not red (0x${px.toString(16)})\n${dump()}`)
          .toBe(0xff0000);
        expect(out.value).toMatch(/FLIP fb=\d+ first=1/);

        const clientCode = await Promise.race([
          clientExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`client timed out.\n${dump()}`)), 25_000)),
        ]);
        expect(clientCode, `client exit.\n${dump()}`).toBe(0);

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
