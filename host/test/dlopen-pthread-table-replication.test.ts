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

  /**
   * After a dlopen publishes a generation, every guarded table access compares
   * the process fence against the generation this Worker last reached. The
   * fork module is what reaches it; if it answers a generation below the fence
   * the guard calls it again on the NEXT access, and on every one after.
   *
   * That happened on every host until the fork module was given the dlopen
   * control address: it answered generation 0 forever, and a loop of indirect
   * calls after a dlopen called it once per iteration (16,384+ calls in a
   * 20,000-call loop, 3-5x slower, measured). There is no host-side counter a
   * test can read, so this measures the effect: the same loop must not get
   * several times slower once a library is loaded.
   */
  it("a loop of indirect calls after dlopen costs what it cost before", {
    timeout: 60_000,
  }, async () => {
    const library = sharedLibrary(LIBRARY, "libloop");
    const program = build(`
      #include <dlfcn.h>
      #include <stdio.h>
      #include <time.h>
      #include <unistd.h>
      typedef int (*fn_t)(int);
      static int local_inc(int x) { return x + 2; }
      static volatile fn_t through = local_inc;
      static double now(void) {
        struct timespec ts;
        clock_gettime(CLOCK_MONOTONIC, &ts);
        return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
      }
      static double loop(int n, long *sum) {
        double start = now();
        long acc = 0;
        for (int i = 0; i < n; i++) acc += through(i);
        *sum = acc;
        return now() - start;
      }
      int main(int argc, char **argv) {
        if (argc > 99) fork(); // links fork(); see the first test
        const int n = 2000000;
        long before_sum = 0, after_sum = 0;
        loop(n, &before_sum); // warm up the tier-up before measuring
        double before = loop(n, &before_sum);
        void *handle = dlopen(argv[1], RTLD_NOW);
        if (!handle) { fprintf(stderr, "dlopen: %s\\n", dlerror()); return 3; }
        loop(n, &after_sum);
        double after = loop(n, &after_sum);
        fprintf(stderr, "before %.2f ms, after %.2f ms\\n", before, after);
        if (before_sum != after_sum) return 4;
        // Generous: a per-call module round trip was 3-5x.
        return after <= before * 2.0 + 10.0 ? 0 : 5;
      }
    `, "loop-after-dlopen.wasm", ["-O2", "-ldl"]);
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["loop-after-dlopen", library],
      timeout: 60_000,
      io: new NodePlatformIO(),
    });
    expect(result.stderr).toMatch(/before [0-9.]+ ms, after [0-9.]+ ms/);
    expect(result.exitCode, result.stderr).toBe(0);
  });

  /**
   * One thread writes a function into a new slot of the process function
   * table and hands the slot to another thread through an atomic; the reader
   * never makes a syscall between seeing the pointer and calling through it.
   * POSIX gives it no other synchronization point, so the reader's first call
   * has to bring its own Worker's copy of the table up to date.
   *
   * It does that through the fork module: the writer's `table.grow` and
   * `table.set` each publish a patch naming (activation, owner), and the
   * reader's guarded `call_indirect` reconciles, applying the patches through
   * the reader's own table shim. C has no funcref-table builtin that clang 21
   * accepts, so the writes are two lines of inline Wasm on the linker's
   * `__indirect_function_table`, which is what any runtime code patcher does.
   * The dlopen is there because the process publication archive is created by
   * the dynamic loader; before one, a guest table mutation has nowhere to be
   * published (docs/architecture.md, "Known gaps").
   */
  it("a function written into the table by one thread is callable by another after an atomic handoff", {
    timeout: 60_000,
  }, async () => {
    const library = sharedLibrary(LIBRARY, "libhandoff");
    const program = build(`
      #include <dlfcn.h>
      #include <pthread.h>
      #include <stdatomic.h>
      #include <stdint.h>
      #include <stdio.h>
      #include <unistd.h>
      __asm__(".tabletype __indirect_function_table, funcref\\n");
      static int grow_table(int n) {
        int at;
        __asm__ volatile("ref.null_func\\n\\tlocal.get %1\\n\\t"
          "table.grow __indirect_function_table\\n\\tlocal.set %0"
          : "=r"(at) : "r"(n));
        return at;
      }
      static void copy_slot(int dst, int src) {
        __asm__ volatile("local.get %0\\n\\tlocal.get %1\\n\\t"
          "table.get __indirect_function_table\\n\\t"
          "table.set __indirect_function_table" :: "r"(dst), "r"(src));
      }
      typedef int (*fn_t)(int);
      static int add_seven(int x) { return x + 7; }
      static volatile fn_t source = add_seven;
      static _Atomic int ready = 0;
      static _Atomic(fn_t) published;
      static _Atomic int answer = -1;
      static void *reader(void *unused) {
        (void)unused;
        atomic_store(&ready, 1);
        fn_t f;
        while (!(f = atomic_load(&published))) { /* no syscall */ }
        atomic_store(&answer, f(35));
        return NULL;
      }
      int main(int argc, char **argv) {
        if (argc > 99) fork(); // links fork(); see the first test
        if (!dlopen(argv[1], RTLD_NOW)) {
          fprintf(stderr, "dlopen: %s\\n", dlerror());
          return 3;
        }
        pthread_t thread;
        if (pthread_create(&thread, NULL, reader, NULL)) return 4;
        while (!atomic_load(&ready)) usleep(1000);
        int at = grow_table(3);
        if (at < 0) return 5;
        copy_slot(at + 2, (int)(uintptr_t)source);
        atomic_store(&published, (fn_t)(uintptr_t)(at + 2));
        for (int i = 0; i < 3000 && atomic_load(&answer) < 0; i++) usleep(1000);
        fprintf(stderr, "reader called slot %d and got %d\\n", at + 2,
          atomic_load(&answer));
        if (atomic_load(&answer) != 42) _exit(6);
        pthread_join(thread, NULL);
        return 0;
      }
    `, "funcref-handoff.wasm", ["-O2", "-ldl"]);
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["funcref-handoff", library],
      timeout: 60_000,
      io: new NodePlatformIO(),
    });
    expect(result.stderr).toContain("and got 42");
    expect(result.exitCode).toBe(0);
  });

  /**
   * A pthread that is ALREADY RUNNING when another thread dlopens a library,
   * then calls into that library through a pointer handed over in shared
   * memory, with no syscall in between.
   *
   * The older thread's Worker has never instantiated the library, so its
   * table has no slots for it. Its first call through the pointer runs the
   * table guard; the fork module's reconcile sees the published archive name
   * an activation this Worker lacks, and asks the host to instantiate it
   * (`__wpk_fork_host_materialize_dlopen_archive`) before applying anything.
   * Before that import existed this trapped "table index is out of bounds":
   * nothing instantiated the library in this Worker until its next fork or
   * loader lock.
   */
  it("a thread created before dlopen calls the library through a handed-over pointer", {
    timeout: 60_000,
  }, async () => {
    const library = sharedLibrary(LIBRARY, "libbefore");
    const program = build(`
      #include <dlfcn.h>
      #include <pthread.h>
      #include <stdatomic.h>
      #include <stdio.h>
      #include <unistd.h>
      typedef int (*fn_t)(int);
      static _Atomic(fn_t) shared_fn;
      static _Atomic int ready = 0;
      static _Atomic int answer = -1;
      static void *run(void *unused) {
        (void)unused;
        atomic_store(&ready, 1);
        fn_t f;
        while (!(f = atomic_load(&shared_fn))) { /* no syscall */ }
        atomic_store(&answer, f(1));
        return NULL;
      }
      int main(int argc, char **argv) {
        if (argc > 99) fork(); // links fork(); see the first test
        pthread_t thread;
        if (pthread_create(&thread, NULL, run, NULL)) return 2;
        while (!atomic_load(&ready)) usleep(1000);
        void *handle = dlopen(argv[1], RTLD_NOW);
        if (!handle) { fprintf(stderr, "dlopen: %s\\n", dlerror()); return 3; }
        atomic_store(&shared_fn, (fn_t)dlsym(handle, "lib_value"));
        for (int i = 0; i < 3000 && atomic_load(&answer) < 0; i++) usleep(1000);
        if (atomic_load(&answer) != 2) _exit(7);
        pthread_join(thread, NULL);
        return 0;
      }
    `, "pointer-before-dlopen.wasm", ["-O2", "-ldl"]);
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["pointer-before-dlopen", library],
      timeout: 60_000,
      io: new NodePlatformIO(),
    });
    expect(result.exitCode).toBe(0);
  });
});

describe("tables across fork", () => {
  beforeAll(() => mkdirSync(BUILD_DIR, { recursive: true }));

  /**
   * An externref table is per-Worker by construction: its host objects cannot
   * exist in another Worker, so it is never replicated. Fork still carries it
   * through the module-state save/restore helpers.
   *
   * Before the instrumenter split "saved across fork" from "replicated across
   * Workers" this program exited 132: its `table.set` was committed as a
   * replicated funcref mutation, which asked the fork module to describe an
   * externref slot as a function-catalog entry.
   */
  it("a program that grows and sets its own externref table forks", {
    timeout: 60_000,
  }, async () => {
    const program = build(`
      #include <stdio.h>
      #include <unistd.h>
      #include <sys/wait.h>
      static __externref_t table[0];
      int main(void) {
        __builtin_wasm_table_grow(table, __builtin_wasm_ref_null_extern(), 100);
        __builtin_wasm_table_set(table, 50, __builtin_wasm_ref_null_extern());
        pid_t pid = fork();
        if (pid == 0) _exit(__builtin_wasm_table_size(table) == 100 ? 0 : 9);
        if (pid < 0) { perror("fork"); return 5; }
        int status = 0;
        if (waitpid(pid, &status, 0) != pid) return 6;
        fprintf(stderr, "child status %d\\n", status);
        return WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : 7;
      }
    `, "externref-table-fork.wasm", ["-O2", "-mreference-types"]);
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["externref-table-fork"],
      timeout: 60_000,
    });
    expect(result.stderr).toContain("child status 0");
    expect(result.exitCode).toBe(0);
  });

  /** The child of a dlopening parent calls the library through both kinds of pointer. */
  it("a fork child calls into a library its parent dlopened", {
    timeout: 60_000,
  }, async () => {
    const library = sharedLibrary(LIBRARY, "libforked");
    const program = build(`
      #include <dlfcn.h>
      #include <stdio.h>
      #include <unistd.h>
      #include <sys/wait.h>
      typedef int (*fn_t)(int);
      int main(int argc, char **argv) {
        (void)argc;
        void *handle = dlopen(argv[1], RTLD_NOW);
        if (!handle) { fprintf(stderr, "dlopen: %s\\n", dlerror()); return 3; }
        fn_t by_dlsym = (fn_t)dlsym(handle, "lib_value");
        fn_t (*pointer)(void) = (fn_t (*)(void))dlsym(handle, "lib_pointer");
        if (!by_dlsym || !pointer) return 4;
        fn_t by_library = pointer();
        pid_t pid = fork();
        if (pid == 0) _exit(by_dlsym(1) == 2 && by_library(1) == 1001 ? 0 : 9);
        if (pid < 0) { perror("fork"); return 5; }
        int status = 0;
        if (waitpid(pid, &status, 0) != pid) return 6;
        fprintf(stderr, "child status %d\\n", status);
        return WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : 7;
      }
    `, "fork-after-dlopen.wasm", ["-O2", "-ldl"]);
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["fork-after-dlopen", library],
      timeout: 60_000,
      io: new NodePlatformIO(),
    });
    expect(result.stderr).toContain("child status 0");
    expect(result.exitCode).toBe(0);
  });
});
