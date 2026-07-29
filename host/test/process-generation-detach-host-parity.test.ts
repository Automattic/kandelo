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

function destroyFunction(source: string): string {
  const start = source.indexOf("async function handleDestroy(");
  const end = source.indexOf("\nfunction handlePtyWrite(", start);
  expect(start, "handleDestroy must exist").toBeGreaterThanOrEqual(0);
  expect(end, "handlePtyWrite must follow handleDestroy").toBeGreaterThan(
    start,
  );
  return source.slice(start, end);
}

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
        asyncFunction(source, terminate, "handleDestroy"),
      ];

      for (const surface of lifecycleSurfaces) {
        expect(surface).toContain("detachExactProcessGeneration({");
      }
      const destroy = destroyFunction(source);
      expect(destroy).toContain("processGenerationDetaches.retryPending()");
      expect(destroy).not.toContain("processes.clear()");
      // The outer kernel Worker can be a safe final containment boundary only
      // after it has explicitly terminated every process Worker and the
      // process-owned pthread Workers nested beneath it.
      expect(destroy).toContain("terminateThreadWorkers(pid)");
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
    });

    it(`${host} keeps exact kernel detach calls inside the shared wrapper`, () => {
      // One exact deactivate and one exact unregister belong to the wrapper.
      // The second unregister is the intentional no-generation case for a PID
      // absent from the host map.
      expect(source.match(/kernelWorker\.deactivateProcess\(/g)).toHaveLength(
        1,
      );
      expect(source.match(/kernelWorker\.unregisterProcess\(/g)).toHaveLength(
        2,
      );
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
