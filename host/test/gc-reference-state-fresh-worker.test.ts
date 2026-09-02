import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { moduleReferenceProof } from "./fork-module-reference-proof";
import {
  RAW_GC_REFERENCE_STATE_FRESH_WORKER_HEX,
} from "./fixtures/gc-reference-state-fresh-worker-bytes";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureSource = resolve(
  testDir,
  "fixtures/gc-reference-state-fresh-worker.wat",
);
const instrumenter = resolve(
  testDir,
  "../../tools/bin/wasm-fork-instrument",
);

describe("Wasm GC reference state in a fresh process Worker", () => {
  let workDir = "";
  let programPath = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-gc-reference-worker-"));
    const rawPath = join(workDir, "gc-reference-state.raw.wasm");
    programPath = join(workDir, "gc-reference-state.wasm");
    // Keep the source path live in the test contract even though the checked
    // byte fixture is required for WABT compatibility.
    expect(fixtureSource).toMatch(/gc-reference-state-fresh-worker\.wat$/);
    writeFileSync(
      rawPath,
      Buffer.from(RAW_GC_REFERENCE_STATE_FRESH_WORKER_HEX, "hex"),
    );
    execFileSync(instrumenter, [rawPath, "-o", programPath]);
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("preserves one cyclic identity across params, carryovers, globals, and tables", async () => {
    const result = await runCentralizedProgram({
      programPath,
      argv: ["gc-reference-state-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
    });

    expect(
      result.exitCode,
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("drives the cyclic typed-GC identity reconstruction through the module (flag on)", async () => {
    // Phase 6 D6.5: the same self-cyclic, 4-aliased `$node` struct, but with the
    // co-resident fork-module ENABLED. Asserts (a) PARITY — the child still
    // exits 0 (its ref.eq alias checks + scalar field 77 all hold) exactly as the
    // flag-off run; and (b) PROOF OF USE — the module advanced its typed-GC node
    // counter (> 0), so the GC graph was reconstructed THROUGH the module rather
    // than silently falling back to the JS typed-graph drive-order.
    const result = await runCentralizedProgram({
      programPath,
      argv: ["gc-reference-state-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
      forkModuleEnabled: true,
    });

    // (a) PARITY.
    expect(
      result.exitCode,
      `flag-on GC fork exited unexpectedly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");

    // (b) PROOF OF USE: the module reconstructed the typed-GC node graph.
    const gcNodes = moduleReferenceProof(result.hostDiagnostics, "gc");
    expect(
      gcNodes,
      "expected a fork-module typed-GC proof-of-use diagnostic; the module did " +
        "not drive the GC reconstruction",
    ).not.toBeNull();
    expect(gcNodes!).toBeGreaterThan(0);
  });
});
