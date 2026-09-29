/**
 * PR23 gate: the wasm32 render stack — pango + harfbuzz + fribidi over
 * cairo image surfaces, on the PR19 freetype/fontconfig fonts —
 * lays out and rasterizes text against the kernel.
 *
 * Runs `pango_cairo_smoke.wasm` (programs/pango_cairo_smoke.c) under
 * the centralized kernel with FONTCONFIG_FILE pointing at a staged
 * fonts.conf whose <dir> holds the in-tree Inconsolata TTF — the
 * fontstack-smoke staging pattern. The program prints an FNV-1a hash
 * over the rendered surface; with every layer pinned (TTF, freetype,
 * pango, cairo) the render is byte-stable, so the test asserts the
 * exact hash. A hash change means the render stack changed — update
 * the constant only after eyeballing why.
 *
 * The binary is built by scripts/build-programs.sh (which resolves the
 * render-stack packages and links their archives). Absent the binary
 * the test skips, matching the other program smoke tests.
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

const pangoCairoSmokeBinary = tryResolveBinary("programs/pango_cairo_smoke.wasm");
const hasBinary = !!pangoCairoSmokeBinary;

const EXPECTED_HASH = "63139fd5";

describe("render stack — pango layout + cairo rasterization on the kernel", () => {
  it.skipIf(!hasBinary)(
    "lays out monospace text and renders it with a stable pixel hash",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "kandelo-pango-"));
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
        programPath: pangoCairoSmokeBinary!,
        argv: ["pango_cairo_smoke"],
        env: [`FONTCONFIG_FILE=${confPath}`, "HOME=/root"],
        io: new NodePlatformIO(),
        timeout: 30_000,
      });

      expect(
        result.exitCode,
        `pango_cairo_smoke exited non-zero. stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);

      expect(result.stdout).toMatch(/\[LAYOUT\] w=\d+ h=\d+/);
      expect(result.stdout).toMatch(/\[INK\] n=[1-9]\d*/);
      expect(result.stdout).toContain(`[HASH] ${EXPECTED_HASH}`);
      expect(result.stdout).toContain("PANGO_CAIRO_OK");
    },
    40_000,
  );
});
