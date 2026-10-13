import { describe, expect, it } from "vitest";
import {
  awaitGracefulKernelRealmDestroy,
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
});
