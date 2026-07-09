/*
 * Native unit test for the pure gap-buffer logic in
 * programs/sdl2/editor.c. The editor module depends only on renderer.h
 * (stubbed in programs/sdl2/test/editor_test.c), so we compile it for
 * the host and run it here — no wasm/kernel/SDL needed. This gives the
 * selection / clipboard-dup / auto-replace / undo-redo logic a dedicated
 * gate that the wasm integration test (sdl2.test.ts) can't observe, since
 * those behaviors emit no stdout breadcrumb.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const SDL2_DIR = join(REPO_ROOT, "programs/sdl2");

import { describe, expect, it } from "vitest";

/* Pick the first working host C compiler. The CLAUDE.md gate runs vitest
 * inside scripts/dev-shell.sh (clang present); macOS dev boxes have
 * /usr/bin/clang and cc. */
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

describe("SDL2 editor — pure gap-buffer logic (native unit test)", () => {
  it("passes every editor_test.c case", () => {
    const cc = findCompiler();
    expect(cc, "no host C compiler (cc/clang/gcc) found").not.toBeNull();

    const editorC = join(SDL2_DIR, "editor.c");
    const testC = join(SDL2_DIR, "test/editor_test.c");
    expect(existsSync(editorC) && existsSync(testC)).toBe(true);

    const work = mkdtempSync(join(tmpdir(), "sdl2-editor-"));
    const bin = join(work, "editor_test");
    try {
      execFileSync(
        cc!,
        ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O1", editorC, testC, "-o", bin],
        { stdio: "pipe" },
      );
      const out = execFileSync(bin, { encoding: "utf8" });
      expect(out, out).toContain("editor_test: ALL PASS");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
