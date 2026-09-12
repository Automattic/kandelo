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

/** `asyncFunction` for the shared module, whose functions are indented. */
function indentedAsyncFunction(
  source: string,
  name: string,
): string {
  const startName = `  async function ${name}(`;
  const start = source.indexOf(startName);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  // Bounded by the module's own structure — the next declaration at the same
  // two-space indent — rather than by naming whichever function follows.
  // Naming a neighbour couples this assertion to code it is not testing:
  // moving that neighbour turns the slice into `-1` and fails a test whose
  // subject has not changed.
  const bodyStart = start + startName.length;
  const next = source.slice(bodyStart).search(
    /\n  (?:async )?(?:function|const|let|class|interface|type) /,
  );
  const end = next === -1 ? source.length : bodyStart + next;
  expect(end, `no declaration follows ${name}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("process generation detach host parity", () => {
  for (const { host, source, terminate } of entries) {
    it(`${host} routes every process-generation terminal path through the shared ledger`, () => {
      // `handleSpawn`, `handleOrdinaryFork`, `handleVfork` and
      // `handlePosixSpawn` are one implementation each in the shared
      // lifecycle module now, so each is sliced from there. That is stronger
      // than checking two copies: a construction path can no longer route
      // through the ledger on one host and bypass it on the other. Each entry
      // must still bind them, which the loop below requires.
      for (const name of [
        "handleSpawn",
        "handleOrdinaryFork",
        "handleVfork",
        "handlePosixSpawn",
      ]) {
        expect(
          source.includes(`  ${name},\n`) && source.includes("} = lifecycle;"),
          `${host} must bind ${name} from ./process-lifecycle`,
        ).toBe(true);
      }
      const lifecycleSurfaces = [
        indentedAsyncFunction(sharedLifecycle, "handleSpawn"),
        indentedAsyncFunction(sharedLifecycle, "handlePosixSpawn"),
        indentedAsyncFunction(sharedLifecycle, "handleOrdinaryFork"),
        indentedAsyncFunction(sharedLifecycle, "handleVfork"),
        // `finishProcessExit` is one implementation in the shared lifecycle
        // module now; slicing it from there means the ledger route cannot be
        // present on one host's exit path and missing on the other's.
        indentedAsyncFunction(sharedLifecycle, "finishProcessExit"),
        asyncFunction(source, terminate, "performDestroy"),
      ];

      for (const surface of lifecycleSurfaces) {
        expect(surface).toContain("detachExactProcessGeneration({");
      }
      const destroy = destroyFunction(source);
      expect(destroy).toMatch(
        /processMemoryCreators\.closeAndRunAfterDrain\(\s*performDestroy\s*,?\s*\)/,
      );
      // The retry sweep is one implementation now, so the entry is asserted
      // to reach it and the sweep itself is asserted where it lives. A
      // destroy that never retried a pending detach would still fail this.
      expect(destroy).toContain("reportRetainedDestroyDetaches()");
      expect(sharedLifecycle).toContain(
        "processGenerationDetaches.retryPending()",
      );
      // Same shape: the entry must reach the shared settle, which is where
      // the allocator is actually released.
      expect(destroy).toContain("settleDestroyedRealmAllocator(");
      expect(sharedLifecycle).toContain(
        "host.processMemoryAllocator().clear()",
      );
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
      const spawn = indentedAsyncFunction(sharedLifecycle, "handleSpawn");
      expect(spawn).toContain("let createdGeneration: Info | undefined");
      expect(spawn).toContain("generation = createdGeneration ??");
      for (const name of ["handleOrdinaryFork", "handlePosixSpawn"]) {
        const rollback = indentedAsyncFunction(sharedLifecycle, name);
        expect(rollback).toContain("let childGeneration: Info | undefined");
        expect(rollback).toContain("generation = childGeneration ??");
      }

      // Every callback that can expose a process Memory to a new process or
      // pthread Worker must enter the same destroy admission gate. The
      // callback record is one implementation in
      // `host/src/process-lifecycle.ts` now, so this is checked once: a gate
      // can no longer be present on one host's callbacks and absent from the
      // other's. The entry is still required to take that record.
      expect(
        source,
        `${host} entry must spread the shared callback record`,
      ).toContain("...processLifecycleKernelCallbacks(),");
      // Four of the five reach the kernel through that record.
      for (const operation of [
        "a fork process Worker",
        "an exec process Worker",
        "a posix_spawn process Worker",
        "a pthread Worker",
      ]) {
        expect(sharedLifecycle).toContain(`"${operation}"`);
      }
      // Four admissions through the gate's scoped form — fork takes two, one
      // per mode — plus exec, which holds the admission across its two-phase
      // launch plan and so acquires it explicitly.
      expect(
        sharedLifecycle.match(
          /processMemoryCreators\s*\.run(?:UntilCommitted)?\(/g,
        ),
      ).toHaveLength(4);
      expect(
        sharedLifecycle.match(/processMemoryCreators\s*\.acquire\(/g),
      ).toHaveLength(1);
      // The fifth is a `spawn` message from main, which arrives at the entry
      // rather than through a kernel callback, so it stays the entry's to
      // admit — and each entry must still admit it.
      expect(source).toContain('"a host-spawned process Worker"');
      expect(
        source.match(/processMemoryCreators\s*\.run(?:UntilCommitted)?\(/g),
      ).toHaveLength(1);
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

  it("posix_spawn rollback owns the exact allocated memory identity", () => {
    // Was browser-only, because only the browser's copy had named its
    // allocation `newMemory` and awaited the host alias release. With one
    // implementation the subject is what it always was: the rollback detaches
    // the generation it actually allocated, and clears whatever host-side
    // alias of that Memory the host still holds — which is where the browser's
    // framebuffer release now lives, behind `releaseGenerationAliases`.
    const handler = indentedAsyncFunction(sharedLifecycle, "handlePosixSpawn");
    expect(handler).toContain("const generation = childGeneration ?? { memory, memoryLease }");
    expect(handler).toContain(
      "host.releaseGenerationAliases(childPid, childGeneration)",
    );
    expect(handler).not.toContain(
      "kernelWorker.deactivateProcess(childPid, memory)",
    );
  });
});
