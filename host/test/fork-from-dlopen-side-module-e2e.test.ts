import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodePlatformIO } from "../src/platform/node";
import {
  FORK_CAP_DYLINK_MAIN,
  FORK_CAP_SIDE_ENTRY,
  parseDylinkSection,
  readForkInstrumentCapabilities,
} from "../src/dylink-artifact";
import {
  makeHostScratchTempRoot,
  runCentralizedProgram,
} from "./centralized-test-helper";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { buildVforkSideModuleFixture } from "./vfork-side-module-fixture";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");
const sysroot = join(repoRoot, "sysroot");
const glueDir = join(repoRoot, "libc", "glue");
// Every artifact in this file is built by the SDK driver. The SDK owns both
// link contracts involved: linkFlags() for the main program and
// SHARED_LINK_FLAGS for the side modules. This file used to carry its own
// copy of each, and the main-program copy had drifted -- no
// -z stack-size=8388608, so the program ran on wasm-ld's ~64 KiB default
// shadow stack instead of the SDK's 8 MiB, and no --export=__abi_version, so
// nothing bound it to a kernel ABI epoch.
//
// Absolute path, never a bare `wasm32posix-cc`: a bare name resolves through
// PATH and can pick up a different worktree's SDK.
const cc = join(repoRoot, "sdk", "bin", "wasm32posix-cc");
const instrument = join(repoRoot, "scripts", "run-wasm-fork-instrument.sh");
// Stage the built `.so` under `<repoRoot>/target` (never an in-kernel tmpfs
// scratch prefix) so the guest reaches the real host file through
// NodePlatformIO. `os.tmpdir()` frequently resolves under `/tmp` (the nix dev
// shell sets `TMPDIR=/tmp/nix-shell.*`), where the empty in-kernel tmpfs would
// shadow the path and the guest dlopen would fail with "cannot stat library".
const buildDir = makeHostScratchTempRoot("kandelo-fork-from-side-module-");
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

function instrumentInPlace(wasmPath: string, entry?: string): void {
  const output = `${wasmPath}.instrumented`;
  const args = [wasmPath, "-o", output];
  if (entry) args.push("--entry", entry);
  execFileSync(instrument, args, { stdio: "pipe" });
  renameSync(output, wasmPath);
}

/**
 * Build a side module.
 *
 * `-shared -fPIC` selects the SDK's side-module link (SHARED_LINK_FLAGS:
 * -nostdlib, --experimental-pic, --shared, --shared-memory, --export-all,
 * --allow-undefined), straight from the .c with no intermediate object.
 *
 * `--Bdynamic` and its dependency list are caller inputs: for a shared link
 * cc.ts:298 leaves `deferExecutableInputs` false, so :305 pushes the caller's
 * arguments verbatim and :332 appends SHARED_LINK_FLAGS after them. That
 * ordering is what puts a `needed_dynlibs` entry in the consumer's dylink.0
 * section for the DT_NEEDED closure test below.
 *
 * The dependencies are passed as plain positional arguments rather than
 * folded into the `-Wl,` list. clang splits a `-Wl,` operand on COMMAS, so
 * `-Wl,--Bdynamic,<path>` would corrupt any path containing one; a bare path
 * with a known-unknown extension is forwarded to the linker untouched and in
 * position.
 */
function buildSharedLibrary(
  source: string,
  name = "libforkinside",
  dependencies: readonly string[] = [],
): string {
  const sourcePath = join(buildDir, `${name}.c`);
  const libraryPath = join(buildDir, `${name}.so`);
  writeFileSync(sourcePath, `${source}
    #include "abi_constants.h"
    __attribute__((export_name("__abi_version")))
    unsigned __abi_version(void) { return WASM_POSIX_ABI_VERSION; }
  `);
  execFileSync(cc, [
    "-shared",
    "-fPIC",
    "-O2",
    `-I${glueDir}`,
    sourcePath,
    ...(dependencies.length === 0 ? [] : ["-Wl,--Bdynamic", ...dependencies]),
    "-o",
    libraryPath,
  ], { stdio: "pipe" });
  instrumentInPlace(libraryPath, "env.fork");
  return libraryPath;
}

function buildMainProgram(source: string): string {
  const sourcePath = join(buildDir, "fork-from-side-main.c");
  const wasmPath = join(buildDir, "fork-from-side-main.wasm");
  writeFileSync(sourcePath, source);
  // The driver supplies the target, the sysroot, -nostdlib, the codegen
  // flags, the syscall glue, compiler_rt.c, cxxrt.c, crt1.o, libc.a and every
  // -Wl, flag. `-ldl` is how it spells the dlopen glue this program needs
  // (parseArgs/linkDl, sdk/src/bin/cc.ts). `-Wl,--export-all` stays: it is
  // this fixture's own requirement, not part of the platform contract.
  execFileSync(cc, [
    "-O2",
    "-ldl",
    sourcePath,
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
      #include <stdlib.h>
      #include <stdio.h>
      #include <sys/wait.h>
      #include <unistd.h>
      typedef int (*side_fork_fn)(void);
      int main(int argc, char **argv) {
        void *lib = dlopen(argv[1], RTLD_NOW);
        if (!lib) {
          fprintf(stderr, "dlopen failed: %s\\n", dlerror());
          return 2;
        }
        side_fork_fn side_fork = (side_fork_fn)dlsym(lib, "side_fork");
        if (!side_fork) return 3;
        for (int i = 0; i < 2; i++) {
          int pid = side_fork();
          if (pid < 0) return 4;
          if (pid == 0) {
            if (dlclose(lib) != 0) exit(7);
            exit(0);
          }
          int status = 0;
          if (waitpid(pid, &status, 0) != pid) return 5;
          if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return 6;
        }
        if (dlclose(lib) != 0) return 8;
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

  it("preserves the side frame and returns in both parent and child (fork-module flag on)", async () => {
    // Phase 6 D7a.1b regression: a dlopen fork is multi-activation (main = 0,
    // side = 1). With the co-resident fork-module ON, its FRAMES route through
    // the module (D7a.1a) AND its reference path is now admitted (D7a.1b enables
    // multi-activation reference reconstruction via the merged, activation-
    // namespaced funcref catalog). This C fixture carries no funcref-typed
    // references (C function pointers are i32 table indices, not wasm funcrefs),
    // so the merged-catalog reference drive runs over an empty/null graph; the
    // point is that admitting multi-activation references does not break a real
    // multi-activation frame fork. It must exit exactly as the flag-off run.
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
    `, "libforkinside-flagon");
    const programPath = buildMainProgram(`
      #include <dlfcn.h>
      #include <stdlib.h>
      #include <stdio.h>
      #include <sys/wait.h>
      #include <unistd.h>
      typedef int (*side_fork_fn)(void);
      int main(int argc, char **argv) {
        void *lib = dlopen(argv[1], RTLD_NOW);
        if (!lib) {
          fprintf(stderr, "dlopen failed: %s\\n", dlerror());
          return 2;
        }
        side_fork_fn side_fork = (side_fork_fn)dlsym(lib, "side_fork");
        if (!side_fork) return 3;
        for (int i = 0; i < 2; i++) {
          int pid = side_fork();
          if (pid < 0) return 4;
          if (pid == 0) {
            if (dlclose(lib) != 0) exit(7);
            exit(0);
          }
          int status = 0;
          if (waitpid(pid, &status, 0) != pid) return 5;
          if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return 6;
        }
        if (dlclose(lib) != 0) return 8;
        puts("side fork ok");
        return 0;
      }
    `);

    const result = await runCentralizedProgram({
      programPath,
      argv: ["fork-from-side-main", libraryPath],
      timeout: 30_000,
      io: new NodePlatformIO(),
    });
    expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("side fork ok");
  }, 30_000);

  it("runs mode-1 vfork from a real side-module frame in the production worker path", async () => {
    const fixture = buildVforkSideModuleFixture();
    try {
      const libraryBytes = new Uint8Array(readFileSync(fixture.libraryPath));
      const imageOwner = KandeloImageFs.create();
      imageOwner.mkdir("/lib", 0o755);
      imageOwner.createFileWithOwner(
        "/lib/libvforkinside.so",
        0o755,
        0,
        0,
        libraryBytes,
      );

      const result = await runCentralizedProgram({
        programPath: fixture.programPath,
        argv: ["vfork-from-side-main", "/lib/libvforkinside.so"],
        timeout: 30_000,
        rootfsImage: await imageOwner.saveImage(),
      });
      expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.match(/PRODUCTION_SIDE_VFORK_ROUND_TRIP/g))
        .toHaveLength(2);
      expect(result.stdout).toContain("PRODUCTION_SIDE_VFORK_PASS");
    } finally {
      fixture.cleanup();
    }
  }, 30_000);

  it("runs mode-1 vfork from a real side-module frame through the fork-module (flag on)", async () => {
    // Phase 6 item 4: a MULTI-activation dlopen-vfork borrowed child drives its
    // borrowed replay (main + side activation) through the co-resident module via
    // fm_begin_borrowed_child_replay + fm_add_activation_borrowed_child_replay.
    const fixture = buildVforkSideModuleFixture();
    try {
      const libraryBytes = new Uint8Array(readFileSync(fixture.libraryPath));
      const imageOwner = KandeloImageFs.create();
      imageOwner.mkdir("/lib", 0o755);
      imageOwner.createFileWithOwner(
        "/lib/libvforkinside.so",
        0o755,
        0,
        0,
        libraryBytes,
      );

      const result = await runCentralizedProgram({
        programPath: fixture.programPath,
        argv: ["vfork-from-side-main", "/lib/libvforkinside.so"],
        timeout: 30_000,
        rootfsImage: await imageOwner.saveImage(),
      });
      expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.match(/PRODUCTION_SIDE_VFORK_ROUND_TRIP/g))
        .toHaveLength(2);
      expect(result.stdout).toContain("PRODUCTION_SIDE_VFORK_PASS");
      // Proof the borrowed child rewound through the module (not a silent JS
      // fallback): a nonzero replayed-frame count. A multi-activation borrowed
      // child that failed to add its side activation would crash, not pass.
      const fm = result.forkModuleDiagnostics.filter((d) => d.source === "fork-module");
      expect(
        fm.some((d) => /fork_module_child_frames=\d+/.test(d.message)),
        `expected a fork-module borrowed proof-of-use; saw: ${JSON.stringify(fm)}`,
      ).toBe(true);
    } finally {
      fixture.cleanup();
    }
  }, 30_000);

  it("replays a fork issued while dlopen runs a side-module constructor", async () => {
    const libraryPath = buildSharedLibrary(`
      extern int fork(void);
      extern void exit(int);
      static int constructor_child = -1;
      __attribute__((constructor))
      static void fork_during_constructor(void) {
        volatile int preserved = 73;
        int pid = fork();
        if (preserved != 73) exit(92);
        if (pid == 0) exit(0);
        constructor_child = pid;
      }
      int constructor_child_pid(void) {
        return constructor_child;
      }
    `);
    const programPath = buildMainProgram(`
      #include <dlfcn.h>
      #include <stdio.h>
      #include <sys/wait.h>
      typedef int (*constructor_child_pid_fn)(void);
      int main(int argc, char **argv) {
        void *lib = dlopen(argv[1], RTLD_NOW);
        if (!lib) {
          fprintf(stderr, "constructor dlopen failed: %s\\n", dlerror());
          return 2;
        }
        constructor_child_pid_fn child_pid =
          (constructor_child_pid_fn)dlsym(lib, "constructor_child_pid");
        if (!child_pid) return 3;
        int pid = child_pid();
        if (pid <= 0) return 4;
        int status = 0;
        if (waitpid(pid, &status, 0) != pid) return 5;
        if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return 6;
        puts("constructor fork ok");
        return 0;
      }
    `);

    const result = await runCentralizedProgram({
      programPath,
      argv: ["fork-from-constructor-main", libraryPath],
      timeout: 30_000,
      io: new NodePlatformIO(),
    });
    expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("constructor fork ok");
  }, 30_000);

  it("lowers the original two-argument loader before a constructor can fork", async () => {
    const libraryPath = buildSharedLibrary(`
      extern int fork(void);
      extern void exit(int);
      static int constructor_child = -1;
      __attribute__((constructor))
      static void fork_during_legacy_load(void) {
        volatile int preserved = 89;
        int pid = fork();
        if (preserved != 89) exit(93);
        if (pid == 0) exit(0);
        constructor_child = pid;
      }
      int legacy_constructor_child_pid(void) {
        return constructor_child;
      }
    `, "liblegacy-constructor-fork");
    const programPath = buildMainProgram(`
      #include <dlfcn.h>
      #include <fcntl.h>
      #include <stdio.h>
      #include <stdlib.h>
      #include <string.h>
      #include <sys/stat.h>
      #include <sys/wait.h>
      #include <unistd.h>

      __attribute__((import_module("env"), import_name("__wasm_dlopen")))
      extern int legacy_host_dlopen(const void *, int);

      static int legacy_open(const char *path) {
        struct stat st;
        if (stat(path, &st) != 0 || st.st_size <= 0) return 0;
        int fd = open(path, O_RDONLY);
        if (fd < 0) return 0;
        void *bytes = malloc((size_t)st.st_size);
        if (!bytes) {
          close(fd);
          return 0;
        }
        ssize_t total = 0;
        while (total < st.st_size) {
          ssize_t count = read(
            fd, (char *)bytes + total, (size_t)(st.st_size - total));
          if (count <= 0) break;
          total += count;
        }
        close(fd);
        int handle = total == st.st_size
          ? legacy_host_dlopen(bytes, (int)st.st_size)
          : 0;
        free(bytes);
        return handle;
      }

      typedef int (*child_pid_fn)(void);
      int main(int argc, char **argv) {
        int handle = legacy_open(argv[1]);
        if (handle <= 0) {
          fprintf(stderr, "legacy loader failed: %s\\n", dlerror());
          return 2;
        }
        child_pid_fn child_pid = (child_pid_fn)dlsym(
          (void *)(long)handle, "legacy_constructor_child_pid");
        if (!child_pid) return 3;
        int pid = child_pid();
        if (pid <= 0) return 4;
        int status = 0;
        if (waitpid(pid, &status, 0) != pid) return 5;
        if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return 6;
        puts("lowered legacy constructor fork ok");
        return 0;
      }
    `);

    const programModule = new WebAssembly.Module(
      new Uint8Array(readFileSync(programPath)) as unknown as BufferSource,
    );
    const imports = WebAssembly.Module.imports(programModule);
    expect(imports.some(
      (entry) => entry.module === "env" && entry.name === "__wasm_dlopen",
    )).toBe(false);
    expect(imports.some(
      (entry) => entry.module === "env"
        && entry.name === "__wasm_dlopen_prepare",
    )).toBe(true);
    expect(WebAssembly.Module.exports(programModule).map((entry) => entry.name))
      .toContain("__wasm_posix_signal_checkpoint");

    const result = await runCentralizedProgram({
      programPath,
      argv: ["legacy-constructor-main", libraryPath],
      timeout: 30_000,
      io: new NodePlatformIO(),
    });
    expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("lowered legacy constructor fork ok");
  }, 30_000);

  it("resolves and replays a real DT_NEEDED closure from the process VFS", async () => {
    const providerPath = buildSharedLibrary(`
      int dependency_value(void) {
        return 41;
      }
    `, "libneeded-provider");
    const consumerPath = buildSharedLibrary(`
      extern int dependency_value(void);
      int needed_value(void) {
        return dependency_value() + 1;
      }
    `, "libneeded-consumer", [providerPath]);
    const consumerBytes = new Uint8Array(readFileSync(consumerPath));
    const metadata = parseDylinkSection(consumerBytes);
    expect(metadata?.neededDynlibs.some(
      (dependency) => dependency.endsWith("libneeded-provider.so"),
    )).toBe(true);

    const programPath = buildMainProgram(`
      #include <dlfcn.h>
      #include <stdlib.h>
      #include <stdio.h>
      #include <sys/wait.h>
      #include <unistd.h>
      typedef int (*needed_value_fn)(void);
      int main(int argc, char **argv) {
        void *lib = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
        if (!lib) {
          fprintf(stderr, "needed dlopen failed: %s\\n", dlerror());
          return 2;
        }
        needed_value_fn needed_value =
          (needed_value_fn)dlsym(lib, "needed_value");
        if (!needed_value || needed_value() != 42) return 3;
        int pid = fork();
        if (pid < 0) return 4;
        if (pid == 0) {
          if (needed_value() != 42) exit(5);
          if (dlclose(lib) != 0) exit(6);
          exit(0);
        }
        int status = 0;
        if (waitpid(pid, &status, 0) != pid) return 7;
        if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return 8;
        if (needed_value() != 42) return 9;
        if (dlclose(lib) != 0) return 10;
        puts("needed fork ok");
        return 0;
      }
    `);

    const result = await runCentralizedProgram({
      programPath,
      argv: ["fork-needed-main", consumerPath],
      timeout: 30_000,
      io: new NodePlatformIO(),
    });
    expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("needed fork ok");
  }, 30_000);
});
