import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { moduleReferenceProof } from "./fork-module-reference-proof";
import {
  RAW_STATIC_ROOT_LOCAL_FORK_FRESH_WORKER_HEX,
} from "./fixtures/static-root-local-fork-fresh-worker-bytes";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureSource = resolve(
  testDir,
  "fixtures/static-root-local-fork-fresh-worker.wat",
);
const instrumenter = resolve(
  testDir,
  "../../tools/bin/wasm-fork-instrument",
);

describe("Wasm GC static-root binder in a fresh process Worker", () => {
  let workDir = "";
  let programPath = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-static-root-worker-"));
    const rawPath = join(workDir, "static-root.raw.wasm");
    programPath = join(workDir, "static-root.wasm");
    // Keep the source path live in the test contract even though the checked
    // byte fixture is required for WABT compatibility.
    expect(fixtureSource).toMatch(/static-root-local-fork-fresh-worker\.wat$/);
    writeFileSync(
      rawPath,
      Buffer.from(RAW_STATIC_ROOT_LOCAL_FORK_FRESH_WORKER_HEX, "hex"),
    );
    execFileSync(instrumenter, [rawPath, "-o", programPath]);
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("reconstructs an immutable static root's canonical identity across fork (flag off)", async () => {
    // Flag OFF: the byte-identical JS reference path publishes the static root
    // into the anyref transit. The child exits 0 iff its `ref.eq` check against
    // the fresh instance's `$static_root` (plus the struct field 123) holds.
    const result = await runCentralizedProgram({
      programPath,
      argv: ["static-root-local-fork-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
    });

    expect(
      result.exitCode,
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("drives the static-root reconstruction through the module (flag on)", async () => {
    // Flag ON: the co-resident fork-module's static-root binder publishes the
    // immutable root into the anyref transit via a DRIVE_OP_STATIC_ROOT step
    // (`table.get` the merged catalog mirror + `table.set` transit, both wasm).
    // Asserts (a) PARITY — the child still exits 0 (its `ref.eq` identity check
    // and struct field 123 hold) exactly as the flag-off run; and (b) PROOF OF
    // USE — the module advanced `fm_static_roots_published` (> 0), so the static
    // root was republished THROUGH the module rather than the JS `publishTransit`
    // fallback.
    const result = await runCentralizedProgram({
      programPath,
      argv: ["static-root-local-fork-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
      forkModuleEnabled: true,
    });

    // (a) PARITY.
    expect(
      result.exitCode,
      `flag-on static-root fork exited unexpectedly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");

    // (b) PROOF OF USE: the module republished the static root into the transit.
    const staticRoots = moduleReferenceProof(
      result.hostDiagnostics,
      "static-root",
    );
    expect(
      staticRoots,
      "expected a fork-module static-root proof-of-use diagnostic; the module " +
        "did not drive the static-root reconstruction",
    ).not.toBeNull();
    expect(staticRoots!).toBeGreaterThan(0);
  });
});
