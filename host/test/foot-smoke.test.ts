/**
 * PR19 gate: unmodified upstream foot 1.17.2 (one declared shm patch —
 * gbm prime-fd pools, see packages/registry/foot/patches/) runs as a
 * real Wayland client under wlcompositor, on the ported font stack.
 *
 * The flow, and what each step proves:
 *
 *   - foot connects via stock wl_display_connect() (XDG_RUNTIME_DIR=/tmp
 *     → /tmp/wayland-0), binds the globals, and negotiates xdg-shell +
 *     server-side decorations;
 *   - fontconfig resolves "monospace" through the staged fonts.conf and
 *     fcft rasterizes with the staged Inconsolata — foot aborts at
 *     startup if the font stack fails;
 *   - its first commit reaches card0: the compositor samples the
 *     composited pixels (COMPOSITE_SAMPLE) and flips (FLIP first=1) —
 *     which also proves the patched gbm-pool shm path carries pixels
 *     across the process boundary;
 *   - foot forks dash (fork instrumentation at work), host-injected
 *     keys spell "exit\n" — compositor keymap → foot's xkb state → PTY —
 *     and dash exits;
 *   - foot exits 0, and the compositor exits 0 once it disconnects.
 *
 * Skips if any binary is missing (bare checkout — foot comes from the
 * package cache / binaries tree).
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

const compositorBin = tryResolveBinary("programs/wldesktop/wlcompositor.wasm");
const footBin = tryResolveBinary("programs/foot.wasm");
const dashBin = tryResolveBinary("programs/dash.wasm");
const hasBinaries =
  !!compositorBin && !!footBin && !!dashBin && existsSync(dashBin!);

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

describe("foot — upstream terminal on wlcompositor + the ported font stack", () => {
  it.skipIf(!hasBinaries)(
    "boots, renders through gbm shm pools, types into dash, exits clean",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const footBytes = loadBytes(footBin!);
      const dashBytes = loadBytes(dashBin!);

      const root = mkdtempSync(join(tmpdir(), "kandelo-foot-"));
      const fontDir = join(root, "fonts");
      mkdirSync(fontDir);
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

      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
        // foot's slave fork execvp's the shell; musl walks PATH.
        onResolveExec: (path) =>
          path === "dash" || path.endsWith("/dash") ? dashBytes : null,
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

        const compExit = host.spawn(compositorBytes, ["wlcompositor"], {
          env: ["WLC_LAYOUT=dwindle"],
        });
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);

        const footExit = host.spawn(
          footBytes,
          ["foot", "--term=vt100", "--override=main.workers=0", "dash"],
          {
            env: [
              "PATH=/usr/bin:/bin",
              "HOME=/root",
              "XDG_RUNTIME_DIR=/tmp",
              // The Node smokes run on host-FS passthrough, where the
              // rootfs's /usr/share/X11/xkb doesn't exist — and
              // xkb_context_new(NO_FLAGS) hard-fails without a readable
              // include root. Any existing dir satisfies it; clients
              // compile the compositor's keymap string, not disk data.
              "XKB_CONFIG_ROOT=/tmp",
              `FONTCONFIG_FILE=${confPath}`,
            ],
          },
        );

        await waitFor(out, "CLIENT_CONNECTED count=1", 30_000, dump);

        // foot's window composited onto card0 — the gbm shm-pool path
        // carried the client's pixels across the process boundary.
        await waitFor(out, "COMPOSITE_SAMPLE", 30_000, dump);
        expect(out.value).toMatch(/FLIP fb=\d+ first=1/);
        // dwindle tiled foot as the sole window.
        expect(out.value).toMatch(/TILE n=1 i=0 /);

        // Type "exit\n" into the focused terminal; dash exits, foot follows.
        await new Promise((r) => setTimeout(r, 2000));
        for (const key of [KEY_E, KEY_X, KEY_I, KEY_T, KEY_ENTER]) tap(key);

        const footCode = await Promise.race([
          footExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`foot timed out.\n${dump()}`)), 30_000)),
        ]);
        expect(footCode, `foot exit.\n${dump()}`).toBe(0);

        const compCode = await Promise.race([
          compExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`compositor timed out.\n${dump()}`)), 10_000)),
        ]);
        expect(compCode, `compositor exit.\n${dump()}`).toBe(0);
        expect(out.value).toContain("COMPOSITOR_LAST_CLIENT_GONE");
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    120_000,
  );
});
