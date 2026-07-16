/**
 * PR14d gate: the wlcompositor's config-file keybind engine.
 *
 * Two paths:
 *   1. No config file -> generic default binds (BINDS_LOADED source=default).
 *      Injecting SUPER+3 / SUPER+1 via evdev drives the workspace dispatcher
 *      (observed on the kwlctl --listen stream), and SUPER+J cycles keyboard
 *      focus between windows (observed via kwlctl activewindow).
 *   2. A hyprland.conf-shaped file pointed at by WLC_CONFIG is parsed
 *      (BINDS_LOADED source=<path>); its custom `SUPER, 5, workspace, 7`
 *      binding fires workspace 7 — proving config -> behavior, not the default.
 *
 * The keybind engine intercepts bound combos in the compositor's keyboard path
 * before the focused client, so this is entirely in-kernel — no host/src change.
 * Skips if the binaries aren't built.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const compositorBin = tryResolveBinary("programs/wlcompositor.wasm");
const clientBin = tryResolveBinary("programs/wlclient-test.wasm");
const kwlctlBin = tryResolveBinary("programs/kwlctl.wasm");
const hasBinaries = !!compositorBin && !!clientBin && !!kwlctlBin;

const CANVAS_W = 1920;
const CANVAS_H = 1080;

// evdev keycodes (linux/input-event-codes.h).
const EV_KEY = 0x01;
const EV_SYN = 0x00;
const SYN_REPORT = 0x00;
const KEY_1 = 2;
const KEY_3 = 4;
const KEY_5 = 6;
const KEY_W = 17;
const KEY_J = 36;
const KEY_K = 37;
const KEY_LEFTMETA = 125; // SUPER

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

describe("wlcompositor — config-file keybind engine", () => {
  it.skipIf(!hasBinaries)(
    "default binds drive workspace + focus-cycle dispatchers via evdev",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const clientBytes = loadBytes(clientBin!);
      const kwlctlBytes = loadBytes(kwlctlBin!);

      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
      });
      const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;
      const activeAddress = async (): Promise<string> => {
        out.value = out.value.replace(/\{"address"[^\n]*/g, ""); // clear stale
        await host.spawn(kwlctlBytes, ["kwlctl", "activewindow"], {});
        const m = out.value.match(/\{"address":"([^"]+)"/);
        expect(m, `no activewindow.\n${dump()}`).not.toBeNull();
        return m![1];
      };

      const tap = (code: number) => {
        host.injectInputEvent(0, EV_KEY, KEY_LEFTMETA, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, code, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, code, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, KEY_LEFTMETA, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
      };

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        // No WLC_CONFIG -> generic defaults.
        const compExit = host.spawn(compositorBytes, ["wlcompositor"], {
          env: ["WLC_LAYOUT=dwindle"],
        });
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);
        expect(out.value, `not default binds.\n${dump()}`)
          .toMatch(/BINDS_LOADED n=\d+ source=default/);

        host.spawn(clientBytes, ["wlclient-test"], {});
        host.spawn(clientBytes, ["wlclient-test"], {});
        await waitFor(out, /TILE n=2 i=1 /, 20_000, dump);

        host.spawn(kwlctlBytes, ["kwlctl", "--listen"], {});
        await waitFor(out, "listening", 10_000, dump);

        // SUPER+3 -> workspace 3, SUPER+1 -> workspace 1 (default binds).
        tap(KEY_3);
        await waitFor(out, "workspace>>3", 10_000, dump);
        tap(KEY_1);
        await waitFor(out, "workspace>>1", 10_000, dump);

        // SUPER+J (cyclenext) / SUPER+K (cycleprev) move focus and back.
        const before = await activeAddress();
        tap(KEY_J);
        await waitFor(out, "activewindow>>", 10_000, dump);
        const after = await activeAddress();
        expect(after, `cyclenext did not move focus.\n${dump()}`).not.toBe(before);
        tap(KEY_K);
        const restored = await activeAddress();
        expect(restored, `cycleprev did not restore focus.\n${dump()}`).toBe(before);

        // SUPER+W (killactive) closes the focused window; it exits and ws 1
        // re-tiles down to the single remaining window.
        tap(KEY_W);
        await waitFor(out, "CLIENT_CLOSED", 10_000, dump);
        await waitFor(out, /TILE n=1 /, 10_000, dump);

        void compExit;
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );

  it.skipIf(!hasBinaries)(
    "a WLC_CONFIG file is parsed and its custom bind overrides the default",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const clientBytes = loadBytes(clientBin!);
      const kwlctlBytes = loadBytes(kwlctlBin!);

      const dir = mkdtempSync(join(tmpdir(), "wlc-conf-"));
      const confPath = join(dir, "wlcompositor.conf");
      // SUPER+5 -> workspace 7 (the default would be workspace 5).
      writeFileSync(confPath,
        "# kandelo test config\nbind = SUPER, 5, workspace, 7\n");

      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
      });
      const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;

      const tap = (code: number) => {
        host.injectInputEvent(0, EV_KEY, KEY_LEFTMETA, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, code, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, code, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, KEY_LEFTMETA, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
      };

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        const compExit = host.spawn(compositorBytes, ["wlcompositor"], {
          env: ["WLC_LAYOUT=dwindle", `WLC_CONFIG=${confPath}`],
        });
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);
        expect(out.value, `config not parsed.\n${dump()}`)
          .toContain(`BINDS_LOADED n=1 source=${confPath}`);

        host.spawn(clientBytes, ["wlclient-test"], {});
        await waitFor(out, "CLIENT_CONNECTED count=1", 20_000, dump);

        host.spawn(kwlctlBytes, ["kwlctl", "--listen"], {});
        await waitFor(out, "listening", 10_000, dump);

        // The parsed bind sends SUPER+5 to workspace 7, not the default 5.
        tap(KEY_5);
        await waitFor(out, "workspace>>7", 10_000, dump);
        expect(out.value).not.toContain("workspace>>5");

        void compExit;
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
