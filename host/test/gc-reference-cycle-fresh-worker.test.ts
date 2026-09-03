// Phase 6 item 3c equivalence VEHICLE: a real instrumented MULTI-NODE Wasm-GC
// guest forked in a fresh process Worker.
//
// The sibling `gc-reference-state-fresh-worker.test.ts` forks a SINGLE
// self-cyclic `$node` struct. This fixture forks a graph with TWO typed-GC
// aggregate kinds joined in a struct<->array CYCLE — a `$node` struct
// referencing an `$arr` array whose element 0 references the struct back. The
// child self-verifies every alias (reference param carryover, mutable reference
// global, mutated reference table), the struct<->array cycle
// (node.array[0] === node), and the scalar struct field, then exits 0 (stderr
// empty) on success.
//
// This is the graph the co-resident fork-module's `fm_build_gc_plan` /
// `fm_drive_execute` typed-GC drive is built to reconstruct (the same
// struct / array ALLOC-emitting kinds `fork-module-drive-r1-trace.test.ts`
// drives through the module). It is authored here so the production 3c flip has
// a genuine multi-node reconstruction to prove flag-on == flag-off against.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { moduleReferenceProof } from "./fork-module-reference-proof";
import {
  RAW_GC_REFERENCE_CYCLE_FRESH_WORKER_HEX,
} from "./fixtures/gc-reference-cycle-fresh-worker-bytes";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureSource = resolve(
  testDir,
  "fixtures/gc-reference-cycle-fresh-worker.wat",
);
const instrumenter = resolve(
  testDir,
  "../../tools/bin/wasm-fork-instrument",
);

describe("Multi-node Wasm GC reference cycle in a fresh process Worker", () => {
  let workDir = "";
  let programPath = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-gc-reference-cycle-"));
    const rawPath = join(workDir, "gc-reference-cycle.raw.wasm");
    programPath = join(workDir, "gc-reference-cycle.wasm");
    // Keep the source path live in the test contract even though the checked
    // byte fixture is required for WABT compatibility.
    expect(fixtureSource).toMatch(/gc-reference-cycle-fresh-worker\.wat$/);
    writeFileSync(
      rawPath,
      Buffer.from(RAW_GC_REFERENCE_CYCLE_FRESH_WORKER_HEX, "hex"),
    );
    execFileSync(instrumenter, [rawPath, "-o", programPath]);
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("rebuilds the struct<->array cycle identities across a fork (flag off)", async () => {
    const result = await runCentralizedProgram({
      programPath,
      argv: ["gc-reference-cycle-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
    });

    expect(
      result.exitCode,
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rebuilds the same multi-node graph with the fork-module enabled (parity)", async () => {
    // PARITY: with the co-resident fork-module ENABLED, the child's ref.eq
    // alias checks + the cyclic array element + scalar fields + the i31 value
    // all still hold, so it exits 0 exactly as the flag-off run. PROOF OF USE:
    // the module advanced its typed-GC node counter (> 0), so the graph was
    // admitted and reconstructed THROUGH the module (the item 3a data feed).
    //
    // NOTE: this counter is the 3a DATA-FEED counter, not the item 3c DRIVE
    // counter. The production typed-GC drive-ORDER is still the proven JS
    // `ForkReferenceTransaction` walk; the module `fm_build_gc_plan` /
    // `fm_drive_execute` drive is built but not yet called on this RESTORE path.
    // The `.skip`'d EQUIVALENCE GATE in `fork-module-drive-r1-trace.test.ts`
    // tracks turning this into a distinct drive proof.
    const result = await runCentralizedProgram({
      programPath,
      argv: ["gc-reference-cycle-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
      forkModuleEnabled: true,
    });

    expect(
      result.exitCode,
      `flag-on GC cycle fork exited unexpectedly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");

    const gcNodes = moduleReferenceProof(result.hostDiagnostics, "gc");
    expect(
      gcNodes,
      "expected a fork-module typed-GC proof-of-use diagnostic; the module did " +
        "not admit the multi-node GC reconstruction",
    ).not.toBeNull();
    expect(gcNodes!).toBeGreaterThan(0);
  });
});
