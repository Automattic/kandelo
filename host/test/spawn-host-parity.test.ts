/**
 * Spawn host-parity test — structural check that both the Node and the
 * Browser kernel-worker entry points wire `onSpawn` to a
 * `handlePosixSpawn` function.
 *
 * Per CLAUDE.md's two-hosts policy, every fork/exec/clone/spawn change
 * needs parallel browser implementations or we ship Node-only fixes
 * that leave the browser broken (PR #388 brk-base ratchet was the most
 * recent example of that class).
 *
 * The Node-side end-to-end coverage lives in `centralized-spawn.test.ts`;
 * the Browser-side end-to-end coverage rides on the existing shell-demo
 * Playwright tests (which exercise dash + coreutils via posix_spawn).
 * Neither of those would catch a silent removal of the browser
 * `onSpawn` wire — the shell demo would just fall back to fork+exec
 * and look like it works. This test pins the wiring at the source
 * level so the regression surfaces at PR-build time.
 *
 * Future work (tracked in `docs/architecture.md` under SYS_SPAWN):
 *   * Plumb a fork-count read into BrowserKernel so a browser-side
 *     vitest can assert spawn doesn't fall back to fork (mirroring the
 *     Node centralized-spawn.test.ts guardrail).
 *   * Add a non-@slow Playwright test that runs a spawn-smoke
 *     equivalent on the simple browser page once VFS pre-staging is
 *     wired through main.ts.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

const nodeEntry = join(repoRoot, "host", "src", "node-kernel-worker-entry.ts");
const browserEntry = join(repoRoot, "host", "src", "browser-kernel-worker-entry.ts");
const sharedWorker = join(repoRoot, "host", "src", "kernel-worker.ts");
const sharedExecTarget = join(repoRoot, "host", "src", "exec-target.ts");
const sharedLifecycle = join(repoRoot, "host", "src", "process-lifecycle.ts");

/**
 * Slice one function out of `host/src/process-lifecycle.ts`.
 *
 * The launch family now has ONE implementation, so these invariants are
 * checked once rather than twice — which is strictly stronger: an invariant
 * can no longer hold in one host's copy while being absent from the other's.
 * Each such assertion is still paired with `expectEntryProvides` on both
 * entries, so sharing a function cannot read as deleting it.
 *
 * Bounded by the next declaration at the module's own two-space indent,
 * rather than by naming whichever function happens to follow.
 */
function sharedFunctionSource(name: string): string {
  const src = readFileSync(sharedLifecycle, "utf8");
  const opening = new RegExp(
    String.raw`\n  (?:async )?function ` + name + String.raw`\(`,
  );
  const m = opening.exec(src);
  expect(m, `process-lifecycle.ts must declare ${name}`).not.toBeNull();
  const start = m!.index;
  const bodyStart = start + m![0].length;
  const next = src.slice(bodyStart).search(
    /\n  (?:async )?(?:function|const|let|class|interface|type) /,
  );
  const end = next === -1 ? src.length : bodyStart + next;
  return src.slice(start, end);
}

/**
 * Assert an entry has `name` in scope — either declared there, or bound from
 * `host/src/process-lifecycle.ts`, the single implementation both entries
 * call.
 *
 * The subject is that the symbol the spawn wiring references exists, not
 * which file declares it. Sharing a function between the two hosts is the
 * outcome this campaign wants; it must not read as a deletion.
 */
function expectEntryProvides(src: string, path: string, name: string): void {
  const declared = new RegExp(
    String.raw`\b(?:async\s+)?function\s+` + name + String.raw`\s*\(`,
  ).test(src);
  const bound = new RegExp(String.raw`^\s*` + name + String.raw`,\s*$`, "m")
    .test(src) && src.includes("} = lifecycle;");
  expect(
    declared || bound,
    path + " must define " + name + " or bind it from ./process-lifecycle",
  ).toBe(true);
}

function posixSpawnHandlerSource(): string {
  return sharedFunctionSource("handlePosixSpawn");
}

function ordinaryForkHandlerSource(): string {
  return sharedFunctionSource("handleOrdinaryFork");
}

function execHandlerSource(src: string): string {
  const start = src.indexOf("async function handleExec(");
  const end = src.indexOf("\n/**\n * Pre-flight resolver", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

function cloneHandlerSource(): string {
  return sharedFunctionSource("handleClone");
}

/**
 * Slice one top-level function's body out of an entry file.
 *
 * Bounded by the entry's own structure — the next declaration at column 0 —
 * rather than by naming whichever function happens to follow. Naming a
 * neighbour couples this assertion to code it is not testing, so moving an
 * unrelated function (for instance into `host/src/process-lifecycle.ts`)
 * silently turns the slice into `-1` and fails a test that still holds.
 */
function topLevelFunctionSource(src: string, startName: string): string {
  const start = src.indexOf(startName);
  expect(start, `missing ${startName}`).toBeGreaterThanOrEqual(0);
  const bodyStart = start + startName.length;
  const next = src.slice(bodyStart).search(
    /\n(?:export )?(?:async )?(?:function|const|let|class|interface|type) /,
  );
  const end = next === -1 ? src.length : bodyStart + next;
  expect(end, `no declaration follows ${startName}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

function centralizedInitMessageSource(handler: string): string {
  const start = handler.indexOf("const initData: CentralizedWorkerInitMessage");
  expect(start).toBeGreaterThanOrEqual(0);
  const closing = handler.slice(start).match(/\n\s*};/);
  const end = closing?.index === undefined
    ? -1
    : start + closing.index + closing[0].length;
  expect(end).toBeGreaterThan(start);
  return handler.slice(start, end);
}

function spawnCallbackSource(src: string): string {
  const start = src.indexOf("onResolveSpawn:");
  const end = src.indexOf("\n      onClone:", start);
  expect(start, "onResolveSpawn callback must exist").toBeGreaterThanOrEqual(0);
  expect(end, "onClone callback must follow onSpawn").toBeGreaterThan(start);
  return src.slice(start, end);
}

function expectSpawnCallbacks(src: string, entry: string): void {
  const callbacks = spawnCallbackSource(src);
  expect(
    callbacks,
    `${entry} must wire onResolveSpawn to handlePosixSpawnResolve`,
  ).toMatch(/onResolveSpawn:\s*handlePosixSpawnResolve/);
  expect(
    callbacks,
    `${entry} must admit onSpawn through the creator gate`,
  ).toMatch(
    /onSpawn:.*processMemoryCreators\.run\(.*handlePosixSpawn\(/s,
  );
}

function expectDeadStartUsesOrdinaryTeardown(handler: string, entry: string): void {
  expect(
    handler,
    `${entry} must retry contention before ordinary lifecycle teardown`,
  ).toMatch(
    /const signal = await retryKernelEntryResult\(\s*\(\) => kernelWorker\.finalizePendingChildTermination\(childPid\),\s*\);\s*lifecycleTeardownStarted = true;\s*await awaitFinalizedProcessTeardown\(/s,
  );
  expect(
    handler,
    `${entry} must not roll back a lifecycle-owned generation`,
  ).toMatch(
    /catch \(error\) \{\s*if \(lifecycleTeardownStarted\) throw error;/s,
  );
}

describe("spawn host parity", () => {
  it("both exec callbacks carry one opaque prepared-target request", () => {
    const shared = readFileSync(sharedWorker, "utf8");
    expect(shared).toMatch(/onExec\?:\s*ExecLaunchCallback/);
    expect(shared).not.toMatch(
      /onExec\?:\s*\(\s*pid:\s*number,\s*path:\s*string,/s,
    );

    for (const entry of [nodeEntry, browserEntry]) {
      const source = readFileSync(entry, "utf8");
      expect(source, `${entry} must accept a target-shaped request`).toMatch(
        /onExec:\s*async\s*\(request\)\s*=>[\s\S]*handleExec\(request\)/,
      );
      expect(source, `${entry} must remove the Task 10 staging gate`).not.toContain(
        "preparedExecTargetReaderPending",
      );
      expect(source, `${entry} must not carry credential path authority`).not.toContain(
        "credentialPath",
      );
      const handler = execHandlerSource(source);
      expect(handler, `${entry} must source replacement bytes from the target request`)
        .toMatch(/targetBytes:\s*(?:programBytes|bytes)/);
      expect(handler, `${entry} must send only target-derived bytes to the Worker`)
        .toMatch(/(?:\bprogramBytes,|programBytes:\s*bytes,)/);
      expect(handler, `${entry} must not receive kernel commit authority`)
        .not.toMatch(/request\.commit\(\)|kernelExecCommit\(/);
      expect(
        handler,
        `${entry} must return a bounded postcommit launch action`,
      ).toContain("startAfterCommit");
      expect(handler, `${entry} must not resolve exec by path`).not.toMatch(
        /resolveExecutableForLaunch|resolveExec\(|execPrograms|execProgramBytes|readFileSync/,
      );
    }
    expect(
      readFileSync(sharedExecTarget, "utf8"),
      "the shared launcher must own the only target commit",
    )
      .toContain("options.commitTarget(");
  });

  it("both spawn adapters receive only the shared exact committed target", () => {
    const shared = readFileSync(sharedWorker, "utf8");
    const prepare = shared.indexOf("this.spawnExecTargetPrepare(");
    const commit = shared.indexOf("this.kernelSpawnExecCommit(");
    const launch = shared.indexOf("startAfterCommit: () => callback(");
    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(prepare);
    expect(launch).toBeGreaterThan(commit);
    expect(shared).toMatch(
      /programBytes:\s*request\.targetBytes,[\s\S]*programModule:\s*request\.targetModule/,
    );

    const handler = posixSpawnHandlerSource();
    expect(handler, "the launch must use the supplied committed module")
      .toContain("const { programBytes, programModule, argv } = program;");
    expect(handler, "the launch must not repeat candidate resolution").not
      .toMatch(
        /resolveExecutableForLaunch|handlePosixSpawnResolve|execPrograms|readExecFromVfs/,
      );
    expect(
      handler,
      "the launch must consume the secure-exec state captured by commit",
    ).toContain("kernelWorker.takeCommittedExecSecureExec(childPid)");
    expect(
      handler,
      "the launch must not re-enter the kernel after the spawn commit",
    ).not.toContain("kernelWorker.processSecureExec(childPid)");
    for (const entry of [nodeEntry, browserEntry]) {
      expectEntryProvides(readFileSync(entry, "utf8"), entry, "handlePosixSpawn");
    }
  });

  it("both spawn adapters check child liveness only after allocation yields", () => {
    const handler = posixSpawnHandlerSource();
    const allocation = handler.indexOf("createFreshProcessMemory(");
    const liveness = handler.indexOf("shouldLaunchPendingChild(childPid)");
    const registration = handler.indexOf("registerProcess(childPid");
    expect(
      handler.match(/shouldLaunchPendingChild\(childPid\)/g) ?? [],
      "the launch must retain exactly one post-allocation liveness fence",
    ).toHaveLength(1);
    expect(allocation, "the launch must allocate process memory")
      .toBeGreaterThanOrEqual(0);
    expect(
      liveness,
      "the launch must check the child after allocation yields",
    ).toBeGreaterThan(allocation);
    expect(
      registration,
      "liveness must be checked before registering the Worker generation",
    ).toBeGreaterThan(liveness);
  });

  it("both exec adapters consume the complete commit-captured transition", () => {
    for (const entry of [nodeEntry, browserEntry]) {
      const handler = execHandlerSource(readFileSync(entry, "utf8"));
      const postCommit = handler.slice(handler.indexOf("const startAfterCommit"));
      expect(
        postCommit,
        `${entry} must consume the complete transition captured by commit`,
      ).toContain("kernelWorker.takeCommittedExecTransition(");
      expect(
        postCommit,
        `${entry} must not issue result-bearing kernel calls before quiescence`,
      ).not.toMatch(
        /kernelWorker\.(?:processSecureExec|wakeProcessWorkersForExecRetirement|finalizeAddressSpaceForExec)\(/,
      );
    }
  });

  it("both hosts recheck process generations inside delayed kernel retries", () => {
    for (const entry of [nodeEntry, browserEntry]) {
      const source = readFileSync(entry, "utf8");
      const exec = execHandlerSource(source);
      expect(
        exec,
        `${entry} must guard exec liveness and address-space preparation`,
      ).toMatch(
        /retryKernelEntryResultForGeneration\(\s*isInitiatingExecGeneration,\s*\(\) => kernelWorker\.isProcessExecutionActive\(pid\),[\s\S]*retryKernelEntryResultForGeneration\(\s*isInitiatingExecGeneration,\s*\(\) => kernelWorker\.prepareAddressSpaceForExec\(pid\),/,
      );

      expectEntryProvides(source, entry, "handleClone");
    }

    const clone = cloneHandlerSource();
    // Placement is no longer a host decision: `sys_clone` reserved the slot and
    // the attachment carries the address, so this host materializes what the
    // kernel placed rather than choosing a page itself.
    expect(
      clone,
      "the clone must materialize the kernel-placed slot",
    ).toMatch(
      /materializeThreadSlot\(memory, slotAddr, processInfo\.ptrWidth\)/,
    );
    expect(
      clone,
      "thread attachment must stay guarded against a generation change",
    ).toMatch(
      /retryKernelEntryResultForGeneration\(\s*belongsToCompiledProcessImage,\s*\(\) => kernelWorker\.attachThreadChannel\(/,
    );
  });

  it("both hosts own the exact fork clone before their first async yield", () => {
    const handler = ordinaryForkHandlerSource();
    const clone = handler.indexOf("acquireForkMemoryClone(");
    const firstAwait = handler.indexOf("await ");
    expect(clone, "the fork must acquire its clone").toBeGreaterThanOrEqual(0);
    expect(firstAwait, "the fork must retain an async launch path")
      .toBeGreaterThanOrEqual(0);
    // WHY: after the first yield, sibling exec can release and recycle the
    // parent generation. The helper's owned synchronous copy is the fork
    // snapshot; doing it later creates an ABA/two-owner race.
    expect(clone, "the fork must clone before yielding").toBeLessThan(firstAwait);
    for (const entry of [nodeEntry, browserEntry]) {
      expectEntryProvides(
        readFileSync(entry, "utf8"),
        entry,
        "handleOrdinaryFork",
      );
    }
  });

  it("all fork and spawn dead-start paths transfer cleanup exactly once", () => {
    expectDeadStartUsesOrdinaryTeardown(
      ordinaryForkHandlerSource(),
      "handleOrdinaryFork",
    );
    expectDeadStartUsesOrdinaryTeardown(
      posixSpawnHandlerSource(),
      "handlePosixSpawn",
    );
  });

  it("Node kernel-worker-entry wires both onResolveSpawn and onSpawn", () => {
    const src = readFileSync(nodeEntry, "utf8");
    expectEntryProvides(src, nodeEntry, "handlePosixSpawn");
    expectEntryProvides(src, nodeEntry, "handlePosixSpawnResolve");
    // WHY: destroy must close this admission gate before its terminal sweep.
    // A direct handler reference can create a new process Memory while that
    // sweep is yielding, making the supposedly retired generation reachable.
    expectSpawnCallbacks(src, nodeEntry);
    const spawnHandler = posixSpawnHandlerSource();
    expect(spawnHandler, "posix_spawn must accept parentage").toMatch(
      /handlePosixSpawn\(\s*parentPid:\s*number,\s*childPid:\s*number,/s,
    );
    expect(spawnHandler, "posix_spawn must publish parentage").toMatch(
      /kind:\s*"spawn",\s*pid:\s*childPid,\s*ppid:\s*parentPid/,
    );
    expect(
      centralizedInitMessageSource(spawnHandler),
      "worker init metadata must not duplicate kernel-owned parentage",
    ).not.toMatch(
      /\bppid\s*:/,
    );
  });

  it("Browser kernel-worker-entry wires both onResolveSpawn and onSpawn", () => {
    const src = readFileSync(browserEntry, "utf8");
    expectEntryProvides(src, browserEntry, "handlePosixSpawn");
    expectEntryProvides(src, browserEntry, "handlePosixSpawnResolve");
    expectSpawnCallbacks(src, browserEntry);
    const spawnHandler = posixSpawnHandlerSource();
    expect(spawnHandler, "posix_spawn must accept parentage").toMatch(
      /handlePosixSpawn\(\s*parentPid:\s*number,\s*childPid:\s*number,/s,
    );
    expect(spawnHandler, "posix_spawn must publish parentage").toMatch(
      /kind:\s*"spawn",\s*pid:\s*childPid,\s*ppid:\s*parentPid/,
    );
    expect(
      centralizedInitMessageSource(spawnHandler),
      "worker init metadata must not duplicate kernel-owned parentage",
    ).not.toMatch(
      /\bppid\s*:/,
    );
  });

  it("CentralizedKernelCallbacks declares both onResolveSpawn and onSpawn", () => {
    // Ensures the host shared interface itself still surfaces both
    // callbacks — without these, neither entry would even type-check.
    const src = readFileSync(join(repoRoot, "host", "src", "kernel-worker.ts"), "utf8");
    expect(src).toMatch(/onSpawn\?:\s*\(\s*parentPid:\s*number,\s*childPid:\s*number,/s);
    expect(src).toMatch(/onResolveSpawn\?:\s*\(/);
  });
});
