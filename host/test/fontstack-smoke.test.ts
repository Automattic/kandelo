/**
 * PR19 gate: the whole wasm32 font stack — freetype + fontconfig +
 * fcft over pixman — resolves a family and rasterizes a glyph against
 * the kernel.
 *
 * Runs `fontstack_smoke.wasm` (programs/fontstack_smoke.c) under the
 * centralized kernel with FONTCONFIG_FILE pointing at a staged
 * fonts.conf whose <dir> holds the in-tree Inconsolata TTF (the same
 * face wpkdraw embeds). "monospace" resolves through the alias, foot's
 * exact lookup path (docs/plans/2026-07-14-build-hyprland-class-
 * compositor-plan.md §4).
 *
 * The binary is built by scripts/build-programs.sh (which resolves the
 * font-stack packages and links their archives). Absent the binary the
 * test skips, matching the other program smoke tests.
 */
import { mkdtempSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { NodePlatformIO } from "../src/platform/node";
import { tryResolveBinary } from "../src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const INCONSOLATA = join(
  REPO_ROOT,
  "examples/libs/wpkdraw/third_party/Inconsolata-Regular.ttf",
);

const fontstackSmokeBinary = tryResolveBinary("programs/fontstack_smoke.wasm");
const hasBinary = !!fontstackSmokeBinary;

describe("font stack — fontconfig resolve + fcft rasterization on the kernel", () => {
  it.skipIf(!hasBinary)(
    "resolves monospace via fonts.conf and rasterizes a glyph with ink",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "kandelo-fonts-"));
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
    <family>monospace</family>
    <prefer><family>Inconsolata</family></prefer>
  </alias>
</fontconfig>
`,
      );

      // Raw host FS (main-thread mode): the staged fonts.conf and TTF live
      // in a host temp dir the mount-based rootfs cannot see.
      const result = await runCentralizedProgram({
        programPath: fontstackSmokeBinary!,
        argv: ["fontstack_smoke"],
        env: [`FONTCONFIG_FILE=${confPath}`, "HOME=/root"],
        io: new NodePlatformIO(),
        timeout: 30_000,
      });

      expect(
        result.exitCode,
        `fontstack_smoke exited non-zero. stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);

      expect(result.stdout).toMatch(/\[FONT\] height=\d+ ascent=\d+/);
      expect(result.stdout).toMatch(/\[GLYPH\] w=\d+ h=\d+ ink=[1-9]\d*/);
      expect(result.stdout).toContain("FONTSTACK_SMOKE_OK");
    },
    40_000,
  );
});
