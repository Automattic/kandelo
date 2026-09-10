import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const entries = [
  {
    host: "Node",
    source: readFileSync(
      join(repoRoot, "host/src/node-kernel-worker-entry.ts"),
      "utf8",
    ),
    terminate: "handleTerminate",
  },
  {
    host: "browser",
    source: readFileSync(
      join(repoRoot, "host/src/browser-kernel-worker-entry.ts"),
      "utf8",
    ),
    terminate: "handleTerminateProcess",
  },
] as const;

function asyncFunction(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf(`\nasync function ${nextName}(`, start);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  expect(end, `${nextName} must follow ${name}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/**
 * Slice `performDestroy` out of an entry file.
 *
 * Bounded by the entry's own structure — the next declaration at column 0 —
 * rather than by naming whichever function follows. Naming a neighbour couples
 * this assertion to code it is not testing: moving that neighbour (for
 * instance into `host/src/process-lifecycle.ts`) silently turns the slice into
 * `-1` and fails a test whose subject has not changed.
 */
function destroyFunction(source: string): string {
  const start = source.indexOf("async function performDestroy(");
  expect(start, "performDestroy must exist").toBeGreaterThanOrEqual(0);
  // The destroy surface is `performDestroy` plus its caller `handleDestroy`,
  // which is where the admission gate wrapping the two lives. Bound the slice
  // at the declaration following `handleDestroy` rather than at whichever
  // function happens to sit after it.
  const caller = "async function handleDestroy(";
  const callerStart = source.indexOf(caller, start);
  expect(callerStart, "handleDestroy must follow performDestroy")
    .toBeGreaterThan(start);
  const bodyStart = callerStart + caller.length;
  const next = source.slice(bodyStart).search(
    /\n(?:export )?(?:async )?(?:function|const|let|class|interface|type) /,
  );
  const end = next === -1 ? source.length : bodyStart + next;
  return source.slice(start, end);
}

/**
 * The shared lifecycle module both entries delegate to. The exact-detach
 * wrapper lives here now, so the "no ad-hoc detach calls" invariant is checked
 * across an entry and this module together.
 */
const sharedLifecycle = readFileSync(
  join(repoRoot, "host/src/process-lifecycle.ts"),
  "utf8",
);

describe("process generation detach host parity", () => {
  for (const { host, source, terminate } of entries) {
    it(`${host} routes every process-generation terminal path through the shared ledger`, () => {
      const spawn = asyncFunction(source, "handleSpawn", "handleFork");
      const fork = asyncFunction(source, "handleFork", "handleExec");
      const posixSpawn = asyncFunction(
        source,
        "handlePosixSpawn",
        "handleClone",
      );
      const lifecycleSurfaces = [
        spawn,
        fork,
        posixSpawn,
        asyncFunction(source, "finishProcessExit", terminate),
        asyncFunction(source, terminate, "performDestroy"),
      ];

      for (const surface of lifecycleSurfaces) {
        expect(surface).toContain("detachExactProcessGeneration({");
      }
      const destroy = destroyFunction(source);
      expect(destroy).toMatch(
        /processMemoryCreators\.closeAndRunAfterDrain\(\s*performDestroy\s*,?\s*\)/,
      );
      expect(destroy).toContain("processGenerationDetaches.retryPending()");
      expect(destroy).toContain("processMemoryAllocator.clear()");
      expect(destroy).not.toContain("processes.clear()");
      // The outer kernel Worker can be a safe final containment boundary only
      // after it has explicitly terminated every process Worker and the
      // process-owned pthread Workers nested beneath it.
      // Arguments beyond the PID (the browser passes a post-termination
      // settle delay) are not this assertion's subject; that every thread
      // Worker is explicitly torn down is.
      expect(destroy).toMatch(/terminateThreadWorkers\(\s*pid\b/);
      expect(destroy).toContain("terminateTrackedWorker(info.worker");
      expect(destroy).toContain(
        "kernelRealmDestroyResult(gracefulDetachComplete)",
      );
      // WHY: Worker termination yields. Keep the installed object itself,
      // rather than looking the PID up afterward and accidentally retiring an
      // exec successor that appeared during the await.
      expect(spawn).toContain("let createdGeneration: ProcessInfo | undefined");
      expect(spawn).toContain("generation = createdGeneration ??");
      for (const rollback of [fork, posixSpawn]) {
        expect(rollback).toContain(
          "let childGeneration: ProcessInfo | undefined",
        );
        expect(rollback).toContain("generation = childGeneration ??");
      }

      // Every callback that can expose a process Memory to a new process or
      // pthread Worker must enter the same destroy admission gate.
      for (const operation of [
        "a host-spawned process Worker",
        "a fork process Worker",
        "an exec process Worker",
        "a posix_spawn process Worker",
        "a pthread Worker",
      ]) {
        expect(source).toContain(`"${operation}"`);
      }
      expect(
        source.match(/processMemoryCreators\s*\.run(?:UntilCommitted)?\(/g),
      ).toHaveLength(5);
    });

    it(`${host} keeps exact kernel detach calls inside the shared wrapper`, () => {
      // The exact-detach wrapper moved into `host/src/process-lifecycle.ts`,
      // which strengthens this invariant rather than weakening it: the pair of
      // kernel detach calls now exists ONCE for both hosts instead of once per
      // entry. So an entry must retain only the intentional no-generation
      // unregister — the case for a PID absent from the host map — and no
      // deactivate at all.
      expect(source.match(/kernelWorker\.deactivateProcess\(/g)).toBeNull();
      expect(source.match(/kernelWorker\.unregisterProcess\(/g)).toHaveLength(
        1,
      );
      // ...and the wrapper itself holds exactly one of each, so no third path
      // can reach the kernel's detach surface unmediated.
      expect(
        sharedLifecycle.match(/host\.kernel\(\)\.deactivateProcess\(/g),
      ).toHaveLength(1);
      expect(
        sharedLifecycle.match(/host\.kernel\(\)\.unregisterProcess\(/g),
      ).toHaveLength(1);
      expect(source).not.toMatch(
        /processes\.delete\((?:createdPid|childPid)\)/,
      );
    });
  }

  it("browser posix_spawn rollback owns the allocated newMemory identity", () => {
    const browser = entries[1].source;
    const handler = asyncFunction(browser, "handlePosixSpawn", "handleClone");
    expect(handler).toContain("memory: newMemory");
    expect(handler).toContain(
      "releaseMainFramebufferGeneration(childPid, childGeneration)",
    );
    expect(handler).not.toContain(
      "kernelWorker.deactivateProcess(childPid, memory)",
    );
  });
});
