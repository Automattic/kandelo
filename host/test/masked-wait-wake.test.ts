import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

// A masked ppoll/pselect woken by another process: a signal sent while it is
// blocked interrupts it, "write, then kill" never loses the signal, and
// readiness ends the wait without a grace period. The browser counterpart is
// apps/browser-demos/test/masked-wait-wake.spec.ts.
describe("masked ppoll/pselect cross-process wakeups", () => {
  it("interrupts on a signal, never loses a late one, and wakes promptly on readiness", async () => {
    const result = await runCentralizedProgram({
      programPath: join(repoRoot, "examples/masked_wait_wake_test.wasm"),
      argv: ["masked-wait-wake"],
      timeout: 60_000,
      useDefaultRootfs: false,
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    // Record the race outcomes and latencies with the run's evidence.
    console.log(result.stdout.match(/MASKED_WAIT_(RACE|LATENCY) .*/g)?.join("\n"));
    expect(result.stdout).toContain("MASKED_WAIT_WAKE_PASS");
    expect(result.stdout.match(/MASKED_WAIT_KILL api=\w+ ok/g)).toHaveLength(2);
    expect(result.stdout.match(/MASKED_WAIT_RACE /g)).toHaveLength(2);
    expect(result.stdout.match(/MASKED_WAIT_LATENCY /g)).toHaveLength(2);
    expect(result.stderr).toBe("");
    expect(result.hostDiagnostics).toEqual([]);
  }, 90_000);
});
