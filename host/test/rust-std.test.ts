import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCentralizedProgram } from "./centralized-test-helper";

/*
 * Rust programs built for wasm32-unknown-kandelo-std with the SDK's
 * wasm32posix-cargo (prebuilt std from the private sysroot), run on the
 * kernel. Besides each program's own checks, every one must import nothing
 * from `env` but the linear memory, the syscall channel and (when it uses
 * fork) the fork-instrumentation runtime: a std symbol
 * that no Kandelo library defines (as `errno_location` and
 * `_Unwind_Backtrace` once were) links as an import and traps only when
 * its path runs, which success-path programs never reach.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RUST_PROGRAMS = join(REPO_ROOT, "programs/rust");
const CARGO_WRAPPER = join(REPO_ROOT, "sdk/bin/wasm32posix-cargo");
const TARGET = "wasm32-unknown-kandelo-std";
const ALLOWED_ENV_IMPORTS = new Set(["memory", "__channel_base"]);
// Fork instrumentation (proc-demo uses fork) adds the host's fork runtime.
const FORK_RUNTIME_IMPORT = /^__wpk_fork_/;

const FIXTURES = [
  "std-hello",
  "thread-demo",
  "fd-demo",
  "net-demo",
  "proc-demo",
  "std-boundaries",
] as const;
type Fixture = (typeof FIXTURES)[number];

// cargo and the SDK come from the dev shell. A missing sdk/rust/libc-upstream
// submodule is not a skip: the sysroot build fails and says how to fix it.
function hasToolchain(): boolean {
  for (const tool of ["cargo", "wasm32posix-cc"]) {
    try {
      execFileSync(tool, ["--version"], { stdio: "ignore" });
    } catch {
      return false;
    }
  }
  return true;
}

const canBuild = hasToolchain();
let buildRoot: string | null = null;
const programs = new Map<Fixture, string>();

beforeAll(() => {
  if (!canBuild) return;
  buildRoot = mkdtempSync(join(tmpdir(), "kandelo-rust-std-"));
  for (const fixture of FIXTURES) {
    const targetDir = join(buildRoot, fixture);
    // The first build compiles std into the private Rust sysroot.
    execFileSync("bash", [CARGO_WRAPPER, "build", "--release"], {
      cwd: join(RUST_PROGRAMS, fixture),
      env: { ...process.env, CARGO_TARGET_DIR: targetDir },
      stdio: "pipe",
      maxBuffer: 64 * 1024 * 1024,
    });
    const outDir = join(targetDir, TARGET, "release");
    const wasm = readdirSync(outDir).filter((f) => f.endsWith(".wasm"));
    expect(wasm, `${fixture} outputs`).toHaveLength(1);
    programs.set(fixture, join(outDir, wasm[0]));
  }
}, 900_000);

afterAll(() => {
  if (buildRoot) rmSync(buildRoot, { recursive: true, force: true });
});

async function run(fixture: Fixture, args: string[] = []) {
  const programPath = programs.get(fixture)!;
  // argv[0] names the program in the guest so proc-demo can exec itself.
  const guestPath = `/usr/bin/${fixture}`;
  const result = await runCentralizedProgram({
    programPath,
    argv: [guestPath, ...args],
    execPrograms: new Map([[guestPath, programPath]]),
    timeout: 30_000,
    useDefaultRootfs: false,
  });
  return {
    result,
    dump: `exit=${result.exitCode}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  };
}

describe.skipIf(!canBuild)("Rust std programs on Kandelo", () => {
  it("import only the memory and the syscall channel from env", () => {
    for (const fixture of FIXTURES) {
      const module = new WebAssembly.Module(readFileSync(programs.get(fixture)!));
      const unresolved = WebAssembly.Module.imports(module)
        .filter((i) => i.module === "env")
        .filter((i) => !ALLOWED_ENV_IMPORTS.has(i.name) && !FORK_RUNTIME_IMPORT.test(i.name))
        .map((i) => i.name);
      expect(unresolved, fixture).toEqual([]);
    }
  });

  const expected: Record<Fixture, string> = {
    "std-hello": "HashMap len=3",
    "thread-demo": "std::thread + Mutex OK",
    "fd-demo": "std fd duplication OK",
    "net-demo": "std::net TCP loopback OK",
    "proc-demo": "std::process::Command OK",
    "std-boundaries": "STD BOUNDARIES OK",
  };
  for (const fixture of FIXTURES) {
    it(`runs ${fixture}`, async () => {
      const { result, dump } = await run(fixture);
      expect(result.exitCode, dump).toBe(0);
      expect(result.stdout, dump).toContain(expected[fixture]);
      expect(result.stdout, dump).not.toContain("FAIL");
      expect(result.stderr, dump).toBe("");
    }, 60_000);
  }

  it("reports the kernel's one CPU through available_parallelism", async () => {
    const { result, dump } = await run("thread-demo");
    expect(result.stdout, dump).toContain("available_parallelism = 1\n");
  }, 60_000);

  it("redirects stdout away from the terminal in fd-demo", async () => {
    const { result, dump } = await run("fd-demo");
    expect(result.stdout, dump).not.toContain("baz");
    expect(result.stdout, dump).not.toContain("qux");
  }, 60_000);

  it("aborts on panic with the panic message", async () => {
    const { result, dump } = await run("std-boundaries", ["panic"]);
    expect(result.exitCode, dump).toBe(134);
    expect(result.stderr, dump).toContain("deliberate panic");
    expect(result.stderr, dump).not.toContain("Unimplemented import");
  }, 60_000);
});
