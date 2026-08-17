import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..");

function ordinaryForkHandlerSource(relativePath: string): string {
  const path = join(repoRoot, relativePath);
  const source = readFileSync(path, "utf8");
  const start = source.indexOf("async function handleOrdinaryFork(");
  const end = source.indexOf("\nasync function handleExec(", start);
  expect(start, `${relativePath} must define handleOrdinaryFork`)
    .toBeGreaterThanOrEqual(0);
  expect(end, `${relativePath} must define handleExec after handleOrdinaryFork`)
    .toBeGreaterThan(start);
  return source.slice(start, end);
}

describe.each([
  ["Node", "host/src/node-kernel-worker-entry.ts"],
  ["browser", "host/src/browser-kernel-worker-entry.ts"],
])("%s fork replay launch transaction", (_host, relativePath) => {
  it("waits for the exact child generation before committing and resolving", () => {
    const handler = ordinaryForkHandlerSource(relativePath);
    const wait = handler.indexOf("await forkReplay.waitUntilReady()");
    const generationCheck = handler.indexOf(
      "processes.get(childPid)?.worker !== launchedWorker",
      wait,
    );
    const commit = handler.indexOf("forkReplay.commit()", generationCheck);
    const resolve = handler.lastIndexOf("return [childChannelOffset]");

    expect(handler).toContain("forkReplayGate: forkReplay.gate");
    expect(handler).toContain("observeForkReplayWorker(");
    expect(wait).toBeGreaterThanOrEqual(0);
    expect(generationCheck).toBeGreaterThan(wait);
    expect(commit).toBeGreaterThan(generationCheck);
    expect(resolve).toBeGreaterThan(commit);
  });

  it("cancels both a deferred launch and the rollback path", () => {
    const handler = ordinaryForkHandlerSource(relativePath);
    const launchGate = handler.indexOf("startProcessWorkerWhenRunnable(");
    const launchCancellation = handler.indexOf("forkReplay.cancel(", launchGate);
    const rollback = handler.indexOf("} catch (error)");
    const rollbackCancellation = handler.indexOf("forkReplay.cancel(error)", rollback);

    expect(launchGate).toBeGreaterThanOrEqual(0);
    expect(launchCancellation).toBeGreaterThan(launchGate);
    expect(launchCancellation).toBeLessThan(rollback);
    expect(rollbackCancellation).toBeGreaterThan(rollback);
    expect(
      handler.indexOf(
        "await terminateTrackedWorker(childWorker)",
        rollbackCancellation,
      ),
    )
      .toBeGreaterThan(rollbackCancellation);
  });

  it("grants the exact copied externref graph before launch and retires rollback", () => {
    const handler = ordinaryForkHandlerSource(relativePath);
    const grant = handler.indexOf(
      "externrefProcessOwner.forkGenerationFromContinuation(",
    );
    const childInit = handler.indexOf(
      "const childInitData: CentralizedWorkerInitMessage",
      grant,
    );
    const start = handler.indexOf("startProcessWorkerWhenRunnable(", childInit);
    const rollback = handler.indexOf("} catch (error)", start);
    const terminate = handler.indexOf(
      "await terminateTrackedWorker(childWorker)",
      rollback,
    );
    const release = handler.indexOf(
      "externrefProcessOwner.releaseGeneration(childExternrefGeneration)",
      rollback,
    );

    expect(grant).toBeGreaterThanOrEqual(0);
    expect(childInit).toBeGreaterThan(grant);
    expect(handler.slice(childInit, start)).toContain(
      "externrefGenerationId: externrefGrant.generation.id",
    );
    expect(start).toBeGreaterThan(childInit);
    expect(handler.slice(grant, childInit)).toContain(
      "childExternrefGeneration = externrefGrant.generation",
    );
    expect(terminate).toBeGreaterThan(rollback);
    expect(release).toBeGreaterThan(terminate);
  });
});
