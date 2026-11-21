import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";

// Clang lowers __int128 multiply and shifts and every long double (fp128)
// operation to compiler builtins that the SDK compiles into each executable
// from libc/glue/compiler_rt.c. The optimizer may recognize a builtin's own
// body as the very operation the Wasm backend lowers back to that builtin;
// the builtin then calls itself and recurses until the stack overflows.
// Clang 23 did this to __multi3.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const compilerRt = join(repoRoot, "libc/glue/compiler_rt.c");
// Absolute path, never a bare `wasm32posix-cc`: a bare name resolves through
// PATH and can pick up a different worktree's SDK.
const sdkCc = (arch: "wasm32" | "wasm64") =>
  join(repoRoot, "sdk", "bin", `${arch}posix-cc`);
// The SDK driver compiles the glue at -O2; the other levels guard packages
// that compile compiler_rt.c themselves and future driver changes.
const optLevels = ["-O1", "-O2", "-O3", "-Os", "-Oz"] as const;
const programs = [
  ["wasm32", join(repoRoot, "examples/compiler_builtins_test.wasm")],
  ["wasm64", join(repoRoot, "examples/compiler_builtins_test.wasm64.wasm")],
] as const;

/** Direct-call graph of the functions an object defines. */
function callGraph(objectPath: string): Map<string, Set<string>> {
  const objdump = process.env.LLVM_BIN
    ? join(process.env.LLVM_BIN, "llvm-objdump")
    : "llvm-objdump";
  const listing = execFileSync(objdump, ["-dr", objectPath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const graph = new Map<string, Set<string>>();
  let current: Set<string> | undefined;
  for (const line of listing.split("\n")) {
    const header = /^[0-9a-f]+ <([^>]+)>:$/.exec(line);
    if (header) {
      current = new Set();
      graph.set(header[1], current);
      continue;
    }
    const call = /R_WASM_FUNCTION_INDEX_LEB\s+(\S+?)(?:\+0)?$/.exec(line.trim());
    if (call && current) current.add(call[1]);
  }
  return graph;
}

/** Every call cycle among the defined functions, as "a -> b -> a". */
function callCycles(graph: Map<string, Set<string>>): string[] {
  const cycles: string[] = [];
  const state = new Map<string, "active" | "done">();
  const stack: string[] = [];
  const visit = (fn: string) => {
    state.set(fn, "active");
    stack.push(fn);
    for (const callee of graph.get(fn) ?? []) {
      if (!graph.has(callee)) continue;
      if (state.get(callee) === "active") {
        cycles.push([...stack.slice(stack.indexOf(callee)), callee].join(" -> "));
      } else if (!state.has(callee)) {
        visit(callee);
      }
    }
    stack.pop();
    state.set(fn, "done");
  };
  for (const fn of graph.keys()) if (!state.has(fn)) visit(fn);
  return cycles;
}

describe("compiler builtins", () => {
  it.each(["wasm32", "wasm64"] as const)(
    "%s compiler_rt.c builtins never call themselves",
    (arch) => {
      const temp = mkdtempSync(join(tmpdir(), "kandelo-compiler-rt-"));
      try {
        for (const opt of optLevels) {
          const object = join(temp, `compiler_rt${opt}.o`);
          execFileSync(sdkCc(arch), [opt, "-c", compilerRt, "-o", object], {
            cwd: repoRoot,
            stdio: "pipe",
          });
          const graph = callGraph(object);
          expect(graph.has("__multi3"), `${opt}: objdump listed no __multi3`).toBe(true);
          // A known call edge proves the relocations parsed; an edgeless
          // graph would otherwise pass the cycle check vacuously. If a
          // compiler inlines __addtf3 here, pick another stable edge.
          expect(
            graph.get("__subtf3")?.has("__addtf3"),
            `${opt}: no __subtf3 -> __addtf3 edge; call relocations did not parse`,
          ).toBe(true);
          expect(callCycles(graph), opt).toEqual([]);
        }
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
    // Five SDK compiles and objdump runs per architecture.
    60_000,
  );

  it.each(programs)("%s computes exact 128-bit and fp128 results", async (_arch, program) => {
    // global-setup builds both; a missing binary is a build failure, not a skip.
    expect(existsSync(program), `${program} was not built`).toBe(true);
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["compiler_builtins_test"],
      useDefaultRootfs: false,
      timeout: 10_000,
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS compiler builtins");
  });
});
