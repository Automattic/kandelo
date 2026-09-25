import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NodePlatformIO } from "../src/platform/node";
import { tryResolveBinary } from "../src/binary-resolver";
import { WPK_FORK_LINKED_FRAME_FORMAT_SECTION } from "../src/generated/abi";
import { artifactGate } from "./support/artifact-gate";
import {
  makeHostScratchTempRoot,
  runCentralizedProgram,
} from "./centralized-test-helper";

/**
 * A malformed fork section is refused AT ADMISSION, by the fork module, with a
 * named errno -- through a real worker and a real instrumented guest.
 *
 * Lane F stage 1b moved every decode of an activation's `kandelo.wpk_fork.*`
 * sections out of the host: the host locates them and copies their bytes
 * (`encodeForkAdmission`), and `fm_admit_activation` decodes and validates
 * them before the activation instantiates. That moves where a corrupt section
 * surfaces, and this pins the new place. Before, the host's own linked-frame
 * decoder refused it; with that decoder gone, nothing on the host side would
 * notice, so if the module did not refuse it either, the first reader would be
 * a capture -- a fork that fails (or worse, succeeds wrongly) far from the
 * cause.
 *
 * THE PATH: a dlopen side module. A main program's sections are checked by the
 * artifact policy at exec (`crates/wasm-artifact`), which would refuse the
 * corruption before any worker exists; a side module is never asked about, so
 * admission is the first and only check. The side module is built through the
 * SDK and instrumented like any other, then ONE byte of its linked-frame
 * descriptor -- the first byte of its magic -- is changed. The dlopen must fail
 * with `fm_admit_activation`'s EINVAL in `dlerror()`, and the process must then
 * fork normally: the refusal left no half-admitted activation behind.
 */

const repoRoot = join(import.meta.dirname, "..", "..");
const cc = join(repoRoot, "sdk", "bin", "wasm32posix-cc");
const instrument = join(repoRoot, "scripts", "run-wasm-fork-instrument.sh");
const glueDir = join(repoRoot, "libc", "glue");
// Under `<repoRoot>/target`, so the guest reaches the real host file through
// NodePlatformIO rather than an in-kernel tmpfs shadowing `/tmp`.
const buildDir = makeHostScratchTempRoot("kandelo-fork-admission-refusal-");

const gate = artifactGate("fork-admission-refusal", [
  {
    what: "musl sysroot (libc.a)",
    present: existsSync(join(repoRoot, "sysroot", "lib", "libc.a")),
    build: "scripts/build-musl.sh",
  },
  {
    what: "kernel.wasm (via the binary resolver)",
    present: tryResolveBinary("kernel.wasm") !== null,
    build: "scripts/dev-shell.sh ./run.sh setup",
  },
]);

function instrumentInPlace(wasmPath: string, entry?: string): void {
  const output = `${wasmPath}.instrumented`;
  execFileSync(instrument, [wasmPath, "-o", output, ...(entry ? ["--entry", entry] : [])], {
    stdio: "pipe",
  });
  renameSync(output, wasmPath);
}

/** Where a custom section's payload starts in a wasm binary. */
function customSectionPayload(bytes: Uint8Array, name: string): number {
  const uleb = (at: number): [number, number] => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[at++]!;
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return [value >>> 0, at];
      shift += 7;
    }
  };
  let at = 8;
  while (at < bytes.length) {
    const id = bytes[at]!;
    const [size, body] = uleb(at + 1);
    if (id === 0) {
      const [nameLength, nameAt] = uleb(body);
      const found = new TextDecoder().decode(bytes.subarray(nameAt, nameAt + nameLength));
      if (found === name) return nameAt + nameLength;
    }
    at = body + size;
  }
  throw new Error(`no ${name} section`);
}

describe.skipIf(gate.skip)("fork admission refusal", () => {
  beforeAll(() => mkdirSync(buildDir, { recursive: true }));

  it("refuses a side module with a corrupt linked-frame section at admission, and forks on", async () => {
    const libSource = join(buildDir, "libadmit.c");
    const libraryPath = join(buildDir, "libadmit.so");
    writeFileSync(libSource, `
      int side_value(void) { return 41; }
      #include "abi_constants.h"
      __attribute__((export_name("__abi_version")))
      unsigned __abi_version(void) { return WASM_POSIX_ABI_VERSION; }
    `);
    execFileSync(cc, ["-shared", "-fPIC", "-O2", `-I${glueDir}`, libSource, "-o", libraryPath], {
      stdio: "pipe",
    });
    instrumentInPlace(libraryPath, "env.fork");

    const corruptPath = join(buildDir, "libadmit-corrupt.so");
    const bytes = new Uint8Array(readFileSync(libraryPath));
    const magic = customSectionPayload(bytes, WPK_FORK_LINKED_FRAME_FORMAT_SECTION);
    expect(String.fromCharCode(bytes[magic]!), "the descriptor's magic starts here").toBe("K");
    bytes[magic] = "X".charCodeAt(0);
    writeFileSync(corruptPath, bytes);

    const mainSource = join(buildDir, "admit-main.c");
    const programPath = join(buildDir, "admit-main.wasm");
    writeFileSync(mainSource, `
      #include <dlfcn.h>
      #include <stdio.h>
      #include <sys/wait.h>
      #include <unistd.h>
      static int try_open(const char *path) {
        void *lib = dlopen(path, RTLD_NOW);
        if (!lib) { printf("refused %s: %s\\n", path, dlerror()); return 0; }
        int (*value)(void) = (int (*)(void))dlsym(lib, "side_value");
        printf("opened %s: %d\\n", path, value ? value() : -1);
        return 1;
      }
      int main(int argc, char **argv) {
        if (try_open(argv[1])) return 2;
        if (!try_open(argv[2])) return 3;
        fflush(stdout);
        pid_t pid = fork();
        if (pid < 0) return 4;
        if (pid == 0) _exit(7);
        int status = 0;
        if (waitpid(pid, &status, 0) != pid) return 5;
        printf("forked after the refusal: child exited %d\\n", WEXITSTATUS(status));
        return 0;
      }
    `);
    execFileSync(cc, ["-O2", "-ldl", mainSource, "-Wl,--export-all", "-o", programPath], {
      stdio: "pipe",
    });
    instrumentInPlace(programPath);

    const result = await runCentralizedProgram({
      programPath,
      argv: ["admit-main", corruptPath, libraryPath],
      timeout: 30_000,
      io: new NodePlatformIO(),
    });
    expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    // The module's refusal, by entry and errno (EINVAL = 22), in dlerror().
    expect(result.stdout).toMatch(
      /refused .*libadmit-corrupt\.so: .*fm_admit_activation failed with errno 22/,
    );
    // The uncorrupted build of the same library still loads, in the same
    // process, after the refusal...
    expect(result.stdout).toContain("libadmit.so: 41");
    // ...and a fork -- a capture over both admitted activations -- completes.
    expect(result.stdout).toContain("forked after the refusal: child exited 7");
  }, 60_000);
});
