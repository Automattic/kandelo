import { describe, expect, it, vi } from "vitest";

import { KernelReentrantEntryError } from "../src/kernel-entry-gate";
import {
  retryKernelEntryResult,
  retryKernelEntryResultForGeneration,
} from "../src/kernel-entry-retry";

describe("retryKernelEntryResult", () => {
  it("yields and retries a result-bearing entry rejected by temporary contention", async () => {
    const scheduled: Array<() => void> = [];
    const operation = vi
      .fn<() => number>()
      .mockImplementationOnce(() => {
        throw new KernelReentrantEntryError("process liveness query");
      })
      .mockImplementationOnce(() => 17);

    const result = retryKernelEntryResult(
      operation,
      (retry) => scheduled.push(retry),
    );

    expect(operation).toHaveBeenCalledOnce();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!();
    await expect(result).resolves.toBe(17);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry an ordinary lifecycle failure", async () => {
    const scheduled = vi.fn<(retry: () => void) => void>();
    const failure = new Error("worker launch failed");

    await expect(
      retryKernelEntryResult(
        () => {
          throw failure;
        },
        scheduled,
      ),
    ).rejects.toBe(failure);
    expect(scheduled).not.toHaveBeenCalled();
  });

  it("rechecks the process generation before a delayed retry", async () => {
    const scheduled: Array<() => void> = [];
    let currentGeneration = true;
    const operation = vi.fn<() => number>(() => {
      throw new KernelReentrantEntryError("dynamic host-region reservation");
    });

    const result = retryKernelEntryResultForGeneration(
      () => currentGeneration,
      operation,
      (retry) => scheduled.push(retry),
    );

    expect(operation).toHaveBeenCalledOnce();
    expect(scheduled).toHaveLength(1);
    currentGeneration = false;
    scheduled.shift()!();

    await expect(result).resolves.toEqual({ status: "stale" });
    expect(operation).toHaveBeenCalledOnce();
  });
});
