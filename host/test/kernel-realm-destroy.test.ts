import { describe, expect, it, vi } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import {
  awaitGracefulKernelRealmDestroy,
  awaitGracefulKernelRealmDestroyOutcome,
  closeKernelRealmStorage,
  kernelRealmDestroyResult,
  PERSISTENT_KERNEL_REALM_DESTROY_TIMEOUT_MS,
  readKernelRealmDestroyResult,
} from "../src/kernel-realm-destroy";

describe("kernel realm destroy result", () => {
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
