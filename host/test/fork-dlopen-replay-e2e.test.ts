/**
 * End-to-end test for fork-after-dlopen.
 *
 * Reproduces the WordPress LEMP browser-demo trap: the parent dlopens a
 * side module whose data section has a function pointer baked in via
 * __wasm_apply_data_relocs (table_base + N). After fork(), the child's
 * freshly-instantiated table is back at module-initial length, so the
 * stored function pointer references a slot only the parent's table had
 * grown to cover. The child traps with "table index is out of bounds"
 * on the first call_indirect through that pointer.
 *
 * The fix is to replay parent dlopens in the fork child before resuming.
 * This fixture is expected to FAIL until that fix lands.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { NodePlatformIO } from "../src/platform/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const SYSROOT = process.env.KANDELO_TEST_SYSROOT ?? join(REPO_ROOT, "sysroot");
const GLUE_DIR = join(REPO_ROOT, "libc", "glue");
const clangDriver = process.env.CLANG ?? "clang";

function llvmTool(name: "clang" | "clang++" | "wasm-ld"): string {
  const override = name === "wasm-ld" ? process.env.WASM_LD : undefined;
  if (override) return override;
  try {
    return execFileSync(clangDriver, [`-print-prog-name=${name}`], {
      encoding: "utf8",
    }).trim() || name;
  } catch {
    return name;
  }
}

const CLANG = llvmTool("clang");
const CLANGXX = llvmTool("clang++");
const WASM_LD = llvmTool("wasm-ld");
const FORK_INSTRUMENT = join(REPO_ROOT, "scripts", "run-wasm-fork-instrument.sh");

const hasSysroot = existsSync(join(SYSROOT, "lib", "libc.a"));
const hasKernel = existsSync(join(REPO_ROOT, "binaries", "kernel.wasm")) ||
  existsSync(join(REPO_ROOT, "local-binaries", "kernel.wasm"));

const BUILD_DIR = join(tmpdir(), "wasm-fork-dlopen-replay-e2e");

function findLibcxxPrefix(): string | undefined {
  const explicit = process.env.KANDELO_LIBCXX_PREFIX;
  if (
    explicit
    && existsSync(join(explicit, "lib", "libc++-pic.a"))
    && existsSync(join(explicit, "lib", "libc++abi-pic.a"))
  ) {
    return explicit;
  }
  const sysrootArchive = join(SYSROOT, "lib", "libc++.a");
  if (!existsSync(sysrootArchive)) return undefined;
  const prefix = dirname(dirname(realpathSync(sysrootArchive)));
  return existsSync(join(prefix, "lib", "libc++-pic.a"))
      && existsSync(join(prefix, "lib", "libc++abi-pic.a"))
    ? prefix
    : undefined;
}

const libcxxPrefix = findLibcxxPrefix();
const hasCppPrerequisites = hasSysroot && hasKernel && libcxxPrefix !== undefined;

if (process.env.KANDELO_REQUIRE_CPP_DYLINK_FORK_E2E === "1" && !hasCppPrerequisites) {
  throw new Error(
    "C++ dlopen/fork e2e was required but kernel.wasm, sysroot/libc.a, or libcxx PIC archives are missing",
  );
}

const CPP_RUNTIME_MAIN_EXPORTS = [
  "getenv", "fprintf", "fflush", "malloc", "strlen", "memcmp", "realloc",
  "free", "fwrite", "vfprintf", "fputc", "abort", "memchr", "snprintf",
  "aligned_alloc", "strcmp", "pthread_mutex_lock", "pthread_mutex_unlock", "calloc",
];

/** Build a shared Wasm library (.so side module) from C source. */
function buildSharedLib(source: string, name: string): string {
  const srcPath = join(BUILD_DIR, `${name}.c`);
  const objPath = join(BUILD_DIR, `${name}.o`);
  const soPath = join(BUILD_DIR, `${name}.so`);

  writeFileSync(srcPath, `${source}
    #include "abi_constants.h"
    __attribute__((export_name("__abi_version")))
    unsigned __abi_version(void) { return WASM_POSIX_ABI_VERSION; }
  `);

  execSync(
    `${CLANG} --target=wasm32-unknown-unknown -fPIC -O2 -matomics -mbulk-memory -I${GLUE_DIR} -c ${srcPath} -o ${objPath}`,
    { stdio: "pipe" },
  );
  execSync(
    `${WASM_LD} --experimental-pic --shared --shared-memory --export-all --allow-undefined -o ${soPath} ${objPath}`,
    { stdio: "pipe" },
  );
  execSync(`${FORK_INSTRUMENT} ${soPath} -o ${soPath}`, { stdio: "pipe" });

  return soPath;
}

/** Build a real C++ EH side module, including its TLS-bearing unwinder. */
function buildCppSharedLib(source: string, name: string): string {
  if (!libcxxPrefix) throw new Error("libcxx PIC prefix unavailable");
  const srcPath = join(BUILD_DIR, `${name}.cpp`);
  const objPath = join(BUILD_DIR, `${name}.o`);
  const soPath = join(BUILD_DIR, `${name}.so`);
  writeFileSync(srcPath, `${source}
    #include "abi_constants.h"
    extern "C" __attribute__((export_name("__abi_version")))
    unsigned __abi_version(void) { return WASM_POSIX_ABI_VERSION; }
  `);
  execFileSync(CLANGXX, [
    "--target=wasm32-unknown-unknown",
    `--sysroot=${SYSROOT}`,
    "-nostdlib",
    "-fPIC",
    "-O2",
    "-fwasm-exceptions",
    "-matomics",
    "-mbulk-memory",
    `-I${GLUE_DIR}`,
    `-I${join(libcxxPrefix, "include", "c++", "v1")}`,
    "-c",
    srcPath,
    "-o",
    objPath,
  ], { stdio: "pipe" });
  execFileSync(WASM_LD, [
    "--experimental-pic",
    "--shared",
    "--shared-memory",
    "--export-all",
    "--allow-undefined",
    "--export=__tls_base",
    "-o",
    soPath,
    objPath,
    join(libcxxPrefix, "lib", "libc++-pic.a"),
    join(libcxxPrefix, "lib", "libc++abi-pic.a"),
  ], { stdio: "pipe" });
  execFileSync("bash", [
    FORK_INSTRUMENT,
    soPath,
    "-o",
    soPath,
  ], { stdio: "pipe" });
  return soPath;
}

/** Build a main program with dlopen + fork support. */
function buildMainProgram(source: string, name: string, forceExports: string[] = []): string {
  const srcPath = join(BUILD_DIR, `${name}.c`);
  const wasmPath = join(BUILD_DIR, `${name}.wasm`);

  writeFileSync(srcPath, source);

  const cflags = [
    "--target=wasm32-unknown-unknown",
    `--sysroot=${SYSROOT}`,
    "-nostdlib",
    "-O2",
    "-matomics", "-mbulk-memory",
    "-fno-trapping-math",
  ];

  const linkFlags = [
    join(GLUE_DIR, "channel_syscall.c"),
    join(GLUE_DIR, "compiler_rt.c"),
    join(GLUE_DIR, "dlopen.c"),
    join(SYSROOT, "lib", "crt1.o"),
    join(SYSROOT, "lib", "libc.a"),
    "-Wl,--no-entry",
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
    ...(forceExports.length > 0 ? ["-Wl,--export-all"] : []),
    ...forceExports.map((symbol) => `-Wl,-u,${symbol}`),
  ];

  const allArgs = [...cflags, srcPath, ...linkFlags, "-o", wasmPath];
  execSync(`${CLANG} ${allArgs.join(" ")}`, { stdio: "pipe" });

  // wasm-fork-instrument is required for fork support; without it,
  // kernel_fork returns ENOSYS and the bug-under-test never reproduces.
  execSync(
    `${FORK_INSTRUMENT} ${wasmPath} -o ${wasmPath}`,
    { stdio: "pipe" },
  );

  return wasmPath;
}

describe.skipIf(!hasSysroot || !hasKernel)("fork after dlopen end-to-end", () => {
  beforeAll(() => {
    mkdirSync(BUILD_DIR, { recursive: true });
  });

  // The .so file lives under `os.tmpdir()` (an absolute host path that
  // the default mount-based VFS doesn't know about). Opt into
  // NodePlatformIO so dlopen() can reach it — same constraint as
  // dlopen-e2e.test.ts.
  const io = () => new NodePlatformIO();

  it("child can call function pointers baked into a parent-dlopened side module", { timeout: 30_000 }, async () => {
    const soPath = buildSharedLib(
      `
      int side_init(void) { return 42; }

      typedef int (*init_fn)(void);
      static struct { init_fn entry; } module_entry = { .entry = side_init };

      int trigger(void) { return module_entry.entry(); }
      `,
      "libforkside",
    );

    const wasmPath = buildMainProgram(
      `
      #include <dlfcn.h>
      #include <stdio.h>
      #include <stdlib.h>
      #include <unistd.h>
      #include <sys/wait.h>

      typedef int (*trigger_fn)(void);

      int main(int argc, char *argv[]) {
        const char *lib_path = argv[1];
        void *lib = dlopen(lib_path, RTLD_NOW);
        if (!lib) { fprintf(stderr, "dlopen: %s\\n", dlerror()); return 1; }

        trigger_fn trigger = (trigger_fn)dlsym(lib, "trigger");
        if (!trigger) { fprintf(stderr, "dlsym: %s\\n", dlerror()); return 1; }

        if (trigger() != 42) { fprintf(stderr, "parent trigger != 42\\n"); return 1; }

        pid_t pid = fork();
        if (pid == 0) {
          int v = trigger();
          _exit(v == 42 ? 0 : 1);
        } else if (pid > 0) {
          int status;
          waitpid(pid, &status, 0);
          if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
            printf("ok\\n");
            return 0;
          }
          fprintf(stderr, "child exited badly: status=%d\\n", status);
          return 1;
        }
        fprintf(stderr, "fork failed\\n");
        return 1;
      }
      `,
      "test-fork-dlopen-replay",
    );

    const result = await runCentralizedProgram({
      programPath: wasmPath,
      argv: ["fork-dlopen-main", soPath],
      timeout: 30_000,
      io: io(),
    });

    expect(result.stderr).not.toContain("table index is out of bounds");
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("replays pthread-hosted dlopen table state into a fresh fork child", { timeout: 30_000 }, async () => {
    const soPath = buildSharedLib(
      `
      typedef int (*step_fn)(int);
      static int increment(int value) { return value + 1; }
      static step_fn relocated_step = increment;
      int pthread_replay_value(int value) { return relocated_step(value); }
      `,
      "libpthreadreplay",
    );
    const wasmPath = buildMainProgram(`
      #include <dlfcn.h>
      #include <pthread.h>
      #include <stdio.h>
      #include <unistd.h>
      #include <sys/wait.h>

      static const char *side_path;
      static int thread_result;
      typedef int (*replay_fn)(int);

      static void *run_thread(void *unused) {
        (void)unused;
        void *side = dlopen(side_path, RTLD_NOW);
        if (!side) {
          fprintf(stderr, "pthread dlopen: %s\\n", dlerror());
          thread_result = 1;
          return NULL;
        }
        replay_fn replay = (replay_fn)dlsym(side, "pthread_replay_value");
        if (!replay || replay(40) != 41) {
          thread_result = 2;
          return NULL;
        }

        pid_t child = fork();
        if (child == 0) {
          _exit(replay(41) == 42 ? 0 : 3);
        }
        if (child < 0) {
          thread_result = 4;
          return NULL;
        }
        int status = 0;
        if (
          waitpid(child, &status, 0) != child
          || !WIFEXITED(status)
          || WEXITSTATUS(status) != 0
        ) {
          thread_result = 5;
          return NULL;
        }
        thread_result = 0;
        return NULL;
      }

      int main(int argc, char **argv) {
        side_path = argv[1];
        pthread_t thread;
        if (pthread_create(&thread, NULL, run_thread, NULL) != 0) return 3;
        if (pthread_join(thread, NULL) != 0) return 4;
        if (thread_result != 0) return 10 + thread_result;
        puts("pthread dlopen fork replay ok");
        return 0;
      }
    `, "test-pthread-dlopen-fork-replay");

    const result = await runCentralizedProgram({
      programPath: wasmPath,
      argv: ["pthread-dlopen-fork-replay", soPath],
      timeout: 30_000,
      io: io(),
      captureForkCount: true,
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pthread dlopen fork replay ok");
    expect(result.forkCount).toBe(1n);
  });

  it("blocks a foreign pthread until the staged loader owner commits", { timeout: 30_000 }, async () => {
    const slowPath = buildSharedLib(
      `
      extern void loader_ctor_enter(void);
      extern void loader_ctor_wait(void);
      __attribute__((constructor))
      static void slow_constructor(void) {
        loader_ctor_enter();
        loader_ctor_wait();
      }
      int slow_value(void) { return 17; }
      `,
      "libpthread-loader-owner",
    );
    const fastPath = buildSharedLib(
      `int fast_value(void) { return 29; }`,
      "libpthread-loader-waiter",
    );
    const wasmPath = buildMainProgram(`
      #include <dlfcn.h>
      #include <pthread.h>
      #include <stdatomic.h>
      #include <stdint.h>
      #include <stdio.h>
      #include <unistd.h>

      static const char *slow_path;
      static const char *fast_path;
      static _Atomic int owner_ready;
      static _Atomic int waiter_ready;
      static _Atomic int start_owner;
      static _Atomic int constructor_entered;
      static _Atomic int release_constructor;
      static _Atomic int waiter_entered;
      static _Atomic int waiter_done;
      static _Atomic int constructor_timeout;
      static int owner_result;
      static int waiter_result;

      static int wait_for(_Atomic int *value) {
        for (int attempt = 0; attempt < 5000; attempt++) {
          if (atomic_load_explicit(value, memory_order_acquire)) return 1;
          usleep(1000);
        }
        return atomic_load_explicit(value, memory_order_acquire) != 0;
      }

      void loader_ctor_enter(void) {
        atomic_store_explicit(&constructor_entered, 1, memory_order_release);
      }

      void loader_ctor_wait(void) {
        if (!wait_for(&release_constructor)) {
          atomic_store_explicit(&constructor_timeout, 1, memory_order_release);
        }
      }

      static void *run_owner(void *unused) {
        (void)unused;
        atomic_store_explicit(&owner_ready, 1, memory_order_release);
        if (!wait_for(&start_owner)) {
          owner_result = 2;
          return NULL;
        }
        void *handle = dlopen(slow_path, RTLD_NOW | RTLD_GLOBAL);
        if (!handle) fprintf(stderr, "owner dlopen: %s\\n", dlerror());
        owner_result = handle ? 0 : 1;
        return NULL;
      }

      static void *run_waiter(void *unused) {
        (void)unused;
        atomic_store_explicit(&waiter_ready, 1, memory_order_release);
        if (!wait_for(&constructor_entered)) {
          waiter_result = 2;
          return NULL;
        }
        atomic_store_explicit(&waiter_entered, 1, memory_order_release);
        void *handle = dlopen(fast_path, RTLD_NOW | RTLD_LOCAL);
        if (!handle) fprintf(stderr, "waiter dlopen: %s\\n", dlerror());
        waiter_result = handle ? 0 : 1;
        atomic_store_explicit(&waiter_done, 1, memory_order_release);
        return NULL;
      }

      int main(int argc, char **argv) {
        slow_path = argv[1];
        fast_path = argv[2];
        pthread_t owner;
        pthread_t waiter;
        if (pthread_create(&owner, NULL, run_owner, NULL) != 0) return 2;
        if (pthread_create(&waiter, NULL, run_waiter, NULL) != 0) return 3;
        if (!wait_for(&owner_ready)) return 11;
        if (!wait_for(&waiter_ready)) return 12;
        atomic_store_explicit(&start_owner, 1, memory_order_release);
        if (!wait_for(&constructor_entered)) return 8;
        if (!wait_for(&waiter_entered)) return 9;
        usleep(10000);
        int waiter_completed_early =
          atomic_load_explicit(&waiter_done, memory_order_acquire);
        atomic_store_explicit(
          &release_constructor,
          1,
          memory_order_release
        );
        if (pthread_join(owner, NULL) != 0) return 5;
        if (pthread_join(waiter, NULL) != 0) return 6;
        if (atomic_load_explicit(&constructor_timeout, memory_order_acquire)) {
          return 10;
        }
        if (waiter_completed_early) return waiter_result == 0 ? 4 : 14;
        if (owner_result != 0 || waiter_result != 0) return 7;
        puts("pthread loader lease ok");
        return 0;
      }
    `, "test-pthread-loader-owner", [
      "loader_ctor_enter",
      "loader_ctor_wait",
    ]);

    const result = await runCentralizedProgram({
      programPath: wasmPath,
      argv: ["pthread-loader-owner", slowPath, fastPath],
      timeout: 30_000,
      io: io(),
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toContain("pthread loader lease ok");
  });

  it.skipIf(!hasCppPrerequisites)(
    "child preserves side-module TLS for a real compiled C++ throw/catch",
    { timeout: 30_000 },
    async () => {
      const soPath = buildCppSharedLib(`
        thread_local int cpp_tls_marker = 7;
        extern "C" void cpp_set_tls_marker(int value) { cpp_tls_marker = value; }
        extern "C" int cpp_get_tls_marker(void) { return cpp_tls_marker; }
        extern "C" int cpp_throw_and_catch(int value) {
          try { throw value; }
          catch (int caught) { return caught; }
        }
      `, "libcppthrow");
      const sideModule = new WebAssembly.Module(
        new Uint8Array(readFileSync(soPath)) as unknown as BufferSource,
      );
      const sideImports = WebAssembly.Module.imports(sideModule);
      const sideExports = WebAssembly.Module.exports(sideModule);
      expect(sideImports.some((entry) =>
        entry.module === "env"
          && entry.name === "__cpp_exception"
          && (entry.kind as string) === "tag"
      )).toBe(true);
      expect(sideExports.map((entry) => entry.name)).toEqual(
        expect.arrayContaining(["__tls_base", "__tls_size", "__wasm_init_tls"]),
      );

      const wasmPath = buildMainProgram(`
        #include <dlfcn.h>
        #include <stdio.h>
        #include <stdlib.h>
        #include <unistd.h>
        #include <sys/wait.h>
        typedef int (*cpp_throw_fn)(int);
        typedef void (*cpp_set_marker_fn)(int);
        typedef int (*cpp_get_marker_fn)(void);
        int main(int argc, char **argv) {
          void *lib = dlopen(argv[1], RTLD_NOW);
          if (!lib) { fprintf(stderr, "dlopen: %s\\n", dlerror()); return 2; }
          cpp_throw_fn run = (cpp_throw_fn)dlsym(lib, "cpp_throw_and_catch");
          cpp_set_marker_fn set_marker = (cpp_set_marker_fn)dlsym(lib, "cpp_set_tls_marker");
          cpp_get_marker_fn get_marker = (cpp_get_marker_fn)dlsym(lib, "cpp_get_tls_marker");
          if (!run || !set_marker || !get_marker || run(41) != 41) return 3;
          set_marker(99);
          if (get_marker() != 99) return 4;
          pid_t pid = fork();
          if (pid == 0) _exit(get_marker() == 99 && run(42) == 42 ? 0 : 5);
          if (pid < 0) return 6;
          int status = 0;
          if (waitpid(pid, &status, 0) != pid) return 7;
          if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return 8;
          puts("cpp throw after fork ok");
          return 0;
        }
      `, "test-cpp-throw-after-dlopen-fork", CPP_RUNTIME_MAIN_EXPORTS);

      const result = await runCentralizedProgram({
        programPath: wasmPath,
        argv: ["cpp-throw-main", soPath],
        timeout: 30_000,
        io: io(),
      });

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("cpp throw after fork ok");
    },
  );
});
