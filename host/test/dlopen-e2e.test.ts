/**
 * End-to-end test for dlopen/dlsym/dlclose.
 *
 * Builds a shared Wasm library and a main program that loads it via dlopen,
 * then runs the program through the centralized kernel and verifies output.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const SYSROOT = join(REPO_ROOT, "sysroot");
const GLUE_DIR = join(REPO_ROOT, "glue");
const CLANG = "/opt/homebrew/opt/llvm@21/bin/clang";
const WASM_LD = "/opt/homebrew/bin/wasm-ld";

const hasSysroot = existsSync(join(SYSROOT, "lib", "libc.a"));
const hasKernel = existsSync(join(__dirname, "../wasm/wasm_posix_kernel.wasm"));

const BUILD_DIR = join(tmpdir(), "wasm-dlopen-e2e");

/** Build a shared Wasm library (.so side module) from C source. */
function buildSharedLib(source: string, name: string): string {
  const srcPath = join(BUILD_DIR, `${name}.c`);
  const objPath = join(BUILD_DIR, `${name}.o`);
  const soPath = join(BUILD_DIR, `${name}.so`);

  writeFileSync(srcPath, source);

  execSync(
    `${CLANG} --target=wasm32-unknown-unknown -fPIC -O2 -matomics -mbulk-memory -c ${srcPath} -o ${objPath}`,
    { stdio: "pipe" },
  );
  execSync(
    `${WASM_LD} --experimental-pic --shared --shared-memory --export-all --allow-undefined -o ${soPath} ${objPath}`,
    { stdio: "pipe" },
  );

  return soPath;
}

/** Build a main program with dlopen support. */
function buildMainProgram(source: string, name: string): string {
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
  ];

  const allArgs = [...cflags, srcPath, ...linkFlags, "-o", wasmPath];
  execSync(`${CLANG} ${allArgs.join(" ")}`, { stdio: "pipe" });

  return wasmPath;
}

describe.skipIf(!hasSysroot || !hasKernel)("dlopen end-to-end", () => {
  beforeAll(() => {
    mkdirSync(BUILD_DIR, { recursive: true });
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
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("add(3, 4) = 7");
    expect(result.stdout).toContain("multiply(5, 6) = 30");
    expect(result.stdout).toContain("done");
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
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("expected: symbol not found");
  });
});
