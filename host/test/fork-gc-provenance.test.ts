// Constructor provenance through a real process Worker: Wasm-GC objects whose
// ONLY construction path is their constructor survive fork().
//
// An immutable Wasm-GC array cannot be filled after allocation, and Wasm has no
// instruction that builds one of runtime length from arbitrary values. A fork
// child is a fresh instance, so the only faithful rebuild is re-running the
// allocation instruction that made the array with operands that reproduce it.
// `array.new_fixed`, `array.new` and `array.new_default` operands are the
// array's own contents; `array.new_data` / `array.new_elem` read a segment
// offset the contents do not reveal, which the co-resident fork module records
// where the instruction runs (docs/fork-reference-support.md, "Constructor
// provenance").
//
// The fixture is the native host's (`crates/host-native/fixtures/
// native_fork_gc_provenance.wat`, `smoke_fork_gc_provenance_reconstructs`):
// one source, three hosts. It drops every segment before forking, forks twice
// from the parent and once from the first child, and checks every object in
// every process itself; see its header for the exit codes.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { moduleReferenceProof } from "./fork-module-reference-proof";

const testDir = dirname(fileURLToPath(import.meta.url));
const instrumenter = resolve(testDir, "../../tools/bin/wasm-fork-instrument");
const fixtureSource = resolve(
  testDir,
  "../../crates/host-native/fixtures/native_fork_gc_provenance.wat",
);

describe("constructor-only Wasm-GC objects in a fresh process Worker", () => {
  let workDir = "";
  let programPath = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-gc-provenance-"));
    const rawPath = join(workDir, "gc-provenance.raw.wasm");
    programPath = join(workDir, "gc-provenance.wasm");
    // wasm-tools, not WABT's wat2wasm: WABT cannot assemble Wasm-GC types.
    execFileSync("wasm-tools", ["parse", fixtureSource, "-o", rawPath]);
    execFileSync(instrumenter, ["--stamp-abi-version", rawPath, "-o", programPath]);
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("rebuilds them by re-running their constructors, in children and a grandchild", async () => {
    const result = await runCentralizedProgram({
      programPath,
      argv: ["gc-provenance"],
      timeout: 60_000,
      useDefaultRootfs: false,
    });

    expect(
      result.exitCode,
      `a rebuilt object failed its check (see the fixture's exit codes; 90 = ` +
        `the parent's fork was refused)\nstdout:\n${result.stdout}\n` +
        `stderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");
    // No fork was aborted: a refusal would have been reported here. That
    // every fork produced a child the fixture checks itself: it exits 90/91
    // when fork() fails and 92 when a child cannot be reaped.
    expect(result.hostDiagnostics.filter((d) => d.source === "fork")).toEqual([]);
    const gcNodes = moduleReferenceProof(result.forkModuleDiagnostics, "gc");
    expect(gcNodes, "the module did not admit a GC reconstruction").not.toBeNull();
    expect(gcNodes!).toBeGreaterThan(0);
  });
});
