import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..");

/**
 * Slice `handleOrdinaryFork` out of `host/src/process-lifecycle.ts`.
 *
 * It is one implementation serving both hosts now, so the replay-gate
 * transaction is checked once. That is stronger than checking two copies: the
 * gate can no longer be committed in the right order on one host and the
 * wrong order on the other. `expectEntryProvides` below keeps each entry on
 * the hook for actually binding it, so sharing cannot read as deleting.
 *
 * Bounded by the next declaration at the module's own two-space indent,
 * rather than by naming whichever function happens to follow.
 */
function ordinaryForkHandlerSource(_relativePath: string): string {
  const source = readFileSync(
    join(repoRoot, "host/src/process-lifecycle.ts"),
    "utf8",
  );
  const startName = "  async function handleOrdinaryFork(";
  const start = source.indexOf(startName);
  expect(start, "process-lifecycle.ts must define handleOrdinaryFork")
    .toBeGreaterThanOrEqual(0);
  const bodyStart = start + startName.length;
  const next = source.slice(bodyStart).search(
    /\n  (?:async )?(?:function|const|let|class|interface|type) /,
  );
  const end = next === -1 ? source.length : bodyStart + next;
  expect(end, "a declaration must follow handleOrdinaryFork")
    .toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Each entry must still bind the shared handler it delegates forks to. */
function expectEntryProvides(relativePath: string): void {
  const entry = readFileSync(join(repoRoot, relativePath), "utf8");
  expect(
    entry.includes("  handleOrdinaryFork,\n")
    && entry.includes("} = lifecycle;"),
    `${relativePath} must bind handleOrdinaryFork from ./process-lifecycle`,
  ).toBe(true);
}

describe.each([
  ["Node", "host/src/node-kernel-worker-entry.ts"],
  ["browser", "host/src/browser-kernel-worker-entry.ts"],
])("%s fork replay launch transaction", (_host, relativePath) => {
  it("binds the shared ordinary-fork launch", () => {
    expectEntryProvides(relativePath);
  });

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
    // `host.` prefixed: the shared module reaches the owner registry through
    // the declared host record rather than a module-level binding.
    const grant = handler.indexOf(
      "host.externrefProcessOwner\n        .forkGenerationFromContinuation(",
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
      "host.externrefProcessOwner.releaseGeneration(childExternrefGeneration)",
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
