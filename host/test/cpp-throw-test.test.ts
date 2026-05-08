/**
 * Regression gate for C++ exception unwinding under the wasm-posix-kernel.
 *
 * The bundled libcxx package currently builds libc++abi.a with
 * LIBCXXABI_USE_LLVM_UNWINDER=OFF, so `_Unwind_RaiseException` is left as
 * an undefined import in every C++ binary and the host has no stub. Any
 * C++ throw deadlocks the process.
 *
 * This test runs `programs/cpp_throw_test.wasm` (typed catch, catch-all,
 * cross-frame throw) and asserts all three sub-tests print PASS. It will
 * FAIL until libcxxabi bundles libunwind via LIBCXXABI_USE_LLVM_UNWINDER=ON
 * — that is the point. Do not remove or rename without first landing the
 * fix it gates.
 */
import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const cppThrowBinary = tryResolveBinary("programs/cpp_throw_test.wasm");
const hasBinary = !!cppThrowBinary;

describe("cpp_throw_test", () => {
  it.skipIf(!hasBinary)(
    "propagates and catches C++ exceptions across frames",
    async () => {
      const result = await runCentralizedProgram({
        programPath: cppThrowBinary!,
        argv: ["cpp_throw_test"],
        timeout: 10_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("PASS: typed catch");
      expect(result.stdout).toContain("PASS: catch-all");
      expect(result.stdout).toContain("PASS: cross-frame");
    },
    15_000,
  );
});
