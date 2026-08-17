import { describe, expect, it, vi } from "vitest";

import { WASM_PAGE_SIZE } from "../src/constants";
import {
  acquireForkMemoryClone,
  copyArrayBufferInChunks,
  createProcessMemoryRetirementPressureHook,
  deriveProcessMemoryRetirementAdmissionThresholds,
  ProcessMemoryAllocator,
  ProcessMemoryCapacityError,
  ProcessMemoryRetirementBacklogError,
  type ProcessMemoryAllocationRequest,
} from "../src/process-memory";

function request(
  initialPages: number,
  maximumPages = 32,
  ptrWidth: 4 | 8 = 4,
): ProcessMemoryAllocationRequest {
  return { ptrWidth, initialPages, maximumPages };
}

function expectAllZero(memory: WebAssembly.Memory): void {
  const bytes = new Uint8Array(memory.buffer);
  expect(bytes.findIndex((byte) => byte !== 0)).toBe(-1);
}

describe("ProcessMemoryAllocator", () => {
  it("allocates isolated fresh zeroed address spaces", () => {
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 2,
      maxTotalBytes: 16 * WASM_PAGE_SIZE,
    });
    const firstLease = allocator.acquire(request(4));
    const secondLease = allocator.acquire(request(4));
    expect(secondLease.memory).not.toBe(firstLease.memory);
    expect(secondLease.memory.buffer.byteLength).toBe(4 * WASM_PAGE_SIZE);
    expectAllZero(secondLease.memory);
    new Uint8Array(firstLease.memory.buffer).fill(0xa5);
    expectAllZero(secondLease.memory);
    firstLease.release();
    secondLease.release();
  });

  it("allocates exact fresh sizes and isolates wasm32 from wasm64", () => {
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 3,
      maxTotalBytes: 32 * WASM_PAGE_SIZE,
    });
    const wasm32 = allocator.acquire(request(3, 16, 4));
    const wasm64 = allocator.acquire(request(5, 16, 8));

    expect(wasm32.memory.buffer.byteLength).toBe(3 * WASM_PAGE_SIZE);
    expect(wasm64.memory.buffer.byteLength).toBe(5 * WASM_PAGE_SIZE);
    expect(wasm64.memory).not.toBe(wasm32.memory);
    wasm32.release();
    wasm64.release();
  });

  it("owns a fork snapshot before an async parent retirement", async () => {
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 3,
      maxTotalBytes: 24 * WASM_PAGE_SIZE,
    });
    const parentLease = allocator.acquire(request(4, 16));
    const parent = parentLease.memory;
    const parentBytes = new Uint8Array(parent.buffer);
    parentBytes.fill(0x2a);
    parentBytes[0] = 0x11;
    parentBytes[parentBytes.length - 1] = 0xee;

    let resumeLaunch!: () => void;
    const launchPaused = new Promise<void>((resolve) => {
      resumeLaunch = resolve;
    });
    const pendingFork = (async () => {
      // Product handlers perform this synchronous clone before their first
      // module-compilation or worker-teardown await.
      const childLease = acquireForkMemoryClone(
        allocator,
        parent,
        4,
        16,
      );
      await launchPaused;
      return childLease;
    })();

    parentLease.release();
    const replacementLease = allocator.acquire(request(4, 16));
    expect(replacementLease.memory).not.toBe(parent);
    new Uint8Array(replacementLease.memory.buffer).fill(0x7c);
    resumeLaunch();

    const childLease = await pendingFork;
    expect(childLease.memory).not.toBe(parent);
    expect(childLease.memory.buffer.byteLength).toBe(4 * WASM_PAGE_SIZE);
    const childBytes = new Uint8Array(childLease.memory.buffer);
    expect(childBytes[0]).toBe(0x11);
    expect(childBytes[childBytes.length - 1]).toBe(0xee);
    expect(childBytes[WASM_PAGE_SIZE + 17]).toBe(0x2a);
    childLease.release();
    replacementLease.release();
  });

  it("bounds retirement bursts without making finalization permanent authority", async () => {
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 8,
      maxTotalBytes: 32 * WASM_PAGE_SIZE,
      retirementAdmissionMemoryThreshold: 2,
      retirementAdmissionByteThreshold: 8 * WASM_PAGE_SIZE,
      retirementBackpressureMs: 0,
      maxRetirementTelemetryRecords: 0,
    });
    const first = allocator.acquire(request(4));
    const second = allocator.acquire(request(4));
    first.release();
    second.release();

    let failure: unknown;
    try {
      allocator.acquire(request(1));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(
      ProcessMemoryRetirementBacklogError,
    );
    expect((failure as ProcessMemoryRetirementBacklogError).errno).toBe(11);
    expect(allocator.getRetirementStats()).toMatchObject({
      liveMemories: 0,
      liveBytes: 0,
      retirementBacklogMemories: 2,
      retirementBacklogBytes: 8 * WASM_PAGE_SIZE,
      chargedMemories: 2,
      chargedBytes: 8 * WASM_PAGE_SIZE,
    });

    // FinalizationRegistry callbacks are optional and may be arbitrarily late.
    // Product call sites wait internally for the retirement timer
    // instead of exposing this healthy sequential churn as EAGAIN.
    const replacement = await allocator.acquireWhenAvailable(request(1));
    expect(
      allocator.getRetirementStats().retirementBacklogMemories,
    ).toBeLessThan(2);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(allocator.getRetirementStats()).toMatchObject({
      retirementBacklogMemories: 0,
      retirementBacklogBytes: 0,
      chargedMemories: 1,
      chargedBytes: WASM_PAGE_SIZE,
      pendingRetirements: 0,
    });
    replacement.release();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  it("treats retirement byte thresholds as admission gates, not hard backlog caps", () => {
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 2,
      maxTotalBytes: 16 * WASM_PAGE_SIZE,
      retirementAdmissionMemoryThreshold: 2,
      retirementAdmissionByteThreshold: 4 * WASM_PAGE_SIZE,
      retirementBackpressureMs: 1_000,
    });
    const grown = allocator.acquire(request(2, 32));
    grown.memory.grow(8);
    grown.release();

    expect(allocator.getRetirementStats()).toMatchObject({
      retirementBacklogMemories: 1,
      retirementBacklogBytes: 10 * WASM_PAGE_SIZE,
    });
    expect(() => allocator.acquire(request(1))).toThrow(
      ProcessMemoryRetirementBacklogError,
    );
    allocator.clear();
  });

  it("retires every already-live generation even when they overshoot both thresholds", () => {
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 3,
      maxTotalBytes: 12 * WASM_PAGE_SIZE,
      retirementAdmissionMemoryThreshold: 1,
      retirementAdmissionByteThreshold: 2 * WASM_PAGE_SIZE,
      retirementBackpressureMs: 1_000,
    });
    const live = [
      allocator.acquire(request(2)),
      allocator.acquire(request(2)),
      allocator.acquire(request(2)),
    ];

    for (const lease of live) lease.release();

    expect(allocator.getRetirementStats()).toMatchObject({
      retirementBacklogMemories: 3,
      retirementBacklogBytes: 6 * WASM_PAGE_SIZE,
    });
    expect(() => allocator.acquire(request(1))).toThrow(
      ProcessMemoryRetirementBacklogError,
    );
    allocator.clear();
  });

  it("captures fork synchronously while holding Worker launch for retirement admission", async () => {
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 3,
      maxTotalBytes: 12 * WASM_PAGE_SIZE,
      retirementAdmissionMemoryThreshold: 1,
      retirementAdmissionByteThreshold: 4 * WASM_PAGE_SIZE,
      retirementBackpressureMs: 10,
      maxRetirementTelemetryRecords: 0,
    });
    const parent = allocator.acquire(request(4));
    const retiring = allocator.acquire(request(4));
    retiring.release();

    new Uint8Array(parent.memory.buffer).fill(0x5a);
    const child = acquireForkMemoryClone(
      allocator,
      parent.memory,
      4,
      32,
    );
    expect(new Uint8Array(child.memory.buffer)[17]).toBe(0x5a);

    await allocator.waitForRetirementBacklogCapacity(
      child.memory.buffer.byteLength,
    );
    parent.release();
    child.release();
  });

  it("keeps EAGAIN as a bounded admission fallback", async () => {
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 2,
      maxTotalBytes: 8 * WASM_PAGE_SIZE,
      retirementAdmissionMemoryThreshold: 1,
      retirementAdmissionByteThreshold: 4 * WASM_PAGE_SIZE,
      retirementBackpressureMs: 1_000,
    });
    allocator.acquire(request(4)).release();

    await expect(
      allocator.acquireWhenAvailable(request(1), 0),
    ).rejects.toBeInstanceOf(ProcessMemoryRetirementBacklogError);
    allocator.clear();
  });

  it("accounts guest growth independently from pending retirements", async () => {
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 4,
      maxTotalBytes: 8 * WASM_PAGE_SIZE,
      retirementAdmissionMemoryThreshold: 4,
      retirementAdmissionByteThreshold: 8 * WASM_PAGE_SIZE,
      retirementBackpressureMs: 0,
      maxRetirementTelemetryRecords: 0,
    });
    allocator.acquire(request(2, 16)).release();
    const grown = allocator.acquire(request(2, 16));
    grown.memory.grow(4);
    const onePage = allocator.acquire(request(1, 16));

    expect(allocator.getRetirementStats()).toMatchObject({
      liveMemories: 2,
      liveBytes: 7 * WASM_PAGE_SIZE,
      retirementBacklogMemories: 1,
      retirementBacklogBytes: 2 * WASM_PAGE_SIZE,
      chargedBytes: 9 * WASM_PAGE_SIZE,
    });

    let failure: unknown;
    try {
      allocator.acquire(request(2, 16));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProcessMemoryCapacityError);
    expect((failure as ProcessMemoryCapacityError).errno).toBe(12);
    expect((failure as ProcessMemoryCapacityError).chargedBytes).toBe(
      7 * WASM_PAGE_SIZE,
    );

    onePage.release();
    grown.release();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  it("samples unmediated aggregate growth at the next allocation boundary", () => {
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 2,
      maxTotalBytes: 4 * WASM_PAGE_SIZE,
    });
    const running = allocator.acquire(request(2, 16));

    // WebAssembly.Memory.grow does not call the allocator. The per-process
    // maximum remains authoritative, while this aggregate admission budget is
    // sampled when another address space is requested.
    running.memory.grow(8);
    expect(running.memory.buffer.byteLength).toBe(10 * WASM_PAGE_SIZE);
    expect(() => allocator.acquire(request(1, 16))).toThrow(
      ProcessMemoryCapacityError,
    );
    expect(allocator.getRetirementStats()).toMatchObject({
      liveMemories: 1,
      liveBytes: 10 * WASM_PAGE_SIZE,
    });
    running.release();
  });

  it("severs consumed lease references and rejects duplicate consumption", () => {
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 1,
      maxTotalBytes: 4 * WASM_PAGE_SIZE,
    });
    const lease = allocator.acquire(request(2));
    lease.release();

    expect(() => lease.memory).toThrow("already consumed");
    expect(() => lease.release()).toThrow("already consumed");
    expect(() => lease.releaseAfterForcedTermination()).toThrow(
      "already consumed",
    );
  });

  it("rejects one observed wrapper being assigned to two memory generations", () => {
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 2,
      maxTotalBytes: 8 * WASM_PAGE_SIZE,
    });
    const first = allocator.acquire(request(2));
    const second = allocator.acquire(request(2));
    const wrapper = {};

    allocator.observeTarget(first.memory, wrapper);
    expect(() => allocator.observeTarget(first.memory, wrapper)).not.toThrow();
    expect(() => allocator.observeTarget(second.memory, wrapper)).toThrow(
      "belongs to another allocation",
    );

    first.release();
    second.release();
  });

  it("drops the host alias after forced termination and applies only bounded backpressure", async () => {
    const retirements: Array<{ mode: string; targets: number }> = [];
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 1,
      maxTotalBytes: 8 * WASM_PAGE_SIZE,
      retirementAdmissionMemoryThreshold: 1,
      retirementAdmissionByteThreshold: 4 * WASM_PAGE_SIZE,
      retirementBackpressureMs: 0,
      maxRetirementTelemetryRecords: 0,
      retirementPressureHook: (notice) => {
        retirements.push({
          mode: notice.retirementMode,
          targets: notice.trackedTargets,
        });
      },
    });
    const lease = allocator.acquire(request(4));
    lease.releaseAfterForcedTermination();

    expect(() => allocator.acquire(request(4))).toThrow(
      ProcessMemoryRetirementBacklogError,
    );
    expect(() => lease.release()).toThrow("already consumed");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const replacement = allocator.acquire(request(4));
    expect(replacement.memory.buffer.byteLength).toBe(4 * WASM_PAGE_SIZE);
    expect(retirements).toEqual([
      { mode: "forced", targets: expect.any(Number) },
    ]);
    replacement.release();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  it("schedules non-authoritative retirement pressure with metadata only", async () => {
    const observedIds: number[] = [];
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 4,
      maxTotalBytes: 4 * WASM_PAGE_SIZE,
      retirementBackpressureMs: 1_000,
      retirementPressureHook: (retirement) => {
        observedIds.push(retirement.retirementId);
        throw new Error("diagnostic hooks cannot fail retirement");
      },
    });

    for (let index = 0; index < 3; index += 1) {
      allocator.acquire(request(1)).release();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const stats = allocator.getRetirementStats();
    expect(observedIds).toEqual([1, 2, 3]);
    expect(stats.observedRetirements).toBe(3);
    expect(stats.pendingRetirements).toBe(3);
    expect(stats.pendingRetiredBytes).toBe(3 * WASM_PAGE_SIZE);
    expect(stats.retirementBacklogMemories).toBe(3);
    expect(stats.retirementBacklogBytes).toBe(3 * WASM_PAGE_SIZE);
    expect(stats.chargedMemories).toBe(3);
    allocator.clear();
  });

  it("keeps retirement-pressure disablement explicit and coalesces enabled bursts", () => {
    vi.useFakeTimers();
    try {
      const notice = {
        retirementId: 1,
        retirementMode: "quiescent" as const,
        ptrWidth: 4 as const,
        maximumPages: 16,
        byteLength: WASM_PAGE_SIZE,
        trackedTargets: 0,
      };
      const disabled = createProcessMemoryRetirementPressureHook(0);
      disabled(notice);
      expect(vi.getTimerCount()).toBe(0);

      const enabled = createProcessMemoryRetirementPressureHook(1);
      enabled(notice);
      enabled({ ...notice, retirementId: 2 });
      expect(vi.getTimerCount()).toBe(1);
      vi.runAllTimers();
      enabled({ ...notice, retirementId: 3 });
      expect(vi.getTimerCount()).toBe(1);
      expect(() =>
        createProcessMemoryRetirementPressureHook(-1)
      ).toThrow("invalid process memory retirement pressure");
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires live leases back before clear and validates configuration", () => {
    expect(
      () =>
        new ProcessMemoryAllocator({
          maxMemories: -1,
          maxTotalBytes: WASM_PAGE_SIZE,
        }),
    ).toThrow();
    expect(
      () =>
        new ProcessMemoryAllocator({
          maxMemories: 1,
          maxTotalBytes: WASM_PAGE_SIZE,
          retirementAdmissionMemoryThreshold: 0,
        }),
    ).toThrow();
    expect(
      () =>
        new ProcessMemoryAllocator({
          maxMemories: 1,
          maxTotalBytes: WASM_PAGE_SIZE,
          retirementAdmissionByteThreshold: 0,
        }),
    ).toThrow();
    expect(
      () =>
        new ProcessMemoryAllocator({
          maxMemories: 1,
          maxTotalBytes: -1,
        }),
    ).toThrow();
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 1,
      maxTotalBytes: 4 * WASM_PAGE_SIZE,
    });
    const leased = allocator.acquire(request(2, 16));
    expect(() => allocator.clear()).toThrow(/leased/);
    leased.release();
    expect(() => allocator.clear()).not.toThrow();

    expect(() => allocator.acquire(request(0, 16))).toThrow();
    expect(() => allocator.acquire(request(4.5, 16))).toThrow();
    expect(() => allocator.acquire(request(17, 16))).toThrow();
    expect(() => allocator.acquire(request(4, 0))).toThrow();
  });

  it("derives retirement admission thresholds independently from live maximum bytes", () => {
    expect(
      deriveProcessMemoryRetirementAdmissionThresholds(
        4,
        4 * 1024 * 1024 * 1024,
      ),
    ).toEqual({
      retirementAdmissionMemoryThreshold: 8,
      retirementAdmissionByteThreshold: 256 * 1024 * 1024,
    });
    expect(
      deriveProcessMemoryRetirementAdmissionThresholds(
        100,
        64 * 1024 * 1024,
      ),
    ).toEqual({
      retirementAdmissionMemoryThreshold: 32,
      retirementAdmissionByteThreshold: 64 * 1024 * 1024,
    });
  });

  it("copies across bounded view boundaries", () => {
    const source = new ArrayBuffer(17);
    const destination = new ArrayBuffer(17);
    new Uint8Array(source).set(
      Array.from({ length: 17 }, (_, index) => index + 1),
    );
    copyArrayBufferInChunks(destination, source, 4);
    expect(new Uint8Array(destination)).toEqual(new Uint8Array(source));
    expect(() =>
      copyArrayBufferInChunks(new ArrayBuffer(16), source, 4)
    ).toThrow();
    expect(() => copyArrayBufferInChunks(destination, source, 0)).toThrow();
  });
});
