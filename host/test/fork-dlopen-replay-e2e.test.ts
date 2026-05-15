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
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { NodePlatformIO } from "../src/platform/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const SYSROOT = join(REPO_ROOT, "sysroot");
const GLUE_DIR = join(REPO_ROOT, "glue");
const LLVM_BIN = process.env.LLVM_BIN || "/opt/homebrew/opt/llvm@21/bin";
const CLANG = `${LLVM_BIN}/clang`;
const WASM_LD = process.env.LLVM_BIN
  ? `${LLVM_BIN}/wasm-ld`
  : "/opt/homebrew/bin/wasm-ld";
const WASM_OPT = process.env.WASM_OPT || "wasm-opt";

const hasSysroot = existsSync(join(SYSROOT, "lib", "libc.a"));
const hasKernel = existsSync(join(REPO_ROOT, "binaries", "kernel.wasm")) ||
  existsSync(join(REPO_ROOT, "local-binaries", "kernel.wasm"));

const BUILD_DIR = join(tmpdir(), "wasm-fork-dlopen-replay-e2e");

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

/** Build a main program with dlopen + fork support (asyncify-instrumented). */
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

  // Asyncify for fork support — without this, kernel_fork returns ENOSYS
  // and the bug-under-test (a real fork+resume) never reproduces.
  execSync(
    `${WASM_OPT} --asyncify --pass-arg=asyncify-imports@kernel.kernel_fork ${wasmPath} -o ${wasmPath}`,
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
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });
});
