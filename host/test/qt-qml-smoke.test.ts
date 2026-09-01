/*
 * Stage-3 gate for the Qt port (packages/registry/qtdeclarative): the
 * QML engine and the QtQuick software scenegraph run on the kernel.
 *
 * test/build-qml-smoke.sh links the static QML layout — plugin
 * archives under qml/ in the prefix, module runtimes under lib/ — and
 * test/qt_qml_smoke.cpp loads QML from a byte array, renders it
 * through the software scenegraph on the offscreen platform, and
 * asserts pixels from QQuickWindow::grabWindow().
 *
 * The font comes from a staged fonts.conf, as in the qtbase gui smoke:
 * the QML Text item asserts ink, not a family name.
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
  "packages/registry/qtdeclarative/test/build-qml-smoke.sh",
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

describe("qtdeclarative — QML and the software scenegraph on the kernel", () => {
  it.skipIf(!canBuild)(
    "loads QML, renders through the software scenegraph and grabs pixels",
    async () => {
      workDir = mkdtempSync(join(tmpdir(), "qt-qml-smoke-"));
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

      const programPath = join(workDir, "qt_qml_smoke.wasm");
      const built = execFileSync("bash", [BUILD_SCRIPT, programPath], {
        encoding: "utf8",
      });
      expect(built, built).toContain("QT_QML_SMOKE_BUILT");

      const result = await runCentralizedProgram({
        programPath,
        argv: ["qt_qml_smoke"],
        env: [`FONTCONFIG_FILE=${confPath}`],
        timeout: 120_000,
      });

      const dump = `stdout=${result.stdout}\nstderr=${result.stderr}`;
      expect(result.exitCode, dump).toBe(0);
      expect(result.stdout).toContain("QT_VERSION=6.10.2");
      expect(result.stdout).toContain("PLATFORM=offscreen");
      expect(result.stdout).toContain("QML_WINDOW=yes");
      expect(result.stdout).toContain("SCENEGRAPH_SOFTWARE=yes");
      expect(result.stdout).toContain("CORNER=ff000000");
      expect(result.stdout).toContain("CENTRE=ffff0000");
      expect(result.stdout).toContain("QT_QML_SMOKE_OK");

      const inked = Number(
        result.stdout.match(/GLYPH_PIXELS=(\d+)/)?.[1] ?? "0",
      );
      expect(inked, dump).toBeGreaterThan(0);
    },
    900_000,
  );
});
