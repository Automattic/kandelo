/**
 * PR17 gate: the Omarchy-shaped theme system.
 *
 * A theme is a directory holding one theme.conf that the compositor and every
 * shell client read. This asserts the three things that makes it a system
 * rather than a colour constant:
 *   1. The configured theme is loaded at startup and its gaps really drive the
 *      layout — the tiling partition is recomputed with the theme's numbers.
 *   2. `kwlctl dispatch theme next` cycles the installed themes live, and the
 *      new gaps re-tile the desktop without a restart.
 *   3. The switch is broadcast on the kwlctl event stream, so kbar (and any
 *      other shell client) reloads its own palette from the same file.
 *
 * Skips if the binaries aren't built (bare checkout).
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const compositorBin = tryResolveBinary("programs/wlcompositor.wasm");
const clientBin = tryResolveBinary("programs/wlclient-test.wasm");
const kbarBin = tryResolveBinary("programs/kbar.wasm");
const kwlctlBin = tryResolveBinary("programs/kwlctl.wasm");
const hasBinaries = !!compositorBin && !!clientBin && !!kbarBin && !!kwlctlBin;

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const BAR_H = 30;   // must match BAR_H in kbar.c

// Two themes with deliberately different gaps, so a switch is observable in
// the geometry and not only in a colour nobody can see from a smoke test.
const THEMES: Record<string, { gapsIn: number; gapsOut: number }> = {
  "aaa-wide": { gapsIn: 24, gapsOut: 40 },
  "bbb-tight": { gapsIn: 2, gapsOut: 4 },
};

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

function computeTiling(area: Rect, n: number, gapOut: number, gapIn: number): Rect[] {
  const out: Rect[] = [];
  if (n <= 0) return out;
  let region: Rect = {
    x: area.x + gapOut,
    y: area.y + gapOut,
    w: Math.max(1, area.w - 2 * gapOut),
    h: Math.max(1, area.h - 2 * gapOut),
  };
  for (let i = 0; i < n; i++) {
    if (i === n - 1) { out.push(region); break; }
    const near: Rect = { ...region };
    const rest: Rect = { ...region };
    if (region.w >= region.h) {
      const half = Math.max(1, Math.floor((region.w - gapIn) / 2));
      near.w = half;
      rest.x = region.x + half + gapIn;
      rest.w = region.w - half - gapIn;
    } else {
      const half = Math.max(1, Math.floor((region.h - gapIn) / 2));
      near.h = half;
      rest.y = region.y + half + gapIn;
      rest.h = region.h - half - gapIn;
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

// A theme root holding both palettes, plus the compositor config selecting one.
function stageThemes(): { themeDir: string; confPath: string } {
  const root = mkdtempSync(join(tmpdir(), "kandelo-themes-"));
  for (const [name, t] of Object.entries(THEMES)) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "theme.conf"),
      [
        `# ${name}`,
        "border_active = 0xff0000",
        "wallpaper_top = 0x101010",
        "wallpaper_bottom = 0x202020",
        "bar = 0x161822",
        "foreground = 0xc8cedc",
        "accent = 0x7aa2f7",
        `gaps_in = ${t.gapsIn}`,
        `gaps_out = ${t.gapsOut}`,
        "",
      ].join("\n"));
  }
  const confPath = join(root, "wlcompositor.conf");
  writeFileSync(confPath, "theme = aaa-wide\nbind = SUPER, Return, exec, wlterm\n");
  return { themeDir: root, confPath };
}

describe("wlcompositor — theme system", () => {
  it.skipIf(!hasBinaries)(
    "loads the configured theme, cycles to the next one live, and tells clients",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const clientBytes = loadBytes(clientBin!);
      const kbarBytes = loadBytes(kbarBin!);
      const kwlctlBytes = loadBytes(kwlctlBin!);
      const { themeDir, confPath } = stageThemes();

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
          env: [
            "WLC_LAYOUT=dwindle",
            `WLC_CONFIG=${confPath}`,
            `WLC_THEME_DIR=${themeDir}`,
          ],
        });
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);

        // 1) The configured theme is live, and its gaps drive the layout.
        expect(out.value, `config theme not loaded.\n${dump()}`)
          .toMatch(/THEME aaa-wide/);

        host.spawn(clientBytes, ["wlclient-test"], {});
        host.spawn(clientBytes, ["wlclient-test"], {});
        await waitFor(out, /TILE n=2 i=1 /, 20_000, dump);
        expect(parseTiles(out.value, 2), `wide-gap tiling mismatch.\n${dump()}`)
          .toEqual(computeTiling({ x: 0, y: 0, w: CANVAS_W, h: CANVAS_H }, 2,
            THEMES["aaa-wide"].gapsOut, THEMES["aaa-wide"].gapsIn));

        // A shell client subscribes to the stream before the switch.
        host.spawn(kbarBytes, ["kbar"], { env: [`KANDELO_THEME_DIR=${themeDir}`] });
        await waitFor(out, /KBAR_THEME name=aaa-wide/, 20_000, dump);

        // 2) Cycle to the next installed theme without a restart.
        out.value = "";
        await host.spawn(kwlctlBytes, ["kwlctl", "dispatch", "theme", "next"], {});
        await waitFor(out, /THEME bbb-tight/, 10_000, dump);
        await waitFor(out, /TILE n=2 i=1 /, 10_000, dump);
        // The bar is up by now, so the new gaps apply to the work area left
        // under its exclusive zone — theme and layer-shell compose.
        expect(parseTiles(out.value, 2), `re-tile ignored new gaps.\n${dump()}`)
          .toEqual(computeTiling({ x: 0, y: BAR_H, w: CANVAS_W, h: CANVAS_H - BAR_H },
            2, THEMES["bbb-tight"].gapsOut, THEMES["bbb-tight"].gapsIn));

        // 3) The bar reloaded its own palette off the broadcast.
        await waitFor(out, /KBAR_THEME name=bbb-tight/, 10_000, dump);

        // Cycling wraps back around the installed set, in both directions.
        await host.spawn(kwlctlBytes, ["kwlctl", "dispatch", "theme", "next"], {});
        await waitFor(out, /THEME aaa-wide/, 10_000, dump);
        out.value = "";
        await host.spawn(kwlctlBytes, ["kwlctl", "dispatch", "theme", "prev"], {});
        await waitFor(out, /THEME bbb-tight/, 10_000, dump);

        // An unknown theme is refused and leaves the live one alone. Anchored:
        // kbar's KBAR_THEME marker from the prev-switch may straggle in.
        out.value = "";
        await host.spawn(kwlctlBytes, ["kwlctl", "dispatch", "theme", "nope"], {});
        await waitFor(out, "err no such theme", 10_000, dump);
        expect(out.value, `a failed switch changed the theme.\n${dump()}`)
          .not.toMatch(/^THEME /m);
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );

  it.skipIf(!hasBinaries)(
    "reports the live theme and the installed set over kwlctl",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const kwlctlBytes = loadBytes(kwlctlBin!);
      const { themeDir, confPath } = stageThemes();

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
          env: [
            "WLC_LAYOUT=dwindle",
            `WLC_CONFIG=${confPath}`,
            `WLC_THEME_DIR=${themeDir}`,
          ],
        });
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);

        out.value = "";
        await host.spawn(kwlctlBytes, ["kwlctl", "theme"], {});
        await waitFor(out, /\{"name":/, 10_000, dump);
        const json = out.value.match(/\{"name":[^\n]*\}/);
        expect(json, `no theme JSON.\n${dump()}`).not.toBeNull();
        expect(JSON.parse(json![0])).toEqual({
          name: "aaa-wide",
          themes: ["aaa-wide", "bbb-tight"],
        });
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
