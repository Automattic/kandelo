import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..");

function source(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

/** The single implementation both entries call for shared lifecycle logic. */
const sharedLifecycle = source("host/src/process-lifecycle.ts");

/**
 * Slice one top-level function's body out of an entry file.
 *
 * `nextName` is optional and only narrows the slice further. The default
 * bound is the entry's own structure — the next declaration at column 0 —
 * because naming a neighbouring function couples this assertion to code it
 * is not testing: moving that neighbour (for instance into
 * `host/src/process-lifecycle.ts`) silently turns the slice into `-1` and
 * fails a test whose subject has not changed at all.
 */
function functionSource(
  text: string,
  startName: string,
  nextName?: string,
): string {
  const start = text.indexOf(startName);
  expect(start, `missing ${startName}`).toBeGreaterThanOrEqual(0);
  const bodyStart = start + startName.length;
  let end: number;
  if (nextName !== undefined) {
    end = text.indexOf(nextName, bodyStart);
    expect(end, `missing ${nextName} after ${startName}`).toBeGreaterThan(start);
  } else {
    // Bound at the next declaration written at the SAME indent as this one.
    // Anchoring to the start marker's own indent is what lets the same helper
    // slice a top-level entry function and a function inside
    // `createProcessLifecycle`, without a two-space-indented `const` in a
    // body ending the slice early.
    const indent = /^ */.exec(startName)![0];
    const next = text.slice(bodyStart).search(
      new RegExp(
        "\\n" + indent
        + "(?:export )?(?:async )?(?:function|const|let|class|interface|type) ",
      ),
    );
    end = next === -1 ? text.length : bodyStart + next;
    expect(end, `no declaration follows ${startName}`).toBeGreaterThan(start);
  }
  return text.slice(start, end);
}

describe.each([
  ["Node", "host/src/node-kernel-worker-entry.ts"],
  ["browser", "host/src/browser-kernel-worker-entry.ts"],
])("%s externref process ownership", (_host, relativePath) => {
  const entry = source(relativePath);

  it("replaces PID-stable authority only in the committed exec transition", () => {
    // Bounded structurally, not by naming whichever declaration follows:
    // `handlePosixSpawnResolve` moved into `host/src/process-lifecycle.ts`,
    // which would have turned this slice into `-1` and failed a test whose
    // subject — the exec transition — did not change.
    const exec = functionSource(entry, "async function handleExec(");
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
    // `handleClone` is one implementation in `host/src/process-lifecycle.ts`
    // serving both hosts, so it is sliced from there. That makes this
    // assertion stronger, not weaker: a pthread worker can no longer be given
    // the right generation on one host's clone path and the wrong one — or
    // none — on the other's. Both entries are still required to bind it, so
    // sharing the function cannot read as deleting it.
    expect(
      entry.includes("  handleClone,\n") && entry.includes("} = lifecycle;"),
      `${relativePath} must bind handleClone from ./process-lifecycle`,
    ).toBe(true);
    const clone = functionSource(sharedLifecycle, "  async function handleClone(");
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
    // `finishProcessExit` is one implementation in
    // `host/src/process-lifecycle.ts` serving both hosts, so it is sliced from
    // there. That makes this assertion stronger, not weaker: the release can no
    // longer be present on one host's exit path and missing on the other's.
    const exit = functionSource(
      sharedLifecycle,
      "  async function finishProcessExit(",
      "  async function awaitFinalizedProcessTeardown(",
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
