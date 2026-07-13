/**
 * End-to-end test for dlopen/dlsym/dlclose.
 *
 * Builds a shared Wasm library and a main program that loads it via dlopen,
 * then runs the program through the kernel and verifies output.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { NodePlatformIO } from "../src/platform/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const hasKernel = existsSync(join(REPO_ROOT, "binaries", "kernel.wasm")) ||
  existsSync(join(REPO_ROOT, "local-binaries", "kernel.wasm"));
function hasCompiler(compiler: string): boolean {
  try {
    execFileSync(compiler, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const BUILD_DIR = join(tmpdir(), "wasm-dlopen-e2e");

const TARGETS = [
  { arch: "wasm32", compiler: "wasm32posix-cc", sysroot: "sysroot" },
  { arch: "wasm64", compiler: "wasm64posix-cc", sysroot: "sysroot64" },
] as const;

type Target = typeof TARGETS[number];

function hasTarget(target: Target): boolean {
  return existsSync(join(REPO_ROOT, target.sysroot, "lib", "libc.a")) &&
    hasCompiler(target.compiler);
}

const availableTargets = TARGETS.filter(hasTarget);

/** Build a shared Wasm library (.so side module) from C source. */
function buildSharedLib(source: string, name: string, target: Target): string {
  const srcPath = join(BUILD_DIR, `${name}-${target.arch}.c`);
  const soPath = join(BUILD_DIR, `${name}-${target.arch}.so`);
  writeFileSync(srcPath, source);
  execFileSync(target.compiler,
    ["-shared", "-fPIC", "-O2", srcPath, "-o", soPath],
    { stdio: "pipe" });
  return soPath;
}

/** Build a main program with dlopen support. */
function buildMainProgram(source: string, name: string, target: Target): string {
  const srcPath = join(BUILD_DIR, `${name}-${target.arch}.c`);
  const wasmPath = join(BUILD_DIR, `${name}-${target.arch}.wasm`);
  writeFileSync(srcPath, source);
  execFileSync(target.compiler,
    ["-O2", "-Wl,--export-all", "-ldl", srcPath, "-o", wasmPath],
    { stdio: "pipe" });
  return wasmPath;
}

describe.skipIf(!hasKernel || availableTargets.length === 0)("dlopen end-to-end", () => {
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

  it.each(availableTargets)(
    "$arch loads a shared library and calls its functions via dlopen/dlsym",
    async (target) => {
      const soPath = buildSharedLib(
        `
        extern int main_value;
        int side_value = 17;
        int add(int a, int b) { return a + b; }
        int multiply(int a, int b) { return a * b; }
        int read_main_value(void) { return main_value; }
        `,
        "libmath", target,
      );

      const wasmPath = buildMainProgram(
        `
        #include <dlfcn.h>
        #include <stdio.h>

        int main_value = 41;

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

          int (*read_main_value)(void) = (int (*)(void))dlsym(lib, "read_main_value");
          int *side_value = (int *)dlsym(lib, "side_value");
          if (!read_main_value || !side_value) {
            printf("dlsym(data) failed: %s\\n", dlerror());
            return 1;
          }

          printf("add(3, 4) = %d\\n", add(3, 4));
          printf("multiply(5, 6) = %d\\n", multiply(5, 6));
          printf("main_value = %d\\n", read_main_value());
          printf("side_value = %d\\n", *side_value);

          dlclose(lib);
          printf("done\\n");
          return 0;
        }
        `,
        "test-dlopen", target,
      );

      const result = await runCentralizedProgram({
        programPath: wasmPath,
        argv: ["test-dlopen", soPath],
        timeout: 10_000,
        io: io(),
      });

      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("add(3, 4) = 7");
      expect(result.stdout).toContain("multiply(5, 6) = 30");
      expect(result.stdout).toContain("main_value = 41");
      expect(result.stdout).toContain("side_value = 17");
      expect(result.stdout).toContain("done");
    },
    30_000,
  );

  it.each(availableTargets)("$arch reports dlerror for missing library", async (target) => {
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
      "test-dlopen-error", target,
    );

    const result = await runCentralizedProgram({
      programPath: wasmPath,
      argv: ["test-dlopen-error"],
      timeout: 10_000,
      io: io(),
    });

    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("expected error:");
  });

  it.each(availableTargets)("$arch returns null for a non-existent symbol", async (target) => {
    const soPath = buildSharedLib(
      `int foo(void) { return 42; }`,
      "libfoo", target,
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
      "test-dlsym-missing", target,
    );

    const result = await runCentralizedProgram({
      programPath: wasmPath,
      argv: ["test-dlsym-missing", soPath],
      timeout: 10_000,
      io: io(),
    });

    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("expected: symbol not found");
  });
});
