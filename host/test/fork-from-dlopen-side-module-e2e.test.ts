import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodePlatformIO } from "../src/platform/node";
import {
  FORK_CAP_DYLINK_MAIN,
  FORK_CAP_SIDE_ENTRY,
  readForkInstrumentCapabilities,
} from "../src/dylink";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");
const sysroot = join(repoRoot, "sysroot");
const glueDir = join(repoRoot, "libc", "glue");
const clangDriver = process.env.CLANG ?? "clang";
const instrument = join(repoRoot, "scripts", "run-wasm-fork-instrument.sh");
const buildDir = join(tmpdir(), "kandelo-fork-from-side-module");
const hasPrerequisites =
  existsSync(join(sysroot, "lib", "libc.a"))
  && (
    existsSync(join(repoRoot, "binaries", "kernel.wasm"))
    || existsSync(join(repoRoot, "local-binaries", "kernel.wasm"))
  );

if (process.env.KANDELO_REQUIRE_SIDE_MODULE_FORK_E2E === "1" && !hasPrerequisites) {
  throw new Error(
    "side-module fork e2e was required but sysroot/libc.a or kernel.wasm is missing",
  );
}

function llvmTool(name: "clang" | "wasm-ld"): string {
  if (name === "wasm-ld" && process.env.WASM_LD) return process.env.WASM_LD;
  // Nix's native clang wrapper injects Darwin hardening flags that are invalid
  // for wasm32. Ask the driver for its underlying LLVM tools so this fixture
  // follows the same cross-target path as the repository build scripts. Keep
  // discovery lazy so a deliberately skipped fixture needs no compiler.
  return execFileSync(clangDriver, [`-print-prog-name=${name}`], {
    encoding: "utf8",
  }).trim() || name;
}

function instrumentInPlace(wasmPath: string, entry?: string): void {
  const output = `${wasmPath}.instrumented`;
  const args = [wasmPath, "-o", output];
  if (entry) args.push("--entry", entry);
  execFileSync(instrument, args, { stdio: "pipe" });
  renameSync(output, wasmPath);
}

function buildSharedLibrary(source: string): string {
  const sourcePath = join(buildDir, "libforkinside.c");
  const objectPath = join(buildDir, "libforkinside.o");
  const libraryPath = join(buildDir, "libforkinside.so");
  writeFileSync(sourcePath, source);
  execFileSync(llvmTool("clang"), [
    "--target=wasm32-unknown-unknown",
    "-fPIC",
    "-O2",
    "-matomics",
    "-mbulk-memory",
    "-c",
    sourcePath,
    "-o",
    objectPath,
  ], { stdio: "pipe" });
  execFileSync(llvmTool("wasm-ld"), [
    "--experimental-pic",
    "--shared",
    "--shared-memory",
    "--export-all",
    "--allow-undefined",
    "-o",
    libraryPath,
    objectPath,
  ], { stdio: "pipe" });
  instrumentInPlace(libraryPath, "env.fork");
  return libraryPath;
}

function buildMainProgram(source: string): string {
  const sourcePath = join(buildDir, "fork-from-side-main.c");
  const wasmPath = join(buildDir, "fork-from-side-main.wasm");
  writeFileSync(sourcePath, source);
  execFileSync(llvmTool("clang"), [
    "--target=wasm32-unknown-unknown",
    `--sysroot=${sysroot}`,
    "-nostdlib",
    "-O2",
    "-matomics",
    "-mbulk-memory",
    "-fno-trapping-math",
    sourcePath,
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
    wasmPath,
  ], { stdio: "pipe" });
  instrumentInPlace(wasmPath);
  return wasmPath;
}

describe.skipIf(!hasPrerequisites)("fork from a dlopened side module", () => {
  beforeAll(() => mkdirSync(buildDir, { recursive: true }));

  it("preserves the side frame and returns in both parent and child", async () => {
    const libraryPath = buildSharedLibrary(`
      extern int fork(void);
      extern void exit(int);
      int side_fork(void) {
        volatile int preserved = 37;
        int pid = fork();
        if (preserved != 37) exit(91);
        if (pid == 0) exit(0);
        return pid;
      }
    `);
    const programPath = buildMainProgram(`
      #include <dlfcn.h>
      #include <stdio.h>
      #include <sys/wait.h>
      typedef int (*side_fork_fn)(void);
      int main(int argc, char **argv) {
        void *lib = dlopen(argv[1], RTLD_NOW);
        if (!lib) return 2;
        side_fork_fn side_fork = (side_fork_fn)dlsym(lib, "side_fork");
        if (!side_fork) return 3;
        for (int i = 0; i < 2; i++) {
          int pid = side_fork();
          if (pid < 0) return 4;
          int status = 0;
          if (waitpid(pid, &status, 0) != pid) return 5;
          if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return 6;
        }
        puts("side fork ok");
        return 0;
      }
    `);

    // Ensure the compiler actually produced a side module with fork state;
    // a stale/inert fixture must never turn this into a false-positive run.
    const libraryModule = new WebAssembly.Module(
      new Uint8Array(readFileSync(libraryPath)) as unknown as BufferSource,
    );
    expect(WebAssembly.Module.exports(libraryModule).map((entry) => entry.name))
      .toContain("wpk_fork_state");
    expect(readForkInstrumentCapabilities(libraryModule) & FORK_CAP_SIDE_ENTRY)
      .toBe(FORK_CAP_SIDE_ENTRY);
    const programModule = new WebAssembly.Module(
      new Uint8Array(readFileSync(programPath)) as unknown as BufferSource,
    );
    expect(readForkInstrumentCapabilities(programModule) & FORK_CAP_DYLINK_MAIN)
      .toBe(FORK_CAP_DYLINK_MAIN);

    const result = await runCentralizedProgram({
      programPath,
      argv: ["fork-from-side-main", libraryPath],
      timeout: 30_000,
      io: new NodePlatformIO(),
    });
    expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("side fork ok");
  }, 30_000);
});
