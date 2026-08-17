import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseMechanismTraceRuns,
  partitionForkDispatches,
  requireCompleteVforkSequence,
  requireVforkStartFailureSequence,
  type MechanismTrace,
} from "./vfork-mechanism-trace";

const testDir = dirname(fileURLToPath(import.meta.url));

function assertPrivatePreparationEvidence(preparation: MechanismTrace): void {
  expect(preparation.fields.get("mode"), preparation.line).toBe("1");
  expect(preparation.fields.get("memory_identity"), preparation.line).toBe("same");
  expect(preparation.fields.get("live_memory_delta"), preparation.line).toBe("0");
  expect(preparation.fields.get("alias_delta"), preparation.line).toBe("1");
  expect(preparation.fields.get("parent_channel"), preparation.line)
    .not.toBe(preparation.fields.get("child_channel"));
  expect(preparation.fields.get("owner_control"), preparation.line)
    .not.toBe(preparation.fields.get("child_prefix"));
  expect(preparation.fields.get("scratch"), preparation.line)
    .not.toBe(preparation.fields.get("owner_control"));
  expect(preparation.fields.get("scratch"), preparation.line)
    .not.toBe(preparation.fields.get("child_prefix"));
  expect(preparation.fields.get("externref_parent"), preparation.line)
    .not.toBe(preparation.fields.get("externref_child"));
}

describe("production fork-mode mechanism evidence", () => {
  it("observes borrowed mode 1 through exact child quiescence before parent release", () => {
    const output = execFileSync(
      "npx",
      ["tsx", join(testDir, "fixtures/vfork-production-trace-runner.ts")],
      {
        cwd: join(testDir, ".."),
        encoding: "utf8",
        env: { ...process.env, KERNEL_SYSCALL_LOG: "1" },
        timeout: 60_000,
      },
    );
    expect(output).toContain("PRODUCTION_VFORK_TRACE_RUNNER_PASS");
    expect(output).toContain("PRODUCTION_SIDE_TRACE_RUNNER_PASS");
    const runs = parseMechanismTraceRuns(output);
    expect(runs.map((run) => run.name)).toEqual([
      "lifecycle",
      "ordinary",
      "side-module",
    ]);

    const lifecycleDispatches = partitionForkDispatches(runs[0]);
    expect(lifecycleDispatches.length).toBeGreaterThan(0);
    for (const dispatch of lifecycleDispatches) {
      const sequence = requireCompleteVforkSequence(dispatch);
      assertPrivatePreparationEvidence(sequence.preparation);
    }

    const ordinaryDispatches = partitionForkDispatches(runs[1]);
    expect(ordinaryDispatches).toHaveLength(1);
    expect(ordinaryDispatches[0].mode).toBe("0");
    const ordinaryPreparations = ordinaryDispatches[0].traces.filter(
      (trace) => trace.event === "fork_prepared",
    );
    expect(ordinaryPreparations).toHaveLength(1);
    expect(ordinaryPreparations[0].fields.get("memory_identity"))
      .toBe("distinct");
    expect(ordinaryPreparations[0].fields.get("live_memory_delta")).toBe("1");

    const sideDispatches = partitionForkDispatches(runs[2]);
    expect(sideDispatches).toHaveLength(2);
    for (const dispatch of sideDispatches) {
      const sequence = requireCompleteVforkSequence(dispatch);
      assertPrivatePreparationEvidence(sequence.preparation);
    }
  }, 75_000);

  it("contains a real Worker factory failure after the borrow boundary", () => {
    const output = execFileSync(
      "npx",
      ["tsx", join(testDir, "fixtures/vfork-start-failure-runner.ts")],
      {
        cwd: join(testDir, ".."),
        encoding: "utf8",
        env: {
          ...process.env,
          KERNEL_SYSCALL_LOG: "1",
          KANDELO_TEST_VFORK_WORKER_START_FAILURE: "once",
        },
        timeout: 60_000,
      },
    );
    const runs = parseMechanismTraceRuns(output);
    expect(runs.map((run) => run.name)).toEqual(["start-failure"]);
    const dispatches = partitionForkDispatches(runs[0]);
    expect(dispatches).toHaveLength(1);
    const failureSequence = requireVforkStartFailureSequence(dispatches[0]);
    assertPrivatePreparationEvidence(failureSequence.preparation);
    const resultLine = output.split(/\r?\n/).find((line) =>
      line.startsWith("VFORK_START_FAILURE_RESULT ")
    );
    expect(resultLine).toBeDefined();
    const result = JSON.parse(
      resultLine!.slice("VFORK_START_FAILURE_RESULT ".length),
    ) as {
      exitCode: number;
      stdout: string;
      stderr: string;
      diagnostics: Array<{ status?: number; source: string; message: string }>;
    };
    expect(result.exitCode).toBe(139);
    expect(result.stdout).not.toContain("PARENT_RESUME_ONE");
    expect(result.stderr).toBe("");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      status: 139,
      source: "vfork address-space containment",
    });
    expect(result.diagnostics[0].message).toContain(
      "injected vfork Worker constructor failure",
    );
  }, 75_000);
});
