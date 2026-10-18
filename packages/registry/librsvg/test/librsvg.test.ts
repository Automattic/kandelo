import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  makeHostScratchTempRoot,
  runCentralizedProgram,
} from "../../../../host/test/centralized-test-helper";

/*
 * librsvg (a C API over a Rust core) renders SVG on the kernel: shapes
 * through cairo, text through pango/harfbuzz/fontconfig/freetype, and a
 * GdkPixbuf through gdk-pixbuf. The check program links the librsvg
 * package the normal way, from its .pc file.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../../..");
const BUILD_SCRIPT = join(__dirname, "build-render-check.sh");
const INCONSOLATA = join(REPO_ROOT, "third_party/Inconsolata-Regular.ttf");

// Building needs the dev shell (SDK, cargo, cargo-c for the package).
function hasToolchain(): boolean {
  for (const tool of ["wasm32posix-cc", "cargo-cbuild"]) {
    try {
      execFileSync(tool, ["--version"], { stdio: "ignore" });
    } catch {
      return false;
    }
  }
  return true;
}

const canBuild = hasToolchain();
let workDir: string | null = null;

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(!canBuild)("librsvg — SVG rendering on the kernel", () => {
  it("renders shapes, text and a pixbuf", async () => {
    workDir = makeHostScratchTempRoot("librsvg-render-");
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
</fontconfig>
`,
    );

    const programPath = join(workDir, "render-check.wasm");
    // The first resolve builds librsvg (Rust sysroot and crates) and any
    // missing dependency.
    const built = execFileSync("bash", [BUILD_SCRIPT, programPath], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(built, built).toContain("RSVG_RENDER_CHECK_BUILT");

    const pngPath = join(workDir, "shapes.png");
    const textPngPath = join(workDir, "text.png");
    const result = await runCentralizedProgram({
      programPath,
      argv: ["render-check", pngPath, textPngPath],
      env: [`FONTCONFIG_FILE=${confPath}`],
      timeout: 60_000,
      // No rootfs image: the guest sees the host filesystem, where the
      // font, its config and the PNG destination live.
      useDefaultRootfs: false,
    });
    const dump = `exit=${result.exitCode}\nstdout=${result.stdout}\nstderr=${result.stderr}`;
    expect(result.exitCode, dump).toBe(0);
    expect(result.stdout, dump).toContain("librsvg 2.63.2");
    expect(result.stdout, dump).toContain("RSVG RENDER OK");
    expect(result.stdout, dump).not.toContain("FAIL");
    expect(existsSync(pngPath)).toBe(true);
    expect(existsSync(textPngPath)).toBe(true);
  }, 2_400_000);
});
