/**
 * PR24 O2 gate, bar side: unmodified upstream Waybar 0.14.0 runs as a
 * GTK3 + gtk-layer-shell client under wlcompositor, with its hyprland
 * modules speaking Hyprland IPC against the compositor's socket pair
 * (/tmp/hypr/wlcompositor/.socket.sock + .socket2.sock).
 *
 * The flow, and what each step proves:
 *
 *   - Waybar connects via GTK's wayland backend (XDG_RUNTIME_DIR=/tmp →
 *     /tmp/wayland-0), reads the staged config + stylesheet, and maps
 *     its bar as a wlr-layer-shell surface through gtk-layer-shell (the
 *     compositor's LAYER ns=waybar marker, exclusive strip h>0);
 *   - the hyprland/workspaces module queries socket1 (j/workspaces,
 *     j/monitors) and attaches to the socket2 event stream — the
 *     compositor's HYPR_LISTENER marker;
 *   - `kwlctl dispatch workspace 2` fires workspace/workspacev2 events
 *     through that stream and the bar keeps running;
 *   - a stylesheet rewrite plus `kill -USR2` reloads the bar, which is
 *     what the omarchy demo's theme switch rides on. Waybar answers
 *     SIGUSR2 from a detached thread blocked on a signal pipe
 *     (src/main.cpp catchSignals), so this also covers signal delivery
 *     to a multi-threaded process — see
 *     host/test/signal-to-threaded.test.ts for the minimal case.
 *
 * The orchestrating shell must be dash: exec targets resolved via
 * onResolveExec are visible to exec() but not to PATH-search stat calls,
 * so the script invokes them by absolute path. Skips if any binary is
 * missing (bare checkout — waybar comes from the package cache).
 */
import { describe, expect, it } from "vitest";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const INCONSOLATA = join(
  REPO_ROOT,
  "examples/libs/wpkdraw/third_party/Inconsolata-Regular.ttf",
);

const compositorBin = tryResolveBinary("programs/wlcompositor.wasm");
const dashBin = tryResolveBinary("programs/dash.wasm");
const daemonBin = tryResolveBinary("programs/dbus/dbus-daemon.wasm");
const waybarBin = tryResolveBinary("programs/waybar.wasm");
const kwlctlBin = tryResolveBinary("programs/kwlctl.wasm");
const hasBinaries =
  !!compositorBin && !!dashBin && !!daemonBin && !!waybarBin && !!kwlctlBin &&
  existsSync(dashBin!);

const CANVAS_W = 1920;
const CANVAS_H = 1080;

// Unique per run: the kernel's /tmp is host-backed and persists across
// hosts, so a failed run's leftover socket node would EADDRINUSE the
// next daemon.
const BUS_SOCKET = `/tmp/dbus-waybar-${process.pid}.socket`;

// The script blocks on this until the test has seen the bar's layer
// surface. Sequencing on a compositor socket instead would be satisfied
// by a leftover node from an earlier run — /tmp is host-backed and
// outlives the host — and the workspace switch plus SIGINT would then
// land before waybar had even connected.
const GO_FILE = `/tmp/waybar-go-${process.pid}`;

const SESSION_CONF = `<busconfig>
  <type>session</type>
  <listen>unix:path=${BUS_SOCKET}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>`;

// Single-line: the orchestrating dash has no `cat`, so these are written
// with printf and must not contain newlines or single quotes.
const WAYBAR_CONFIG =
  `{ "layer": "top", "position": "top", "height": 26, ` +
  `"modules-left": ["hyprland/workspaces"], "modules-center": ["clock"], ` +
  `"hyprland/workspaces": { "format": "{name}", ` +
  `"persistent-workspaces": { "1": [], "2": [], "3": [] } }, ` +
  `"clock": { "format": "{:%H:%M}", "tooltip": false } }`;

const WAYBAR_STYLE =
  `* { font-family: monospace; font-size: 13px; } ` +
  `window#waybar { background: #1a1b26; color: #c0caf5; }`;

// The palette the SIGUSR2 reload picks up, standing in for a theme switch.
const WAYBAR_STYLE_RELOADED =
  `* { font-family: monospace; font-size: 13px; } ` +
  `window#waybar { background: #2d353b; color: #d3c6aa; }`;

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
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for "${needle}".\n${context()}`);
}

describe("waybar — upstream status bar on wlcompositor's Hyprland IPC", () => {
  it.skipIf(!hasBinaries)(
    "maps a layer-shell bar, attaches to the event stream, survives a workspace switch",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const dashBytes = loadBytes(dashBin!);
      const daemonBytes = loadBytes(daemonBin!);
      const waybarBytes = loadBytes(waybarBin!);
      const kwlctlBytes = loadBytes(kwlctlBin!);

      const root = mkdtempSync(join(tmpdir(), "kandelo-waybar-"));
      const fontDir = join(root, "fonts");
      mkdirSync(fontDir);
      // GTK builds its keymap through xkb_context_new() with default
      // flags, and that returns NULL when not one of its include paths
      // exists — the caller does not check, so the NULL context reaches
      // xkb_keymap_new_from_string and reads its atom table at address
      // 0. The rootfs image carries /usr/share/X11/xkb for exactly this
      // reason (MANIFEST), but this host runs with rootfsImage
      // undefined, so the guest sees the developer's real filesystem,
      // where that directory does not exist. Point the system path at
      // an empty directory we own: the keymap is the compositor's
      // self-contained string, so nothing is ever read from it.
      const xkbDir = join(root, "xkb");
      mkdirSync(xkbDir);
      copyFileSync(INCONSOLATA, join(fontDir, "Inconsolata-Regular.ttf"));
      const confPath = join(root, "fonts.conf");
      writeFileSync(
        confPath,
        `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontDir}</dir>
  <alias>
    <family>monospace</family>
    <prefer><family>Inconsolata</family></prefer>
  </alias>
</fontconfig>
`,
      );

      const script = [
        `printf '%s\\n' '${WAYBAR_CONFIG}' > /tmp/waybar-config.jsonc`,
        `printf '%s\\n' '${WAYBAR_STYLE}' > /tmp/waybar-style.css`,
        `printf '%s\\n' '${SESSION_CONF}' > /tmp/waybar-session.conf`,
        // Waybar is a Gtk::Application, so g_application_register needs a
        // session bus. Without one GIO tries to autolaunch and dies on the
        // missing machine-id; the omarchy demo passes the same address.
        `/bin/dbus-daemon --config-file=/tmp/waybar-session.conf --nofork &`,
        `b=0`,
        `while [ ! -S ${BUS_SOCKET} ] && [ $b -lt 20000 ]; do b=$((b+1)); done`,
        `export DBUS_SESSION_BUS_ADDRESS=unix:path=${BUS_SOCKET}`,
        `export HYPRLAND_INSTANCE_SIGNATURE=wlcompositor`,
        `/bin/waybar -c /tmp/waybar-config.jsonc -s /tmp/waybar-style.css &`,
        `bar_pid=$!`,
        // No sleep in this environment either: spin until the test has
        // seen the bar map, then drive the event stream.
        `i=0`,
        `while [ ! -f ${GO_FILE} ] && [ $i -lt 4000000 ]; do i=$((i+1)); done`,
        `/bin/kwlctl dispatch workspace 2`,
        `/bin/kwlctl dispatch workspace 1`,
        `j=0; while [ $j -lt 200000 ]; do j=$((j+1)); done`,
        // The omarchy theme switch: rewrite the stylesheet, then SIGUSR2
        // the bar. Waybar's default on-sigusr2 action is reload.
        `printf '%s\\n' '${WAYBAR_STYLE_RELOADED}' > /tmp/waybar-style.css`,
        `kill -USR2 $bar_pid`,
        `k=0; while [ $k -lt 400000 ]; do k=$((k+1)); done`,
        // `kill -0` probes without signalling: the bar must still be
        // running after the reload. Teardown is the host's job — the
        // test reaps the bar in `finally`.
        `kill -0 $bar_pid && echo WAYBAR_ALIVE=1`,
        `exit 0`,
      ].join("\n");

      const out = { value: "" };
      const err = { value: "" };
      // Waybar's own spdlog lines are asserted through this merged view:
      // which stream they land on is spdlog's business, not the test's.
      const log = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => {
          const text = new TextDecoder().decode(data);
          out.value += text;
          log.value += text;
        },
        onStderr: (_pid, data) => {
          const text = new TextDecoder().decode(data);
          err.value += text;
          log.value += text;
        },
        onResolveExec: (path) => {
          if (path.endsWith("/dbus-daemon")) return daemonBytes;
          if (path.endsWith("/waybar")) return waybarBytes;
          if (path.endsWith("/kwlctl")) return kwlctlBytes;
          return null;
        },
      });
      const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        // Never settles: the compositor runs until its last client goes,
        // and this test leaves the bar up for host.destroy() to reap.
        host.spawn(compositorBytes, ["wlcompositor"], {}).catch(() => {});
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);

        const dashExit = host.spawn(dashBytes, ["dash", "-c", script], {
          env: [
            "PATH=/bin",
            "HOME=/root",
            "XDG_RUNTIME_DIR=/tmp",
            `XKB_CONFIG_ROOT=${xkbDir}`,
            `FONTCONFIG_FILE=${confPath}`,
          ],
        });

        // The hyprland module attached to the socket2 event stream.
        await waitFor(out, "HYPR_LISTENER", 60_000, dump);

        // The bar mapped as a layer-shell surface with an exclusive strip.
        await waitFor(out, "LAYER ns=waybar", 60_000, dump);
        const layer = out.value.match(
          /LAYER ns=waybar layer=\d+ x=0 y=0 w=(\d+) h=(\d+)/);
        expect(layer, `no layer geometry.\n${dump()}`).not.toBeNull();
        expect(parseInt(layer![1], 10)).toBeGreaterThan(0);
        expect(parseInt(layer![2], 10)).toBeGreaterThan(0);

        // Release the script now that the bar is up: the workspace
        // switch it drives next is only a real test of the event stream
        // once waybar is listening on it.
        writeFileSync(GO_FILE, "");

        // The bar was still running after the workspace round trip —
        // it neither crashed on the events nor exited early.
        await waitFor(out, "WAYBAR_ALIVE=1", 60_000, dump);
        const dashCode = await Promise.race([
          dashExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`dash timed out.\n${dump()}`)), 30_000)),
        ]);
        expect(dashCode, `dash exit.\n${dump()}`).toBe(0);

        // The event stream carried the switch while waybar was attached:
        // both workspace lines must follow the bar's first LAYER line.
        const afterMap = out.value.split("LAYER ns=waybar").slice(1).join("");
        expect(afterMap, `no workspace events after the bar mapped.\n${dump()}`)
          .toMatch(/WORKSPACE active=2/);

        // SIGUSR2 reached the handler on waybar's signal thread, and the
        // bar re-read the rewritten stylesheet.
        await waitFor(log, "Reloading...", 30_000, dump);
        const deadline = Date.now() + 30_000;
        while (
          log.value.split("Using CSS file").length - 1 < 2 &&
          Date.now() < deadline
        ) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(
          log.value.split("Using CSS file").length - 1,
          `stylesheet not re-read after SIGUSR2.\n${dump()}`,
        ).toBeGreaterThanOrEqual(2);
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    180_000,
  );
});
