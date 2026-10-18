/**
 * PR24 gate (GTK3 leg): unmodified GTK 3.24.34, wayland backend only,
 * runs as the session client of cage, the wlroots kiosk compositor.
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
 *   - wlroots reads GTK's buffer by mapping the pool's PRIME fd; a
 *     failed mapping is a protocol error that disconnects the client;
 *   - the smoke quits its main loop and exits 0, and cage exits with its
 *     status.
 *
 * Skips if any binary is missing (bare checkout — gtk3_smoke.wasm is
 * built by scripts/build-programs.sh, which resolves the gtk3 package
 * closure).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

const gtkSmokeBin = tryResolveBinary("programs/gtk3_smoke.wasm");
const hasBinaries = hasSession("cage") && !!gtkSmokeBin;

const FONT_DIR = "/usr/share/fonts";
const FONTS_CONF = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${FONT_DIR}</dir>
  <cachedir>/tmp/fontconfig</cachedir>
  <alias>
    <family>sans-serif</family>
    <prefer><family>Inconsolata</family></prefer>
  </alias>
</fontconfig>
`;

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

describe("gtk3 — unmodified GTK 3.24 wayland client on cage", () => {
  it.skipIf(!hasBinaries)(
    "maps a window, renders a label, exits clean",
    async () => {
      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        rootfsImage: await sessionRootfs("cage", [
          { path: "/usr/bin/gtk3_smoke", bytes: new Uint8Array(readFileSync(gtkSmokeBin!)), mode: 0o755 },
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

      try {
        await host.init();

        const cageExit = host.spawn(compositorBytes("cage"), ["cage", "--", "/usr/bin/gtk3_smoke"], {
          env: [...WLROOTS_ENV, "HOME=/root", "GDK_BACKEND=wayland"],
        });

        await waitFor(out, "GTK3-SMOKE: init backend=GdkWaylandDisplay", 30_000, dump);
        await waitFor(out, "GTK3-SMOKE: draw", 30_000, dump);

        const cageCode = await Promise.race([
          cageExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`cage timed out.\n${dump()}`)), 30_000)),
        ]);
        expect(cageCode, `cage exit.\n${dump()}`).toBe(0);
        expect(out.value).toContain("GTK3-SMOKE: exit");
        expect(err.value, `the client was disconnected.\n${dump()}`)
          .not.toContain("error in client communication");
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    120_000,
  );
});
