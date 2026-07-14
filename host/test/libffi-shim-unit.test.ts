/*
 * Native unit test for the Wayland-scoped libffi shim
 * (packages/registry/libffi/). The shim's whole job is `ffi_call`
 * dispatching a decoded Wayland message to an N-ary function via an
 * i32-arity `call_indirect` trampoline; test/ffi_shim_test.c drives
 * `ffi_prep_cif` + `ffi_call` across every arity 0..22 and asserts each
 * 32-bit argument word lands in the right parameter slot.
 *
 * We compile the shim + driver for the HOST and run them here — no
 * wasm/kernel needed. Proving arity + argument marshalling on the host
 * proves `wl_closure_invoke` will dispatch correctly on wasm32, where
 * the same function-pointer calls lower to `call_indirect`. This is the
 * PR1 de-risk that gates investing in the libwayland port.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

describe("libffi Wayland shim — arity call_indirect trampoline (native unit test)", () => {
  it("dispatches every arity 0..22 with correct argument marshalling", () => {
    const cc = findCompiler();
    expect(cc, "no host C compiler (cc/clang/gcc) found").not.toBeNull();

    const inc = join(LIBFFI_DIR, "include");
    const shimC = join(LIBFFI_DIR, "src/ffi_shim.c");
    const testC = join(LIBFFI_DIR, "test/ffi_shim_test.c");
    expect(existsSync(shimC) && existsSync(testC)).toBe(true);

    const work = mkdtempSync(join(tmpdir(), "libffi-shim-"));
    const bin = join(work, "ffi_shim_test");
    try {
      execFileSync(
        cc!,
        ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O1", `-I${inc}`, shimC, testC, "-o", bin],
        { stdio: "pipe" },
      );
      const out = execFileSync(bin, { encoding: "utf8" });
      expect(out, out).toContain("ffi_shim_test: ALL PASS");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
