/*
 * Native unit test for the VT100 core in programs/wlterm/vt100.c: UTF-8
 * carried across reads, CSI parameter parsing, erasure, and scrolling regions. The
 * core depends on wpkdraw only for vt100_render, which
 * programs/wlterm/test/vt100_test.c stubs, so it compiles for the host
 * and runs here — no wasm/kernel/compositor needed. The wasm smoke
 * (wlterm-smoke.test.ts) sees only whole shell lines and cannot observe
 * a split character or an overflowing parameter.
 *
 * Built with -fsanitize=undefined and no recovery: the parameter cases
 * exist because signed overflow once passed silently, and without the
 * sanitizer an overflow could still land on an in-range cursor by luck.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const WLTERM_DIR = join(REPO_ROOT, "programs/wlterm");
const WPKDRAW_INCLUDE = join(REPO_ROOT, "examples/libs/wpkdraw/include");

import { describe, expect, it } from "vitest";

/* Pick the first working host C compiler, as sdl2-editor-unit.test.ts does. */
function findCompiler(): string | null {
  for (const cc of ["cc", "clang", "gcc"]) {
    try {
      execFileSync(cc, ["--version"], { stdio: "ignore" });
      return cc;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

describe("wlterm VT100 core (native unit test)", () => {
  it("passes every vt100_test.c case under UBSan", () => {
    const cc = findCompiler();
    expect(cc, "no host C compiler (cc/clang/gcc) found").not.toBeNull();

    const vt100C = join(WLTERM_DIR, "vt100.c");
    const testC = join(WLTERM_DIR, "test/vt100_test.c");
    expect(existsSync(vt100C) && existsSync(testC)).toBe(true);

    const work = mkdtempSync(join(tmpdir(), "wlterm-vt100-"));
    const bin = join(work, "vt100_test");
    try {
      execFileSync(
        cc!,
        [
          "-std=c11", "-Wall", "-Wextra", "-Werror", "-O1", "-g",
          "-fsanitize=undefined", "-fno-sanitize-recover=all",
          `-I${WPKDRAW_INCLUDE}`,
          vt100C, testC, "-o", bin,
        ],
        { stdio: "pipe" },
      );
      const out = execFileSync(bin, { encoding: "utf8" });
      expect(out, out).toContain("vt100_test: ALL PASS");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
