/**
 * Upstream fuzzel 1.15.0 runs as a sway layer-shell client on the ported
 * font stack and launches an application from its desktop entry.
 *
 * The flow, and what each step proves:
 *
 *   - sway's config `exec` forks fuzzel, which maps an overlay layer
 *     surface with exclusive keyboard interactivity, so sway gives it the
 *     keyboard;
 *   - fontconfig resolves fuzzel's default "monospace" through the staged
 *     fonts.conf, and fcft rasterizes the staged Inconsolata;
 *   - fuzzel lists the one entry it reads from
 *     /usr/share/applications, and Enter launches it: fuzzel forks and
 *     execs the entry's Exec line (fork instrumentation at work);
 *   - the launched foot maps as a sway window with app_id foot, as
 *     swaymsg `get_tree` reports, and swaymsg `exit` ends the session
 *     with status 0.
 *
 * Requires the normal sway, fuzzel, foot and shell package artifacts. A missing
 * artifact is a provisioning failure, not passing or skipped coverage.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";
import { WLROOTS_ENV, compositorBytes, requireSession, sessionRootfs } from "./wlroots-session";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INCONSOLATA = join(__dirname, "../../third_party/Inconsolata-Regular.ttf");

const fuzzelBin = resolveBinary("programs/fuzzel.wasm");
const swaymsgBin = resolveBinary("programs/sway/swaymsg.wasm");
const footBin = resolveBinary("programs/foot.wasm");
const dashBin = resolveBinary("programs/dash.wasm");
requireSession("sway");

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const SWAYSOCK = "/tmp/sway-ipc.sock";

const FONT_DIR = "/usr/share/fonts";
const FONTS_CONF = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${FONT_DIR}</dir>
  <cachedir>/tmp/fontconfig</cachedir>
  <alias>
    <family>monospace</family>
    <prefer><family>Inconsolata</family></prefer>
  </alias>
</fontconfig>
`;

const DESKTOP_ENTRY = `[Desktop Entry]
Type=Application
Name=foo
Exec=foot --term=vt100 --override=main.workers=0 sh
`;

// linux/input-event-codes.h
const EV_SYN = 0x00;
const EV_KEY = 0x01;
const SYN_REPORT = 0x00;
const KEY_ENTER = 28;

function bytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

function arrayBuffer(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe("fuzzel — upstream launcher on sway + the ported font stack", () => {
  it(
    "takes the keyboard as a layer surface and launches a desktop entry on Enter",
    async () => {
      const out = { value: "" };
      const err = { value: "" };
      const encode = (text: string) => new TextEncoder().encode(text);
      const host = new NodeKernelHost({
        rootfsImage: await sessionRootfs("sway", [
          { path: "/bin/sh", bytes: bytes(dashBin!), mode: 0o755 },
          { path: "/usr/bin/fuzzel", bytes: bytes(fuzzelBin!), mode: 0o755 },
          { path: "/usr/bin/foot", bytes: bytes(footBin!), mode: 0o755 },
          { path: "/usr/share/applications/foo.desktop", bytes: encode(DESKTOP_ENTRY), mode: 0o644 },
          { path: `${FONT_DIR}/Inconsolata-Regular.ttf`, bytes: bytes(INCONSOLATA), mode: 0o644 },
          { path: "/etc/fonts/fonts.conf", bytes: encode(FONTS_CONF), mode: 0o644 },
          { path: "/etc/sway/config", bytes: encode("exec fuzzel\n"), mode: 0o644 },
        ]),
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
      });
      const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;
      const env = [...WLROOTS_ENV, "PATH=/usr/bin:/bin", "HOME=/tmp", `SWAYSOCK=${SWAYSOCK}`];

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);
        const swayExit = host.spawn(compositorBytes("sway"), ["sway"], { env });

        const swaymsg = async (...args: string[]) => {
          const before = out.value.length;
          const code = await host.spawn(arrayBuffer(swaymsgBin!), ["swaymsg", ...args], { env });
          expect(code, `swaymsg ${args.join(" ")}.\n${dump()}`).toBe(0);
          return out.value.slice(before);
        };

        // Keys reach fuzzel only once sway has mapped its layer surface and
        // given it the keyboard; before that sway has no focus to send them
        // to. Press Enter until the launched foot maps.
        const deadline = Date.now() + 90_000;
        let launched = false;
        while (!launched && Date.now() < deadline) {
          host.injectInputEvent(0, EV_KEY, KEY_ENTER, 1);
          host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
          host.injectInputEvent(0, EV_KEY, KEY_ENTER, 0);
          host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
          await new Promise((r) => setTimeout(r, 2000));
          launched = (await swaymsg("-t", "get_tree")).includes('"app_id": "foot"');
        }
        expect(launched, `fuzzel did not launch its entry.\n${dump()}`).toBe(true);

        await host.spawn(arrayBuffer(swaymsgBin!), ["swaymsg", "exit"], { env });
        const swayCode = await Promise.race([
          swayExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`sway timed out.\n${dump()}`)), 30_000)),
        ]);
        expect(swayCode, `sway exit.\n${dump()}`).toBe(0);
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    180_000,
  );
});
