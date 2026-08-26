/**
 * PR24 gate (GTK3 leg): unmodified GTK 3.24.34, wayland backend only,
 * runs as a real Wayland client under wlcompositor.
 *
 * The flow, and what each step proves:
 *
 *   - gtk_init connects via stock wl_display_connect() and prints the
 *     display's GObject type name — GdkWaylandDisplay proves the
 *     wayland backend (not a broken fallback) is live;
 *   - a GtkWindow holding a GtkLabel maps through xdg-shell; pango
 *     shapes the label text through the PR23 render stack and GTK
 *     paints it into a wl_shm buffer (cairo image surface);
 *   - the window's first draw fires — the "GTK3-SMOKE: draw" marker;
 *   - the compositor samples the composited pixels (COMPOSITE_SAMPLE)
 *     and flips, proving GTK's buffer crossed the process boundary;
 *   - the smoke quits its main loop and exits 0; the compositor exits
 *     0 once it disconnects.
 *
 * Skips if any binary is missing (bare checkout — gtk3_smoke.wasm is
 * built by scripts/build-programs.sh, which resolves the gtk3 package
 * closure).
 */
import { describe, expect, it } from "vitest";
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
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
const gtkSmokeBin = tryResolveBinary("programs/gtk3_smoke.wasm");
const hasBinaries = !!compositorBin && !!gtkSmokeBin;

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

describe("gtk3 — unmodified GTK 3.24 wayland client on wlcompositor", () => {
  it.skipIf(!hasBinaries)(
    "maps a window, renders a label, composites, exits clean",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const gtkBytes = loadBytes(gtkSmokeBin!);

      const root = mkdtempSync(join(tmpdir(), "kandelo-gtk3-"));
      const fontDir = join(root, "fonts");
      const cacheDir = join(root, "cache");
      mkdirSync(fontDir);
      mkdirSync(cacheDir);
      copyFileSync(INCONSOLATA, join(fontDir, "Inconsolata-Regular.ttf"));
      const confPath = join(root, "fonts.conf");
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
</fontconfig>
`,
      );

      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
      });
      const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;

      try {
        await host.init();

        const compExit = host.spawn(compositorBytes, ["wlcompositor"], {
          env: ["WLC_LAYOUT=dwindle"],
        });
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);

        const gtkExit = host.spawn(gtkBytes, ["gtk3_smoke"], {
          env: [
            "HOME=/root",
            "XDG_RUNTIME_DIR=/tmp",
            "GDK_BACKEND=wayland",
            "XKB_CONFIG_ROOT=/tmp",
            `FONTCONFIG_FILE=${confPath}`,
          ],
        });

        await waitFor(out, "CLIENT_CONNECTED count=1", 30_000, dump);
        await waitFor(out, "GTK3-SMOKE: init backend=GdkWaylandDisplay", 30_000, dump);
        await waitFor(out, "GTK3-SMOKE: draw", 30_000, dump);
        await waitFor(out, "COMPOSITE_SAMPLE", 30_000, dump);

        const gtkCode = await Promise.race([
          gtkExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`gtk3_smoke timed out.\n${dump()}`)), 30_000)),
        ]);
        expect(gtkCode, `gtk3_smoke exit.\n${dump()}`).toBe(0);
        expect(out.value).toContain("GTK3-SMOKE: exit");

        // The window's pixels reached the compositor: gdk-wayland backs its
        // wl_shm pool with a gbm prime-fd dumb bo, so every buffer imports.
        // A memfd-backed pool (upstream's default) fails here instead, once
        // per buffer, and the window composites as nothing.
        expect(err.value, `a client buffer failed to import.\n${dump()}`)
          .not.toContain("gbm_bo_import");

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
