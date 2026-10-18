/*
 * PR20 gate: the full libffi port (packages/registry/libffi/) —
 * real type classification in ffi_call plus ffi_closure over the
 * static trampoline pool — driven by the programs/libffi_full_test.c
 * matrix: arities x {i32, i64, f32, f64, small-struct, big-struct} x
 * {ffi_call, ffi_closure}.
 *
 * Two legs:
 *
 * 1. Native — gen-dispatch.sh output + the core + the driver compiled
 *    for the HOST. Fast iteration on the signature encoder, scalar
 *    dispatch and closure-pool routing. Aggregate call/closure cases
 *    compile out natively (the port's pointer-cast dispatch is the
 *    wasm32 byval/sret lowering; native ABIs pass aggregates in
 *    registers).
 * 2. Wasm under the kernel — programs/libffi_full_test.wasm (built by
 *    scripts/build-programs.sh against the sysroot's libffi.a), the
 *    ground truth including every struct shape. Skips when the binary
 *    is missing, matching the other program smoke tests.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { NodePlatformIO } from "../src/platform/node";
import { tryResolveBinary } from "../src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const LIBFFI_DIR = join(REPO_ROOT, "packages/registry/libffi");
const DRIVER_C = join(REPO_ROOT, "programs/libffi_full_test.c");

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

const wasmBinary = tryResolveBinary("programs/libffi_full_test.wasm");

function maxWasmFunctionBodySize(path: string): number {
  const bytes = new Uint8Array(readFileSync(path));
  let off = 8;
  const leb = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = bytes[off++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  };
  let max = 0;
  while (off < bytes.length) {
    const id = bytes[off++];
    const size = leb();
    const end = off + size;
    if (id === 10) {
      const count = leb();
      for (let i = 0; i < count; i++) {
        const bodySize = leb();
        if (bodySize > max) max = bodySize;
        off += bodySize;
      }
    }
    off = end;
  }
  return max;
}

describe("libffi full port — call + closure matrix", () => {
  it("passes the matrix natively (scalars, encoder, closure pool)", () => {
    const cc = findCompiler();
    expect(cc, "no host C compiler (cc/clang/gcc) found").not.toBeNull();

    const gen = join(LIBFFI_DIR, "gen-dispatch.sh");
    const coreC = join(LIBFFI_DIR, "src/ffi_core.c");
    expect(existsSync(gen), "gen-dispatch.sh missing").toBe(true);
    expect(existsSync(coreC), "src/ffi_core.c missing").toBe(true);
    expect(existsSync(DRIVER_C), "programs/libffi_full_test.c missing").toBe(true);

    const work = mkdtempSync(join(tmpdir(), "libffi-full-"));
    try {
      execFileSync("bash", [gen, work], { stdio: "pipe" });
      const generated = readdirSync(work)
        .filter((f) => f.endsWith(".c"))
        .map((f) => join(work, f));
      expect(generated.length, "generator emitted no C files").toBeGreaterThan(0);

      const bin = join(work, "libffi_full_test");
      execFileSync(
        cc!,
        [
          "-std=c11", "-Wall", "-Wextra", "-Werror", "-O1",
          `-I${join(LIBFFI_DIR, "include")}`,
          `-I${join(LIBFFI_DIR, "src")}`,
          coreC, ...generated, DRIVER_C,
          "-o", bin,
        ],
        { stdio: "pipe" },
      );
      const out = execFileSync(bin, { encoding: "utf8" });
      expect(out, out).toContain("LIBFFI_FULL_OK");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);

  /*
   * The generated dispatch must stay split into per-(return class,
   * arity) leaves routed through a function-pointer table: fused into
   * one function (~275 KB of sparse uint64 switch) it kills the whole
   * process with "Fatal process out of memory: Zone" when V8's
   * optimizing tier compiles it. The clang driver runs wasm-opt -O2
   * post-link, and binaryen re-inlines single-caller functions of any
   * size, so only the indirect-call routing holds the split.
   */
  it.skipIf(!wasmBinary)(
    "keeps every function small enough for V8's optimizing tier",
    () => {
      expect(maxWasmFunctionBodySize(wasmBinary!)).toBeLessThan(131072);
    },
  );

  it.skipIf(!wasmBinary)(
    "passes the matrix on wasm32 under the kernel (incl. structs)",
    async () => {
      const result = await runCentralizedProgram({
        programPath: wasmBinary!,
        argv: ["libffi_full_test"],
        env: [],
        io: new NodePlatformIO(),
        timeout: 30_000,
      });

      expect(
        result.exitCode,
        `libffi_full_test exited non-zero. stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toContain("LIBFFI_FULL_OK");
    },
    40_000,
  );
});
