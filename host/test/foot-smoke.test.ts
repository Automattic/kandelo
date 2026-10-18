/**
 * Unmodified upstream foot 1.17.2 (one declared shm patch — gbm prime-fd
 * pools, see packages/registry/foot/patches/) runs as the session client
 * of cage, the wlroots kiosk compositor, on the ported font stack.
 *
 * The flow, and what each step proves:
 *
 *   - cage forks and execs foot, which connects via stock
 *     wl_display_connect() (XDG_RUNTIME_DIR=/tmp → /tmp/wayland-0), binds
 *     the globals, and negotiates xdg-shell + server-side decorations;
 *   - fontconfig resolves "monospace" through the staged fonts.conf and
 *     fcft rasterizes with the staged Inconsolata — foot aborts at
 *     startup if the font stack fails;
 *   - cage maps foot's toplevel only after a commit with a buffer, which
 *     wlroots reads by mapping the pool's PRIME fd, and only a mapped
 *     toplevel gets keyboard focus;
 *   - foot forks dash (fork instrumentation at work), host-injected
 *     keys spell "exit\n" — libinput → cage's keymap → foot's xkb state
 *     → PTY — and dash exits;
 *   - foot exits 0, and cage exits with foot's status.
 *
 * Skips if any binary is missing (bare checkout — foot comes from the
 * package cache / binaries tree).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";
import { WLROOTS_ENV, compositorBytes, hasSession, sessionRootfs } from "./wlroots-session";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const INCONSOLATA = join(
  REPO_ROOT,
  "third_party/Inconsolata-Regular.ttf",
);

const footBin = tryResolveBinary("programs/foot.wasm");
const dashBin = tryResolveBinary("programs/dash.wasm");
const hasBinaries = hasSession("cage") && !!footBin && !!dashBin && existsSync(dashBin!);

const FONT_DIR = "/usr/share/fonts";
const FONTS_CONF = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${FONT_DIR}</dir>
  <alias>
    <family>monospace</family>
    <prefer><family>Inconsolata</family></prefer>
  </alias>
</fontconfig>
`;

const CANVAS_W = 1920;
const CANVAS_H = 1080;

// linux/input-event-codes.h
const EV_SYN = 0x00;
const EV_KEY = 0x01;
const SYN_REPORT = 0x00;
const KEY_E = 18;
const KEY_X = 45;
const KEY_I = 23;
const KEY_T = 20;
const KEY_ENTER = 28;

describe("foot — upstream terminal on cage + the ported font stack", () => {
  it.skipIf(!hasBinaries)(
    "maps through gbm shm pools, types into dash, exits clean",
    async () => {
      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        rootfsImage: await sessionRootfs("cage", [
          { path: "/usr/bin/foot", bytes: new Uint8Array(readFileSync(footBin!)), mode: 0o755 },
          { path: "/bin/dash", bytes: new Uint8Array(readFileSync(dashBin!)), mode: 0o755 },
          {
            path: `${FONT_DIR}/Inconsolata-Regular.ttf`,
            bytes: new Uint8Array(readFileSync(INCONSOLATA)),
            mode: 0o644,
          },
          { path: "/etc/fonts/fonts.conf", bytes: new TextEncoder().encode(FONTS_CONF), mode: 0o644 },
        ]),
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

        const start = Date.now();
        const cageExit = host.spawn(
          compositorBytes("cage"),
          ["cage", "--", "/usr/bin/foot", "--term=vt100", "--override=main.workers=0", "dash"],
          { env: [...WLROOTS_ENV, "PATH=/usr/bin:/bin", "HOME=/root"] },
        );

        // Keys reach foot only once cage has mapped its toplevel and
        // focused it; before that wlroots drops them. Type "exit\n" until
        // dash exits, foot follows, and cage exits with foot's status.
        let exited = false;
        const exit = cageExit.finally(() => { exited = true; });
        while (!exited && Date.now() < start + 60_000) {
          for (const key of [KEY_E, KEY_X, KEY_I, KEY_T, KEY_ENTER]) tap(key);
          await new Promise((r) => setTimeout(r, 3000));
        }

        const cageCode = await Promise.race([
          exit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`cage timed out.\n${dump()}`)), 5_000)),
        ]);
        expect(cageCode, `cage exit.\n${dump()}`).toBe(0);
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    120_000,
  );
});
