import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST_ENV_IMPORTS,
  WPK_FORK_GLOBAL_IMPORTS,
  WPK_FORK_REQUIRED_IMPORTS,
} from "../src/generated/abi";
import { assertDeclaredEnvImports } from "../src/env-imports";

const hostSrc = join(dirname(fileURLToPath(import.meta.url)), "../src");

// wabt's wat2wasm from the dev shell, as host/test/dylink.test.ts uses.
function moduleFromWat(wat: string): WebAssembly.Module {
  const dir = mkdtempSync(join(tmpdir(), "env-imports-"));
  writeFileSync(join(dir, "t.wat"), wat);
  execFileSync("wat2wasm", [join(dir, "t.wat"), "-o", join(dir, "t.wasm")]);
  return new WebAssembly.Module(readFileSync(join(dir, "t.wasm")));
}

// The C/C++ library functions the host used to fake in JavaScript before
// ABI 46. They come from libc, libc++abi, or libc++ now.
const REMOVED_STAND_INS = [
  "_Znwm", "_Znam", "_ZdlPv", "_ZdlPvm", "_ZdaPv", "_ZdaPvm",
  "_ZnwmRKSt9nothrow_t", "_ZnamRKSt9nothrow_t",
  "__cxa_guard_acquire", "__cxa_guard_release", "__cxa_guard_abort",
  "__cxa_pure_virtual", "__cxa_atexit", "__cxa_thread_atexit",
  "_ZNSt3__122__libcpp_verbose_abortEPKcz", "__dynamic_cast",
  "_ZNSt3__16__sortIRNS_6__lessIyyEEPyEEvT0_S5_T_",
];

describe("host env imports", () => {
  it("refuses a program that imports an undeclared env function", () => {
    const m = moduleFromWat(`(module (import "env" "re_search" (func)))`);
    expect(() => assertDeclaredEnvImports(m)).toThrow(
      "program imports env.re_search, which Kandelo does not provide; rebuild it with the current SDK",
    );
  });

  it("refuses the removed C++ stand-ins", () => {
    const m = moduleFromWat(`(module (import "env" "_Znwm" (func (param i32) (result i32))))`);
    expect(() => assertDeclaredEnvImports(m)).toThrow(/env\._Znwm/);
  });

  it("refuses a declared name imported as the wrong kind", () => {
    const m = moduleFromWat(`(module (import "env" "__wasm_dlopen" (global i32)))`);
    expect(() => assertDeclaredEnvImports(m)).toThrow(/env\.__wasm_dlopen/);
  });

  it("accepts every declared host function import", () => {
    for (const { name, kind } of HOST_ENV_IMPORTS) {
      if (kind !== "function") continue;
      const m = moduleFromWat(`(module (import "env" "${name}" (func)))`);
      expect(() => assertDeclaredEnvImports(m), name).not.toThrow();
    }
  });

  it("accepts the imports fork instrumentation adds", () => {
    const { name } = WPK_FORK_REQUIRED_IMPORTS.find((i) => i.module === "env")!;
    const globals = WPK_FORK_GLOBAL_IMPORTS
      .map((g) => `(import "env" "${g.name}" (global ${g.value}))`)
      .join(" ");
    const m = moduleFromWat(`(module (import "env" "${name}" (func)) ${globals})`);
    expect(() => assertDeclaredEnvImports(m)).not.toThrow();
  });

  it("ignores imports from other modules", () => {
    const m = moduleFromWat(`(module (import "kernel" "kernel_fork" (func (param i32) (result i32))))`);
    expect(() => assertDeclaredEnvImports(m)).not.toThrow();
  });

  it("worker-main.ts no longer fakes library functions or stubs unknown imports", () => {
    const source = readFileSync(join(hostSrc, "worker-main.ts"), "utf8");
    expect(source).not.toMatch(/Unimplemented import/);
    for (const name of REMOVED_STAND_INS) {
      const escaped = name.replace(/[$]/g, "\\$&");
      expect(source, name).not.toMatch(
        new RegExp(`envImports(\\.${escaped}\\b|\\["${escaped}"\\])\\s*=`),
      );
    }
  });
});
