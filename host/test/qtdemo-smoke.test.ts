/**
 * Qt-on-the-desktop gate: qtdemo (a QRasterWindow through the wayland QPA
 * plugin) maps as a real window on wlcompositor and animates.
 *
 * qt-gui-smoke proves QtGui paints on the offscreen platform; this is the
 * other half — the Wayland client path end to end: Qt's xdg-shell
 * integration configures against the compositor, the raster backing store
 * lands in wl_shm, and the compositor composites non-black pixels from it.
 * The repeated QTDEMO_FRAME markers prove the frame-callback loop keeps
 * granting Qt new frames, not just the first one. A host-injected Escape
 * then closes the window through Qt's xkb state and both processes exit 0.
 *
 * The font comes from a staged fonts.conf, as in qt-gui-smoke: without it
 * fontconfig has no config and QtGui's font database is empty.
 *
 * Skips if the binaries aren't built (bare checkout).
 */
import { afterAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const qtdemoBin = tryResolveBinary("programs/qtdemo.wasm");
const hasBinaries = !!compositorBin && !!qtdemoBin;

const CANVAS_W = 1920;
const CANVAS_H = 1080;

// linux/input-event-codes.h
const EV_SYN = 0x00;
const EV_KEY = 0x01;
const SYN_REPORT = 0x00;
const KEY_ESC = 1;

let workDir: string | null = null;

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function waitFor(
  ref: { value: string },
  pattern: string | RegExp,
  timeoutMs: number,
  context: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = ref.value;
    if (typeof pattern === "string" ? s.includes(pattern) : pattern.test(s))
      return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${String(pattern)}.\n${context()}`);
}

describe("qtdemo — a Qt window on the wayland desktop", () => {
  it.skipIf(!hasBinaries)(
    "maps through xdg-shell, animates, and composites non-black pixels",
    async () => {
      workDir = mkdtempSync(join(tmpdir(), "qtdemo-smoke-"));
      const fontDir = join(workDir, "fonts");
      const cacheDir = join(workDir, "cache");
      mkdirSync(fontDir);
      mkdirSync(cacheDir);
      copyFileSync(INCONSOLATA, join(fontDir, "Inconsolata-Regular.ttf"));
      const confPath = join(workDir, "fonts.conf");
      writeFileSync(
        confPath,
        `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontDir}</dir>
  <cachedir>${cacheDir}</cachedir>
  <alias>
    <family>sans-serif</family>
    <prefer><family>Inconsolata</family></prefer>
  </alias>
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
      });
      const dump = () =>
        `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;
      const tap = (code: number) => {
        host.injectInputEvent(0, EV_KEY, code, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, code, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
      };

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        const compExit = host.spawn(loadBytes(compositorBin!), ["wlcompositor"], {});
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);

        const qtdemoExit = host.spawn(loadBytes(qtdemoBin!), ["qtdemo"], {
          env: [
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
        });
        await waitFor(out, "QTDEMO_PLATFORM=wayland", 30_000, dump);
        await waitFor(out, /QTDEMO_EXPOSED \d+x\d+/, 30_000, dump);

        // The frame-callback loop keeps granting frames: two successive
        // markers, not just the first paint.
        await waitFor(out, "QTDEMO_FRAME n=30", 30_000, dump);
        await waitFor(out, "QTDEMO_FRAME n=60", 30_000, dump);

        // The compositor's sample is one-shot, emitted on the first composite
        // with a mapped surface — qtdemo, the only client.
        await waitFor(out, "COMPOSITE_SAMPLE", 10_000, dump);
        const sample = out.value
          .match(/COMPOSITE_SAMPLE x=\d+ y=\d+ px=0x([0-9a-f]{8})/);
        expect(sample, `no composite sample.\n${dump()}`).not.toBeNull();
        expect(parseInt(sample![1], 16) & 0xffffff).not.toBe(0);

        // Escape closes the window: compositor keymap → Qt's xkb state →
        // keyPressEvent → close(), and the compositor follows its last
        // client out.
        tap(KEY_ESC);
        const qtdemoCode = await Promise.race([
          qtdemoExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`qtdemo timed out.\n${dump()}`)), 30_000)),
        ]);
        expect(qtdemoCode, `qtdemo exit.\n${dump()}`).toBe(0);

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
