import { describe, expect, it, vi } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { ProcessMemoryCreatorGate } from "../src/process-memory-creator-gate";
import {
  awaitGracefulKernelRealmDestroy,
  awaitGracefulKernelRealmDestroyOutcome,
  closeKernelRealmStorage,
  closeKernelRealmStorageAsync,
  kernelRealmDestroyResult,
  PERSISTENT_KERNEL_REALM_DESTROY_TIMEOUT_MS,
  readKernelRealmDestroyResult,
} from "../src/kernel-realm-destroy";

describe("kernel realm destroy result", () => {
  it.each([false, true])("drains rejected initialization cleanup before destroy and preserves its lock on failure (%s)", async (closeFails) => {
    const gate = new ProcessMemoryCreatorGate();
    let finishBoot!: () => void;
    let finishDeferredClose!: () => void;
    const boot = new Promise<void>(resolve => { finishBoot = resolve; });
    const deferredClose = new Promise<void>(resolve => { finishDeferredClose = resolve; });
    const closeFailure = new Error("deferred close failed");
    const journalClose = vi.fn();
    const indexClose = vi.fn();
    const lockClose = vi.fn();
    const ready = vi.fn();
    let cleanup: Promise<void> | undefined;
    const retire = () => cleanup ??= closeKernelRealmStorageAsync([
      async () => { await deferredClose; if (closeFails) throw closeFailure; },
      journalClose,
      indexClose,
    ]).then(() => { lockClose(); });
    const initializing = gate.run("kernel initialization", async () => {
      await boot;
      try {
        gate.assertOpen("persistent compactor initialization");
        ready();
      } catch (error) {
        await retire();
        throw error;
      }
    });
    const rejected = expect(initializing).rejects.toThrow(closeFails ? "deferred close failed" : "being destroyed");
    const destroyed = gate.closeAndRunAfterDrain(retire);
    const destroyOutcome = closeFails
      ? expect(destroyed).rejects.toThrow("deferred close failed")
      : expect(destroyed).resolves.toBeUndefined();
    finishBoot();
    await Promise.resolve();
    expect(lockClose).not.toHaveBeenCalled();
    finishDeferredClose();
    await rejected;
    await destroyOutcome;
    expect(journalClose).toHaveBeenCalledOnce();
    expect(indexClose).toHaveBeenCalledOnce();
    expect(lockClose).toHaveBeenCalledTimes(closeFails ? 0 : 1);
    expect(ready).not.toHaveBeenCalled();
    expect(retire()).toBe(cleanup);
  });

  it("retains an exclusive lock when either persistent writer close is unproven", async () => {
    const failure = new Error("journal close failed");
    const indexClose = vi.fn();
    const lockClose = vi.fn();
    const closing = closeKernelRealmStorageAsync([
      () => { throw failure; },
      indexClose,
    ]).then(lockClose);
    await expect(closing).rejects.toMatchObject({ errors: [failure] });
    expect(indexClose).toHaveBeenCalledOnce();
    expect(lockClose).not.toHaveBeenCalled();
  });

  it("attempts all storage closes but does not acknowledge a failed close", async () => {
    const events: string[] = [];
    const journalError = new Error("journal close EIO");
    const indexError = new Error("index close EIO");
    const outcome = await awaitGracefulKernelRealmDestroyOutcome(async () => {
      closeKernelRealmStorage([
        () => { events.push("journal"); throw journalError; },
        () => { events.push("index"); throw indexError; },
        () => { events.push("base"); },
      ]);
      return kernelRealmDestroyResult(true);
    }, 1000);
    expect(events).toEqual(["journal", "index", "base"]);
    expect(outcome.result).toBeNull();
    expect(outcome.failure).toContain("journal close EIO; index close EIO");
  });

  it("retains exact close failures and permits a successful empty storage cleanup", () => {
    expect(() => closeKernelRealmStorage([])).not.toThrow();
    const failure = new Error("OPFS close failed");
    try {
      closeKernelRealmStorage([() => { throw failure; }]);
      expect.unreachable("failed storage close must not return success");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([failure]);
    }
  });

  it("lets persistent Node shutdown finish storage work beyond the ordinary realm deadline", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const host = new NodeKernelHost({ rootfsImage: new Uint8Array(8), experimentalResizablePersistencePath: "persistent-shutdown" });
      const internal = host as unknown as {
        workerStarted: boolean;
        initialized: boolean;
        request: () => Promise<unknown>;
        terminateWorker: () => Promise<number>;
      };
      internal.workerStarted = true;
      internal.initialized = true;
      internal.request = () => new Promise((resolve) => setTimeout(() => resolve(kernelRealmDestroyResult(true)), 6_000));
      internal.terminateWorker = vi.fn(async () => { internal.workerStarted = false; return 0; });
      const destruction = host.destroy();
      await vi.advanceTimersByTimeAsync(5_001);
      expect(internal.terminateWorker).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(999);
      await destruction;
      expect(internal.terminateWorker).toHaveBeenCalledOnce();
      expect(host.getPersistenceShutdownFailure()).toBeNull();
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it("still bounds a persistent shutdown that never acknowledges storage quiescence", async () => {
    vi.useFakeTimers();
    try {
      const outcome = awaitGracefulKernelRealmDestroyOutcome(() => new Promise(() => {}), PERSISTENT_KERNEL_REALM_DESTROY_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(PERSISTENT_KERNEL_REALM_DESTROY_TIMEOUT_MS);
      expect(await outcome).toEqual({ result: null, failure: "graceful kernel-worker detach timed out after 30000ms" });
    } finally { vi.useRealTimers(); }
  });

  it("reports persistence sync failure rather than acknowledging a clean shutdown", async () => {
    const result = kernelRealmDestroyResult(true, "rootfs persistence shutdown sync failed: EIO");
    expect(readKernelRealmDestroyResult(result)).toEqual(result);
    expect(await awaitGracefulKernelRealmDestroy(() => Promise.resolve(result), 1000))
      .toContain("shutdown sync failed");
  });

  it("rejects malformed persistence failure fields", () => {
    expect(readKernelRealmDestroyResult({ gracefulDetachComplete: true, persistenceSyncFailure: 5 }))
      .toBeNull();
  });

  it("distinguishes an acknowledged storage shutdown from a missing response", async () => {
    const response = kernelRealmDestroyResult(false, "rootfs persistence shutdown sync failed: EIO");
    const acknowledged = await awaitGracefulKernelRealmDestroyOutcome(() => Promise.resolve(response), 1000);
    expect(acknowledged.result).toEqual(response);
    expect(acknowledged.failure).toContain("shutdown sync failed");
    const invalid = await awaitGracefulKernelRealmDestroyOutcome(() => Promise.resolve({}), 1000);
    expect(invalid.result).toBeNull();
    expect(invalid.failure).toContain("invalid destroy result");
  });

  it("keeps a Node shutdown sync failure available after teardown", async () => {
    const host = new NodeKernelHost();
    const internal = host as unknown as {
      workerStarted: boolean;
      initialized: boolean;
      request: () => Promise<unknown>;
      terminateWorker: () => Promise<number>;
    };
    internal.workerStarted = true;
    internal.initialized = true;
    internal.request = async () => kernelRealmDestroyResult(true, "injected sync failure");
    internal.terminateWorker = async () => {
      internal.workerStarted = false;
      return 0;
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await host.destroy();
      expect(host.getPersistenceShutdownFailure()).toBe("injected sync failure");
    } finally {
      warning.mockRestore();
    }
  });
});
