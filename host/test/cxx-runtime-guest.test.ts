import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

// Every C++ runtime function comes from the C++ runtime, not the host
// (programs/cxx_runtime_test.cpp). Before ABI 47 the host faked many of them,
// including a __cxa_thread_atexit that never ran thread_local destructors.
const HOST_STAND_INS = [
  "_Znwm", "_Znam", "_ZdlPv", "_ZdlPvm", "_ZdaPv", "_ZdaPvm",
  "_ZnwmRKSt9nothrow_t", "_ZnamRKSt9nothrow_t",
  "__cxa_atexit", "__cxa_guard_acquire", "__cxa_guard_release", "__cxa_guard_abort",
  "__cxa_pure_virtual", "__dynamic_cast", "__cxa_thread_atexit",
  "_ZNSt3__122__libcpp_verbose_abortEPKcz",
];

const program = tryResolveBinary("programs/cxx_runtime_test.wasm");

describe("C++ runtime", () => {
  it("builds the fixture (a missing binary is a build failure, not a skip)", () => {
    expect(program, "scripts/build-programs.sh did not produce cxx_runtime_test.wasm").toBeTruthy();
  });

  it("imports no C++ runtime function from the host", () => {
    const module = new WebAssembly.Module(readFileSync(program!));
    const fromEnv = WebAssembly.Module.imports(module)
      .filter((i) => i.module === "env")
      .map((i) => i.name);
    expect(fromEnv.filter((n) => HOST_STAND_INS.includes(n))).toEqual([]);
  });

  it("runs new/delete, dynamic_cast, static-local guards, and thread_local destructors", async () => {
    const r = await runCentralizedProgram({
      programPath: program!,
      argv: ["cxx_runtime_test"],
      useDefaultRootfs: false,
      timeout: 30_000,
    });
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("PASS cxx runtime");
  }, 60_000);
});
