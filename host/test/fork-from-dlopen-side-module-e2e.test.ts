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
const GLUE_DIR = join(REPO_ROOT, "libc", "glue");
const LLVM_BIN = process.env.LLVM_BIN;
const CLANG = process.env.CLANG || (LLVM_BIN ? join(LLVM_BIN, "clang") : "clang");
const WASM_LD = process.env.WASM_LD || (LLVM_BIN ? join(LLVM_BIN, "wasm-ld") : "wasm-ld");
const FORK_INSTRUMENT_FALLBACK = join(REPO_ROOT, "scripts", "run-wasm-fork-instrument.sh");
const hasSysroot = existsSync(join(SYSROOT, "lib", "libc.a"));
const hasKernel = existsSync(join(REPO_ROOT, "binaries", "kernel.wasm")) || existsSync(join(REPO_ROOT, "local-binaries", "kernel.wasm"));
const BUILD_DIR = join(tmpdir(), "wasm-fork-from-side-e2e");

function instrumentTool(): string {
  if (process.env.FORK_INSTRUMENT) return process.env.FORK_INSTRUMENT;
  if (process.env.HOST_TARGET) {
    const candidate = join(REPO_ROOT, "target", process.env.HOST_TARGET, "release", "wasm-fork-instrument");
    if (existsSync(candidate)) return candidate;
  }
  try {
    const hostTarget = execSync("rustc -vV | awk '/^host:/ {print $2}'", { encoding: "utf8" }).trim();
    const candidate = join(REPO_ROOT, "target", hostTarget, "release", "wasm-fork-instrument");
    if (existsSync(candidate)) return candidate;
  } catch {
    // Fall back to the wrapper below; it knows how to build the tool.
  }
  return FORK_INSTRUMENT_FALLBACK;
}

function buildSharedLib(source: string, name: string, instrumentFork: boolean): string {
  const srcPath = join(BUILD_DIR, `${name}.c`);
  const objPath = join(BUILD_DIR, `${name}.o`);
  const soPath = join(BUILD_DIR, `${name}.so`);
  writeFileSync(srcPath, source);
  execSync(`${CLANG} --target=wasm32-unknown-unknown -fPIC -O2 -matomics -mbulk-memory -c ${srcPath} -o ${objPath}`, { stdio: "pipe" });
  execSync(`${WASM_LD} --experimental-pic --shared --shared-memory --export-all --allow-undefined -o ${soPath} ${objPath}`, { stdio: "pipe" });
  if (instrumentFork) {
    execSync(`${instrumentTool()} ${soPath} -o ${soPath}.instr --entry env.fork`, { stdio: "pipe" });
    execSync(`mv ${soPath}.instr ${soPath}`, { stdio: "pipe" });
  }
  return soPath;
}

function buildMainProgram(source: string, name: string): string {
  const srcPath = join(BUILD_DIR, `${name}.c`);
  const wasmPath = join(BUILD_DIR, `${name}.wasm`);
  writeFileSync(srcPath, source);
  const cflags = ["--target=wasm32-unknown-unknown", `--sysroot=${SYSROOT}`, "-nostdlib", "-O2", "-matomics", "-mbulk-memory", "-fno-trapping-math"];
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
    "-Wl,--export-all",
  ];
  execSync(`${CLANG} ${[...cflags, srcPath, ...linkFlags, "-o", wasmPath].join(" ")}`, { stdio: "pipe" });
  execSync(`${instrumentTool()} ${wasmPath} -o ${wasmPath}.instr`, { stdio: "pipe" });
  execSync(`mv ${wasmPath}.instr ${wasmPath}`, { stdio: "pipe" });
  return wasmPath;
}

describe.skipIf(!hasSysroot || !hasKernel)("fork from dlopened side module", () => {
  beforeAll(() => mkdirSync(BUILD_DIR, { recursive: true }));
  const io = () => new NodePlatformIO();

  it("fork called by a side module resumes parent and child at the call site", { timeout: 30_000 }, async () => {
    const soPath = buildSharedLib(`
      extern int fork(void);
      extern void exit(int);
      int side_fork(void) {
        int pid = fork();
        if (pid == 0) exit(0);
        return pid;
      }
    `, "libforkinside", true);

    const wasmPath = buildMainProgram(`
      #include <dlfcn.h>
      #include <stdio.h>
      #include <sys/wait.h>
      typedef int (*side_fork_fn)(void);
      int main(int argc, char **argv) {
        void *lib = dlopen(argv[1], RTLD_NOW);
        if (!lib) { fprintf(stderr, "dlopen: %s\\n", dlerror()); return 1; }
        side_fork_fn side_fork = (side_fork_fn)dlsym(lib, "side_fork");
        if (!side_fork) { fprintf(stderr, "dlsym: %s\\n", dlerror()); return 1; }
        int pid = side_fork();
        if (pid < 0) { fprintf(stderr, "side fork failed: %d\\n", pid); return 1; }
        int status = 0;
        if (waitpid(pid, &status, 0) != pid) { fprintf(stderr, "waitpid failed\\n"); return 1; }
        if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) { fprintf(stderr, "bad child status %d\\n", status); return 1; }
        puts("ok");
        return 0;
      }
    `, "test-fork-from-side");

    const result = await runCentralizedProgram({
      programPath: wasmPath,
      argv: ["fork-from-side-main", soPath],
      timeout: 30_000,
      io: io(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });
});
