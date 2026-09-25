import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..");

/**
 * Slice `handleOrdinaryFork` out of `host/src/process-lifecycle.ts`.
 *
 * It is one implementation serving both hosts now, so the launch
 * transaction is checked once. That is stronger than checking two copies: the
 * launch can no longer be observed in the right order on one host and the
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

/**
 * Each entry must still route the kernel's fork callback into the shared
 * lifecycle. That route is `processLifecycleKernelCallbacks()`, whose `onFork`
 * calls `handleFork` and so `handleOrdinaryFork`, spread into the kernel
 * worker's callbacks. It used to be checked by the entry destructuring
 * `handleOrdinaryFork` itself, which neither entry calls: the name was bound
 * and never read, so the check held whether or not forks reached the handler.
 */
function expectEntryProvides(relativePath: string): void {
  const entry = readFileSync(join(repoRoot, relativePath), "utf8");
  expect(
    entry.includes("  processLifecycleKernelCallbacks,\n")
    && entry.includes("} = lifecycle;")
    && entry.includes("...processLifecycleKernelCallbacks(),"),
    `${relativePath} must route the kernel's fork callback through ` +
      "processLifecycleKernelCallbacks() from ./process-lifecycle",
  ).toBe(true);
}

describe.each([
  ["Node", "host/src/node-kernel-worker-entry.ts"],
  ["browser", "host/src/browser-kernel-worker-entry.ts"],
])("%s kernel-completed fork launch", (_host, relativePath) => {
  it("routes the kernel fork callback into the shared ordinary-fork launch", () => {
    expectEntryProvides(relativePath);
  });

  it("observes the launch before the ordinary listeners and waits for the kernel", () => {
    const handler = ordinaryForkHandlerSource(relativePath);
    const observe = handler.indexOf("observeForkLaunchWorker(");
    const listeners = handler.indexOf("host.installProcessWorkerListeners(");
    const wait = handler.indexOf(
      "await Promise.race([launchDecided, launchFailure])",
    );
    const resolve = handler.lastIndexOf("return [childChannelOffset]");

    // The observer must run first, so a Worker ending before the kernel
    // decided is a failed launch rather than an ordinary process death.
    expect(observe).toBeGreaterThanOrEqual(0);
    expect(listeners).toBeGreaterThan(observe);
    expect(wait).toBeGreaterThan(listeners);
    expect(resolve).toBeGreaterThan(wait);
    // No host-side gate commits the child any more: the kernel does.
    expect(handler).not.toContain("forkReplayGate");
    expect(handler).not.toContain(".commit()");
  });

  it("rolls a failed launch back and hands it to the kernel", () => {
    const handler = ordinaryForkHandlerSource(relativePath);
    const rollback = handler.indexOf("} catch (error)");
    const terminate = handler.indexOf(
      "await terminateTrackedWorker(childWorker)",
      rollback,
    );
    const rethrow = handler.indexOf("throw error;", terminate);

    expect(rollback).toBeGreaterThanOrEqual(0);
    expect(terminate).toBeGreaterThan(rollback);
    expect(rethrow).toBeGreaterThan(terminate);
  });
});
