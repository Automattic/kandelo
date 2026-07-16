/**
 * PR14e gate: the wlcompositor's zxdg_decoration_manager_v1 support.
 *
 * The compositor advertises the decoration manager and forces SERVER_SIDE mode
 * (a tiled window has no titlebar; even a floating one gets only the focus
 * ring, so clients must not draw CSD). wlclient-test, run with WLC_DECOR=1,
 * binds the manager, creates a toplevel decoration, requests a mode, and prints
 * the negotiated mode from the configure event — which must be server_side.
 *
 * Decoration negotiation is a client<->compositor protocol entirely inside the
 * kernel — no host/src change. Skips if the binaries aren't built.
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

describe("wlcompositor — server-side decoration negotiation", () => {
  it.skipIf(!hasBinaries)(
    "a client requesting decorations is configured SERVER_SIDE",
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
          env: ["WLC_LAYOUT=dwindle"],
        });
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);

        host.spawn(clientBytes, ["wlclient-test"], { env: ["WLC_DECOR=1"] });
        await waitFor(out, "DECOR_MODE server_side", 20_000, dump);
        expect(out.value, `client-side decoration leaked.\n${dump()}`)
          .not.toContain("DECOR_MODE client_side");

        void compExit;
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
