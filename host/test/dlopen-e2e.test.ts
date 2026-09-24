/**
 * End-to-end test for dlopen/dlsym/dlclose.
 *
 * Builds a shared Wasm library and a main program that loads it via dlopen,
 * then runs the program through the kernel and verifies output.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeHostScratchTempRoot,
  runCentralizedProgram,
} from "./centralized-test-helper";
import { NodePlatformIO } from "../src/platform/node";
import { tryResolveBinary } from "../src/binary-resolver";
import { artifactGate } from "./support/artifact-gate";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const SYSROOT = join(REPO_ROOT, "sysroot");
const SYSROOT64 = join(REPO_ROOT, "sysroot64");

const hasSysroot = existsSync(join(SYSROOT, "lib", "libc.a"));
const hasSysroot64 = existsSync(join(SYSROOT64, "lib", "libc.a"));
// Ask the resolver, the way `runCentralizedProgram` finds the kernel it
// boots. Probing two fixed paths skipped this whole file whenever the kernel
// lived only in a source-only generation (`local-binaries/source-only-v1`).
const hasKernel = tryResolveBinary("kernel.wasm") !== null;
function hasCompiler(compiler = "wasm32posix-cc"): boolean {
  try {
    execFileSync(compiler, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Stage the built `.so`/`.wasm` under `<repoRoot>/target` (never an in-kernel
// tmpfs scratch prefix) so the guest reaches the real host file through
// NodePlatformIO. `os.tmpdir()` frequently resolves under `/tmp` (the nix dev
// shell sets `TMPDIR=/tmp/nix-shell.*`), where the empty in-kernel tmpfs shadows
// the path and the guest dlopen fails with "cannot stat library".
const BUILD_DIR = makeHostScratchTempRoot("wasm-dlopen-e2e-");

/** Build a shared Wasm library (.so side module) from C source. */
function buildSharedLib(
  source: string,
  name: string,
  compiler = "wasm32posix-cc",
): string {
  const srcPath = join(BUILD_DIR, `${name}.c`);
  const soPath = join(BUILD_DIR, `${name}.so`);
  writeFileSync(srcPath, source);
  execFileSync(compiler,
    ["-shared", "-fPIC", "-O2", srcPath, "-o", soPath],
    { stdio: "pipe" });
  return soPath;
}

/** Build a main program with dlopen support. */
function buildMainProgram(
  source: string,
  name: string,
  extraArgs: string[] = [],
  compiler = "wasm32posix-cc",
): string {
  const srcPath = join(BUILD_DIR, `${name}.c`);
  const wasmPath = join(BUILD_DIR, `${name}.wasm`);
  writeFileSync(srcPath, source);
  execFileSync(compiler,
    ["-O2", "-ldl", ...extraArgs, srcPath, "-o", wasmPath],
    { stdio: "pipe" });
  return wasmPath;
}

const dlopenGate = artifactGate("dlopen-e2e", [
  { what: "musl sysroot (libc.a)", present: hasSysroot, build: "scripts/build-musl.sh" },
  {
    what: "kernel.wasm (via the binary resolver)",
    present: hasKernel,
    build: "scripts/dev-shell.sh ./run.sh setup",
  },
  {
    what: "wasm32posix-cc on PATH",
    present: hasCompiler(),
    build: "run inside scripts/dev-shell.sh",
  },
]);

describe.skipIf(dlopenGate.skip)("dlopen end-to-end", () => {
  beforeAll(() => {
    mkdirSync(BUILD_DIR, { recursive: true });
  });

  // The .so files are written under `<repoRoot>/target` and passed to the wasm
  // program as an absolute host path. The default mount-based VFS doesn't know
  // about that path, so dlopen() would see ENOENT. Opt the test into the
  // raw-host-fs escape hatch via `NodePlatformIO`, since this test exercises
  // the dlopen plumbing rather than the VFS layer.
  const io = () => new NodePlatformIO();

  it("opens and resolves the main program symbol scope", async () => {
    const wasmPath = buildMainProgram(
      readFileSync(join(__dirname, "fixtures", "dlopen-main-scope.c"), "utf8"),
      "test-dlopen-main",
      ["-Wl,--export-dynamic"],
    );

    const result = await runCentralizedProgram({
      programPath: wasmPath,
      argv: ["test-dlopen-main"],
      timeout: 10_000,
      useDefaultRootfs: false,
    });

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("self=42 default=8 data=35\n");
    expect(result.stderr).toBe("");
  });

  it("loads a shared library and calls its functions via dlopen/dlsym", { timeout: 30_000 }, async () => {
    // Build the shared library
    const soPath = buildSharedLib(
      `
      int add(int a, int b) { return a + b; }
      int multiply(int a, int b) { return a * b; }
      `,
      "libmath",
    );

    // Build the main program
    const wasmPath = buildMainProgram(
      `
      #include <dlfcn.h>
      #include <stdio.h>

      int main(int argc, char *argv[]) {
        const char *lib_path = argv[1];

        void *lib = dlopen(lib_path, RTLD_LAZY);
        if (!lib) {
          printf("dlopen failed: %s\\n", dlerror());
          return 1;
        }

        int (*add)(int, int) = (int (*)(int, int))dlsym(lib, "add");
        if (!add) {
          printf("dlsym(add) failed: %s\\n", dlerror());
          return 1;
        }

        int (*multiply)(int, int) = (int (*)(int, int))dlsym(lib, "multiply");
        if (!multiply) {
          printf("dlsym(multiply) failed: %s\\n", dlerror());
          return 1;
        }

        printf("add(3, 4) = %d\\n", add(3, 4));
        printf("multiply(5, 6) = %d\\n", multiply(5, 6));

        dlclose(lib);
        printf("done\\n");
        return 0;
      }
      `,
      "test-dlopen",
    );

    const result = await runCentralizedProgram({
      programPath: wasmPath,
      argv: ["test-dlopen", soPath],
      timeout: 10_000,
      io: io(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("add(3, 4) = 7");
    expect(result.stdout).toContain("multiply(5, 6) = 30");
    expect(result.stdout).toContain("done");
  });

  it.skipIf(!hasSysroot64 || !hasCompiler("wasm64posix-cc"))(
    "loads and resolves a memory64 shared library through dlopen/dlsym",
    { timeout: 30_000 },
    async () => {
      const soPath = buildSharedLib(
        `
        long add(long a, long b) { return a + b; }
        static long counter = 40;
        long increment(void) { return ++counter; }
        `,
        "libmath64",
        "wasm64posix-cc",
      );
      const wasmPath = buildMainProgram(
        `
        #include <dlfcn.h>
        #include <stdio.h>

        int main(int argc, char *argv[]) {
          void *lib = dlopen(argv[1], RTLD_LAZY);
          if (!lib) {
            printf("dlopen failed: %s\\n", dlerror());
            return 1;
          }
          long (*add)(long, long) = (long (*)(long, long))dlsym(lib, "add");
          long (*increment)(void) = (long (*)(void))dlsym(lib, "increment");
          if (!add || !increment) {
            printf("dlsym failed: %s\\n", dlerror());
            return 2;
          }
          printf("add=%ld counter=%ld\\n", add(20, 22), increment());
          return dlclose(lib);
        }
        `,
        "test-dlopen64",
        [],
        "wasm64posix-cc",
      );

      const result = await runCentralizedProgram({
        programPath: wasmPath,
        argv: ["test-dlopen64", soPath],
        timeout: 10_000,
        io: io(),
      });

      expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
      expect(result.stdout).toBe("add=42 counter=41\n");
      expect(result.stderr).toBe("");
    },
  );

  // libc's reserved-namespace names (`__errno_location`, `__environ`,
  // `__sigsetjmp_save`) are ordinary symbols the MAIN program defines and a
  // side module imports from `env` / `GOT.mem`. PHP's `opcache.so` is the
  // case that found it: it imports `env.__sigsetjmp_save`, which `php.wasm`
  // exports, and dlopen failed with `undefined symbol: __sigsetjmp_save`
  // because the planner dropped every `__`-prefixed main-image export.
  it("resolves a side module's imports of the main program's __-prefixed libc symbols", { timeout: 30_000 }, async () => {
    const soPath = buildSharedLib(
      `
      #include <errno.h>
      #include <setjmp.h>
      #include <string.h>

      extern char **__environ;

      int probe(void) {
        sigjmp_buf jb;
        volatile int jumped = 0;
        errno = 0;
        if (sigsetjmp(jb, 1) == 0) {
          errno = 77;
          siglongjmp(jb, 1);
        }
        jumped = 1;
        int found = 0;
        for (char **e = __environ; e && *e; e++) {
          if (strcmp(*e, "DLOPEN_LIBC_PROBE=yes") == 0) found = 1;
        }
        return jumped * 1000 + errno * 10 + found;
      }
      `,
      "liblibcprobe",
    );

    const wasmPath = buildMainProgram(
      `
      #include <dlfcn.h>
      #include <setjmp.h>
      #include <stdio.h>

      int main(int argc, char *argv[]) {
        // Link sigsetjmp's helper into the main program, as php.wasm does.
        sigjmp_buf jb;
        if (sigsetjmp(jb, 0) != 0) return 9;

        void *lib = dlopen(argv[1], RTLD_NOW);
        if (!lib) {
          printf("dlopen failed: %s\\n", dlerror());
          return 1;
        }
        int (*probe)(void) = (int (*)(void))dlsym(lib, "probe");
        if (!probe) {
          printf("dlsym failed: %s\\n", dlerror());
          return 2;
        }
        printf("probe=%d\\n", probe());
        return dlclose(lib);
      }
      `,
      "test-dlopen-libc-probe",
      // php.wasm links with --export-all so its extensions can import libc
      // from it. That would also export `fork` and demand fork
      // instrumentation, so export exactly the libc symbols the probe uses.
      // --export-dynamic exports the main image's `__c_longjmp` tag, which a
      // side module's `longjmp` must share (php.wasm exports it too).
      [
        "-Wl,--export-dynamic",
        "-Wl,--export=__errno_location",
        "-Wl,--export=__environ",
        "-Wl,--export=__sigsetjmp_save",
        "-Wl,--export=__siglongjmp_restore",
        "-Wl,--export=__wasm_setjmp",
        "-Wl,--export=__wasm_setjmp_test",
        "-Wl,--export=__wasm_longjmp",
        "-Wl,--export=strcmp",
      ],
    );

    const result = await runCentralizedProgram({
      programPath: wasmPath,
      argv: ["test-dlopen-libc-probe", soPath],
      env: ["DLOPEN_LIBC_PROBE=yes"],
      timeout: 10_000,
      io: io(),
    });

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("probe=1771\n");
  });

  it("reports dlerror for missing library", async () => {
    const wasmPath = buildMainProgram(
      `
      #include <dlfcn.h>
      #include <stdio.h>

      int main(void) {
        void *lib = dlopen("/nonexistent/lib.so", RTLD_LAZY);
        if (!lib) {
          printf("expected error: %s\\n", dlerror());
          return 0;
        }
        return 1;
      }
      `,
      "test-dlopen-error",
    );

    const result = await runCentralizedProgram({
      programPath: wasmPath,
      argv: ["test-dlopen-error"],
      timeout: 10_000,
      io: io(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("expected error:");
  });

  it("dlsym returns null for non-existent symbol", async () => {
    const soPath = buildSharedLib(
      `int foo(void) { return 42; }`,
      "libfoo",
    );

    const wasmPath = buildMainProgram(
      `
      #include <dlfcn.h>
      #include <stdio.h>

      int main(int argc, char *argv[]) {
        void *lib = dlopen(argv[1], RTLD_LAZY);
        if (!lib) {
          printf("dlopen failed: %s\\n", dlerror());
          return 1;
        }

        void *sym = dlsym(lib, "nonexistent");
        if (!sym) {
          printf("expected: symbol not found\\n");
        } else {
          printf("unexpected: found symbol\\n");
        }

        dlclose(lib);
        return 0;
      }
      `,
      "test-dlsym-missing",
    );

    const result = await runCentralizedProgram({
      programPath: wasmPath,
      argv: ["test-dlsym-missing", soPath],
      timeout: 10_000,
      io: io(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("expected: symbol not found");
  });
});
