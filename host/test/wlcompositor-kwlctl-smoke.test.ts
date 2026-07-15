/**
 * PR14c gate: the wlcompositor's kwlctl control + event socket (/tmp/kwlctl-0),
 * the hyprctl analog.
 *
 * Spawns the compositor in dwindle mode plus three clients, then drives the
 * kwlctl CLI (programs/wlcompositor/kwlctl.c) over the control socket:
 *
 *   - `kwlctl clients` returns JSON for the three windows whose geometry equals
 *     the dwindle partition (proves the query surface reflects the layout);
 *   - `kwlctl --listen` streams the `event>>data` line emitted when
 *     `kwlctl dispatch workspace 2` switches workspace (proves the event bus);
 *   - `kwlctl dispatch exec wlclient-test` forks+execs a fourth client through
 *     the compositor (proves dispatch exec; the exec resolves via onResolveExec).
 *
 * kwlctl talks to the compositor entirely inside the kernel (a client<->server
 * UNIX socket), so there is no host/src change — the dual-host parity rule is
 * not triggered. Skips if the binaries aren't built.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const compositorBin = tryResolveBinary("programs/wlcompositor.wasm");
const clientBin = tryResolveBinary("programs/wlclient-test.wasm");
const kwlctlBin = tryResolveBinary("programs/kwlctl.wasm");
const hasBinaries = !!compositorBin && !!clientBin && !!kwlctlBin;

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const GAP_OUTER = 12;
const GAP_INNER = 8;

interface Rect { x: number; y: number; w: number; h: number }

// Mirror of the C compute_tiling() (see wlcompositor-tiling-smoke.test.ts).
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

describe("wlcompositor — kwlctl control + event IPC", () => {
  it.skipIf(!hasBinaries)(
    "clients JSON matches dwindle; dispatch drives workspace + exec; --listen streams events",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const clientBytes = loadBytes(clientBin!);
      const kwlctlBytes = loadBytes(kwlctlBin!);

      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
        // `dispatch exec` runs posix_spawnp inside the compositor; the kernel
        // resolves the spawn target from execPrograms (path -> wasm file). We
        // dispatch an absolute path so libc skips its VFS-stat PATH search
        // (the binary only exists in this map, not as a real VFS file).
        execPrograms: { "/usr/local/bin/wlclient-test": clientBin! },
      });
      const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;

      const runKwlctl = (args: string[]) =>
        host.spawn(kwlctlBytes, ["kwlctl", ...args], {});

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        const compExit = host.spawn(compositorBytes, ["wlcompositor"], {
          env: ["WLC_LAYOUT=dwindle"],
        });
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);

        host.spawn(clientBytes, ["wlclient-test"], {});
        host.spawn(clientBytes, ["wlclient-test"], {});
        host.spawn(clientBytes, ["wlclient-test"], {});
        await waitFor(out, /TILE n=3 i=2 /, 20_000, dump);

        // --- kwlctl clients: JSON geometry equals the dwindle partition. ---
        const clientsCode = await runKwlctl(["clients"]);
        expect(clientsCode, `kwlctl clients exit.\n${dump()}`).toBe(0);
        const arrMatch = out.value.match(/(\[\{"address"[^\n]*\])/);
        expect(arrMatch, `no clients JSON.\n${dump()}`).not.toBeNull();
        const windows = JSON.parse(arrMatch![1]) as Array<{
          workspace: { id: number };
          at: [number, number];
          size: [number, number];
          focused: boolean;
        }>;
        expect(windows.length, `expected 3 windows.\n${dump()}`).toBe(3);
        const expected = computeTiling({ x: 0, y: 0, w: CANVAS_W, h: CANVAS_H }, 3);
        windows.forEach((w, i) => {
          expect(w.workspace.id, `window ${i} workspace`).toBe(1);
          expect({ x: w.at[0], y: w.at[1], w: w.size[0], h: w.size[1] },
            `window ${i} geometry.\n${dump()}`).toEqual(expected[i]);
        });
        expect(windows.filter((w) => w.focused).length,
          `exactly one focused.\n${dump()}`).toBe(1);

        // --- --listen streams the workspace event fired by a dispatch. ---
        runKwlctl(["--listen"]); // background; drains until compositor exits
        await waitFor(out, "listening", 10_000, dump);

        const dispCode = await runKwlctl(["dispatch", "workspace", "2"]);
        expect(dispCode, `dispatch workspace exit.\n${dump()}`).toBe(0);
        await waitFor(out, "workspace>>2", 10_000, dump);

        // --- dispatch exec spawns a fourth client through the compositor.
        const execCode = await runKwlctl(
          ["dispatch", "exec", "/usr/local/bin/wlclient-test"]);
        expect(execCode, `dispatch exec exit.\n${dump()}`).toBe(0);
        await waitFor(out, "CLIENT_CONNECTED count=4", 20_000, dump);

        void compExit;
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
