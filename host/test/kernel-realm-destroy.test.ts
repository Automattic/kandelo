import { describe, expect, it } from "vitest";
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
});
