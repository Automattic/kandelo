/**
 * Client resize gate: a libkwl window honours the tiling compositor's dictated
 * geometry.
 *
 * The tiling-smoke test proves the compositor computes the right partition and
 * emits TILE markers, but its raw wlclient-test clients ignore the dictated
 * size. This test closes that gap with real libkwl clients (wlclock): under
 * WLC_LAYOUT=dwindle the compositor sends each window an xdg configure with its
 * tile size; libkwl reallocates its buffers and posts KWL_RESIZE, and wlclock
 * prints `WLCLOCK_RESIZE w=.. h=..`. We assert those dims equal the dwindle
 * partition computed here (the same rule as tiling-smoke) — so the whole
 * compositor→client resize path is verified end to end, not just the
 * compositor's math. With one window it fills the whole gapped work area; a
 * second window forces both down to the two-way split.
 *
 * wlclock (not wlterm) is used so the test needs no forkpty'd shell. Skips if
 * the binaries aren't built.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const compositorBin = tryResolveBinary("programs/wlcompositor.wasm");
const clockBin = tryResolveBinary("programs/wlclock.wasm");
const hasBinaries = !!compositorBin && !!clockBin;

const CANVAS_W = 1920;
const CANVAS_H = 1080;

// Must match TILE_GAP_OUTER / TILE_GAP_INNER in wlcompositor.c.
const GAP_OUTER = 12;
const GAP_INNER = 8;

interface Rect { x: number; y: number; w: number; h: number }

// Mirror of the C compute_tiling() — see wlcompositor-tiling-smoke.test.ts.
function computeTiling(area: Rect, n: number): Rect[] {
  const out: Rect[] = [];
  if (n <= 0) return out;
  let region: Rect = {
    x: area.x + GAP_OUTER,
    y: area.y + GAP_OUTER,
    w: Math.max(1, area.w - 2 * GAP_OUTER),
    h: Math.max(1, area.h - 2 * GAP_OUTER),
  };
  for (let i = 0; i < n; i++) {
    if (i === n - 1) { out.push(region); break; }
    const near: Rect = { ...region };
    const rest: Rect = { ...region };
    if (region.w >= region.h) {
      const half = Math.max(1, Math.floor((region.w - GAP_INNER) / 2));
      near.w = half;
      rest.x = region.x + half + GAP_INNER;
      rest.w = region.w - half - GAP_INNER;
    } else {
      const half = Math.max(1, Math.floor((region.h - GAP_INNER) / 2));
      near.h = half;
      rest.y = region.y + half + GAP_INNER;
      rest.h = region.h - half - GAP_INNER;
    }
    out.push(near);
    region = rest;
  }
  return out;
}

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function waitFor(
  ref: { value: string },
  needle: string | RegExp,
  timeoutMs: number,
  context: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const hit = () =>
    typeof needle === "string" ? ref.value.includes(needle) : needle.test(ref.value);
  while (Date.now() < deadline) {
    if (hit()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${needle}.\n${context()}`);
}

describe("wlcompositor — libkwl clients resize to the dictated tile", () => {
  it.skipIf(!hasBinaries)(
    "one window fills the work area; a second splits both to the two-way partition",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const clockBytes = loadBytes(clockBin!);

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

        // One window: the sole tile is the whole gapped work area. Under
        // server-side decoration (forced in dwindle) the content fills the
        // full surface, so the resize dims equal the tile exactly.
        host.spawn(clockBytes, ["wlclock"], {});
        const [solo] = computeTiling({ x: 0, y: 0, w: CANVAS_W, h: CANVAS_H }, 1);
        await waitFor(out, `WLCLOCK_RESIZE w=${solo.w} h=${solo.h}`, 20_000, dump);

        // Second window: dwindle splits the work area along its longer (x)
        // axis, so BOTH windows are reconfigured to the same half-width tile.
        host.spawn(clockBytes, ["wlclock"], {});
        const two = computeTiling({ x: 0, y: 0, w: CANVAS_W, h: CANVAS_H }, 2);
        expect(two[0].w, "expected an x-axis split").toBe(two[1].w);
        await waitFor(out, `WLCLOCK_RESIZE w=${two[0].w} h=${two[0].h}`, 20_000, dump);

        // Both clients ended up at the two-way tile size — the first shrank
        // from the solo tile and the second mapped straight into its half.
        const resizes = [...out.value.matchAll(/WLCLOCK_RESIZE w=(\d+) h=(\d+)/g)]
          .map((m) => `${m[1]}x${m[2]}`);
        const halved = resizes.filter((r) => r === `${two[0].w}x${two[0].h}`);
        expect(halved.length,
          `expected both windows at the two-way tile.\n${dump()}`)
          .toBeGreaterThanOrEqual(2);

        void compExit;
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
