import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { ProcessMemoryCreatorGate } from "../src/process-memory-creator-gate";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("process memory creator destroy gate", () => {
  it("cancels suspended initialization before compactor creation and readiness", async () => {
    const gate = new ProcessMemoryCreatorGate();
    const bootCompaction = deferred();
    const createCompactor = vi.fn();
    const publishReady = vi.fn();
    const closeStorage = vi.fn();
    const initialization = gate.run("kernel initialization", async () => {
      await bootCompaction.promise;
      gate.assertOpen("persistent compactor initialization");
      createCompactor();
      gate.assertOpen("kernel readiness");
      publishReady();
    });
    const rejected = expect(initialization).rejects.toThrow("being destroyed");
    const destroyed = gate.closeAndRunAfterDrain(closeStorage);
    expect(closeStorage).not.toHaveBeenCalled();
    await expect(gate.run("kernel initialization", publishReady)).rejects.toThrow("being destroyed");
    bootCompaction.resolve();
    await rejected;
    await destroyed;
    expect(createCompactor).not.toHaveBeenCalled();
    expect(publishReady).not.toHaveBeenCalled();
    expect(closeStorage).toHaveBeenCalledOnce();
  });

  it("drains a previously installed compactor before closing its storage", async () => {
    const gate = new ProcessMemoryCreatorGate();
    const stopCompaction = deferred();
    const order: string[] = [];
    let compactor: { stop: () => Promise<void> } | undefined;
    await gate.run("kernel initialization", () => {
      gate.assertOpen("persistent compactor initialization");
      compactor = { stop: async () => {
        order.push("stop");
        await stopCompaction.promise;
        order.push("stopped");
      } };
      gate.assertOpen("kernel readiness");
      order.push("ready");
    });
    const destroyed = gate.closeAndRunAfterDrain(async () => {
      await compactor?.stop();
      order.push("close");
    });
    await Promise.resolve();
    expect(order).toEqual(["ready", "stop"]);
    stopCompaction.resolve();
    await destroyed;
    expect(order).toEqual(["ready", "stop", "stopped", "close"]);
  });

  it.each(["browser", "node"])("%s initialization joins the terminal creator gate", (host) => {
    const source = readFileSync(new URL(`../src/${host}-kernel-worker-entry.ts`, import.meta.url), "utf8");
    const initialization = source.slice(source.indexOf("async function handleInit("), source.indexOf("async function compileTopLevelProgram("));
    expect(source).toContain('void processMemoryCreators.run("kernel initialization",');
    const compactorCheck = initialization.indexOf('assertOpen("persistent compactor initialization")');
    const compactorCreation = initialization.indexOf("new LiveOverlayCompactor(");
    expect(compactorCheck).toBeGreaterThan(0);
    expect(compactorCreation).toBeGreaterThan(compactorCheck);
    const readinessCheck = initialization.indexOf('assertOpen("kernel readiness")');
    expect(readinessCheck).toBeGreaterThan(compactorCreation);
    expect(initialization.indexOf("initReady = true")).toBeGreaterThan(readinessCheck);
    expect(source).toContain("processMemoryCreators.closeAndRunAfterDrain(");
  });

  it("drains an admitted creator before running one terminal destroy sweep", async () => {
    const gate = new ProcessMemoryCreatorGate();
    const spawn = deferred();
    const spawnStarted = vi.fn();
    const lateExec = vi.fn();
    const sweep = vi.fn(() => ({ gracefulDetachComplete: true }));
    const duplicateSweep = vi.fn(() => ({ gracefulDetachComplete: false }));
    const errorResponses: string[] = [];
    const admittedSpawn = gate.run("spawn", async () => {
      spawnStarted();
      await spawn.promise;
      return 17;
    });

    const destroy = gate.closeAndRunAfterDrain(sweep);
    const repeatedDestroy = gate.closeAndRunAfterDrain(duplicateSweep);
    await gate
      .run("exec", () => {
        lateExec();
        return 0;
      })
      .catch((error) => {
        // Mirrors the worker-entry request catch: one rejected admission gets
        // one response and never invokes the rejected creator body.
        errorResponses.push(
          error instanceof Error ? error.message : String(error),
        );
      });
    expect(spawnStarted).toHaveBeenCalledOnce();
    expect(lateExec).not.toHaveBeenCalled();
    expect(errorResponses).toEqual([
      "kernel worker is being destroyed; cannot start exec",
    ]);
    expect(repeatedDestroy).toBe(destroy);
    expect(sweep).not.toHaveBeenCalled();
    expect(duplicateSweep).not.toHaveBeenCalled();

    let destroyFinished = false;
    void destroy.then(() => {
      destroyFinished = true;
    });
    await Promise.resolve();
    expect(destroyFinished).toBe(false);

    spawn.resolve();
    await expect(admittedSpawn).resolves.toBe(17);
    await expect(destroy).resolves.toEqual({ gracefulDetachComplete: true });
    await expect(repeatedDestroy).resolves.toEqual({
      gracefulDetachComplete: true,
    });
    expect(sweep).toHaveBeenCalledOnce();
    expect(duplicateSweep).not.toHaveBeenCalled();
  });

  it("drains an admitted exec and rejects a later spawn", async () => {
    const gate = new ProcessMemoryCreatorGate();
    const exec = deferred();
    const lateSpawn = vi.fn();
    const admittedExec = gate.run("exec", async () => {
      await exec.promise;
      return 0;
    });

    const firstDrain = gate.closeAndWait();
    const secondDrain = gate.closeAndWait();
    await expect(
      gate.run("spawn", () => {
        lateSpawn();
        return 23;
      }),
    ).rejects.toThrow("kernel worker is being destroyed; cannot start spawn");
    expect(lateSpawn).not.toHaveBeenCalled();

    exec.resolve();
    await expect(admittedExec).resolves.toBe(0);
    await expect(Promise.all([firstDrain, secondDrain])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it("keeps transferred exec-plan ownership in the destroy drain until release", async () => {
    const gate = new ProcessMemoryCreatorGate();
    const sweep = vi.fn();
    const admission = gate.acquire("an exec replacement plan");

    const destroy = gate.closeAndRunAfterDrain(sweep);
    await Promise.resolve();
    expect(sweep).not.toHaveBeenCalled();

    admission.release();
    admission.release();
    await expect(destroy).resolves.toBeUndefined();
    expect(sweep).toHaveBeenCalledOnce();
    expect(() => gate.acquire("a late exec replacement plan")).toThrow(
      "kernel worker is being destroyed; cannot start a late exec replacement plan",
    );
  });

  it("releases admission when a creator throws", async () => {
    const gate = new ProcessMemoryCreatorGate();
    const sweep = vi.fn();
    await expect(
      gate.run("failing creator", () => {
        throw new Error("injected creator failure");
      }),
    ).rejects.toThrow("injected creator failure");
    await expect(
      gate.closeAndRunAfterDrain(sweep),
    ).resolves.toBeUndefined();
    expect(sweep).toHaveBeenCalledOnce();
  });

  it("runs terminal teardown after an admitted creator rejects", async () => {
    const gate = new ProcessMemoryCreatorGate();
    const resume = deferred();
    const sweep = vi.fn();
    const creator = gate.run("failing async creator", async () => {
      await resume.promise;
      throw new Error("injected async creator failure");
    });
    const destroy = gate.closeAndRunAfterDrain(sweep);

    expect(sweep).not.toHaveBeenCalled();
    resume.resolve();
    await expect(creator).rejects.toThrow("injected async creator failure");
    await expect(destroy).resolves.toBeUndefined();
    expect(sweep).toHaveBeenCalledOnce();
  });

  it("lets destroy sweep a committed generation while its syscall stays parked", async () => {
    const gate = new ProcessMemoryCreatorGate();
    const vforkLifetime = deferred();
    const generationPublished = vi.fn();
    const sweep = vi.fn(() => ({ gracefulDetachComplete: true }));
    const vfork = gate.runUntilCommitted(
      "vfork process Worker",
      async (commit) => {
        generationPublished();
        commit();
        await vforkLifetime.promise;
        return 41;
      },
    );

    const destroy = gate.closeAndRunAfterDrain(sweep);
    await expect(destroy).resolves.toEqual({ gracefulDetachComplete: true });
    expect(generationPublished).toHaveBeenCalledOnce();
    expect(sweep).toHaveBeenCalledOnce();

    let vforkFinished = false;
    void vfork.then(() => {
      vforkFinished = true;
    });
    await Promise.resolve();
    expect(vforkFinished).toBe(false);

    vforkLifetime.resolve();
    await expect(vfork).resolves.toBe(41);
  });

  it("keeps pre-commit creation failures in the destroy drain", async () => {
    const gate = new ProcessMemoryCreatorGate();
    const rollback = deferred();
    const sweep = vi.fn();
    const creator = gate.runUntilCommitted(
      "failing vfork setup",
      async (_commit) => {
        await rollback.promise;
        throw new Error("injected pre-commit failure");
      },
    );
    const destroy = gate.closeAndRunAfterDrain(sweep);

    await Promise.resolve();
    expect(sweep).not.toHaveBeenCalled();
    rollback.resolve();
    await expect(creator).rejects.toThrow("injected pre-commit failure");
    await expect(destroy).resolves.toBeUndefined();
    expect(sweep).toHaveBeenCalledOnce();
  });
});
