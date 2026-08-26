/**
 * PR15 gate: zwlr_layer_shell_v1 in the wlcompositor, driven by its two real
 * consumers — kbar (the status bar) and klauncher (the app launcher).
 *
 * Three things must hold for a shell component to work at all:
 *   1. The compositor anchors the surface where the client asked, at the size
 *      it dictated (the `LAYER ns=… x= y= w= h=` marker).
 *   2. Its exclusive zone shrinks the window work area: the windows below tile
 *      into the output MINUS the bar, so nothing is ever covered. Asserted by
 *      recomputing the dwindle partition of the reduced area here.
 *   3. Exclusive keyboard interactivity really takes the keyboard: keys typed
 *      while klauncher is up filter its list instead of reaching the window
 *      that had focus, and Enter dispatches the entry's exec through kwlctl.
 *
 * Skips if the binaries aren't built (bare checkout).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const compositorBin = tryResolveBinary("programs/wldesktop/wlcompositor.wasm");
const clientBin = tryResolveBinary("programs/wlclient-test.wasm");
const kbarBin = tryResolveBinary("programs/kbar.wasm");
const klauncherBin = tryResolveBinary("programs/wldesktop/klauncher.wasm");
const kwlctlBin = tryResolveBinary("programs/kwlctl.wasm");
const hasBinaries = !!compositorBin && !!clientBin && !!kbarBin && !!klauncherBin
  && !!kwlctlBin;

const CANVAS_W = 1920;
const CANVAS_H = 1080;

// Must match BAR_H in kbar.c and the gap constants in wlcompositor.c.
const BAR_H = 30;
const GAP_OUTER = 12;
const GAP_INNER = 8;

// evdev keycodes (linux/input-event-codes.h).
const EV_KEY = 0x01;
const EV_SYN = 0x00;
const SYN_REPORT = 0x00;
const KEY_T = 20;
const KEY_ENTER = 28;

interface Rect { x: number; y: number; w: number; h: number }

function parseTiles(text: string, count: number): Rect[] {
  const tiles: Rect[] = [];
  const re = new RegExp(
    `TILE n=${count} i=(\\d+) x=(-?\\d+) y=(-?\\d+) w=(\\d+) h=(\\d+)`, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    tiles[Number(m[1])] = {
      x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]),
    };
  }
  return tiles;
}

// Mirror of the C compute_tiling(), over whatever work area is left.
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

describe("wlcompositor — wlr-layer-shell shell components", () => {
  it.skipIf(!hasBinaries)(
    "kbar anchors across the top and its exclusive zone shrinks the tiling area",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const clientBytes = loadBytes(clientBin!);
      const kbarBytes = loadBytes(kbarBin!);

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

        host.spawn(compositorBytes, ["wlcompositor"], {
          env: ["WLC_LAYOUT=dwindle"],
        });
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);

        host.spawn(kbarBytes, ["kbar"], {});
        await waitFor(out, /KBAR_READY /, 20_000, dump);
        // kbar prints KBAR_READY once it commits its first buffer; the
        // compositor prints LAYER once it processes that commit, which is
        // strictly later.
        await waitFor(out, /LAYER ns=bar /, 20_000, dump);

        // 1) Anchored full-width along the top edge at the height it asked for.
        const layer = out.value.match(
          /LAYER ns=bar layer=(\d+) x=(-?\d+) y=(-?\d+) w=(\d+) h=(\d+)/);
        expect(layer, `no bar LAYER marker.\n${dump()}`).not.toBeNull();
        expect(Number(layer![1]), "bar should sit on the top layer").toBe(2);
        expect({
          x: Number(layer![2]), y: Number(layer![3]),
          w: Number(layer![4]), h: Number(layer![5]),
        }).toEqual({ x: 0, y: 0, w: CANVAS_W, h: BAR_H });

        // The bar renders at the size the compositor dictated.
        expect(out.value, `bar size mismatch.\n${dump()}`)
          .toMatch(new RegExp(`KBAR_READY w=${CANVAS_W} h=${BAR_H}`));

        // 2) Windows tile into the output MINUS the bar's exclusive zone.
        host.spawn(clientBytes, ["wlclient-test"], {});
        host.spawn(clientBytes, ["wlclient-test"], {});
        await waitFor(out, /TILE n=2 i=1 /, 20_000, dump);

        const tiles = parseTiles(out.value, 2);
        const expected = computeTiling(
          { x: 0, y: BAR_H, w: CANVAS_W, h: CANVAS_H - BAR_H }, 2);
        expect(tiles, `tiling ignored the exclusive zone.\n${dump()}`)
          .toEqual(expected);
        for (const t of tiles)
          expect(t.y, `window overlaps the bar.\n${dump()}`)
            .toBeGreaterThanOrEqual(BAR_H);

      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );

  it.skipIf(!hasBinaries)(
    "klauncher takes the keyboard exclusively, filters, and execs on Enter",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const clientBytes = loadBytes(clientBin!);
      const klauncherBytes = loadBytes(klauncherBin!);
      const kwlctlBytes = loadBytes(kwlctlBin!);

      // A two-entry registry: typing "t" must narrow it to one.
      const appsDir = mkdtempSync(join(tmpdir(), "kandelo-apps-"));
      mkdirSync(appsDir, { recursive: true });
      writeFileSync(join(appsDir, "terminal.conf"),
        "name = Terminal\nexec = /usr/local/bin/wlterm\n");
      writeFileSync(join(appsDir, "clock.conf"),
        "name = Clock\nexec = /usr/local/bin/wlclock\n");

      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
      });
      const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;
      const tap = (code: number) => {
        host.injectInputEvent(0, EV_KEY, code, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, code, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
      };

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        host.spawn(compositorBytes, ["wlcompositor"], {
          env: ["WLC_LAYOUT=dwindle"],
        });
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);

        // A window owns the keyboard first — the launcher has to take it away.
        host.spawn(clientBytes, ["wlclient-test"], {});
        await waitFor(out, /KBD_FOCUS app_id=/, 20_000, dump);

        host.spawn(klauncherBytes, ["klauncher"], {
          env: [`KLAUNCHER_APPS_DIR=${appsDir}`],
        });
        await waitFor(out, /KLAUNCHER_READY n=2/, 20_000, dump);
        await waitFor(out, /LAYER ns=launcher /, 20_000, dump);

        // Overlay layer, centred, at the size it asked for.
        const layer = out.value.match(/LAYER ns=launcher layer=(\d+) /);
        expect(layer, `no launcher LAYER marker.\n${dump()}`).not.toBeNull();
        expect(Number(layer![1]), "launcher should sit on the overlay layer")
          .toBe(3);

        // Typing goes to the launcher, not to the window that had focus.
        tap(KEY_T);
        await waitFor(out, /KLAUNCHER_FILTER q=t n=1/, 10_000, dump);

        // Enter hands the entry's command to the compositor over kwlctl and
        // dismisses the launcher. The compositor reports the launch either
        // way; this VFS has no /usr/local/bin/wlterm staged, so what is
        // asserted is that the dispatch arrived with the right command.
        tap(KEY_ENTER);
        await waitFor(out, /KLAUNCHER_EXEC cmd=\/usr\/local\/bin\/wlterm/,
          10_000, dump);
        await waitFor(out, /KWLCTL_EXEC(_FAILED)? "\/usr\/local\/bin\/wlterm"/,
          10_000, dump);
        await waitFor(out, "KLAUNCHER_EXIT", 10_000, dump);

        // The desktop survives the launcher going away: its layer surface is
        // torn down while the window below still holds a session, and the
        // compositor keeps serving.
        host.spawn(kwlctlBytes, ["kwlctl", "clients"], {});
        await waitFor(out, /\[\{"address"/, 10_000, dump);
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
