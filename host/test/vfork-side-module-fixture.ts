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
  /**
   * The C driver to build with. Defaults to this worktree's SDK wrapper.
   * Tests override it to prove the fixture cleans up after a failed build.
   */
  readonly ccDriver?: string;
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
    // The SDK owns both link contracts this fixture needs: SHARED_LINK_FLAGS
    // for the side module and linkFlags() for the main program
    // (sdk/src/lib/flags.ts). This file used to invoke clang and wasm-ld
    // directly with its own copy of each, and the main-program copy had
    // drifted -- it reserved wasm-ld's ~64 KiB default shadow stack instead of
    // the SDK's 8 MiB and exported no __abi_version, so the fixture ran under
    // a process memory layout no real Kandelo program runs under.
    //
    // Absolute path, never a bare `wasm32posix-cc`: a bare name resolves
    // through PATH and can pick up a different worktree's SDK.
    const cc = options.ccDriver ?? join(repoRoot, "sdk", "bin", "wasm32posix-cc");
    const instrument = join(repoRoot, "scripts", "run-wasm-fork-instrument.sh");

    // `-shared -fPIC` selects the SDK's side-module link: -nostdlib,
    // --experimental-pic, --shared, --shared-memory, --export-all and
    // --allow-undefined, straight from the .c with no intermediate object.
    // `-I` still points at the glue dir for the fixture's own
    // `#include "abi_constants.h"`.
    execFileSync(cc, [
      "-shared",
      "-fPIC",
      "-O2",
      `-I${glueDir}`,
      join(fixturesDir, "vfork-side-module.c"),
      "-o",
      libraryPath,
    ], { stdio: "pipe" });
    instrumentInPlace(instrument, libraryPath, "env.fork");

    // `-ldl` is how the SDK spells the dlopen glue (parseArgs/linkDl in
    // sdk/src/bin/cc.ts). `-Wl,--export-all` stays: it is this fixture's own
    // requirement, not part of the platform link contract.
    execFileSync(cc, [
      "-O2",
      "-ldl",
      join(fixturesDir, "vfork-side-main.c"),
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
