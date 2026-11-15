/**
 * C++ exceptions work with the SDK's default flags.
 *
 * `programs/cpp_throw_test.wasm` is compiled by scripts/build-programs.sh
 * with no exception flag: the SDK driver enables Wasm exception handling
 * for C++ itself (docs/sdk-guide.md, "C++ exceptions"). The program checks
 * catch handlers, destructors run while unwinding, exceptions thrown by
 * libc++ and libc++abi, exception_ptr across threads and the catch
 * handler inside libc++.a's std::call_once. Without exception handling in
 * the program a throw ends it; without it in the libcxx package the
 * call_once check hangs until the program's watchdog alarm ends it.
 */
import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const program = tryResolveBinary("programs/cpp_throw_test.wasm");

describe("cpp_throw_test", () => {
  it("builds the fixture (a missing binary is a build failure, not a skip)", () => {
    expect(program, "scripts/build-programs.sh did not produce cpp_throw_test.wasm").toBeTruthy();
  });

  it("catches C++ exceptions thrown by the program, libc++ and libc++abi", async () => {
    const result = await runCentralizedProgram({
      programPath: program!,
      argv: ["cpp_throw_test"],
      useDefaultRootfs: false,
      timeout: 30_000,
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS cpp_throw_test");
  }, 60_000);
});
