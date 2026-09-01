import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

// Phase 6 D5: prove the co-resident `fork-module` instantiates at process init
// behind `forkModuleEnabled` inside a REAL centralized worker (parent + fork
// child), and that a real single-parent fork still completes end-to-end. The
// import flip is NOT done in this step, so a successful fork is the proof that
// init-time placement + `continuationMmap` reservation do not perturb the live
// guest. `fork-module-instance.test.ts` separately asserts the required
// exports at the unit level.

const FIXTURE = "programs/d_01_single_fork.wasm";
const EXPECT = ["PRE_FORK", "CHILD: ok", "PASS: D-01"];

async function runSingleFork(forkModuleEnabled: boolean) {
  const binary = resolveBinary(FIXTURE);
  const result = await runCentralizedProgram({
    programPath: binary,
    argv: [FIXTURE],
    timeout: 10_000,
    forkModuleEnabled,
  });
  return result;
}

describe("fork-module worker instantiation (flag-gated)", () => {
  it("boots and forks with the fork-module enabled", async () => {
    const result = await runSingleFork(true);
    expect(
      result.exitCode,
      `flag-on fork exited unexpectedly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    for (const fragment of EXPECT) {
      expect(result.stdout).toContain(fragment);
    }
  });

  it("boots and forks unchanged with the fork-module disabled", async () => {
    const result = await runSingleFork(false);
    expect(result.exitCode).toBe(0);
    for (const fragment of EXPECT) {
      expect(result.stdout).toContain(fragment);
    }
  });
});
