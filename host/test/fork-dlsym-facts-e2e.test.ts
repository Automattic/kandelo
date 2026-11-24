/**
 * Fork after calls through dlsym() pointers in a main program that
 * wasm-fork-instrument plans from compiler facts.
 *
 * The other dlopen/fork suites link their main programs with bare clang, so
 * they carry no facts and the instrumenter falls back to the conservative
 * full closure. These programs are built through the SDK driver (which
 * embeds the facts) with the default `--side-modules=traced-entries`, and
 * each case first checks that the facts analysis really chose the plan.
 *
 * A call through a pointer the host's dynamic linker installed at run time
 * once had no targets in that plan, so it was treated as never returning
 * and main's frame was left uninstrumented: the fork child trapped with
 * "null function or function signature mismatch".
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  makeHostScratchTempRoot,
  runCentralizedProgram,
} from "./centralized-test-helper";
import { compileSdkFixture } from "./support/compile-sdk-fixture";
import { NodePlatformIO } from "../src/platform/node";
import { tryResolveBinary } from "../src/binary-resolver";

const REPO_ROOT = join(__dirname, "../..");
const SYSROOT = join(REPO_ROOT, "sysroot");
const GLUE_DIR = join(REPO_ROOT, "libc", "glue");
const FORK_INSTRUMENT = join(REPO_ROOT, "scripts", "run-wasm-fork-instrument.sh");
const SOURCE = new URL("./fixtures/dlsym-fork-facts.c", import.meta.url);

const hasSysroot = existsSync(join(SYSROOT, "lib", "libc.a"));
const hasKernel = tryResolveBinary("kernel.wasm") !== null;

function llvmTool(name: "clang" | "wasm-ld"): string {
  try {
    return execFileSync(process.env.CLANG ?? "clang", [`-print-prog-name=${name}`], {
      encoding: "utf8",
    }).trim() || name;
  } catch {
    return name;
  }
}

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

function buildMain(mode: number): string {
  const { programPath, cleanup } = compileSdkFixture(
    SOURCE,
    [`-DMODE=${mode}`, "-ldl"],
    { forkInstrument: true },
  );
  cleanups.push(cleanup);
  const report = execFileSync(
    "bash",
    [FORK_INSTRUMENT, `${programPath}.linked`, "--sink-report"],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  expect(report.split("\n")[0], report).toBe("source\tfacts");
  return programPath;
}

/** A side module with no imports and a C type no main function has. */
function buildSideModule(): string {
  const dir = makeHostScratchTempRoot("dlsym-fork-facts-side-");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const src = join(dir, "side.c");
  const obj = join(dir, "side.o");
  const so = join(dir, "libside.so");
  writeFileSync(src, `
    long long side_scale(int value) { return (long long)value * 3; }
    #include "abi_constants.h"
    __attribute__((export_name("__abi_version")))
    unsigned __abi_version(void) { return WASM_POSIX_ABI_VERSION; }
  `);
  execFileSync(llvmTool("clang"), [
    "--target=wasm32-unknown-unknown", "-fPIC", "-O2", "-matomics",
    "-mbulk-memory", `-I${GLUE_DIR}`, "-c", src, "-o", obj,
  ], { stdio: "pipe" });
  execFileSync(llvmTool("wasm-ld"), [
    "--experimental-pic", "--shared", "--shared-memory", "--export-all",
    "--allow-undefined", "-o", so, obj,
  ], { stdio: "pipe" });
  execFileSync("bash", [FORK_INSTRUMENT, so, "-o", so], { stdio: "pipe" });
  return so;
}

async function run(programPath: string, argv: string[] = []) {
  const result = await runCentralizedProgram({
    programPath,
    argv: ["dlsym-fork-facts", ...argv],
    timeout: 30_000,
    io: new NodePlatformIO(),
  });
  expect(result.stderr).not.toContain("null function or function signature mismatch");
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.stdout).toContain("dlsym fork ok");
}

describe.skipIf(!hasSysroot || !hasKernel)("fork after dlsym pointer calls (facts plan)", () => {
  it("forks after calling a main-program export from dlsym(RTLD_DEFAULT)", { timeout: 120_000 }, async () => {
    await run(buildMain(1));
  });

  it("forks through a dlsym(RTLD_DEFAULT) pointer to a main-program export", { timeout: 120_000 }, async () => {
    await run(buildMain(2));
  });

  it("forks after calling a side-module function from dlsym", { timeout: 120_000 }, async () => {
    await run(buildMain(3), [buildSideModule()]);
  });
});
