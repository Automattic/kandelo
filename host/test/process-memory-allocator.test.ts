import { describe, expect, it, vi } from "vitest";

import { WASM_PAGE_SIZE } from "../src/constants";
import {
  acquireForkMemoryClone,
  copyArrayBufferInChunks,
  copyIntoZeroedArrayBuffer,
  copyProcessAddressSpace,
  createProcessMemoryRetirementPressureHook,
  deriveProcessMemoryRetirementAdmissionThresholds,
  ProcessMemoryAllocator,
  ProcessMemoryCapacityError,
  ProcessMemoryRetirementBacklogError,
  type ProcessMemoryAllocationRequest,
  type ProcessMemoryAllocatorOptions,
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
  it("reports native constructor exhaustion as ENOMEM without consuming admission", () => {
    const exhausted = new RangeError("native reservation exhausted");
    const construction = vi.spyOn(WebAssembly, "Memory").mockImplementationOnce(function () {
      throw exhausted;
    });
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 1,
      maxTotalBytes: 4 * WASM_PAGE_SIZE,
    });
    try {
      expect(() => allocator.acquire(request(1))).toThrow(ProcessMemoryCapacityError);
      expect(allocator.getRetirementStats()).toMatchObject({
        liveMemories: 0, chargedMemories: 0, chargedBytes: 0,
      });
      construction.mockRestore();
      const healthy = allocator.acquire(request(1));
      healthy.release();
      allocator.clear();
    } finally {
      construction.mockRestore();
    }
  });

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

  it("counts retained aliases once and retires only after the final release", () => {
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 1,
      maxTotalBytes: 4 * WASM_PAGE_SIZE,
      retirementBackpressureMs: 1_000,
    });
    const owner = allocator.acquire(request(4));
    const alias = owner.retainAlias();

    expect(alias.memory).toBe(owner.memory);
    expect(allocator.getRetirementStats()).toMatchObject({
      liveMemories: 1,
      liveAliases: 2,
      liveBytes: 4 * WASM_PAGE_SIZE,
      pendingRetirements: 0,
      retirementBacklogMemories: 0,
    });
    expect(() => allocator.acquire(request(1))).toThrow(
      ProcessMemoryCapacityError,
    );

    owner.release();
    expect(() => owner.memory).toThrow("already consumed");
    new Uint8Array(alias.memory.buffer)[17] = 0x5a;
    expect(allocator.getRetirementStats()).toMatchObject({
      liveMemories: 1,
      liveAliases: 1,
      liveBytes: 4 * WASM_PAGE_SIZE,
      pendingRetirements: 0,
    });

    alias.release();
    expect(allocator.getRetirementStats()).toMatchObject({
      liveMemories: 0,
      liveAliases: 0,
      liveBytes: 0,
      pendingRetirements: 1,
      retirementBacklogMemories: 1,
      retirementBacklogBytes: 4 * WASM_PAGE_SIZE,
    });
    allocator.clear();
  });

  it("taints all aliases after forced termination until final retirement", async () => {
    const retirements: string[] = [];
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 1,
      maxTotalBytes: 4 * WASM_PAGE_SIZE,
      retirementBackpressureMs: 1_000,
      retirementPressureHook: ({ retirementMode }) => {
        retirements.push(retirementMode);
      },
    });
    const owner = allocator.acquire(request(4));
    const alias = owner.retainAlias();

    alias.releaseAfterForcedTermination();
    expect(allocator.getRetirementStats()).toMatchObject({
      liveMemories: 1,
      liveAliases: 1,
      pendingRetirements: 0,
    });
    expect(() => owner.retainAlias()).toThrow(
      "Cannot retain process memory after forced termination",
    );

    owner.release();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(retirements).toEqual(["forced"]);
    expect(allocator.getRetirementStats()).toMatchObject({
      liveMemories: 0,
      liveAliases: 0,
      pendingRetirements: 1,
    });
    allocator.clear();
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

  it("rejects fork before allocating or copying when retirement debt is saturated", () => {
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 3,
      maxTotalBytes: 12 * WASM_PAGE_SIZE,
      retirementAdmissionMemoryThreshold: 1,
      retirementAdmissionByteThreshold: 4 * WASM_PAGE_SIZE,
      retirementBackpressureMs: 1_000,
      maxRetirementTelemetryRecords: 0,
    });
    const parent = allocator.acquire(request(4));
    const retiring = allocator.acquire(request(4));
    retiring.release();

    new Uint8Array(parent.memory.buffer).fill(0x5a);
    const memoryConstructor = vi.spyOn(WebAssembly, "Memory");
    try {
      expect(() => acquireForkMemoryClone(
        allocator,
        parent.memory,
        4,
        32,
      )).toThrow(ProcessMemoryRetirementBacklogError);
      expect(memoryConstructor).not.toHaveBeenCalled();
    } finally {
      memoryConstructor.mockRestore();
    }
    expect(allocator.getRetirementStats()).toMatchObject({
      liveMemories: 1,
      liveBytes: 4 * WASM_PAGE_SIZE,
      retirementBacklogMemories: 1,
      retirementBacklogBytes: 4 * WASM_PAGE_SIZE,
    });
    expect(new Uint8Array(parent.memory.buffer)[17]).toBe(0x5a);

    parent.release();
    allocator.clear();
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
    expect(() => lease.retainAlias()).toThrow("already consumed");
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

  it("copies across bounded view boundaries and zero chunks", () => {
    const source = new ArrayBuffer(17);
    const destination = new ArrayBuffer(17);
    new Uint8Array(source).set(
      Array.from({ length: 17 }, (_, index) => (index >> 2) % 2 ? 0 : index + 1),
    );
    copyIntoZeroedArrayBuffer(destination, source, 4);
    expect(new Uint8Array(destination)).toEqual(new Uint8Array(source));
    expect(() =>
      copyIntoZeroedArrayBuffer(new ArrayBuffer(16), source, 4)
    ).toThrow();
    expect(() => copyIntoZeroedArrayBuffer(destination, source, 0)).toThrow();
    expect(() => copyIntoZeroedArrayBuffer(destination, source, 6)).toThrow();
  });

  it("does not write the destination chunks whose source is all zero", () => {
    const source = new ArrayBuffer(12);
    const destination = new ArrayBuffer(12);
    new Uint8Array(source).set([1, 2, 3, 4], 8);
    new Uint8Array(destination).fill(0xff);
    copyIntoZeroedArrayBuffer(destination, source, 4);
    expect([...new Uint8Array(destination)]).toEqual([
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 1, 2, 3, 4,
    ]);
  });

  it("writes every destination chunk in dense mode", () => {
    const source = new ArrayBuffer(12);
    const destination = new ArrayBuffer(12);
    new Uint8Array(source).set([1, 2, 3, 4], 8);
    new Uint8Array(destination).fill(0xff);
    copyArrayBufferInChunks(destination, source, 4);
    expect(new Uint8Array(destination)).toEqual(new Uint8Array(source));
    expect(() => copyArrayBufferInChunks(new ArrayBuffer(8), source, 4)).toThrow();
    expect(() => copyArrayBufferInChunks(destination, source, 0)).toThrow();
  });

  it("selects the fork copy by mode", () => {
    const source = new ArrayBuffer(2 * WASM_PAGE_SIZE);
    new Uint8Array(source)[2 * WASM_PAGE_SIZE - 1] = 7;
    const stale = (): ArrayBuffer => {
      const buffer = new ArrayBuffer(source.byteLength);
      new Uint8Array(buffer).fill(0xff);
      return buffer;
    };
    // A non-fresh destination exposes which pages each mode wrote.
    const sparse = new Uint8Array(stale());
    copyProcessAddressSpace("sparse", sparse.buffer, source);
    expect(sparse[0]).toBe(0xff);
    expect(sparse[2 * WASM_PAGE_SIZE - 1]).toBe(7);
    const dense = new Uint8Array(stale());
    copyProcessAddressSpace("dense", dense.buffer, source);
    expect(dense).toEqual(new Uint8Array(source));
  });

  it.each(["sparse", "dense"] as const)("clones a fork address space exactly with %s copy", (forkCopy) => {
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 4,
      maxTotalBytes: 16 * WASM_PAGE_SIZE,
      forkCopy,
    });
    const parentLease = allocator.acquire(request(3, 8));
    const parentBytes = new Uint8Array(parentLease.memory.buffer);
    parentBytes[1] = 0x11;
    parentBytes[parentBytes.length - 1] = 0xee;
    const childLease = acquireForkMemoryClone(allocator, parentLease.memory, 4, 8);
    expect(new Uint8Array(childLease.memory.buffer)).toEqual(parentBytes);
    childLease.release();
    parentLease.release();
  });

  it("rejects an unknown fork copy mode", () => {
    expect(() => new ProcessMemoryAllocator({
      maxMemories: 1,
      maxTotalBytes: WASM_PAGE_SIZE,
      forkCopy: "lazy" as never,
    })).toThrow(/fork address-space copy mode/);
  });
});


describe("allocator-owned execution admission metadata (activation disabled)", () => {
  function allocator() {
    return new ProcessMemoryAllocator({
      maxMemories: 3,
      maxTotalBytes: 16 * WASM_PAGE_SIZE,
      retirementBackpressureMs: 0,
    });
  }

  it("shares only opaque metadata across exact aliases and isolates fresh generations", () => {
    const memoryAllocator = allocator();
    const lease = memoryAllocator.acquire(request(2));
    const owner = lease.executionOwner;
    const before = owner.snapshot();
    const alias = lease.retainAlias();
    const fresh = memoryAllocator.acquire(request(2));
    expect(alias.executionOwner).toBe(owner);
    expect(fresh.executionOwner).not.toBe(owner);
    expect(owner.snapshot().admissionEpoch).toBeGreaterThan(before.admissionEpoch);
    expect(Object.isFrozen(owner)).toBe(true);
    expect(Object.isFrozen(before)).toBe(true);
    expect(before).toEqual({ admissionEpoch: 0, pendingReservations: 0,
      exposures: 0, unknown: false, forced: false, retired: false });
    expect(Object.keys(owner)).toEqual(["snapshot"]);
    expect(Object.values(owner).some(value => value instanceof WebAssembly.Memory)).toBe(false);
    lease.release();
    expect(owner.snapshot().retired).toBe(false);
    alias.release();
    expect(owner.snapshot().retired).toBe(true);
    expect(fresh.executionOwner.snapshot().retired).toBe(false);
    fresh.release();
    memoryAllocator.clear();
  });

  it("reserves and consumes before Memory escapes with once-only admission", () => {
    const memoryAllocator = allocator();
    const lease = memoryAllocator.acquire(request(2));
    const before = lease.executionOwner.snapshot();
    const token = lease.reserveWriter();
    expect(Object.isFrozen(token)).toBe(true);
    expect(token.owner).toBe(lease.executionOwner);
    const reserved = token.owner.snapshot();
    expect(reserved.admissionEpoch).toBeGreaterThan(before.admissionEpoch);
    expect(reserved).toMatchObject({ pendingReservations: 1, exposures: 0, unknown: false });
    const memory = token.exposeMemory();
    expect(memory).toBeInstanceOf(WebAssembly.Memory);
    expect(memory.buffer.byteLength).toBe(2 * WASM_PAGE_SIZE);
    expect(token.owner.snapshot()).toMatchObject({ pendingReservations: 0, exposures: 1, unknown: false });
    expect(token.owner.snapshot().admissionEpoch).toBeGreaterThan(reserved.admissionEpoch);
    const exposed = token.owner.snapshot();
    expect(() => token.exposeMemory()).toThrow("already exposed");
    expect(() => token.cancelBeforeExposure()).toThrow("already exposed");
    expect(token.owner.snapshot()).toEqual(exposed);
    const next = lease.reserveWriter();
    expect(next.id).toBeGreaterThan(token.id);
    expect(next.exposeMemory()).toBe(memory);
    expect(token.owner.snapshot().exposures).toBe(2); // Cumulative, not live writers.
    lease.release();
    memoryAllocator.clear();
  });

  it("bounds reservations per lease and allocates IDs across aliases without reuse", () => {
    const memoryAllocator = allocator();
    const lease = memoryAllocator.acquire(request(2));
    const alias = lease.retainAlias();
    const first = lease.reserveWriter();
    const beforeRefusal = first.owner.snapshot();
    expect(() => lease.reserveWriter()).toThrow("already has a writer reservation");
    expect(first.owner.snapshot()).toEqual(beforeRefusal);
    const second = alias.reserveWriter();
    expect(second.id).toBeGreaterThan(first.id);
    expect(first.owner.snapshot().pendingReservations).toBe(2);
    first.cancelBeforeExposure();
    const cancelled = first.owner.snapshot();
    expect(() => first.cancelBeforeExposure()).toThrow("already cancelled");
    expect(() => first.exposeMemory()).toThrow("already cancelled");
    expect(first.owner.snapshot()).toEqual(cancelled);
    const third = lease.reserveWriter();
    expect(third.id).toBeGreaterThan(second.id);
    third.cancelBeforeExposure();
    second.cancelBeforeExposure();
    expect(first.owner.snapshot()).toMatchObject({ pendingReservations: 0, exposures: 0 });
    lease.release(); alias.release(); memoryAllocator.clear();
  });

  it("invalidates only the consumed lease's outstanding token while its alias stays live", () => {
    const memoryAllocator = allocator();
    const lease = memoryAllocator.acquire(request(2));
    const alias = lease.retainAlias();
    const stale = lease.reserveWriter();
    const live = alias.reserveWriter();
    lease.release();
    expect(stale.owner.snapshot()).toMatchObject({ pendingReservations: 1, retired: false });
    expect(() => stale.exposeMemory()).toThrow("already consumed");
    expect(() => stale.cancelBeforeExposure()).toThrow("already consumed");
    expect(() => lease.reserveWriter()).toThrow("already consumed");
    expect(live.exposeMemory()).toBeInstanceOf(WebAssembly.Memory);
    alias.release();
    expect(stale.owner.snapshot()).toMatchObject({ pendingReservations: 0, retired: true });
    memoryAllocator.clear();
  });

  it("keeps unknown raw exposure sticky through later explicit admissions", () => {
    const memoryAllocator = allocator();
    const lease = memoryAllocator.acquire(request(2));
    const before = lease.executionOwner.snapshot();
    const memory = lease.memory;
    expect(lease.executionOwner.snapshot().unknown).toBe(true);
    expect(lease.executionOwner.snapshot().admissionEpoch).toBeGreaterThan(before.admissionEpoch);
    const token = lease.reserveWriter();
    expect(token.exposeMemory()).toBe(memory);
    expect(token.owner.snapshot().unknown).toBe(true);
    lease.release();
    expect(token.owner.snapshot()).toMatchObject({ unknown: true, retired: true });
    memoryAllocator.clear();
  });

  it("does not trust an injected construction callback even when it returns a valid fresh Memory", async () => {
    const memoryAllocator = new ProcessMemoryAllocator({
      maxMemories: 1, maxTotalBytes: 4 * WASM_PAGE_SIZE,
      createMemoryAsync: async request => new WebAssembly.Memory({
        initial: request.initialPages, maximum: request.maximumPages, shared: true,
      }),
    });
    const lease = await memoryAllocator.acquireWhenAvailable(request(2));
    expect(lease.executionOwner.snapshot().unknown).toBe(true);
    lease.reserveWriter().cancelBeforeExposure();
    expect(lease.executionOwner.snapshot().unknown).toBe(true);
    lease.release(); memoryAllocator.clear();
  });

  it("poisons pending and new admissions across all aliases after forced termination", () => {
    const memoryAllocator = allocator();
    const lease = memoryAllocator.acquire(request(2));
    const alias = lease.retainAlias();
    const pending = lease.reserveWriter();
    alias.releaseAfterForcedTermination();
    expect(pending.owner.snapshot()).toMatchObject({ forced: true, unknown: true, retired: false });
    expect(() => pending.exposeMemory()).toThrow("after forced termination");
    expect(() => pending.cancelBeforeExposure()).toThrow("after forced termination");
    expect(() => lease.reserveWriter()).toThrow("after forced termination");
    // Preserve the old raw getter contract; it supplies no new safe admission.
    expect(lease.memory).toBeInstanceOf(WebAssembly.Memory);
    lease.release();
    expect(pending.owner.snapshot()).toMatchObject({ forced: true, retired: true, pendingReservations: 0 });
    expect(() => pending.exposeMemory()).toThrow("already consumed");
    memoryAllocator.clear();
  });

  it("binds unknown creator provenance to the actual path despite callback mutation", async () => {
    const options: ProcessMemoryAllocatorOptions = {
      maxMemories: 1, maxTotalBytes: 4 * WASM_PAGE_SIZE,
      createMemoryAsync: async request => {
        delete options.createMemoryAsync;
        return new WebAssembly.Memory({
          initial: request.initialPages, maximum: request.maximumPages, shared: true,
        });
      },
    };
    const memoryAllocator = new ProcessMemoryAllocator(options);
    const lease = await memoryAllocator.acquireWhenAvailable(request(2));
    expect(options.createMemoryAsync).toBeUndefined();
    expect(lease.executionOwner.snapshot().unknown).toBe(true);
    lease.release(); memoryAllocator.clear();
  });

  it("cannot retarget stale tokens to a fresh exec-style allocation", () => {
    const memoryAllocator = allocator();
    const old = memoryAllocator.acquire(request(2));
    const token = old.reserveWriter();
    old.release();
    const fresh = memoryAllocator.acquire(request(2));
    expect(token.owner).not.toBe(fresh.executionOwner);
    const freshBefore = fresh.executionOwner.snapshot();
    expect(() => token.exposeMemory()).toThrow("already consumed");
    expect(() => token.cancelBeforeExposure()).toThrow("already consumed");
    expect(fresh.executionOwner.snapshot()).toEqual(freshBefore);
    fresh.release(); memoryAllocator.clear();
  });

  it("does not publish a reservation if its weak token allocation fails", () => {
    const memoryAllocator = allocator();
    const lease = memoryAllocator.acquire(request(2));
    const before = lease.executionOwner.snapshot();
    try {
      vi.stubGlobal("WeakRef", class {
        constructor() { throw new Error("injected token allocation failure"); }
      });
      expect(() => lease.reserveWriter()).toThrow("injected token allocation failure");
      expect(lease.executionOwner.snapshot()).toEqual(before);
    } finally { vi.unstubAllGlobals(); }
    const token = lease.reserveWriter();
    expect(token.id).toBe(1);
    token.cancelBeforeExposure();
    lease.release(); memoryAllocator.clear();
  });

  it("fails closed if a token's weak lease reference has cleared", () => {
    const memoryAllocator = allocator();
    const lease = memoryAllocator.acquire(request(2));
    try {
      // Deterministic cleared-reference branch; not a claim about GC timing.
      vi.stubGlobal("WeakRef", class {
        deref() { return undefined; }
      });
      const token = lease.reserveWriter();
      expect(() => token.exposeMemory()).toThrow("already consumed");
      expect(() => token.cancelBeforeExposure()).toThrow("already consumed");
      expect(token.owner.snapshot().pendingReservations).toBe(1);
      lease.release();
      expect(token.owner.snapshot()).toMatchObject({ pendingReservations: 0, retired: true });
    } finally { vi.unstubAllGlobals(); memoryAllocator.clear(); }
  });

  it.each([false, true])("retains retryable lease custody after a backing check throws (forced=%s)", forced => {
    const memoryAllocator = allocator();
    const lease = memoryAllocator.acquire(request(2));
    const memory = lease.reserveWriter().exposeMemory();
    const token = lease.reserveWriter();
    const buffer = vi.spyOn(memory, "buffer", "get").mockImplementationOnce(() => {
      throw new Error("injected backing check failure");
    });
    try {
      expect(() => forced ? lease.releaseAfterForcedTermination() : lease.release())
        .toThrow("injected backing check failure");
      expect(token.owner.snapshot()).toMatchObject({ pendingReservations: 1, retired: false, forced });
      expect(memoryAllocator.getRetirementStats()).toMatchObject({ liveMemories: 1, liveAliases: 1 });
      if (forced) expect(() => token.exposeMemory()).toThrow("after forced termination");
      else token.cancelBeforeExposure();
    } finally { buffer.mockRestore(); }
    lease.release();
    expect(token.owner.snapshot()).toMatchObject({ pendingReservations: 0, retired: true, forced });
    memoryAllocator.clear();
  });
});
