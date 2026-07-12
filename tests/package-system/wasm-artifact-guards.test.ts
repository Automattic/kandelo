import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", "..");
const guardsPath = path.join(repoRoot, "scripts", "wasm-artifact-guards.sh");

describe("wasm artifact ABI guards", () => {
  let fixtureDir: string;
  let namedWasm: string;
  let strippedWasm: string;
  let wrappedWasm: string;
  let wrappedStrippedWasm: string;
  let arbitraryWrapperWasm: string;
  let failingObjdumpBin: string;

  beforeAll(() => {
    fixtureDir = mkdtempSync(path.join(tmpdir(), "kandelo-wasm-abi-guard-"));
    const watPath = path.join(fixtureDir, "aliased-abi.wat");
    namedWasm = path.join(fixtureDir, "aliased-abi.wasm");
    strippedWasm = path.join(fixtureDir, "aliased-abi-stripped.wasm");

    // The imported function and decoy constant ensure the guard follows the
    // exported function index instead of assuming a body order or debug name.
    writeFileSync(
      watPath,
      `(module
        (import "kernel" "noop" (func $noop))
        (func $decoy (result i32)
          i32.const 99)
        (func $__wasm_posix_user_abi_version (result i32)
          i32.const 2
          drop
          i32.const 17)
        (export "__abi_version" (func $__wasm_posix_user_abi_version)))\n`,
    );
    execFileSync("wat2wasm", ["--debug-names", watPath, "-o", namedWasm]);
    copyFileSync(namedWasm, strippedWasm);
    execFileSync("wasm-strip", [strippedWasm]);

    const wrappedWatPath = path.join(fixtureDir, "wrapped-abi.wat");
    wrappedWasm = path.join(fixtureDir, "wrapped-abi.wasm");
    wrappedStrippedWasm = path.join(fixtureDir, "wrapped-abi-stripped.wasm");
    writeFileSync(
      wrappedWatPath,
      `(module
        (func $__wasm_call_ctors)
        (func $__wasm_posix_user_abi_version (result i32)
          i32.const 18)
        (func $__wasm_posix_user_abi_version.command_export (result i32)
          call $__wasm_call_ctors
          call $__wasm_posix_user_abi_version)
        (export "__abi_version" (func $__wasm_posix_user_abi_version.command_export)))\n`,
    );
    execFileSync("wat2wasm", [
      "--debug-names",
      wrappedWatPath,
      "-o",
      wrappedWasm,
    ]);
    copyFileSync(wrappedWasm, wrappedStrippedWasm);
    execFileSync("wasm-strip", [wrappedStrippedWasm]);

    const arbitraryWrapperWatPath = path.join(
      fixtureDir,
      "arbitrary-wrapper-abi.wat",
    );
    arbitraryWrapperWasm = path.join(fixtureDir, "arbitrary-wrapper-abi.wasm");
    writeFileSync(
      arbitraryWrapperWatPath,
      `(module
        (func $__wasm_call_ctors)
        (func $__wasm_posix_user_abi_version (result i32)
          i32.const 18)
        (func $__wasm_posix_user_abi_version.command_export (result i32)
          call $__wasm_call_ctors
          call $__wasm_posix_user_abi_version
          i32.const 1
          i32.add)
        (export "__abi_version" (func $__wasm_posix_user_abi_version.command_export)))\n`,
    );
    execFileSync("wat2wasm", [
      "--debug-names",
      arbitraryWrapperWatPath,
      "-o",
      arbitraryWrapperWasm,
    ]);

    // Current LLVM output can use instructions that the pinned WABT reads in
    // the export table but rejects while disassembling. Model that split so
    // the Binaryen fallback remains covered without checking in a large SDK
    // binary fixture.
    const realObjdump = execFileSync(
      "bash",
      ["-c", "command -v wasm-objdump"],
      {
        encoding: "utf8",
      },
    ).trim();
    failingObjdumpBin = path.join(fixtureDir, "failing-objdump-bin");
    mkdirSync(failingObjdumpBin);
    const objdumpWrapper = path.join(failingObjdumpBin, "wasm-objdump");
    writeFileSync(
      objdumpWrapper,
      [
        "#!/usr/bin/env bash",
        'if [ "${1:-}" = "-d" ]; then exit 1; fi',
        `exec ${JSON.stringify(realObjdump)} "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(objdumpWrapper, 0o755);
  });

  afterAll(() => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  function runGuardWithEnv(
    script: string,
    env: NodeJS.ProcessEnv,
    ...args: string[]
  ) {
    return spawnSync(
      "bash",
      ["-c", `source "$1"\nshift\n${script}`, "_", guardsPath, ...args],
      { encoding: "utf8", env: { ...process.env, ...env } },
    );
  }

  function runGuard(script: string, ...args: string[]) {
    return runGuardWithEnv(script, {}, ...args);
  }

  it("extracts ABI through an aliased export name", () => {
    const exports = execFileSync("wasm-objdump", ["-x", namedWasm], {
      encoding: "utf8",
    });
    expect(exports).toContain(
      '<__wasm_posix_user_abi_version> -> "__abi_version"',
    );

    const result = runGuard('wasm_extract_abi_version "$1"', namedWasm);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("17");
  });

  it("extracts ABI when the custom name section is stripped", () => {
    const exports = execFileSync("wasm-objdump", ["-x", strippedWasm], {
      encoding: "utf8",
    });
    expect(exports).toMatch(/func\[2\].*-> "__abi_version"/);
    expect(exports).not.toContain("__wasm_posix_user_abi_version");

    const result = runGuard('wasm_extract_abi_version "$1"', strippedWasm);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("17");
  });

  it("falls back when WABT cannot disassemble the mapped function", () => {
    const result = runGuardWithEnv(
      'wasm_extract_abi_version "$1"',
      { PATH: `${failingObjdumpBin}:${process.env.PATH ?? ""}` },
      namedWasm,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("17");
  });

  it("extracts ABI through wasm-ld's command export wrapper", () => {
    const exports = execFileSync("wasm-objdump", ["-x", wrappedWasm], {
      encoding: "utf8",
    });
    expect(exports).toContain(
      '<__wasm_posix_user_abi_version.command_export> -> "__abi_version"',
    );

    const result = runGuard('wasm_extract_abi_version "$1"', wrappedWasm);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("18");
  });

  it("extracts wrapped ABI when the custom name section is stripped", () => {
    const result = runGuard(
      'wasm_extract_abi_version "$1"',
      wrappedStrippedWasm,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("18");
  });

  it("falls back for a wrapped ABI when WABT cannot disassemble it", () => {
    const result = runGuardWithEnv(
      'wasm_extract_abi_version "$1"',
      { PATH: `${failingObjdumpBin}:${process.env.PATH ?? ""}` },
      wrappedWasm,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("18");
  });

  it("rejects wrappers with computation after the delegated ABI call", () => {
    const result = runGuard(
      'wasm_extract_abi_version "$1"',
      arbitraryWrapperWasm,
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("classifies aliased artifacts by their extracted ABI", () => {
    const matching = runGuard('wasm_has_stale_abi "$1" "$2"', namedWasm, "17");
    expect(matching.status, matching.stderr).toBe(1);

    const stale = runGuard('wasm_has_stale_abi "$1" "$2"', namedWasm, "18");
    expect(stale.status, stale.stderr).toBe(0);
  });
});
