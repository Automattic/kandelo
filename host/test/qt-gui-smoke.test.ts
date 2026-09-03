/*
 * Stage-2 gate for the Qt port (packages/registry/qtbase): QtGui and the
 * Wayland platform plugin run on the kernel.
 *
 * Qt 6.10 moved the Wayland client platform plugin into qtbase
 * (src/plugins/platforms/wayland), so one package delivers QtGui,
 * QtWaylandClient, the `wayland` QPA key and the xdg-shell integration.
 * test/build-gui-smoke.sh links them into a wasm32 program and
 * test/qt_gui_smoke.cpp asserts each one from inside the guest.
 *
 * The font comes from a staged fonts.conf, as in the gtk3, foot, mako
 * and waybar smokes. Without it fontconfig has no config and QtGui's
 * font database is empty.
 *
 * The QProcess pass re-execs the program with --child through forkfd's
 * generic fork() fallback (src/forkfd-generic-on-wasm.patch), staged as
 * an execPrograms entry so the guest path resolves.
 *
 * The build runs the resolver, so this needs the dev shell and a
 * buildable worktree. Outside those the test skips.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { afterAll, describe, expect, it } from "vitest";

import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const BUILD_SCRIPT = join(
  REPO_ROOT,
  "packages/registry/qtbase/test/build-gui-smoke.sh",
);
const INCONSOLATA = join(
  REPO_ROOT,
  "examples/libs/wpkdraw/third_party/Inconsolata-Regular.ttf",
);

function hasToolchain(): boolean {
  try {
    execFileSync("wasm32posix-c++", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const canBuild = hasToolchain();
let workDir: string | null = null;

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("qtbase — QtGui and the Wayland plugin on the kernel", () => {
  it.skipIf(!canBuild)(
    "registers the wayland QPA key, rasterises and typesets",
    async () => {
      workDir = mkdtempSync(join(tmpdir(), "qt-gui-smoke-"));
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
</fontconfig>
`,
      );

      const programPath = join(workDir, "qt_gui_smoke.wasm");
      const built = execFileSync("bash", [BUILD_SCRIPT, programPath], {
        encoding: "utf8",
      });
      expect(built, built).toContain("QT_GUI_SMOKE_BUILT");

      // argv[0] is the guest path the QProcess pass re-execs, so it must
      // name the execPrograms entry, not a bare program name.
      const guestPath = "/usr/local/bin/qt_gui_smoke";
      const result = await runCentralizedProgram({
        programPath,
        argv: [guestPath],
        env: [`FONTCONFIG_FILE=${confPath}`],
        execPrograms: new Map([[guestPath, programPath]]),
        timeout: 120_000,
      });

      const dump = `stdout=${result.stdout}\nstderr=${result.stderr}`;
      expect(result.exitCode, dump).toBe(0);
      expect(result.stdout).toContain("QT_VERSION=6.10.2");
      expect(result.stdout).toContain("PLATFORM=offscreen");
      expect(result.stdout).toContain("WAYLAND_PLUGIN=yes");
      expect(result.stdout).toContain("XDG_SHELL_PLUGIN=yes");
      expect(result.stdout).toContain("CORNER=ff000000");
      expect(result.stdout).toContain("CENTRE=ffff0000");
      expect(result.stdout).toContain("QPROCESS_EXIT=0");
      expect(result.stdout).toContain("QT_PROCESS_CHILD_OK");
      expect(result.stdout).toContain("QT_GUI_SMOKE_OK");

      const families = Number(
        result.stdout.match(/FONT_FAMILIES=(\d+)/)?.[1] ?? "0",
      );
      expect(families, dump).toBeGreaterThan(0);

      // Ink, not a family name: fontconfig matches and FreeType rasterises
      // the staged font, but QFontDatabase enumerates only Qt's generic
      // families here, so the staged name never appears.
      const inked = Number(
        result.stdout.match(/GLYPH_PIXELS=(\d+)/)?.[1] ?? "0",
      );
      expect(inked, dump).toBeGreaterThan(0);
    },
    900_000,
  );
});
