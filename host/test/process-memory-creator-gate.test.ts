import { describe, expect, it, vi } from "vitest";

import { ProcessMemoryCreatorGate } from "../src/process-memory-creator-gate";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("process memory creator destroy gate", () => {
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
});
