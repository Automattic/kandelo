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
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { NodePlatformIO } from "../src/platform/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const SYSROOT = join(REPO_ROOT, "sysroot");
const SYSROOT64 = join(REPO_ROOT, "sysroot64");

const hasSysroot = existsSync(join(SYSROOT, "lib", "libc.a"));
const hasSysroot64 = existsSync(join(SYSROOT64, "lib", "libc.a"));
const hasKernel = existsSync(join(REPO_ROOT, "binaries", "kernel.wasm")) ||
  existsSync(join(REPO_ROOT, "local-binaries", "kernel.wasm"));
function hasCompiler(compiler = "wasm32posix-cc"): boolean {
  try {
    execFileSync(compiler, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const BUILD_DIR = join(tmpdir(), "wasm-dlopen-e2e");

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

describe.skipIf(!hasSysroot || !hasKernel || !hasCompiler())("dlopen end-to-end", () => {
  beforeAll(() => {
    mkdirSync(BUILD_DIR, { recursive: true });
  });

  // The .so files are written under `os.tmpdir()` (e.g. `/var/folders/.../T`
  // on macOS) and passed to the wasm program as an absolute host path. The
  // default mount-based VFS doesn't know about that path, so dlopen() would
  // see ENOENT. Opt the test into the raw-host-fs escape hatch via
  // `NodePlatformIO`, since this test exercises the dlopen plumbing rather
  // than the VFS layer.
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

  it("exports libc functions referenced only by a side module", { timeout: 30_000 }, async () => {
    const soPath = buildSharedLib(
      `
      #include <arpa/inet.h>
      unsigned short network_value(void) { return ntohs(0x3412); }
      `,
      "lib-process-libc",
    );
    const wasmPath = buildMainProgram(
      `
      #include <dlfcn.h>
      #include <stdio.h>

      int main(int argc, char *argv[]) {
        void *lib = dlopen(argv[1], RTLD_NOW);
        if (!lib) {
          printf("dlopen failed: %s\\n", dlerror());
          return 1;
        }
        unsigned short (*network_value)(void) =
          (unsigned short (*)(void))dlsym(lib, "network_value");
        if (!network_value) {
          printf("dlsym failed: %s\\n", dlerror());
          return 2;
        }
        printf("network-value=%u\\n", network_value());
        return dlclose(lib);
      }
      `,
      "test-dlopen-process-libc",
    );

    const result = await runCentralizedProgram({
      programPath: wasmPath,
      argv: ["test-dlopen-process-libc", soPath],
      timeout: 10_000,
      io: io(),
    });

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("network-value=4660\n");
    expect(result.stderr).toBe("");
  });

  it("prefers a strong executable libc interposition over the dynamic fallback", async () => {
    const interposeSource = join(BUILD_DIR, "putenv-interpose.c");
    const interposeObject = join(BUILD_DIR, "putenv-interpose.o");
    const interposeArchive = join(BUILD_DIR, "libputenv-interpose.a");
    writeFileSync(interposeSource, `
      #include <stdlib.h>
      int putenv(char *value) { return value[0] == 'K' ? 73 : 74; }
    `);
    execFileSync("wasm32posix-cc", [
      "-O2", "-c", interposeSource, "-o", interposeObject,
    ], { stdio: "pipe" });
    execFileSync("wasm32posix-ar", [
      "rcs", interposeArchive, interposeObject,
    ], { stdio: "pipe" });

    const wasmPath = buildMainProgram(
      `
      #include <stdio.h>
      #include <stdlib.h>

      int main(void) {
        char value[] = "KANDELO_INTERPOSE=1";
        printf("interposed=%d\\n", putenv(value));
        return 0;
      }
      `,
      "test-dlopen-libc-interposition",
      [interposeArchive],
    );

    const result = await runCentralizedProgram({
      programPath: wasmPath,
      argv: ["test-dlopen-libc-interposition"],
      timeout: 10_000,
      useDefaultRootfs: false,
    });

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("interposed=73\n");
    expect(result.stderr).toBe("");
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
