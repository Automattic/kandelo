import { describe, expect, it, vi } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import {
  awaitGracefulKernelRealmDestroy,
  awaitGracefulKernelRealmDestroyOutcome,
  kernelRealmDestroyResult,
  readKernelRealmDestroyResult,
} from "../src/kernel-realm-destroy";

describe("kernel realm destroy result", () => {
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
