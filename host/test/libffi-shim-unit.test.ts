/*
 * Native regression test for the Wayland dispatch path of the full
 * libffi port (packages/registry/libffi/): test/ffi_shim_test.c drives
 * `ffi_prep_cif` + `ffi_call` across every arity 0..22 of the shape
 * `wl_closure_invoke` uses (all-i32 arguments, void return) and asserts
 * each 32-bit argument word lands in the right parameter slot. This was
 * the PR1 de-risk gate for the libwayland port and must stay green
 * through the PR20 full-port rewrite; the PR20 matrix itself lives in
 * host/test/libffi-full-unit.test.ts.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const LIBFFI_DIR = join(REPO_ROOT, "packages/registry/libffi");

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

describe("libffi Wayland dispatch — arity call_indirect (native unit test)", () => {
  it("dispatches every arity 0..22 with correct argument marshalling", () => {
    const cc = findCompiler();
    expect(cc, "no host C compiler (cc/clang/gcc) found").not.toBeNull();

    const coreC = join(LIBFFI_DIR, "src/ffi_core.c");
    const testC = join(LIBFFI_DIR, "test/ffi_shim_test.c");
    expect(existsSync(coreC) && existsSync(testC)).toBe(true);

    const work = mkdtempSync(join(tmpdir(), "libffi-shim-"));
    const bin = join(work, "ffi_shim_test");
    try {
      execFileSync("bash", [join(LIBFFI_DIR, "gen-dispatch.sh"), work], {
        stdio: "pipe",
      });
      const generated = readdirSync(work)
        .filter((f) => f.endsWith(".c"))
        .map((f) => join(work, f));
      execFileSync(
        cc!,
        [
          "-std=c11", "-Wall", "-Wextra", "-Werror", "-O1",
          `-I${join(LIBFFI_DIR, "include")}`,
          `-I${join(LIBFFI_DIR, "src")}`,
          coreC, ...generated, testC,
          "-o", bin,
        ],
        { stdio: "pipe" },
      );
      const out = execFileSync(bin, { encoding: "utf8" });
      expect(out, out).toContain("ffi_shim_test: ALL PASS");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});
