/**
 * PR24 gate: the wlcompositor's zxdg_output_manager_v1 + wp_viewporter +
 * wp_fractional_scale_manager_v1 support — the protocol surface GTK3,
 * Waybar and mako query beyond the core desktop set.
 *
 * wlclient-test, run with WLC_PROTOS=1, binds the three globals, reads the
 * xdg_output logical geometry burst, receives the fixed scale-1 preference
 * (120/120ths), and sets a viewport destination at twice its buffer size.
 * The compositor's VIEWPORT marker reports the applied crop/scale box, and
 * the composite sample proves the scaled blit still delivers the client's
 * pixels.
 *
 * The protocols live entirely between client and compositor inside the
 * kernel — no host/src change. Skips if the binaries aren't built.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const compositorBin = tryResolveBinary("programs/wldesktop/wlcompositor.wasm");
const clientBin = tryResolveBinary("programs/wlclient-test.wasm");
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

describe("wlcompositor — xdg-output + viewporter + fractional-scale", () => {
  it.skipIf(!hasBinaries)(
    "a client reads logical output geometry, scale 120, and maps through a 2x viewport",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const clientBytes = loadBytes(clientBin!);

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

        const compExit = host.spawn(compositorBytes, ["wlcompositor"], {});
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);

        host.spawn(clientBytes, ["wlclient-test"], { env: ["WLC_PROTOS=1"] });

        // xdg_output: the single virtual output is fullscreen at (0,0) with
        // the mode as its logical size; wl_output v4 carries the same name
        // (mako binds v4 unconditionally).
        await waitFor(out, "XDG_OUTPUT_NAME virtual-0", 20_000, dump);
        expect(out.value).toContain("OUTPUT_NAME virtual-0");
        expect(out.value).toContain("XDG_OUTPUT_POS x=0 y=0");
        const size = out.value.match(/XDG_OUTPUT_SIZE w=(\d+) h=(\d+)/);
        expect(size, `no logical size.\n${dump()}`).not.toBeNull();
        expect(parseInt(size![1], 10)).toBeGreaterThan(0);
        expect(parseInt(size![2], 10)).toBeGreaterThan(0);

        // fractional-scale: the desktop is fixed at scale 1 = 120/120ths.
        expect(out.value).toContain("FRACTIONAL_SCALE scale=120");

        // viewporter: the 200x150 buffer maps as a 400x300 window and the
        // scaled blit still composites the client's red pixels.
        await waitFor(out, "VIEWPORT bw=200 bh=150 w=400 h=300", 20_000, dump);
        await waitFor(out, "CLIENT_READY\n", 20_000, dump);
        await waitFor(out, "COMPOSITE_SAMPLE", 5_000, dump);
        const sample = out.value.match(/COMPOSITE_SAMPLE x=\d+ y=\d+ px=0x([0-9a-f]{8})/);
        expect(sample, `no composite sample.\n${dump()}`).not.toBeNull();
        const px = parseInt(sample![1], 16);
        expect(px & 0xffffff, `composited pixel not red (0x${px.toString(16)})\n${dump()}`)
          .toBe(0xff0000);

        void compExit;
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
