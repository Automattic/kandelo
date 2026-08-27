import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import {
  RAW_GC_REFERENCE_STATE_FRESH_WORKER_HEX,
} from "./fixtures/gc-reference-state-fresh-worker-bytes";
import { describeWasmArtifactPolicyFailures, extractAbiVersion } from "../src/constants";
import { ABI_VERSION } from "../src/generated/abi";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureSource = resolve(
  testDir,
  "fixtures/gc-reference-state-fresh-worker.wat",
);
const instrumenter = resolve(
  testDir,
  "../../tools/bin/wasm-fork-instrument",
);

function readArtifact(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

describe("Wasm GC reference state in a fresh process Worker", () => {
  let workDir = "";
  let rawPath = "";
  let programPath = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-gc-reference-worker-"));
    rawPath = join(workDir, "gc-reference-state.raw.wasm");
    programPath = join(workDir, "gc-reference-state.wasm");
    // Keep the source path live in the test contract even though the checked
    // byte fixture is required for WABT compatibility.
    expect(fixtureSource).toMatch(/gc-reference-state-fresh-worker\.wat$/);
    writeFileSync(
      rawPath,
      Buffer.from(RAW_GC_REFERENCE_STATE_FRESH_WORKER_HEX, "hex"),
    );
    // The committed fixture declares a placeholder sentinel __abi_version, not a
    // real ABI epoch. Stamp the current ABI at instrumentation time (test-only
    // flag) so the artifact tracks the running ABI instead of going stale on
    // every bump. This unblocks the artifact gate only; the reconstruction
    // assertion below is what proves correctness.
    execFileSync(instrumenter, [
      "--stamp-abi-version",
      rawPath,
      "-o",
      programPath,
    ]);
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

  it("keeps the ABI-staleness gate real: without --stamp-abi-version the fixture is rejected", () => {
    // Guard that the test-only stamp flag is load-bearing and the rejection path
    // it bypasses is genuine. Instrumenting the same fixture WITHOUT the flag
    // preserves the committed placeholder sentinel, which the host
    // artifact-policy gate rejects as a stale ABI epoch.
    const stalePath = join(workDir, "gc-reference-state.stale.wasm");
    execFileSync(instrumenter, [rawPath, "-o", stalePath]);
    const staleBytes = readArtifact(stalePath);

    const declared = extractAbiVersion(staleBytes);
    expect(declared).not.toBeNull();
    expect(declared).not.toBe(ABI_VERSION);
    expect(
      describeWasmArtifactPolicyFailures(staleBytes, { expectedAbi: ABI_VERSION }),
    ).toContain(`ABI ${declared}, expected ${ABI_VERSION}`);

    // The stamped artifact used by the reconstruction test above declares the
    // current epoch and no longer trips the ABI-mismatch gate.
    const stampedBytes = readArtifact(programPath);
    expect(extractAbiVersion(stampedBytes)).toBe(ABI_VERSION);
    expect(
      describeWasmArtifactPolicyFailures(stampedBytes, { expectedAbi: ABI_VERSION }),
    ).not.toContain(`ABI ${ABI_VERSION}, expected ${ABI_VERSION}`);
  });
});
