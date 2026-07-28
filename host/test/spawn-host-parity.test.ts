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

function posixSpawnHandlerSource(src: string): string {
  const start = src.indexOf("async function handlePosixSpawn(");
  const end = src.indexOf("\nasync function handleClone(", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

function forkHandlerSource(src: string): string {
  const start = src.indexOf("async function handleFork(");
  const end = src.indexOf("\nasync function handleExec(", start);
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

function expectDeadStartUsesOrdinaryTeardown(handler: string, entry: string): void {
  expect(
    handler,
    `${entry} must transfer a dead child to ordinary lifecycle teardown`,
  ).toMatch(
    /const signal = kernelWorker\.finalizePendingChildTermination\(childPid\);\s*lifecycleTeardownStarted = true;\s*await awaitFinalizedProcessTeardown\(/s,
  );
  expect(
    handler,
    `${entry} must not roll back a lifecycle-owned generation`,
  ).toMatch(
    /catch \(error\) \{\s*if \(lifecycleTeardownStarted\) throw error;/s,
  );
}

describe("spawn host parity", () => {
  it("both hosts own the exact fork clone before their first async yield", () => {
    for (const entry of [nodeEntry, browserEntry]) {
      const handler = forkHandlerSource(readFileSync(entry, "utf8"));
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
      expectDeadStartUsesOrdinaryTeardown(forkHandlerSource(source), entry);
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
    expect(src, `${nodeEntry} must wire onSpawn: handlePosixSpawn`).toMatch(
      /onSpawn:\s*handlePosixSpawn/,
    );
    expect(src, `${nodeEntry} must wire onResolveSpawn: handlePosixSpawnResolve`).toMatch(
      /onResolveSpawn:\s*handlePosixSpawnResolve/,
    );
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
    expect(src, `${browserEntry} must wire onSpawn (calling handlePosixSpawn)`).toMatch(
      /onSpawn:.*handlePosixSpawn/s,
    );
    expect(src, `${browserEntry} must wire onResolveSpawn (calling handlePosixSpawnResolve)`).toMatch(
      /onResolveSpawn:.*handlePosixSpawnResolve/s,
    );
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
