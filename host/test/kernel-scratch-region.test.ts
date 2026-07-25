import { describe, expect, it, vi } from "vitest";

import {
  allocateKernelScratchRegion,
  checkedMemoryRange,
  type KernelScratchDataView,
  type KernelScratchLease,
  KernelScratchError,
  reserveKernelScratchRegion,
} from "../src/kernel-scratch";

function memory(pages = 1): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: pages, maximum: pages });
}

function syntheticMemory(byteLength: number): WebAssembly.Memory {
  return {
    buffer: { byteLength },
  } as unknown as WebAssembly.Memory;
}

function installDataViewConstructorCounter(): {
  count: () => number;
  restore: () => void;
} {
  const NativeDataView = globalThis.DataView;
  let constructions = 0;
  class CountingDataView extends NativeDataView {
    constructor(
      buffer: ArrayBufferLike,
      byteOffset?: number,
      byteLength?: number,
    ) {
      super(buffer, byteOffset, byteLength);
      constructions++;
    }
  }
  vi.stubGlobal("DataView", CountingDataView);
  return {
    count: () => constructions,
    restore: () => vi.unstubAllGlobals(),
  };
}

describe("KernelScratchRegion", () => {
  it.each([4, 8] as const)(
    "accepts exact-capacity copies and rejects capacity + 1 for wasm%d",
    (pointerWidth) => {
      const kernelMemory = memory();
      const region = allocateKernelScratchRegion(
        kernelMemory,
        vi.fn(() => pointerWidth === 8 ? 4096n : 4096),
        32,
        pointerWidth,
        "test scratch",
      );

      region.withLease((scratch) => {
        scratch.copyFrom(new Uint8Array(32).fill(0x5a));
      });
      expect(new Uint8Array(kernelMemory.buffer, 4096, 32))
        .toEqual(new Uint8Array(32).fill(0x5a));

      expect(() => region.withLease((scratch) => {
        scratch.copyFrom(new Uint8Array(33));
      })).toThrow(KernelScratchError);
    },
  );

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 4096.5],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["negative bigint", -1n],
    ["unrepresentable bigint", BigInt(Number.MAX_SAFE_INTEGER) + 1n],
  ])("rejects a %s allocator pointer", (_name, pointer) => {
    expect(() => allocateKernelScratchRegion(
      memory(),
      () => pointer,
      32,
      8,
      "test scratch",
    )).toThrow(KernelScratchError);
  });

  it("rejects wasm32 pointers outside the wasm32 address space", () => {
    expect(() => allocateKernelScratchRegion(
      memory(),
      () => 0x1_0000_0000n,
      32,
      4,
      "test scratch",
    )).toThrow(KernelScratchError);
  });

  it("normalizes the signed high bit of a wasm32 allocator result", () => {
    const region = allocateKernelScratchRegion(
      syntheticMemory(0x8001_0000),
      () => -0x8000_0000,
      65_536,
      4,
      "high wasm32 allocation",
    );

    expect(region.withLease((scratch) =>
      scratch.address(0, 65_536)
    )).toBe(0x8000_0000);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("rejects a %s capacity", (_name, capacity) => {
    expect(() => allocateKernelScratchRegion(
      memory(),
      () => 4096,
      capacity,
      4,
      "test scratch",
    )).toThrow(KernelScratchError);
  });

  it("rejects allocator capacity above u32 before calling Wasm", () => {
    const allocator = vi.fn(() => 4096);
    expect(() => allocateKernelScratchRegion(
      syntheticMemory(0x1_0001_0001),
      allocator,
      0x1_0000_0000,
      8,
      "oversized allocator request",
    )).toThrow(/u32/i);
    expect(allocator).not.toHaveBeenCalled();
  });

  it("rejects allocation failure and an allocation outside current memory", () => {
    expect(() => allocateKernelScratchRegion(
      memory(),
      () => 0,
      32,
      4,
      "test scratch",
    )).toThrow(KernelScratchError);
    expect(() => allocateKernelScratchRegion(
      memory(),
      () => 65_520,
      32,
      4,
      "test scratch",
    )).toThrow(KernelScratchError);
  });

  it("revalidates the current memory buffer before each operation", () => {
    const kernelMemory = memory();
    const region = allocateKernelScratchRegion(
      kernelMemory,
      () => 65_504,
      32,
      4,
      "test scratch",
    );

    expect(() => region.withLease((scratch) => {
      scratch.copyFrom(new Uint8Array(32), 1);
    })).toThrow(KernelScratchError);
    expect(new Uint8Array(kernelMemory.buffer, 65_504, 32))
      .toEqual(new Uint8Array(32));
  });

  it("rejects negative, fractional, unsafe, and overflowing copy ranges", () => {
    const region = allocateKernelScratchRegion(
      memory(),
      () => 4096,
      32,
      4,
      "test scratch",
    );
    for (const bad of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => region.withLease((scratch) => {
        scratch.copyFrom(new Uint8Array(1), bad);
      })).toThrow(KernelScratchError);
    }
    expect(() => region.withLease((scratch) => {
      scratch.copyFrom(new Uint8Array(8), 28);
    })).toThrow(KernelScratchError);
  });

  it("permits sequential leases and rejects nested or asynchronous reuse", async () => {
    const region = allocateKernelScratchRegion(
      memory(),
      () => 4096,
      32,
      4,
      "test scratch",
    );

    region.withLease((scratch) => scratch.fill(1, 0, 32));
    region.withLease((scratch) => scratch.fill(2, 0, 32));

    expect(() => region.withLease(() => {
      region.withLease(() => undefined);
    })).toThrow(/already in use/i);

    expect(() => region.withLease(async () => undefined))
      .toThrow(/synchronous/i);
    await Promise.resolve();
  });

  it("revokes a lease before inspecting a hostile then getter", () => {
    const kernelMemory = memory();
    const region = allocateKernelScratchRegion(
      kernelMemory,
      () => 4096,
      32,
      4,
      "test scratch",
    );
    let escaped: KernelScratchLease | undefined;
    const hostileResult = Object.defineProperty({}, "then", {
      get() {
        escaped!.fill(0x7f, 0, 1);
        return undefined;
      },
    });

    expect(() => region.withLease((scratch) => {
      escaped = scratch;
      return hostileResult;
    })).toThrow(/no longer active/i);
    expect(new Uint8Array(kernelMemory.buffer)[4096]).toBe(0);

    // The rejected return object did not strand the reusable region.
    region.withLease((scratch) => scratch.fill(0x2a, 0, 1));
    expect(new Uint8Array(kernelMemory.buffer)[4096]).toBe(0x2a);
  });

  it("reuses a native data view while revoking every post-lease access", () => {
    const region = allocateKernelScratchRegion(
      memory(),
      () => 4096,
      32,
      4,
      "test scratch",
    );
    const counter = installDataViewConstructorCounter();
    let escaped: KernelScratchDataView | undefined;
    try {
      region.withLease((scratch) => {
        escaped = scratch.dataView(0, 4);
        expect(counter.count()).toBe(1);
        escaped.setUint32(0, 0x1234_5678, true);
        expect(escaped.getUint16(0, true)).toBe(0x5678);
        expect(escaped.byteLength).toBe(4);
        expect(counter.count()).toBe(1);
      });

      expect(() => escaped!.setUint32(0, 0, true))
        .toThrow(/no longer active/i);
      expect(counter.count()).toBe(1);
    } finally {
      counter.restore();
    }
  });

  it("detaches copyTo input before invoking a caller-owned receiver", () => {
    const kernelMemory = memory();
    const region = allocateKernelScratchRegion(
      kernelMemory,
      () => 4096,
      32,
      4,
      "test scratch",
    );
    new Uint8Array(kernelMemory.buffer, 4096, 32).fill(0x5a);
    let retained: Uint8Array | undefined;
    let reentryError: unknown;
    class HostileDestination extends Uint8Array {
      override set(source: ArrayLike<number>, offset?: number): void {
        retained = source as Uint8Array;
        try {
          region.withLease(() => undefined);
        } catch (error) {
          reentryError = error;
        }
        super.set(source, offset);
      }
    }
    const destination = new HostileDestination(32);

    region.withLease((scratch) => scratch.copyTo(destination));

    expect(Uint8Array.from(destination))
      .toEqual(new Uint8Array(32).fill(0x5a));
    expect(reentryError).toBeInstanceOf(KernelScratchError);
    expect(retained!.buffer).not.toBe(kernelMemory.buffer);
    retained![0] = 0;
    expect(new Uint8Array(kernelMemory.buffer, 4096, 1)[0]).toBe(0x5a);
  });

  it("ignores a hostile source subarray override after proving length", () => {
    const kernelMemory = memory();
    const region = allocateKernelScratchRegion(
      kernelMemory,
      () => 4096,
      32,
      4,
      "test scratch",
    );
    const sentinel = new Uint8Array(kernelMemory.buffer, 4096 + 32, 32);
    sentinel.fill(0xa5);
    class HostileSource extends Uint8Array {
      override subarray(): Uint8Array {
        return new Uint8Array(64).fill(0xff);
      }
    }
    const source = new HostileSource(32);
    source.fill(0x6c);

    region.withLease((scratch) => scratch.copyFrom(source));

    expect(new Uint8Array(kernelMemory.buffer, 4096, 32))
      .toEqual(new Uint8Array(32).fill(0x6c));
    expect(sentinel).toEqual(new Uint8Array(32).fill(0xa5));
  });

  it("rechecks and refreshes one guarded view after shared memory growth", () => {
    const kernelMemory = new WebAssembly.Memory({
      initial: 1,
      maximum: 2,
      shared: true,
    });
    const region = allocateKernelScratchRegion(
      kernelMemory,
      () => 4096,
      32,
      4,
      "test scratch",
    );
    const counter = installDataViewConstructorCounter();

    try {
      region.withLease((scratch) => {
        const view = scratch.dataView(0, 8);
        view.setUint32(0, 0x1234_5678, true);
        expect(counter.count()).toBe(1);

        const previousBuffer = kernelMemory.buffer;
        kernelMemory.grow(1);
        expect(kernelMemory.buffer).not.toBe(previousBuffer);

        view.setUint32(4, 0x90ab_cdef, true);
        expect(view.getUint32(0, true)).toBe(0x1234_5678);
        expect(counter.count()).toBe(2);
      });
    } finally {
      counter.restore();
    }

    const output = new DataView(kernelMemory.buffer, 4096, 8);
    expect(output.getUint32(4, true)).toBe(0x90ab_cdef);
  });

  it.each([4, 8] as const)(
    "validates a reserved pointer plus capacity for wasm%d",
    (pointerWidth) => {
      const kernelMemory = memory();
      const region = reserveKernelScratchRegion(
        kernelMemory,
        vi.fn(() => ({
          pointer: pointerWidth === 8 ? 4096n : 4096,
          capacity: pointerWidth === 8 ? 48n : 48,
        })),
        32,
        pointerWidth,
        "reserved scratch",
      );

      region.withLease((scratch) => {
        scratch.copyFrom(new Uint8Array(48).fill(0x6b));
      });
      expect(new Uint8Array(kernelMemory.buffer, 4096, 48))
        .toEqual(new Uint8Array(48).fill(0x6b));
      expect(() => region.withLease((scratch) => {
        scratch.copyFrom(new Uint8Array(1));
      })).toThrow(/single-use/i);

      const overflowRegion = reserveKernelScratchRegion(
        kernelMemory,
        () => ({
          pointer: pointerWidth === 8 ? 8192n : 8192,
          capacity: pointerWidth === 8 ? 48n : 48,
        }),
        32,
        pointerWidth,
        "reserved overflow scratch",
      );
      expect(() => overflowRegion.withLease((scratch) => {
        scratch.copyFrom(new Uint8Array(49));
      })).toThrow(KernelScratchError);
    },
  );

  it("normalizes the signed high bit of a wasm32 reservation result", () => {
    const region = reserveKernelScratchRegion(
      syntheticMemory(0x8001_0000),
      () => ({
        pointer: -0x8000_0000,
        capacity: 65_536,
      }),
      65_536,
      4,
      "high wasm32 reservation",
    );

    expect(region.withLease((scratch) =>
      scratch.address(0, 65_536)
    )).toBe(0x8000_0000);
  });

  it("cannot reuse or revive a reservation-derived region", () => {
    const kernelMemory = memory();
    const region = reserveKernelScratchRegion(
      kernelMemory,
      () => ({ pointer: 4096, capacity: 32 }),
      32,
      4,
      "one-shot reservation",
    );

    region.withLease((scratch) => {
      scratch.copyFrom(new Uint8Array(32).fill(0x4d));
    });
    expect(() => region.withLease(() => undefined))
      .toThrow(/single-use/i);
    region.revoke();
    expect(() => region.withLease(() => undefined))
      .toThrow(/no longer valid/i);

    const cancelled = reserveKernelScratchRegion(
      kernelMemory,
      () => ({ pointer: 8192, capacity: 32 }),
      32,
      4,
      "cancelled reservation",
    );
    cancelled.revoke();
    expect(() => cancelled.withLease(() => undefined))
      .toThrow(/no longer valid/i);
  });

  it.each([
    ["zero minimum", 0, { pointer: 4096, capacity: 32 }],
    ["negative minimum", -1, { pointer: 4096, capacity: 32 }],
    ["fractional minimum", 1.5, { pointer: 4096, capacity: 32 }],
    ["failed pointer", 32, { pointer: 0, capacity: 32 }],
    ["short capacity", 32, { pointer: 4096, capacity: 31 }],
    ["negative capacity", 32, { pointer: 4096, capacity: -1 }],
    ["fractional capacity", 32, { pointer: 4096, capacity: 32.5 }],
    [
      "unsafe capacity",
      32,
      { pointer: 4096, capacity: Number.MAX_SAFE_INTEGER + 1 },
    ],
    ["range beyond memory", 32, { pointer: 65_520, capacity: 32 }],
  ])("rejects a %s reservation", (_name, minimum, reservation) => {
    expect(() => reserveKernelScratchRegion(
      memory(),
      () => reservation,
      minimum,
      4,
      "reserved scratch",
    )).toThrow(KernelScratchError);
  });
});

describe("checkedMemoryRange", () => {
  it.each([4, 8] as const)(
    "accepts the exact end of memory for wasm%d",
    (pointerWidth) => {
      const kernelMemory = memory();
      expect(checkedMemoryRange(
        kernelMemory,
        65_504,
        32,
        pointerWidth,
        "Rust-owned output",
      )).toEqual({ pointer: 65_504, length: 32, end: 65_536 });
    },
  );

  it.each([
    ["null positive range", 0, 1],
    ["negative pointer", -1, 1],
    ["fractional pointer", 1.5, 1],
    ["unsafe pointer", Number.MAX_SAFE_INTEGER + 1, 1],
    ["negative length", 1, -1],
    ["fractional length", 1, 1.5],
    ["unsafe length", 1, Number.MAX_SAFE_INTEGER + 1],
    ["end beyond memory", 65_535, 2],
  ])("rejects %s", (_name, pointer, length) => {
    expect(() => checkedMemoryRange(
      memory(),
      pointer,
      length,
      8,
      "Rust-owned output",
    )).toThrow(KernelScratchError);
  });

  it("allows a null pointer only for an empty range", () => {
    expect(checkedMemoryRange(
      memory(),
      0,
      0,
      4,
      "empty output",
    )).toEqual({ pointer: 0, length: 0, end: 0 });
  });
});
