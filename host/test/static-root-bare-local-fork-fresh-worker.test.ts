import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import {
  RAW_STATIC_ROOT_BARE_LOCAL_FORK_FRESH_WORKER_HEX,
} from "./fixtures/static-root-bare-local-fork-fresh-worker-bytes";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureSource = resolve(
  testDir,
  "fixtures/static-root-bare-local-fork-fresh-worker.wat",
);
const instrumenter = resolve(
  testDir,
  "../../tools/bin/wasm-fork-instrument",
);

// Regression for the pre-existing gap: a static root captured as a BARE local
// value across fork (not behind a GC struct field) trapped on parent replay.
// A captured i31/struct is published into the PARENT's anyref transit at capture
// (encodeI31 / claimGcSlot grow+publish); the static-root lookup path grew and
// published nothing, so the parent's resume `decode_anyref` (a pure
// `table.get(transit, recipe+1)`) read an unsized slot and trapped
// out of bounds. The fix publishes the static root into the transit in
// `ForkReferenceTransaction.lookupGcSlot`, symmetric with i31/struct. The fixture
// asserts BOTH the parent and the child reconstruct the bare static root.
describe("Wasm GC bare static-root fork in a fresh process Worker", () => {
  let workDir = "";
  let programPath = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-static-root-bare-"));
    const rawPath = join(workDir, "static-root-bare.raw.wasm");
    programPath = join(workDir, "static-root-bare.wasm");
    expect(fixtureSource).toMatch(
      /static-root-bare-local-fork-fresh-worker\.wat$/,
    );
    writeFileSync(
      rawPath,
      Buffer.from(RAW_STATIC_ROOT_BARE_LOCAL_FORK_FRESH_WORKER_HEX, "hex"),
    );
    execFileSync(instrumenter, [rawPath, "-o", programPath]);
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  for (const forkModuleEnabled of [false, true]) {
    it(`reconstructs a bare static root on both parent and child (flag ${
      forkModuleEnabled ? "on" : "off"
    })`, async () => {
      const result = await runCentralizedProgram({
        programPath,
        argv: ["static-root-bare-local-fork-fresh-worker"],
        timeout: 30_000,
        useDefaultRootfs: false,
        forkModuleEnabled,
      });

      // exit 91 = child ref.eq/field check failed; 93 = parent check failed
      // (the reconstruction gap this test regresses); 92 = wait/status mismatch.
      expect(
        result.exitCode,
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0);
      expect(result.stderr).toBe("");
    });
  }
});
