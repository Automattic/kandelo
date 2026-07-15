/**
 * PR14a gate: the wlcompositor's dwindle tiling engine partitions the output
 * among mapped windows.
 *
 * Spawns the compositor with WLC_LAYOUT=dwindle plus three raw libwayland
 * clients (programs/wlclient-test.c) over the real AF_UNIX socket. As each
 * client maps, the compositor's pure compute_tiling() recomputes the layout
 * and emits one `TILE n=<count> i=<idx> x= y= w= h=` marker per window. This
 * test parses the three-window retile and asserts the emitted geometry equals
 * the dwindle partition — computed here from the same recursive rule — so the
 * engine's decision is verified independently of whether the fixed-size test
 * clients honour the dictated size. Also checks the tiles are in-bounds and
 * pairwise non-overlapping.
 *
 * The floating desktop (/?demo=wayland) uses the default FLOATING mode and is
 * covered by wlcompositor-smoke.test.ts; this test only exercises DWINDLE.
 * Skips if the binaries aren't built (bare checkout).
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

// Must match TILE_GAP_OUTER / TILE_GAP_INNER in wlcompositor.c.
const GAP_OUTER = 12;
const GAP_INNER = 8;

interface Rect { x: number; y: number; w: number; h: number }

// Mirror of the C compute_tiling(): recursively split the remaining region
// along its longer side, near-half to window i, remainder carried forward.
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

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w &&
         a.y < b.y + b.h && b.y < a.y + a.h;
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

describe("wlcompositor — dwindle tiling partitions the output", () => {
  it.skipIf(!hasBinaries)(
    "three mapped clients tile into the exact non-overlapping dwindle partition",
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

        // Compositor in dwindle mode.
        const compExit = host.spawn(compositorBytes, ["wlcompositor"], {
          env: ["WLC_LAYOUT=dwindle"],
        });
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);
        expect(out.value, `layout not dwindle.\n${dump()}`).toMatch(/WLC_LAYOUT dwindle/);

        // Three clients. Each maps a fixed-size window and then blocks waiting
        // for input, so all three stay mapped simultaneously. We inject no
        // input, so none exits before we read the layout.
        host.spawn(clientBytes, ["wlclient-test"], {});
        host.spawn(clientBytes, ["wlclient-test"], {});
        host.spawn(clientBytes, ["wlclient-test"], {});

        // The retile at the third map emits the full three-window partition.
        await waitFor(out, /TILE n=3 i=2 /, 20_000, dump);

        const tiles: Rect[] = [];
        const re = /TILE n=3 i=(\d+) x=(-?\d+) y=(-?\d+) w=(\d+) h=(\d+)/g;
        for (let m = re.exec(out.value); m; m = re.exec(out.value)) {
          tiles[Number(m[1])] = {
            x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]),
          };
        }
        expect(tiles.filter(Boolean).length, `expected 3 tiles.\n${dump()}`).toBe(3);

        // 1) Emitted geometry equals the dwindle partition computed here.
        const expected = computeTiling({ x: 0, y: 0, w: CANVAS_W, h: CANVAS_H }, 3);
        expect(tiles, `tiling mismatch.\n${dump()}`).toEqual(expected);

        // 2) Every tile sits inside the gapped work area.
        for (const t of tiles) {
          expect(t.w).toBeGreaterThan(0);
          expect(t.h).toBeGreaterThan(0);
          expect(t.x).toBeGreaterThanOrEqual(GAP_OUTER);
          expect(t.y).toBeGreaterThanOrEqual(GAP_OUTER);
          expect(t.x + t.w).toBeLessThanOrEqual(CANVAS_W - GAP_OUTER);
          expect(t.y + t.h).toBeLessThanOrEqual(CANVAS_H - GAP_OUTER);
        }

        // 3) Pairwise non-overlapping — a genuine partition, not a stack.
        for (let i = 0; i < tiles.length; i++)
          for (let j = i + 1; j < tiles.length; j++)
            expect(overlaps(tiles[i], tiles[j]),
              `tiles ${i} and ${j} overlap.\n${dump()}`).toBe(false);

        void compExit; // cleaned up by host.destroy() in finally.
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
