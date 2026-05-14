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
const postCatchForkBinary = tryResolveBinary("programs/cpp_post_catch_fork_test.wasm");
const hasPostCatchForkBinary = !!postCatchForkBinary;

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

  // Regression gate for SpiderMonkey-spike test (b) — documented in
  // memory:spidermonkey-spike-eh-toolchain-gap.md as a post-catch
  // fork-hang. Throw + catch (catch frame fully popped) followed by
  // fork() outside any try region; the spike found the fork hangs.
  //
  // Status (2026-05-13, decision C2 in
  // docs/plans/2026-05-13-fork-instrument-unsupported-cases-review.md):
  // Bug reproduces on this branch — the program runs through
  // "CAUGHT: 42" and "PRE_FORK" but the parent never returns from
  // fork() to print PARENT:/CHILD: lines, exits with code 0 and only
  // partial stdout. Not the spike's literal hang but the same broken
  // post-catch-fork path. The architectural pivot (eliminate
  // guard-dispatch) is the planned fix — see
  // docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md.
  // Marked `.fails` so this file is green today but vitest will flag
  // the test if the bug is incidentally fixed, prompting us to flip
  // it back to a normal assertion.
  it.fails.skipIf(!hasPostCatchForkBinary)(
    "forks correctly after a fully-popped catch frame (spike test b)",
    async () => {
      const result = await runCentralizedProgram({
        programPath: postCatchForkBinary!,
        argv: ["cpp_post_catch_fork_test"],
        timeout: 10_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CAUGHT: 42");
      expect(result.stdout).toContain("CHILD: ok");
      expect(result.stdout).toContain("PASS: post-catch fork");
    },
    15_000,
  );
});
