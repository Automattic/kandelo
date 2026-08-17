import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const nodeEntry = readFileSync(
  join(repoRoot, "host/src/node-kernel-worker-entry.ts"),
  "utf8",
);

function functionSource(name: string, nextName: string): string {
  const start = nodeEntry.indexOf(`async function ${name}(`);
  const end = nodeEntry.indexOf(`\nfunction ${nextName}(`, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return nodeEntry.slice(start, end);
}

describe("Node process Worker teardown ordering", () => {
  it("does not diagnose a naturally closed Worker during semantic exit teardown", () => {
    const start = nodeEntry.indexOf("function installCrashSafetyNet(");
    const end = nodeEntry.indexOf(
      "\nfunction installProcessWorkerListeners(",
      start,
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const safetyNet = nodeEntry.slice(start, end);
    const inFlightGuard = safetyNet.indexOf("processTeardowns.has(worker)");
    const crashDiagnostic = safetyNet.indexOf("reportHostDiagnostic");

    expect(inFlightGuard).toBeGreaterThanOrEqual(0);
    expect(inFlightGuard).toBeLessThan(crashDiagnostic);
  });

  it("does not let a trailing Worker event overtake an in-flight kernel exit teardown", () => {
    const finalize = functionSource(
      "finalizeProcessWorker",
      "processWorkerErrorDisposition",
    );
    const inFlightGuard = finalize.indexOf("processTeardowns.has(worker)");
    const crashNotification = finalize.indexOf("kernelWorker.notifyHostProcessCrashed");
    const sharedTeardown = finalize.indexOf(
      'await finishProcessExit(pid, exitStatus, worker, "trap")',
    );

    expect(inFlightGuard).toBeGreaterThanOrEqual(0);
    expect(finalize).toMatch(
      /if \(processTeardowns\.has\(worker\)\) \{\s*reportProcessExit\(pid, exitStatus\);\s*return;\s*\}/s,
    );
    expect(inFlightGuard).toBeLessThan(crashNotification);
    expect(inFlightGuard).toBeLessThan(sharedTeardown);
    expect(crashNotification).toBeLessThan(sharedTeardown);
  });
});
