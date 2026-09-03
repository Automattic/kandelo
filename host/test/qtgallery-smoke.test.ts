/**
 * Qt-on-the-desktop gate: qtgallery (the Omarchy theme gallery, a
 * QRasterWindow through the wayland QPA plugin) maps as a real window on
 * wlcompositor, receives a pointer click, and drives a theme switch.
 *
 * qt-gui-smoke proves QtGui paints on the offscreen platform; this is the
 * other half — the Wayland client path end to end: Qt's xdg-shell
 * integration configures against the compositor, the raster backing store
 * lands in wl_shm, and the compositor composites non-black pixels from it.
 * The injected click is the pointer half of that path: evdev → libinput →
 * wl_pointer → Qt's xkb-independent mouse delivery — and the activated
 * card's `dispatch theme` line on the kwlctl socket comes back as the
 * compositor's THEME marker, the whole demo loop in one gate. A
 * host-injected Escape then closes the window through Qt's xkb state and
 * both processes exit 0.
 *
 * The font comes from a staged fonts.conf, as in qt-gui-smoke: without it
 * fontconfig has no config and QtGui's font database is empty. The themes
 * are fixtures staged under WLC_THEME_DIR, which both the compositor and
 * the gallery read instead of /usr/share/kandelo/themes.
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
const qtgalleryBin = tryResolveBinary("programs/qtgallery.wasm");
const hasBinaries = !!compositorBin && !!qtgalleryBin;

const CANVAS_W = 1920;
const CANVAS_H = 1080;

// The compositor's cascade places the first unmatched window at (160, 120)
// (wlcompositor.c place_surface), and the gallery's first theme card sits at
// window-local (24, 88) with a 216x132 body (qtgallery.cpp layout constants).
const WINDOW_X = 160;
const WINDOW_Y = 120;
const CARD_CENTER_X = 24 + 108;
const CARD_CENTER_Y = 88 + 66;

// linux/input-event-codes.h
const EV_SYN = 0x00;
const EV_KEY = 0x01;
const EV_ABS = 0x03;
const SYN_REPORT = 0x00;
const ABS_X = 0x00;
const ABS_Y = 0x01;
const BTN_LEFT = 0x110;
const KEY_ESC = 1;

const THEME_CONF = `border_active = 0x7aa2f7
wallpaper_top = 0x1a1b26
wallpaper_bottom = 0x24283b
bar = 0x16161e
foreground = 0xc0caf5
accent = 0x7aa2f7
occupied = 0x292e42
background = 0x1a1b26
`;

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

describe("qtgallery — the theme gallery on the wayland desktop", () => {
  it.skipIf(!hasBinaries)(
    "maps through xdg-shell, takes a click, and switches the theme",
    async () => {
      workDir = mkdtempSync(join(tmpdir(), "qtgallery-smoke-"));
      const fontDir = join(workDir, "fonts");
      const cacheDir = join(workDir, "cache");
      const themesDir = join(workDir, "themes");
      const shellsDir = join(workDir, "shells");
      mkdirSync(fontDir);
      mkdirSync(cacheDir);
      for (const theme of ["bar", "foo"]) {
        mkdirSync(join(themesDir, theme), { recursive: true });
        writeFileSync(join(themesDir, theme, "theme.conf"), THEME_CONF);
      }
      mkdirSync(shellsDir);
      writeFileSync(join(shellsDir, "garply.qml"), "// fixture\n");
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
      const moveTo = (x: number, y: number) => {
        host.injectInputEvent(1, EV_ABS, ABS_X, x);
        host.injectInputEvent(1, EV_ABS, ABS_Y, y);
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
      };
      const click = () => {
        host.injectInputEvent(1, EV_KEY, BTN_LEFT, 1);
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(1, EV_KEY, BTN_LEFT, 0);
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
      };

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        const compExit = host.spawn(loadBytes(compositorBin!), ["wlcompositor"], {
          env: [`WLC_THEME_DIR=${themesDir}`],
        });
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);

        const galleryExit = host.spawn(loadBytes(qtgalleryBin!), ["qtgallery"], {
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
            `WLC_THEME_DIR=${themesDir}`,
            `QTGALLERY_SHELL_DIR=${shellsDir}`,
          ],
        });
        await waitFor(out, "GALLERY_PLATFORM=wayland", 30_000, dump);
        await waitFor(out, "GALLERY_THEMES n=2", 10_000, dump);
        await waitFor(out, "GALLERY_SHELLS n=1", 10_000, dump);
        await waitFor(out, /GALLERY_EXPOSED \d+x\d+/, 30_000, dump);

        // The compositor's sample is one-shot, emitted on the first composite
        // with a mapped surface — the gallery, the only client.
        await waitFor(out, "COMPOSITE_SAMPLE", 10_000, dump);
        const sample = out.value
          .match(/COMPOSITE_SAMPLE x=\d+ y=\d+ px=0x([0-9a-f]{8})/);
        expect(sample, `no composite sample.\n${dump()}`).not.toBeNull();
        expect(parseInt(sample![1], 16) & 0xffffff).not.toBe(0);

        // A real pointer click on the first theme card ("bar", first in
        // sorted order): motion targets the card center, the press activates
        // it, the gallery dispatches on the kwlctl socket, and the
        // compositor answers ok and prints the switch.
        moveTo(WINDOW_X + CARD_CENTER_X, WINDOW_Y + CARD_CENTER_Y);
        moveTo(WINDOW_X + CARD_CENTER_X + 2, WINDOW_Y + CARD_CENTER_Y + 2);
        click();
        await waitFor(out, "GALLERY_APPLY theme=bar reply=ok", 15_000, dump);
        await waitFor(out, "THEME bar", 10_000, dump);

        // Escape closes the window: compositor keymap → Qt's xkb state →
        // keyPressEvent → close(), and the compositor follows its last
        // client out.
        tap(KEY_ESC);
        const galleryCode = await Promise.race([
          galleryExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`qtgallery timed out.\n${dump()}`)), 30_000)),
        ]);
        expect(galleryCode, `qtgallery exit.\n${dump()}`).toBe(0);

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
