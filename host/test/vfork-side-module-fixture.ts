import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface VforkSideModuleFixture {
  readonly programPath: string;
  readonly libraryPath: string;
  cleanup(): void;
}

export interface VforkSideModuleFixtureOptions {
  readonly outputRoot?: string;
  readonly clangDriver?: string;
}

function llvmTool(clang: string, name: "clang" | "wasm-ld"): string {
  if (name === "wasm-ld" && process.env.WASM_LD) return process.env.WASM_LD;
  return execFileSync(clang, [`-print-prog-name=${name}`], {
    encoding: "utf8",
  }).trim() || name;
}

function instrumentInPlace(instrument: string, path: string, entry?: string): void {
  const output = `${path}.instrumented`;
  const args = [path, "-o", output];
  if (entry) args.push("--entry", entry);
  execFileSync(instrument, args, { stdio: "pipe" });
  renameSync(output, path);
}

export function buildVforkSideModuleFixture(
  options: VforkSideModuleFixtureOptions = {},
): VforkSideModuleFixture {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, "../..");
  const sysroot = join(repoRoot, "sysroot");
  const glueDir = join(repoRoot, "libc", "glue");
  const fixturesDir = join(testDir, "fixtures");
  const fixtureOutputRoot = options.outputRoot
    ?? join(repoRoot, "local-binaries", "test-fixtures");
  mkdirSync(fixtureOutputRoot, { recursive: true });
  const buildDir = mkdtempSync(join(fixtureOutputRoot, "vfork-side-"));
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    rmSync(buildDir, { recursive: true, force: true });
  };
  try {
    const programPath = join(buildDir, "vfork-side-main.wasm");
    const libraryPath = join(buildDir, "libvfork-side.so");
    const sideObject = join(buildDir, "vfork-side-module.o");
    const clangDriver = options.clangDriver ?? process.env.CLANG ?? "clang";
    const clang = llvmTool(clangDriver, "clang");
    const wasmLd = llvmTool(clangDriver, "wasm-ld");
    const instrument = join(repoRoot, "scripts", "run-wasm-fork-instrument.sh");

    execFileSync(clang, [
      "--target=wasm32-unknown-unknown",
      "-fPIC",
      "-O2",
      "-matomics",
      "-mbulk-memory",
      `-I${glueDir}`,
      "-c",
      join(fixturesDir, "vfork-side-module.c"),
      "-o",
      sideObject,
    ], { stdio: "pipe" });
    execFileSync(wasmLd, [
      "--experimental-pic",
      "--shared",
      "--shared-memory",
      "--export-all",
      "--allow-undefined",
      "-o",
      libraryPath,
      sideObject,
    ], { stdio: "pipe" });
    instrumentInPlace(instrument, libraryPath, "env.fork");

    execFileSync(clang, [
      "--target=wasm32-unknown-unknown",
      `--sysroot=${sysroot}`,
      "-nostdlib",
      "-O2",
      "-matomics",
      "-mbulk-memory",
      "-fno-trapping-math",
      join(fixturesDir, "vfork-side-main.c"),
      join(glueDir, "channel_syscall.c"),
      join(glueDir, "compiler_rt.c"),
      join(glueDir, "dlopen.c"),
      join(sysroot, "lib", "crt1.o"),
      join(sysroot, "lib", "libc.a"),
      "-Wl,--entry=_start",
      "-Wl,--export=_start",
      "-Wl,--export=__heap_base",
      "-Wl,--import-memory",
      "-Wl,--shared-memory",
      "-Wl,--max-memory=1073741824",
      "-Wl,--allow-undefined",
      "-Wl,--global-base=1114112",
      "-Wl,--table-base=3",
      "-Wl,--export-table",
      "-Wl,--growable-table",
      "-Wl,--export=__wasm_init_tls",
      "-Wl,--export=__tls_base",
      "-Wl,--export=__tls_size",
      "-Wl,--export=__tls_align",
      "-Wl,--export=__stack_pointer",
      "-Wl,--export=__wasm_thread_init",
      "-Wl,--export-all",
      "-o",
      programPath,
    ], { stdio: "pipe" });
    instrumentInPlace(instrument, programPath);

    return { programPath, libraryPath, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
