/**
 * The wlcompositor's wl_output scale: the mode is device pixels, WLC_SCALE
 * says how many of them make a logical pixel, and every protocol object that
 * carries a size has to agree on which of the two grids it is in.
 *
 * wl_output.mode stays device pixels while wl_output.scale, xdg_output's
 * logical size and wp_fractional_scale's preference all follow the scale.
 * A browser is the only place a real dpr-2 pane exists, so without this gate
 * the split is only covered by a Playwright spec.
 *
 * wl_surface.set_buffer_scale is the client's half of the same contract: a
 * client that attaches scale-N pixels gets a window N times smaller than its
 * buffer, which is what lets it render sharp instead of being upscaled.
 * Skips if the binaries aren't built.
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
  count = 1,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ref.value.split(needle).length > count) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `Timed out waiting for ${count}x ${JSON.stringify(needle)}.\n${context()}`);
}

describe("wlcompositor — wl_output scale", () => {
  it.skipIf(!hasBinaries)(
    "splits the mode into a device grid and a logical grid half its size",
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

        const compExit = host.spawn(compositorBytes, ["wlcompositor"], {
          env: ["WLC_SCALE=2"],
        });
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);

        expect(out.value).toContain("WLC_SCALE 2");
        expect(out.value, `logical grid is not the mode halved.\n${dump()}`)
          .toContain(`COMPOSITOR_UP w=${CANVAS_W / 2} h=${CANVAS_H / 2}`);

        host.spawn(clientBytes, ["wlclient-test"], { env: ["WLC_PROTOS=1"] });
        await waitFor(out, "XDG_OUTPUT_NAME virtual-0", 20_000, dump);

        // wl_output.mode is device pixels and does not shrink with the scale;
        // a client that ignores wl_output.scale reads exactly what it read
        // before the scale existed.
        expect(out.value).toContain(`OUTPUT_MODE w=${CANVAS_W} h=${CANVAS_H}`);
        expect(out.value).toContain("OUTPUT_SCALE factor=2");

        // xdg_output and wp_fractional_scale are both logical. The client asks
        // for the fractional scale after the xdg_output, so its reply is the
        // last of the burst and has to be waited for, not read.
        expect(out.value)
          .toContain(`XDG_OUTPUT_SIZE w=${CANVAS_W / 2} h=${CANVAS_H / 2}`);
        await waitFor(out, "FRACTIONAL_SCALE scale=240", 20_000, dump);

        // A second client declares its 200x150 buffer as scale-2 pixels, so
        // its window is 100x75 logical. That window covers 200x150 device
        // pixels, which is the buffer 1:1 — the case the whole scale exists
        // for. No viewport here: a viewport destination is already logical
        // and would override the division under test.
        host.spawn(clientBytes, ["wlclient-test"], { env: ["WLC_BUFSCALE=2"] });
        await waitFor(out,
                      "BUFFER_SCALE app=wlclient-test scale=2 bw=200 bh=150 w=100 h=75",
                      20_000, dump);

        // A third client reads its scale from wl_surface.enter instead of
        // being told its own, which is what mako does. It draws exactly one
        // frame, so the enter has to reach it before that frame — hence the
        // compositor sends it when the surface takes a role, not when it
        // maps, which is a frame too late. Sent at map, this client reaches
        // its first attach with no enter and bails.
        host.spawn(clientBytes, ["wlclient-test"], { env: ["WLC_ENTERSCALE=1"] });
        await waitFor(out, "SURFACE_ENTER scale=2", 20_000, dump);
        // Its third occurrence: this client committed a frame, which it only
        // does with the enter in hand.
        await waitFor(out, "CLIENT_READY", 20_000, dump, 3);
        expect(err.value, "a client never got the enter before its first frame")
          .not.toContain("no wl_surface.enter before the first frame");
        // One output means one enter per surface. The compositor sends it from
        // the role and again from the map, so three clients that each got it
        // twice would count six.
        expect(out.value.split("SURFACE_ENTER").length - 1,
               "a surface was entered onto the same output more than once")
          .toBe(3);

        void compExit;
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
