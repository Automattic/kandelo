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

function posixSpawnHandlerSource(src: string): string {
  const start = src.indexOf("async function handlePosixSpawn(");
  const end = src.indexOf("\nasync function handleClone(", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

function ordinaryForkHandlerSource(src: string): string {
  const start = src.indexOf("async function handleOrdinaryFork(");
  const end = src.indexOf("\nasync function handleExec(", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

function execHandlerSource(src: string): string {
  const start = src.indexOf("async function handleExec(");
  const end = src.indexOf("\n/**\n * Pre-flight resolver", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

function cloneHandlerSource(src: string): string {
  const start = src.indexOf("async function handleClone(");
  const end = src.indexOf("\nfunction handleThreadExit(", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
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

    for (const entry of [nodeEntry, browserEntry]) {
      const handler = posixSpawnHandlerSource(readFileSync(entry, "utf8"));
      expect(handler, `${entry} must launch the supplied committed module`)
        .toContain("const { programBytes, programModule, argv } = program;");
      expect(handler, `${entry} must not repeat candidate resolution`).not.toMatch(
        /resolveExecutableForLaunch|handlePosixSpawnResolve|execPrograms|readExecFromVfs/,
      );
      expect(
        handler,
        `${entry} must consume the secure-exec state captured by commit`,
      ).toContain("kernelWorker.takeCommittedExecSecureExec(childPid)");
      expect(
        handler,
        `${entry} must not re-enter the kernel after the spawn commit`,
      ).not.toContain("kernelWorker.processSecureExec(childPid)");
    }
  });

  it("both spawn adapters check child liveness only after allocation yields", () => {
    for (const entry of [nodeEntry, browserEntry]) {
      const handler = posixSpawnHandlerSource(readFileSync(entry, "utf8"));
      const allocation = handler.indexOf("createFreshProcessMemory(");
      const liveness = handler.indexOf("shouldLaunchPendingChild(childPid)");
      const registration = handler.indexOf("registerProcess(childPid");
      expect(
        handler.match(/shouldLaunchPendingChild\(childPid\)/g) ?? [],
        `${entry} must retain exactly one post-allocation liveness fence`,
      ).toHaveLength(1);
      expect(allocation, `${entry} must allocate process memory`)
        .toBeGreaterThanOrEqual(0);
      expect(
        liveness,
        `${entry} must check the child after allocation yields`,
      ).toBeGreaterThan(allocation);
      expect(
        registration,
        `${entry} must check liveness before registering the Worker generation`,
      ).toBeGreaterThan(liveness);
    }
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

      const clone = cloneHandlerSource(source);
      expect(
        clone,
        `${entry} must guard clone allocation and thread attachment`,
      ).toMatch(
        /retryKernelEntryResultForGeneration\(\s*belongsToCompiledProcessImage,\s*\(\) => processInfo\.threadAllocator\.allocate\(memory\),[\s\S]*retryKernelEntryResultForGeneration\(\s*belongsToCompiledProcessImage,\s*\(\) => kernelWorker\.attachThreadChannel\(/,
      );
    }
  });

  it("both hosts own the exact fork clone before their first async yield", () => {
    for (const entry of [nodeEntry, browserEntry]) {
      const handler = ordinaryForkHandlerSource(readFileSync(entry, "utf8"));
      const clone = handler.indexOf("acquireForkMemoryClone(");
      const firstAwait = handler.indexOf("await ");
      expect(clone, `${entry} must acquire the fork clone`).toBeGreaterThanOrEqual(0);
      expect(firstAwait, `${entry} must retain an async launch path`).toBeGreaterThanOrEqual(0);
      // WHY: after the first yield, sibling exec can release and recycle the
      // parent generation. The helper's owned synchronous copy is the fork
      // snapshot; doing it later creates an ABA/two-owner race.
      expect(clone, `${entry} must clone before yielding`).toBeLessThan(firstAwait);
    }
  });

  it("all fork and spawn dead-start paths transfer cleanup exactly once", () => {
    for (const entry of [nodeEntry, browserEntry]) {
      const source = readFileSync(entry, "utf8");
      expectDeadStartUsesOrdinaryTeardown(
        ordinaryForkHandlerSource(source),
        entry,
      );
      expectDeadStartUsesOrdinaryTeardown(posixSpawnHandlerSource(source), entry);
    }
  });

  it("Node kernel-worker-entry wires both onResolveSpawn and onSpawn", () => {
    const src = readFileSync(nodeEntry, "utf8");
    expect(src, `${nodeEntry} must define handlePosixSpawn`).toMatch(
      /\b(?:async\s+)?function\s+handlePosixSpawn\s*\(/,
    );
    expect(src, `${nodeEntry} must define handlePosixSpawnResolve`).toMatch(
      /\b(?:async\s+)?function\s+handlePosixSpawnResolve\s*\(/,
    );
    // WHY: destroy must close this admission gate before its terminal sweep.
    // A direct handler reference can create a new process Memory while that
    // sweep is yielding, making the supposedly retired generation reachable.
    expectSpawnCallbacks(src, nodeEntry);
    const spawnHandler = posixSpawnHandlerSource(src);
    expect(spawnHandler, `${nodeEntry} must accept posix_spawn parentage`).toMatch(
      /handlePosixSpawn\(\s*parentPid:\s*number,\s*childPid:\s*number,/s,
    );
    expect(spawnHandler, `${nodeEntry} must publish posix_spawn parentage`).toMatch(
      /kind:\s*"spawn",\s*pid:\s*childPid,\s*ppid:\s*parentPid/,
    );
    expect(
      centralizedInitMessageSource(spawnHandler),
      `${nodeEntry} must not duplicate kernel-owned parentage in worker init metadata`,
    ).not.toMatch(
      /\bppid\s*:/,
    );
  });

  it("Browser kernel-worker-entry wires both onResolveSpawn and onSpawn", () => {
    const src = readFileSync(browserEntry, "utf8");
    expect(src, `${browserEntry} must define handlePosixSpawn`).toMatch(
      /\b(?:async\s+)?function\s+handlePosixSpawn\s*\(/,
    );
    expect(src, `${browserEntry} must define handlePosixSpawnResolve`).toMatch(
      /\b(?:async\s+)?function\s+handlePosixSpawnResolve\s*\(/,
    );
    expectSpawnCallbacks(src, browserEntry);
    const spawnHandler = posixSpawnHandlerSource(src);
    expect(spawnHandler, `${browserEntry} must accept posix_spawn parentage`).toMatch(
      /handlePosixSpawn\(\s*parentPid:\s*number,\s*childPid:\s*number,/s,
    );
    expect(spawnHandler, `${browserEntry} must publish posix_spawn parentage`).toMatch(
      /kind:\s*"spawn",\s*pid:\s*childPid,\s*ppid:\s*parentPid/,
    );
    expect(
      centralizedInitMessageSource(spawnHandler),
      `${browserEntry} must not duplicate kernel-owned parentage in worker init metadata`,
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
