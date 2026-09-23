/**
 * A process's function table, as each of its threads sees it.
 *
 * A C function pointer is an index into the indirect function table, and every
 * pthread runs in its own Worker with its own `WebAssembly.Table`. So a pointer
 * one thread stores into shared memory names a function in ANOTHER thread's
 * table only if both tables hold the same function at that index. These tests
 * run real programs through real Workers and check exactly that, by calling
 * through pointers handed across threads and checking WHICH function answered.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeHostScratchTempRoot,
  runCentralizedProgram,
} from "./centralized-test-helper";
import { NodePlatformIO } from "../src/platform/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const GLUE_DIR = join(REPO_ROOT, "libc", "glue");
// Absolute, so a bare name cannot resolve another worktree's SDK.
const CC = join(REPO_ROOT, "sdk", "bin", "wasm32posix-cc");
const FORK_INSTRUMENT = join(REPO_ROOT, "scripts", "run-wasm-fork-instrument.sh");
// Under `<repo>/target`, not the in-kernel tmpfs, so the guest's dlopen reaches
// the real host file through NodePlatformIO.
const BUILD_DIR = makeHostScratchTempRoot("dlopen-pthread-table-");

function build(source: string, name: string, flags: string[]): string {
  const src = join(BUILD_DIR, `${name}.c`);
  const out = join(BUILD_DIR, name);
  writeFileSync(src, source);
  execFileSync(CC, [...flags, src, "-o", out], { stdio: "pipe" });
  execFileSync(FORK_INSTRUMENT, [out, "-o", out], { stdio: "pipe" });
  return out;
}

function sharedLibrary(source: string, name: string): string {
  return build(
    `${source}
    #include "abi_constants.h"
    __attribute__((export_name("__abi_version")))
    unsigned __abi_version(void) { return WASM_POSIX_ABI_VERSION; }
    `,
    `${name}.so`,
    ["-shared", "-fPIC", "-O2", `-I${GLUE_DIR}`],
  );
}

/**
 * Three functions with three different answers, so a call through the wrong
 * slot is a wrong NUMBER rather than a coincidentally right one.
 */
const LIBRARY = `
  typedef int (*fn_t)(int);
  static int lib_private(int x) { return x + 1000; }
  fn_t lib_pointer(void) { return lib_private; }
  int lib_value(int x) { return x + 1; }
`;

describe("function pointers across pthreads after dlopen", () => {
  beforeAll(() => mkdirSync(BUILD_DIR, { recursive: true }));

  /**
   * The thread is created AFTER the dlopen, so it materializes the library
   * from the published archive when it starts. Its table must put every
   * library function where the loading thread's table did.
   *
   * Before the dylink export-slot fix this failed two ways at once: the
   * `dlsym` pointer was one past the end of the thread's table ("table index
   * is out of bounds"), and the pointer to `lib_private` named `lib_value`
   * there instead -- a wrong function, not a trap.
   */
  it("a thread created after dlopen calls the library through pointers the loader handed out", {
    timeout: 60_000,
  }, async () => {
    const library = sharedLibrary(LIBRARY, "libpointers");
    const program = build(`
      #include <dlfcn.h>
      #include <pthread.h>
      #include <stdio.h>
      #include <unistd.h>
      typedef int (*fn_t)(int);
      static fn_t by_dlsym;
      static fn_t by_library;
      static int from_dlsym = -1;
      static int from_library = -1;
      static void *run(void *unused) {
        (void)unused;
        from_dlsym = by_dlsym(1);
        from_library = by_library(1);
        return NULL;
      }
      int main(int argc, char **argv) {
        // Never taken. It links fork(), because Kandelo accepts a
        // fork-instrumented side module only into a main program that can
        // fork (the dylink-main capability); a program that never forks
        // cannot dlopen one today. That is a separate platform gap.
        if (argc > 99) fork();
        void *handle = dlopen(argv[1], RTLD_NOW);
        if (!handle) { fprintf(stderr, "dlopen: %s\\n", dlerror()); return 3; }
        by_dlsym = (fn_t)dlsym(handle, "lib_value");
        fn_t (*pointer)(void) = (fn_t (*)(void))dlsym(handle, "lib_pointer");
        if (!by_dlsym || !pointer) return 4;
        by_library = pointer();
        if (by_dlsym(1) != 2 || by_library(1) != 1001) return 5;
        pthread_t thread;
        if (pthread_create(&thread, NULL, run, NULL)) return 6;
        pthread_join(thread, NULL);
        fprintf(stderr, "thread: dlsym pointer %d, library pointer %d\\n",
          from_dlsym, from_library);
        return from_dlsym == 2 && from_library == 1001 ? 0 : 7;
      }
    `, "pointers-after-dlopen.wasm", ["-O2", "-ldl"]);
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["pointers-after-dlopen", library],
      timeout: 60_000,
      io: new NodePlatformIO(),
    });
    expect(result.stderr).toContain("thread: dlsym pointer 2, library pointer 1001");
    expect(result.exitCode).toBe(0);
  });
});
