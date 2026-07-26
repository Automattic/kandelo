import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureSource = resolve(
  testDir,
  "fixtures/catch-ref-fresh-worker.wat",
);
const referencePayloadFixtureSource = resolve(
  testDir,
  "fixtures/reference-catch-payload-fresh-worker.wat",
);
const instrumenter = resolve(
  testDir,
  "../../tools/bin/wasm-fork-instrument",
);

describe("CatchRef fresh process worker replay", () => {
  let workDir = "";
  let programPath = "";
  let referencePayloadProgramPath = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-catch-ref-worker-"));
    const rawPath = join(workDir, "catch-ref-fresh-worker.raw.wasm");
    programPath = join(workDir, "catch-ref-fresh-worker.wasm");
    execFileSync("wat2wasm", [
      "--enable-exceptions",
      "--enable-threads",
      fixtureSource,
      "-o",
      rawPath,
    ]);
    execFileSync(instrumenter, [rawPath, "-o", programPath]);

    const referencePayloadRawPath = join(
      workDir,
      "reference-catch-payload-fresh-worker.raw.wasm",
    );
    referencePayloadProgramPath = join(
      workDir,
      "reference-catch-payload-fresh-worker.wasm",
    );
    execFileSync("wat2wasm", [
      "--enable-exceptions",
      "--enable-threads",
      referencePayloadFixtureSource,
      "-o",
      referencePayloadRawPath,
    ]);
    execFileSync(instrumenter, [
      referencePayloadRawPath,
      "-o",
      referencePayloadProgramPath,
    ]);
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("reconstructs the caught exception in a fresh Node child worker", async () => {
    // The fixture's parent waits for the fork child. The child exits 91 if
    // CatchRef replay did not restore payload 42; the parent converts any
    // failed wait status into exit 92.
    const result = await runCentralizedProgram({
      programPath,
      argv: ["catch-ref-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
    });

    expect(
      result.exitCode,
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("reconstructs reference-bearing catches in fresh Node child workers", async () => {
    // The first child calls a non-null funcref reconstructed from the child's
    // static function catalog. The second verifies a nullable externref
    // payload; both values originated in a caught exception recipe.
    const result = await runCentralizedProgram({
      programPath: referencePayloadProgramPath,
      argv: ["reference-catch-payload-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
    });

    expect(
      result.exitCode,
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");
  });
});
