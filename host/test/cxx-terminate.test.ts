/**
 * C++ allocation failure and uncaught exceptions end the way the C++
 * standard and Linux say they do.
 *
 * `programs/cxx_bad_alloc_test.wasm`: a failed throwing operator new throws
 * std::bad_alloc (after calling the new_handler) and the nothrow forms
 * return a null pointer. libc++ supplies them; the SDK's minimal C++ runtime
 * (libc/glue/cxxrt.c) is linked lazily after libc++ so its abort-on-failure
 * fallback no longer wins (docs/sdk-guide.md, "C++ exceptions").
 *
 * `programs/cxx_uncaught_test.wasm`: an exception that no handler catches
 * calls std::terminate, whose default handler prints libc++abi's message
 * and aborts, so the process is killed by SIGABRT. The SDK's C++ runtime
 * entry (libc/glue/cxxrt_entry.cpp) provides the catch at the bottom of the
 * main thread's and every other thread's stack that WebAssembly exception
 * handling's missing search phase otherwise leaves out.
 */
import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const badAlloc = tryResolveBinary("programs/cxx_bad_alloc_test.wasm");
const uncaught = tryResolveBinary("programs/cxx_uncaught_test.wasm");
const TERMINATED_BY_SIGABRT = 128 + 6;

function runUncaught(mode: string, env: string[] = []) {
  return runCentralizedProgram({
    programPath: uncaught!,
    argv: ["cxx_uncaught_test", mode],
    env,
    useDefaultRootfs: false,
    timeout: 30_000,
  });
}

describe("C++ operator new failure", () => {
  it("builds the fixture (a missing binary is a build failure, not a skip)", () => {
    expect(badAlloc, "scripts/build-programs.sh did not produce cxx_bad_alloc_test.wasm").toBeTruthy();
  });

  it("throws std::bad_alloc from throwing forms and returns null from nothrow forms", async () => {
    const result = await runCentralizedProgram({
      programPath: badAlloc!,
      argv: ["cxx_bad_alloc_test"],
      useDefaultRootfs: false,
      timeout: 30_000,
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS cxx_bad_alloc_test");
  }, 60_000);
});

describe("C++ exception with no handler", () => {
  it("builds the fixture (a missing binary is a build failure, not a skip)", () => {
    expect(uncaught, "scripts/build-programs.sh did not produce cxx_uncaught_test.wasm").toBeTruthy();
  });

  it("calls std::terminate from main: libc++abi's message, then SIGABRT", async () => {
    const result = await runUncaught("main");
    expect(result.exitCode, result.stdout + result.stderr).toBe(TERMINATED_BY_SIGABRT);
    expect(result.stderr).toContain(
      "libc++abi: terminating due to uncaught exception of type std::runtime_error: thrown from main",
    );
    // Implementation-defined ([except.handle]): Kandelo unwinds first.
    expect(result.stdout).toContain("unwound main");
  }, 60_000);

  it("names a non-class exception type", async () => {
    const result = await runUncaught("int");
    expect(result.exitCode, result.stdout + result.stderr).toBe(TERMINATED_BY_SIGABRT);
    expect(result.stderr).toContain("libc++abi: terminating due to uncaught exception of type int");
  }, 60_000);

  it("covers static constructors, which run before main", async () => {
    const result = await runUncaught("ctor", ["CXX_UNCAUGHT_MODE=ctor"]);
    expect(result.exitCode, result.stdout + result.stderr).toBe(TERMINATED_BY_SIGABRT);
    expect(result.stderr).toContain(
      "terminating due to uncaught exception of type std::logic_error: static constructor",
    );
  }, 60_000);

  it.each([
    ["std::thread", "thread", "std::thread function"],
    ["pthread_create", "pthread", "pthread start routine"],
  ])("terminates the process from a %s thread", async (_, mode, what) => {
    const result = await runUncaught(mode);
    expect(result.exitCode, result.stdout + result.stderr).toBe(TERMINATED_BY_SIGABRT);
    expect(result.stderr).toContain(
      `terminating due to uncaught exception of type std::runtime_error: ${what}`,
    );
  }, 60_000);

  it("runs a std::set_terminate handler with the exception current", async () => {
    const result = await runUncaught("handler");
    expect(result.exitCode, result.stdout + result.stderr).toBe(3);
    expect(result.stdout).toContain("terminate handler ran");
    expect(result.stdout).toContain("current exception: handled by set_terminate");
    expect(result.stderr).not.toContain("terminating");
  }, 60_000);

  it("leaves a handled exception alone", async () => {
    const result = await runUncaught("caught");
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("caught: caught");
  }, 60_000);

  it("reports the forked child's SIGABRT through waitpid", async () => {
    const result = await runUncaught("waitpid");
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("child signaled 6 (SIGABRT)");
    expect(result.stderr).toContain(
      "terminating due to uncaught exception of type std::runtime_error: thrown in a forked child",
    );
  }, 60_000);
});
