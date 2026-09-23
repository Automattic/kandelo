/**
 * `dlclose` releases a side module's fork activation through the fork module,
 * and a process that exhausts activation ids fails its `dlopen` loudly.
 *
 * Every fork-instrumented side module gets an activation id, and the fork
 * module has 64 per-activation entries. Ids are NOT reused yet: a `dlclose`
 * is local to the Worker that runs it, and reusing an id a peer thread still
 * holds turned that peer's failure into a hang (T4 item 2 of
 * docs/superpowers/plans/2026-09-23-fork-test-only-removal.md). So the 63rd
 * side activation of a process is refused -- and the refusal must be a
 * `dlopen` failure the program can read, not a trap or a hang.
 *
 * Both programs run through a real process worker and then fork, with the
 * child calling into libraries open at that moment. That the module clears a
 * closed activation's ranges and places the next catalog into them is
 * `fork-activation-release.test.ts`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodePlatformIO } from "../src/platform/node";
import {
  makeHostScratchTempRoot,
  runCentralizedProgram,
} from "./centralized-test-helper";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const cc = join(repoRoot, "sdk", "bin", "wasm32posix-cc");
const instrument = join(repoRoot, "scripts", "run-wasm-fork-instrument.sh");
const buildDir = makeHostScratchTempRoot("kandelo-dlclose-reuse-");

function build(name: string, source: string, args: readonly string[]): string {
  const src = join(buildDir, `${name}.c`);
  const out = join(buildDir, name);
  writeFileSync(src, source);
  execFileSync(cc, [...args, src, "-o", out], { stdio: "pipe" });
  execFileSync(instrument, [out, "-o", out], { stdio: "pipe" });
  return out;
}

function sideModule(name: string, body: string): string {
  return build(`${name}.so`, `${body}
    #include "abi_constants.h"
    __attribute__((export_name("__abi_version")))
    unsigned __abi_version(void) { return WASM_POSIX_ABI_VERSION; }
  `, ["-shared", "-fPIC", "-O2", `-I${join(repoRoot, "libc", "glue")}`]);
}

/** Well below the 64-entry cap: the kept library plus these, plus one. */
const CYCLES = 40;

const CYCLING = `
  #include <dlfcn.h>
  #include <stdio.h>
  #include <unistd.h>
  #include <sys/wait.h>
  typedef int (*fn_t)(int);
  int main(int argc, char **argv) {
    void *kept = dlopen(argv[1], RTLD_NOW);
    fn_t kept_fn = kept ? (fn_t)dlsym(kept, "kept_value") : 0;
    if (!kept_fn || kept_fn(1) != 11) return 2;
    for (int i = 0; i < ${CYCLES}; i++) {
      void *h = dlopen(argv[2 + i % 2], RTLD_NOW);
      if (!h) { fprintf(stderr, "cycle %d: %s\\n", i, dlerror()); return 3; }
      fn_t f = (fn_t)dlsym(h, i % 2 ? "odd_value" : "even_value");
      if (!f || f(i) != i + (i % 2 ? 30 : 20)) return 4;
      if (dlclose(h) != 0) { fprintf(stderr, "dlclose %d: %s\\n", i, dlerror()); return 5; }
    }
    void *open = dlopen(argv[2], RTLD_NOW);
    fn_t open_fn = open ? (fn_t)dlsym(open, "even_value") : 0;
    if (!open_fn || open_fn(3) != 23) return 6;
    pid_t pid = fork();
    if (pid == 0) _exit(kept_fn(2) == 12 && open_fn(3) == 23 ? 0 : 9);
    if (pid < 0) { perror("fork"); return 7; }
    int status = 0;
    if (waitpid(pid, &status, 0) != pid) return 8;
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
      fprintf(stderr, "child status %d\\n", status);
      return 10;
    }
    puts("cycled");
    return 0;
  }
`;

/** Open and close until `dlopen` refuses, then keep working and fork. */
const EXHAUSTING = `
  #include <dlfcn.h>
  #include <stdio.h>
  #include <unistd.h>
  #include <sys/wait.h>
  typedef int (*fn_t)(int);
  int main(int argc, char **argv) {
    void *kept = dlopen(argv[1], RTLD_NOW);
    fn_t kept_fn = kept ? (fn_t)dlsym(kept, "kept_value") : 0;
    if (!kept_fn) return 2;
    int i = 0;
    for (; i < 200; i++) {
      void *h = dlopen(argv[2], RTLD_NOW);
      if (!h) { printf("cycle %d: %s\\n", i, dlerror()); break; }
      if (dlclose(h) != 0) return 5;
    }
    if (i == 200) return 3;
    if (kept_fn(1) != 11) return 4;
    pid_t pid = fork();
    if (pid == 0) _exit(kept_fn(2) == 12 ? 0 : 9);
    int status = 0;
    if (pid < 0 || waitpid(pid, &status, 0) != pid) return 8;
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return 10;
    puts("refused");
    return 0;
  }
`;

describe("dlclose and the fork activation cap", () => {
  let libs: string[] = [];
  beforeAll(() => {
    mkdirSync(buildDir, { recursive: true });
    libs = [
      sideModule("libkept", "int kept_value(int x) { return x + 10; }"),
      sideModule("libeven", "int even_value(int x) { return x + 20; }"),
      sideModule("libodd", "int odd_value(int x) { return x + 30; }"),
    ];
  });

  it(`opens and closes a library ${CYCLES} times, then forks`, { timeout: 180_000 }, async () => {
    const program = build("cycle.wasm", CYCLING, ["-O2", "-ldl"]);
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["cycle", ...libs],
      timeout: 180_000,
      io: new NodePlatformIO(),
    });
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("cycled\n");
    expect(result.exitCode).toBe(0);
  });

  it("refuses the dlopen past the activation cap, loudly, and keeps working", { timeout: 120_000 }, async () => {
    const program = build("exhaust.wasm", EXHAUSTING, ["-O2", "-ldl"]);
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["exhaust", ...libs],
      timeout: 90_000,
      io: new NodePlatformIO(),
    });
    // The kept library is activation 1 and cycle i is activation i + 2, so
    // cycle 62 asks for activation 64 -- the first the module has no entry for.
    expect(result.stdout).toMatch(
      /^cycle 62: .*libeven\.so: .*activation 64 is outside the module's table of 64 activations\nrefused\n$/,
    );
    expect(result.exitCode).toBe(0);
  });
});
