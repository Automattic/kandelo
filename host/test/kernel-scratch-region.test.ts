import { describe, expect, it, vi } from "vitest";

import {
  allocateKernelScratchRegion,
  checkedMemoryRange,
  type KernelScratchDataView,
  KernelScratchError,
  reserveKernelScratchRegion,
} from "../src/kernel-scratch";

function memory(pages = 1): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: pages, maximum: pages });
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

  it("revokes an escaped data view when its lease ends", () => {
    const region = allocateKernelScratchRegion(
      memory(),
      () => 4096,
      32,
      4,
      "test scratch",
    );
    let escaped: KernelScratchDataView | undefined;
    region.withLease((scratch) => {
      escaped = scratch.dataView(0, 4);
      escaped.setUint32(0, 0x1234_5678, true);
    });

    expect(() => escaped!.setUint32(0, 0, true))
      .toThrow(/no longer active/i);
  });

  it("reacquires a guarded data view after in-lease memory growth", () => {
    const kernelMemory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    const region = allocateKernelScratchRegion(
      kernelMemory,
      () => 4096,
      32,
      4,
      "test scratch",
    );

    region.withLease((scratch) => {
      const view = scratch.dataView(0, 8);
      view.setUint32(0, 0x1234_5678, true);
      kernelMemory.grow(1);
      view.setUint32(4, 0x90ab_cdef, true);
      expect(view.getUint32(0, true)).toBe(0x1234_5678);
    });

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
        scratch.copyFrom(new Uint8Array(49));
      })).toThrow(KernelScratchError);
    },
  );

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
