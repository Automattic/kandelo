import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

const SIGKILL = 9;

/**
 * The kernel owns a fork launch. The child's replay reports
 * SYS_FORK_REPLAY_READY from inside the fork module, and the kernel then
 * completes the parent's SYS_FORK; the host completes it from the kernel's
 * fork-lifecycle event and nowhere else.
 */
describe("kernel-completed fork launch", () => {
  it("returns in the parent while the child is still running", async () => {
    // Runs on the production Node host. The child cannot exit until the
    // parent writes after fork() returned, so the parent must be completed at
    // the child's replay-ready report, not at its exit.
    const result = await runCentralizedProgram({
      programPath: resolveBinary("programs/fork-parent-returns-first.wasm"),
      argv: ["fork-parent-returns-first"],
      timeout: 20_000,
    });

    expect(result.stdout).toContain("PARENT_RETURNED_FROM_FORK");
    expect(result.stdout).toContain("CHILD_EXITED_AFTER_PARENT");
    expect(result.exitCode).toBe(0);
  }, 30_000);

  it("gives the parent the pid and a reapable zombie of a child killed before replay readiness", async () => {
    // A child killed inside the launch window was still created, so POSIX
    // gives the parent its pid and a zombie with the kill status. The kernel
    // commits the parent's result at the child's death. The harness kills the
    // child after the host registered it and before it has a Worker that
    // could reach its fork site.
    let killed = 0;
    const result = await runCentralizedProgram({
      programPath: resolveBinary("programs/fork-kill-before-ready.wasm"),
      argv: ["fork-kill-before-ready"],
      timeout: 20_000,
      onForkChildRegistered: (kernelWorker, childPid) => {
        expect(kernelWorker.signalProcess(childPid, SIGKILL)).toBe(true);
        killed += 1;
      },
    });

    expect(killed).toBe(1);
    expect(result.stdout).not.toContain("CHILD_RAN");
    expect(result.stdout).not.toContain("FORK_FAILED");
    expect(result.stdout).toContain("PARENT_GOT_PID");
    expect(result.stdout).toContain("PARENT_REAPED_SIGKILL");
    expect(result.exitCode).toBe(0);
  }, 30_000);
});
