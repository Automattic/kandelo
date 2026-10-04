import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCentralizedProgram } from "./centralized-test-helper";

/*
 * Rust and C/C++ share one program on Kandelo: a Rust static library
 * (built for wasm32-unknown-kandelo-std and installed with cargo-c) linked
 * into C and C++ programs, and C and C++ static libraries linked into Rust
 * programs. The fixtures (programs/rust/c-interop/) check what must agree
 * across the link: compiler intrinsics both sides define, callbacks
 * through function pointers, struct layout, C++ static constructors and
 * exceptions, and the single musl instance behind errno, the environment,
 * files, threads and the allocator.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BUILD_SCRIPT = join(REPO_ROOT, "programs/rust/c-interop/build.sh");

// The fixtures need the dev shell's Rust toolchain (cargo, cargo-c) and the
// SDK. A missing sdk/rust/libc-upstream submodule is not a skip: the build
// fails and says how to initialize it.
function hasToolchain(): boolean {
  for (const tool of ["wasm32posix-cc", "wasm32posix-c++", "cargo-cbuild"]) {
    try {
      execFileSync(tool, ["--version"], { stdio: "ignore" });
    } catch {
      return false;
    }
  }
  return true;
}

const canBuild = hasToolchain();
let outDir: string | null = null;

beforeAll(() => {
  if (!canBuild) return;
  outDir = mkdtempSync(join(tmpdir(), "kandelo-rust-c-interop-"));
  // The first run builds std into the private Rust sysroot.
  const built = execFileSync("bash", [BUILD_SCRIPT, outDir], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(built).toContain("C_RUST_INTEROP_BUILT");
}, 900_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

async function run(name: string) {
  const result = await runCentralizedProgram({
    programPath: join(outDir!, `${name}.wasm`),
    argv: [name],
    timeout: 30_000,
    useDefaultRootfs: false,
  });
  return {
    result,
    dump: `exit=${result.exitCode}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  };
}

const PROGRAMS = ["c-calls-rust", "cpp-calls-rust", "rust-calls-c", "rust-calls-cpp"];

describe.skipIf(!canBuild)("Rust <-> C/C++ static linking on Kandelo", () => {
  // Anything else under `env` is a symbol no linked library defined; it
  // would trap when its path ran (see rust-std.test.ts).
  it("leaves no unresolved env imports in the linked programs", () => {
    for (const name of PROGRAMS) {
      const module = new WebAssembly.Module(readFileSync(join(outDir!, `${name}.wasm`)));
      const unresolved = WebAssembly.Module.imports(module)
        .filter((i) => i.module === "env")
        .filter((i) => !["memory", "__channel_base"].includes(i.name) && !/^__wpk_fork_/.test(i.name))
        .map((i) => i.name);
      expect(unresolved, name).toEqual([]);
    }
  });

  it("cargo-c reports only libc as the Rust library's native dependency", () => {
    const pc = readFileSync(join(outDir!, "kandelo_interop.pc"), "utf8");
    expect(pc).toMatch(/^Libs\.private: -lc$/m);
    expect(pc).not.toContain("gcc_s");
  });

  it("links a Rust library into a C program", async () => {
    const { result, dump } = await run("c-calls-rust");
    expect(result.exitCode, dump).toBe(0);
    expect(result.stdout, dump).toContain("C-CALLS-RUST OK");
    expect(result.stdout, dump).not.toContain("FAIL");
    expect(result.stderr, dump).toBe("");
  }, 60_000);

  it("links a Rust library into a C++ program", async () => {
    const { result, dump } = await run("cpp-calls-rust");
    expect(result.exitCode, dump).toBe(0);
    expect(result.stdout, dump).toContain("CPP-CALLS-RUST OK");
    expect(result.stdout, dump).not.toContain("FAIL");
    expect(result.stderr, dump).toBe("");
  }, 60_000);

  it("links a C library into a Rust program", async () => {
    const { result, dump } = await run("rust-calls-c");
    expect(result.exitCode, dump).toBe(0);
    expect(result.stdout, dump).toContain("RUST-CALLS-C OK");
    expect(result.stdout, dump).not.toContain("FAIL");
    expect(result.stderr, dump).toBe("");
  }, 60_000);

  // rustc links through the C driver, so the C++ runtime is named by the
  // program's build.rs; C++ exceptions stay inside the C++ library
  // (Kandelo's Rust is panic=abort and cannot unwind through Rust frames).
  it("links a C++ library into a Rust program", async () => {
    const { result, dump } = await run("rust-calls-cpp");
    expect(result.exitCode, dump).toBe(0);
    expect(result.stdout, dump).toContain("RUST-CALLS-CPP OK");
    expect(result.stdout, dump).not.toContain("FAIL");
    expect(result.stderr, dump).toBe("");
  }, 60_000);
});
