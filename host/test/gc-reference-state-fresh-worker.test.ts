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

  it("aborts a cyclic typed-GC identity fork cleanly with EOPNOTSUPP (flag off)", async () => {
    // GATED KIND: typed Wasm-GC struct references are engine-internal and cannot
    // be faithfully reconstructed in a fresh child today, so the fork is aborted
    // cleanly with -EOPNOTSUPP on the CAPTURE side (the GC record-stubs in
    // fork-activation-registry.ts mark the kind; the parent run loop calls
    // beginAbortReplay(EOPNOTSUPP) after seal). No child is spawned and nothing
    // is reconstructed.
    //
    // The fixture guest does not branch on a negative fork() return, so
    // -EOPNOTSUPP (-95) drives it into its parent/wait path and it exits 92. The
    // load-bearing signals are that the gate is CLEAN: no worker crash (stderr
    // empty) and no reconstruction (the typed-GC proof-of-use is null).
    const result = await runCentralizedProgram({
      programPath,
      argv: ["gc-reference-state-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
    });

    expect(
      result.exitCode,
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(92);
    expect(result.stderr).toBe("");
    expect(moduleReferenceProof(result.hostDiagnostics, "gc")).toBeNull();
  });

  // SKIPPED: module-mode (WASM_POSIX_FORK_MODULE=1) fork abort-replay is a known
  // gap deferred to M8 — see docs/fork-reference-support.md. With the co-resident
  // fork-module enabled, a gated fork cannot yet abort cleanly: the module owns
  // its own continuation journal (the JS replay-event journal stays idle) and has
  // no abort-replay path, so beginAbortReplay would crash the worker. The
  // flag-off test above proves the capture-side EOPNOTSUPP gate; this case is
  // re-enabled once module-mode abort-replay lands.
  it.skip("aborts the same cyclic typed-GC identity fork cleanly with EOPNOTSUPP (flag on)", async () => {
    const result = await runCentralizedProgram({
      programPath,
      argv: ["gc-reference-state-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
      forkModuleEnabled: true,
    });

    expect(
      result.exitCode,
      `flag-on GC fork exited unexpectedly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(92);
    expect(result.stderr).toBe("");
    expect(moduleReferenceProof(result.hostDiagnostics, "gc")).toBeNull();
  });
});
