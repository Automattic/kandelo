import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..");

function source(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function functionSource(
  text: string,
  startName: string,
  nextName: string,
): string {
  const start = text.indexOf(startName);
  const end = text.indexOf(nextName, start + startName.length);
  expect(start, `missing ${startName}`).toBeGreaterThanOrEqual(0);
  expect(end, `missing ${nextName} after ${startName}`).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe.each([
  ["Node", "host/src/node-kernel-worker-entry.ts"],
  ["browser", "host/src/browser-kernel-worker-entry.ts"],
])("%s externref process ownership", (_host, relativePath) => {
  const entry = source(relativePath);

  it("replaces PID-stable authority only in the committed exec transition", () => {
    const exec = functionSource(
      entry,
      "async function handleExec(",
      "async function handlePosixSpawnResolve(",
    );
    const commit = exec.indexOf(
      "kernelWorker.prepareProcessForExec(pid, initiatingInfo.memory)",
    );
    const replace = exec.indexOf(
      "externrefProcessOwner.replaceGeneration(",
      commit,
    );
    const replacementInit = exec.indexOf(
      "externrefGenerationId: replacementExternrefGeneration.id",
      replace,
    );

    expect(commit).toBeGreaterThanOrEqual(0);
    expect(replace).toBeGreaterThan(commit);
    expect(replacementInit).toBeGreaterThan(replace);
  });

  it("gives pthread Workers the main process image generation", () => {
    const clone = functionSource(
      entry,
      "async function handleClone(",
      "function handleThreadExit(",
    );
    expect(clone).toContain(
      "externrefGenerationId: processInfo.externrefGeneration.id",
    );
  });

  it("releases owner generations on exit, explicit terminate, and destroy", () => {
    const release =
      "externrefProcessOwner.releaseGeneration(info.externrefGeneration)";
    const terminateStart = relativePath.includes("browser")
      ? "async function handleTerminateProcess("
      : "async function handleTerminate(";
    const exit = functionSource(
      entry,
      "async function finishProcessExit(",
      terminateStart,
    );
    const destroyStart = "async function handleDestroy(";
    const terminate = functionSource(entry, terminateStart, destroyStart);
    const performDestroy = functionSource(
      entry,
      "async function performDestroy(",
      destroyStart,
    );
    const destroy = entry.slice(entry.indexOf(destroyStart));

    expect(exit).toContain(release);
    expect(terminate).toContain(release);
    expect(performDestroy).toContain(release);
    expect(destroy).toContain("performDestroy");
  });
});
