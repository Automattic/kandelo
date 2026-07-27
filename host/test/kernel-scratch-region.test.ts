import { describe, expect, it, vi } from "vitest";

import * as kernelScratchModule from "../src/kernel-scratch";
import {
  allocateKernelScratchRegion,
  checkedKernelExportPointer,
  checkedMemoryRange,
  type KernelScratchDataView,
  type KernelScratchLease,
  KernelScratchError,
  reserveKernelScratchRegion,
} from "../src/kernel-scratch";
import {
  createKernelEntryGatedInstance,
  createKernelEntryScopedInstance,
  KernelEntryGate,
} from "../src/kernel-entry-gate";

function memory(pages = 1): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: pages, maximum: pages });
}

type WasmValueType = "i32" | "i64";

function unsignedLeb128(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function wasmString(value: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(value));
  return [...unsignedLeb128(bytes.length), ...bytes];
}

function wasmSection(id: number, payload: number[]): number[] {
  return [id, ...unsignedLeb128(payload.length), ...payload];
}

function importedKernelExportInstance(
  memory: WebAssembly.Memory,
  exportName: string,
  parameterTypes: readonly WasmValueType[],
  callback: (...args: Array<number | bigint>) => number,
  allocator?: () => number | bigint,
): WebAssembly.Instance {
  const valueType = (type: WasmValueType): number =>
    type === "i32" ? 0x7f : 0x7e;
  const pointerType: WasmValueType = parameterTypes.includes("i64")
    ? "i64"
    : "i32";
  const allocatorImpl = allocator ?? (() =>
    pointerType === "i64" ? 4096n : 4096);
  const typeSection = [
    2,
    0x60,
    1,
    valueType("i32"),
    1,
    valueType(pointerType),
    0x60,
    ...unsignedLeb128(parameterTypes.length),
    ...parameterTypes.map(valueType),
    1,
    0x7f,
  ];
  const importSection = [
    3,
    ...wasmString("host"),
    ...wasmString("memory"),
    2,
    0,
    0,
    ...wasmString("host"),
    ...wasmString("allocator"),
    0,
    0,
    ...wasmString("host"),
    ...wasmString("callback"),
    0,
    1,
  ];
  const exportSection = [
    3,
    ...wasmString("memory"),
    2,
    0,
    ...wasmString("kernel_alloc_scratch"),
    0,
    0,
    ...wasmString(exportName),
    0,
    1,
  ];
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...wasmSection(1, typeSection),
    ...wasmSection(2, importSection),
    ...wasmSection(7, exportSection),
  ]);
  const module = new WebAssembly.Module(bytes);
  return new WebAssembly.Instance(module, {
    host: {
      memory,
      allocator: allocatorImpl,
      callback,
    },
  });
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
  it("exports only structural scratch capabilities, not concrete constructors", () => {
    expect(Object.hasOwn(kernelScratchModule, "KernelScratchRegion")).toBe(false);
    expect(Object.hasOwn(kernelScratchModule, "KernelScratchLease")).toBe(false);
    expect(Object.hasOwn(kernelScratchModule, "KernelScratchDataView")).toBe(false);
  });

  it("keeps region capacity and authority in immutable runtime state", () => {
    const kernelMemory = memory();
    const region = allocateKernelScratchRegion(
      kernelMemory,
      () => 4096,
      32,
      4,
      "immutable scratch",
    );
    const reflected = region as unknown as Record<string, unknown>;

    expect(Object.isFrozen(region)).toBe(true);
    expect(Reflect.ownKeys(region)).toEqual(["capacity"]);
    expect(reflected.pointer).toBeUndefined();
    expect(reflected.memory).toBeUndefined();
    expect(reflected.kernelExports).toBeUndefined();
    expect(Reflect.set(region, "capacity", 96)).toBe(false);
    expect(() => Object.defineProperty(region, "capacity", { value: 96 }))
      .toThrow();
    expect(region.capacity).toBe(32);

    new Uint8Array(kernelMemory.buffer, 4096, 96).fill(0x5a);
    expect(() => region.withLease((scratch) => {
      scratch.copyFrom(new Uint8Array(33));
    })).toThrow(KernelScratchError);
    expect(new Uint8Array(kernelMemory.buffer, 4096 + 32, 64))
      .toEqual(new Uint8Array(64).fill(0x5a));

    const ReflectedConstructor = reflected.constructor as new (
      ...args: unknown[]
    ) => unknown;
    expect(() => new ReflectedConstructor({})).toThrow(/cannot be constructed/i);
  });

  it("exposes no reflectable lease or guarded-view authority", () => {
    const region = allocateKernelScratchRegion(
      memory(),
      () => 4096,
      32,
      4,
      "private-state scratch",
    );

    region.withLease((scratch) => {
      const reflectedLease = scratch as unknown as Record<string, unknown>;
      expect(Object.isFrozen(scratch)).toBe(true);
      expect(Reflect.ownKeys(scratch)).toEqual([]);
      for (const name of [
        "rangeForLease",
        "currentMemoryBuffer",
        "kernelExports",
        "valid",
        "invokingKernelExport",
      ]) {
        expect(reflectedLease[name]).toBeUndefined();
        expect(Reflect.set(scratch, name, false)).toBe(false);
      }
      const ReflectedLeaseConstructor = reflectedLease.constructor as new (
        ...args: unknown[]
      ) => unknown;
      expect(() => new ReflectedLeaseConstructor({}))
        .toThrow(/cannot be constructed/i);

      const view = scratch.dataView(0, 8);
      const reflectedView = view as unknown as Record<string, unknown>;
      expect(Object.isFrozen(view)).toBe(true);
      expect(Reflect.ownKeys(view)).toEqual([]);
      expect(reflectedView.cachedView).toBeUndefined();
      expect(reflectedView.cachedBuffer).toBeUndefined();
      const ReflectedViewConstructor = reflectedView.constructor as new (
        ...args: unknown[]
      ) => unknown;
      expect(() => new ReflectedViewConstructor({}))
        .toThrow(/cannot be constructed/i);
    });
  });

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

  it("rejects an unsupported runtime pointer width before allocating", () => {
    const allocator = vi.fn(() => 4096);
    expect(() => allocateKernelScratchRegion(
      memory(),
      allocator,
      32,
      5 as 4,
      "invalid-width scratch",
    )).toThrow(/pointer width must be exactly 4 or 8/i);
    expect(allocator).not.toHaveBeenCalled();
  });

  it("normalizes the signed high bit of a wasm32 allocator result", () => {
    expect(checkedKernelExportPointer(
      -0x8000_0000,
      4,
      "high wasm32 allocation",
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
      memory(),
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

  it("uses the captured native data view while revoking post-lease access", () => {
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
        expect(counter.count()).toBe(0);
        escaped.setUint32(0, 0x1234_5678, true);
        expect(escaped.getUint16(0, true)).toBe(0x5678);
        expect(escaped.byteLength).toBe(4);
        expect(counter.count()).toBe(0);
      });

      expect(() => escaped!.setUint32(0, 0, true))
        .toThrow(/no longer active/i);
      expect(counter.count()).toBe(0);
    } finally {
      counter.restore();
    }
  });

  it.each([
    ["u32-le", 4, 0x1008n],
    ["u64-le", 8, 0x1008n],
    ["u32-to-u64-le", 8, 0x1008n],
  ] as const)(
    "encodes a checked %s address without making its bytes readable",
    (encoding, encodedBytes, expectedPointer) => {
      const kernelMemory = memory();
      const region = allocateKernelScratchRegion(
        kernelMemory,
        () => 4096,
        32,
        4,
        "test scratch",
      );

      region.withLease((scratch) => {
        scratch.writeAddress(0, 8, 8, encoding);
        const view = scratch.dataView(0, 32);
        const raw = new DataView(
          kernelMemory.buffer,
          4096,
          encodedBytes,
        );
        expect(encodedBytes === 4
          ? BigInt(raw.getUint32(0, true))
          : raw.getBigUint64(0, true)
        ).toBe(expectedPointer);

        // The pointer value was written for synchronous Rust consumption, but
        // no host read API may turn those bytes back into a retainable number.
        expect(() => encoding === "u32-le"
          ? view.getUint32(0, true)
          : view.getBigUint64(0, true)
        ).toThrow(/address bytes.*write-only/i);
        expect(() => view.getUint8(encodedBytes - 1))
          .toThrow(/address bytes.*write-only/i);
        expect(() => scratch.copyOut(0, encodedBytes))
          .toThrow(/address bytes.*write-only/i);
        expect(() => scratch.copyTo(new Uint8Array(encodedBytes), 0))
          .toThrow(/address bytes.*write-only/i);

        // Unrelated bytes in the same lease remain normally readable.
        view.setUint32(16, 0x1234_5678, true);
        expect(view.getUint32(16, true)).toBe(0x1234_5678);
      });

      expect(new Uint8Array(kernelMemory.buffer, 4096, encodedBytes))
        .toEqual(new Uint8Array(encodedBytes));
    },
  );

  it("checks both sides and the encoding width of write-only addresses", () => {
    const region = allocateKernelScratchRegion(
      memory(),
      () => 4096,
      32,
      4,
      "test scratch",
    );

    expect(() => region.withLease((scratch) => {
      scratch.writeAddress(29, 0, 1, "u32-le");
    })).toThrow(KernelScratchError);
    expect(() => region.withLease((scratch) => {
      scratch.writeAddress(0, 31, 2, "u64-le");
    })).toThrow(KernelScratchError);
    expect(() => region.withLease((scratch) => {
      scratch.writeAddress(0, 0, 1, "invalid" as "u32-le");
    })).toThrow(/encoding/i);

    expect(checkedKernelExportPointer(
      0x1_0000_0000n,
      8,
      "high wasm64 scratch",
    )).toBe(0x1_0000_0000);
  });

  it.each(["return", "throw"] as const)(
    "scrubs write-only addresses before a sequential lease after callback %s",
    (completion) => {
      const kernelMemory = memory();
      const region = allocateKernelScratchRegion(
        kernelMemory,
        () => 4096,
        32,
        4,
        "test scratch",
      );
      const encode = () => region.withLease((scratch) => {
        scratch.writeAddress(0, 8, 8, "u64-le");
        if (completion === "throw") {
          throw new Error("synthetic callback failure");
        }
      });

      if (completion === "throw") {
        expect(encode).toThrow("synthetic callback failure");
      } else {
        encode();
      }

      region.withLease((scratch) => {
        expect(scratch.dataView(0, 8).getBigUint64(0, true)).toBe(0n);
        expect(scratch.copyOut(0, 8)).toEqual(new Uint8Array(8));
      });
      expect(new Uint8Array(kernelMemory.buffer, 4096, 8))
        .toEqual(new Uint8Array(8));
    },
  );

  it("cannot reflectively replace the buffer used to scrub encoded addresses", () => {
    const kernelMemory = memory();
    const region = allocateKernelScratchRegion(
      kernelMemory,
      () => 4096,
      32,
      4,
      "private scrub scratch",
    );

    region.withLease((scratch) => {
      scratch.writeAddress(0, 8, 1, "u64-le");
      expect(Reflect.set(
        scratch,
        "currentMemoryBuffer",
        () => {
          throw new Error("scrub sabotage");
        },
      )).toBe(false);
    });

    region.withLease((scratch) => {
      expect(scratch.copyOut(0, 8)).toEqual(new Uint8Array(8));
    });
  });

  it("blocks preexisting and overlapping address views", () => {
    const region = allocateKernelScratchRegion(
      memory(),
      () => 4096,
      32,
      4,
      "test scratch",
    );

    region.withLease((scratch) => {
      const preexisting = scratch.dataView(0, 16);
      scratch.writeAddress(4, 16, 8, "u64-le");
      const overlapping = scratch.dataView(8, 8);

      expect(() => preexisting.getUint8(4))
        .toThrow(/address bytes.*write-only/i);
      expect(() => overlapping.getUint32(0, true))
        .toThrow(/address bytes.*write-only/i);
      expect(() => preexisting.setUint32(4, 0, true))
        .toThrow(/address bytes.*immutable/i);
    });
  });

  it.each([
    [
      "an exact scalar setter",
      (scratch: KernelScratchLease) =>
        scratch.dataView(0, 32).setBigUint64(8, 0n, true),
    ],
    [
      "a partially overlapping scalar setter",
      (scratch: KernelScratchLease) =>
        scratch.dataView(0, 32).setUint32(6, 0, true),
    ],
    [
      "an exact copyFrom",
      (scratch: KernelScratchLease) =>
        scratch.copyFrom(new Uint8Array(8), 8),
    ],
    [
      "a partially overlapping copyFrom",
      (scratch: KernelScratchLease) =>
        scratch.copyFrom(new Uint8Array(4), 14),
    ],
    [
      "an exact fill",
      (scratch: KernelScratchLease) => scratch.fill(0, 8, 8),
    ],
    [
      "a partially overlapping fill",
      (scratch: KernelScratchLease) => scratch.fill(0, 7, 2),
    ],
    [
      "a repeated writeAddress",
      (scratch: KernelScratchLease) =>
        scratch.writeAddress(8, 24, 1, "u64-le"),
    ],
    [
      "a partially overlapping writeAddress",
      (scratch: KernelScratchLease) =>
        scratch.writeAddress(12, 24, 1, "u32-le"),
    ],
  ] as const)("rejects %s over encoded address bytes", (_label, mutate) => {
    const region = allocateKernelScratchRegion(
      memory(),
      () => 4096,
      32,
      4,
      "immutable address scratch",
    );

    expect(() => region.withLease((scratch) => {
      scratch.writeAddress(8, 24, 1, "u64-le");
      mutate(scratch);
    })).toThrow(/address bytes.*immutable/i);
  });

  it("keeps out-of-order address intervals sorted without blocking gaps", () => {
    const region = allocateKernelScratchRegion(
      memory(),
      () => 4096,
      32,
      4,
      "sorted address scratch",
    );

    region.withLease((scratch) => {
      const view = scratch.dataView(0, 32);
      scratch.writeAddress(16, 28, 1, "u32-le");
      scratch.writeAddress(0, 28, 1, "u32-le");
      view.setUint32(8, 0x1234_5678, true);
      expect(view.getUint32(8, true)).toBe(0x1234_5678);
      expect(() => view.getUint8(0)).toThrow(/write-only/i);
      expect(() => view.getUint8(16)).toThrow(/write-only/i);
    });
  });

  it("rejects coercive scalar writes before they can reenter a lease", () => {
    const kernelMemory = memory();
    const region = allocateKernelScratchRegion(
      kernelMemory,
      () => 4096,
      32,
      4,
      "coercion-safe scratch",
    );
    let reentered = false;
    const coercive = {
      valueOf() {
        reentered = true;
        return 1;
      },
    };

    region.withLease((scratch) => {
      const view = scratch.dataView(0, 32);
      expect(() => view.setUint32(
        0,
        coercive as unknown as number,
        true,
      )).toThrow(/primitive number/i);
      expect(() => view.setBigUint64(
        0,
        coercive as unknown as bigint,
        true,
      )).toThrow(/primitive bigint/i);
      expect(() => view.setUint8(
        coercive as unknown as number,
        1,
      )).toThrow(/non-negative safe integer/i);
      expect(() => view.setUint8(0.5, 1))
        .toThrow(/non-negative safe integer/i);
      expect(() => scratch.fill(
        coercive as unknown as number,
        0,
        1,
      )).toThrow(/primitive number/i);
      expect(reentered).toBe(false);
      expect(new Uint8Array(kernelMemory.buffer, 4096, 1)[0]).toBe(0);
    });
  });

  it("rejects a structural export table before calling the allocator", () => {
    const allocator = vi.fn(() => 4096);
    expect(() => allocateKernelScratchRegion(
      memory(),
      allocator,
      32,
      4,
      "test scratch",
      {
        exports: {
          kernel_send: vi.fn(() => 0),
        },
      } as unknown as WebAssembly.Instance,
    )).toThrow(/does not own.*WebAssembly\.Memory/i);
    expect(allocator).not.toHaveBeenCalled();
  });

  it("binds the allocator, exports, and memory to one genuine instance", () => {
    const firstMemory = memory();
    const secondMemory = memory();
    const instance = importedKernelExportInstance(
      secondMemory,
      "kernel_send",
      ["i32", "i32", "i32", "i32"],
      () => 0,
    );
    const allocator = instance.exports.kernel_alloc_scratch as
      (size: number) => number;

    expect(() => allocateKernelScratchRegion(
      firstMemory,
      allocator,
      32,
      4,
      "mismatched memory scratch",
      instance,
    )).toThrow(/does not own.*Memory/i);

    const wrapper = vi.fn((size: number) => allocator(size));
    expect(() => allocateKernelScratchRegion(
      secondMemory,
      wrapper,
      32,
      4,
      "mismatched allocator scratch",
      instance,
    )).toThrow(/not the bound instance.*allocator/i);
    expect(wrapper).not.toHaveBeenCalled();
  });

  it("binds a scoped allocator call to its persistent gated generation", () => {
    const kernelMemory = memory();
    const allocate = vi.fn(() => 4096);
    const rawInstance = importedKernelExportInstance(
      kernelMemory,
      "kernel_send",
      ["i32", "i32", "i32", "i32"],
      () => 0,
      allocate,
    );
    const gate = new KernelEntryGate();
    const owner = createKernelEntryGatedInstance(rawInstance, gate);
    let region: ReturnType<typeof allocateKernelScratchRegion> | undefined;
    let staleScoped!: WebAssembly.Instance;
    let staleAllocator!: (capacity: number) => number;

    gate.runOrDeferVoidIngress("scoped scratch allocation", (scope) => {
      const scoped = createKernelEntryScopedInstance(owner, scope);
      const allocator = scoped.exports.kernel_alloc_scratch as
        (capacity: number) => number;
      staleScoped = scoped;
      staleAllocator = allocator;
      const alternateScoped = createKernelEntryScopedInstance(owner, scope);
      expect(() => allocateKernelScratchRegion(
        kernelMemory,
        allocator,
        32,
        4,
        "mismatched scoped callable scratch",
        owner,
        alternateScoped,
      )).toThrow(/not the bound instance.*allocator/i);
      expect(allocate).not.toHaveBeenCalled();
      region = allocateKernelScratchRegion(
        kernelMemory,
        allocator,
        32,
        4,
        "scoped test scratch",
        owner,
        scoped,
      );
    });

    expect(allocate).toHaveBeenCalledOnce();
    expect(() => region!.withLease((lease) => {
      lease.invokeKernelExport("kernel_send", [
        1,
        lease.exportPointer(0, 32),
        32,
        0,
      ]);
    })).not.toThrow();

    expect(() => allocateKernelScratchRegion(
      kernelMemory,
      staleAllocator,
      32,
      4,
      "revoked scoped scratch",
      owner,
      staleScoped,
    )).toThrow(/scope is no longer active/);
    expect(allocate).toHaveBeenCalledOnce();

    const foreignMemory = memory();
    const foreignRaw = importedKernelExportInstance(
      foreignMemory,
      "kernel_send",
      ["i32", "i32", "i32", "i32"],
      () => 0,
    );
    const foreignOwner = createKernelEntryGatedInstance(
      foreignRaw,
      new KernelEntryGate(),
    );
    gate.runOrDeferVoidIngress("foreign scoped scratch rejection", (scope) => {
      const scoped = createKernelEntryScopedInstance(owner, scope);
      const allocator = scoped.exports.kernel_alloc_scratch as
        (capacity: number) => number;
      expect(() => allocateKernelScratchRegion(
        foreignMemory,
        allocator,
        32,
        4,
        "foreign scoped scratch",
        foreignOwner,
        scoped,
      )).toThrow(/not the bound instance.*allocator/i);
    });
    expect(allocate).toHaveBeenCalledOnce();
  });

  it("uses captured genuine Memory and buffer bounds after prototype replacement", () => {
    const kernelMemory = memory();
    const region = allocateKernelScratchRegion(
      kernelMemory,
      () => 65_504,
      32,
      4,
      "captured memory scratch",
    );
    const memoryBufferDescriptor = Object.getOwnPropertyDescriptor(
      WebAssembly.Memory.prototype,
      "buffer",
    )!;
    const byteLengthDescriptor = Object.getOwnPropertyDescriptor(
      ArrayBuffer.prototype,
      "byteLength",
    )!;

    try {
      Object.defineProperty(WebAssembly.Memory.prototype, "buffer", {
        configurable: true,
        get: () => new ArrayBuffer(1_000_000),
      });
      Object.defineProperty(ArrayBuffer.prototype, "byteLength", {
        configurable: true,
        get: () => 1_000_000,
      });

      expect(() => checkedMemoryRange(
        kernelMemory,
        65_535,
        2,
        4,
        "captured memory range",
      )).toThrow(/outside.*range/i);
      region.withLease((scratch) => scratch.fill(0x6c, 0, 32));
    } finally {
      Object.defineProperty(
        WebAssembly.Memory.prototype,
        "buffer",
        memoryBufferDescriptor,
      );
      Object.defineProperty(
        ArrayBuffer.prototype,
        "byteLength",
        byteLengthDescriptor,
      );
    }

    expect(new Uint8Array(kernelMemory.buffer, 65_504, 32))
      .toEqual(new Uint8Array(32).fill(0x6c));
  });

  it("keeps captured shared-memory bounds after prototype replacement", () => {
    const kernelMemory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const region = allocateKernelScratchRegion(
      kernelMemory,
      () => 65_504,
      32,
      4,
      "captured shared-memory scratch",
    );
    const memoryBufferDescriptor = Object.getOwnPropertyDescriptor(
      WebAssembly.Memory.prototype,
      "buffer",
    )!;
    const byteLengthDescriptor = Object.getOwnPropertyDescriptor(
      SharedArrayBuffer.prototype,
      "byteLength",
    )!;

    try {
      Object.defineProperty(WebAssembly.Memory.prototype, "buffer", {
        configurable: true,
        get: () => new SharedArrayBuffer(1_000_000),
      });
      Object.defineProperty(SharedArrayBuffer.prototype, "byteLength", {
        configurable: true,
        get: () => 1_000_000,
      });

      expect(() => checkedMemoryRange(
        kernelMemory,
        65_535,
        2,
        4,
        "captured shared-memory range",
      )).toThrow(/outside.*range/i);
      region.withLease((scratch) => scratch.fill(0x3d, 0, 32));
    } finally {
      Object.defineProperty(
        WebAssembly.Memory.prototype,
        "buffer",
        memoryBufferDescriptor,
      );
      Object.defineProperty(
        SharedArrayBuffer.prototype,
        "byteLength",
        byteLengthDescriptor,
      );
    }

    expect(new Uint8Array(kernelMemory.buffer, 65_504, 32))
      .toEqual(new Uint8Array(32).fill(0x3d));
  });

  it("rejects structural memory objects even when their reported range fits", () => {
    expect(() => checkedMemoryRange(
      { buffer: new ArrayBuffer(65_536) } as WebAssembly.Memory,
      4096,
      32,
      4,
      "structural memory",
    )).toThrow(/genuine WebAssembly\.Memory/i);
  });

  it.each([4, 8] as const)(
    "substitutes an opaque checked pointer only inside a genuine wasm%d export",
    (pointerWidth) => {
      const calls: Array<Array<number | bigint>> = [];
      const kernelMemory = memory();
      const instance = importedKernelExportInstance(
        kernelMemory,
        "kernel_send",
        pointerWidth === 4
          ? ["i32", "i32", "i32", "i32"]
          : ["i32", "i64", "i32", "i32"],
        (...args) => {
          calls.push(args);
          return 7;
        },
      );
      const region = allocateKernelScratchRegion(
        kernelMemory,
        instance.exports.kernel_alloc_scratch as
          (size: number) => number | bigint,
        32,
        pointerWidth,
        "test scratch",
        instance,
      );
      let escapedLease: KernelScratchLease | undefined;
      let escapedPointer: ReturnType<KernelScratchLease["exportPointer"]>
        | undefined;

      const result = region.withLease((scratch) => {
        escapedLease = scratch;
        escapedPointer = scratch.exportPointer(8, 16);
        return scratch.invokeKernelExport("kernel_send", [
          3,
          escapedPointer,
          16,
          0,
        ]);
      });

      expect(result).toBe(7);
      expect(calls).toEqual([[
        3,
        pointerWidth === 4 ? 4104 : 4104n,
        16,
        0,
      ]]);
      expect(() => escapedLease!.invokeKernelExport("kernel_send", [
        3,
        escapedPointer!,
        16,
        0,
      ])).toThrow(/no longer active/i);
    },
  );

  it("checks opaque pointer capacity and current-memory boundaries", () => {
    const kernelMemory = memory();
    const instance = importedKernelExportInstance(
      kernelMemory,
      "kernel_uname",
      ["i32", "i32"],
      () => 0,
      () => 65_504,
    );
    const region = allocateKernelScratchRegion(
      kernelMemory,
      instance.exports.kernel_alloc_scratch as (size: number) => number,
      32,
      4,
      "end-of-memory scratch",
      instance,
    );

    expect(() => region.withLease((scratch) => {
      scratch.invokeKernelExport("kernel_uname", [
        scratch.exportPointer(0, 32),
        32,
      ]);
    })).not.toThrow();
    expect(() => region.withLease((scratch) => {
      scratch.exportPointer(0, 33);
    })).toThrow(KernelScratchError);
    expect(() => region.withLease((scratch) => {
      scratch.exportPointer(1, 32);
    })).toThrow(KernelScratchError);
  });

  it("rejects forged, cross-lease, reused, misplaced, and missing export pointers", () => {
    const kernelMemory = memory();
    let nextAllocation = 4096;
    const instance = importedKernelExportInstance(
      kernelMemory,
      "kernel_send",
      ["i32", "i32", "i32", "i32"],
      () => 0,
      () => {
        const pointer = nextAllocation;
        nextAllocation += 4096;
        return pointer;
      },
    );
    const first = allocateKernelScratchRegion(
      kernelMemory,
      instance.exports.kernel_alloc_scratch as (size: number) => number,
      32,
      4,
      "first scratch",
      instance,
    );
    const second = allocateKernelScratchRegion(
      kernelMemory,
      instance.exports.kernel_alloc_scratch as (size: number) => number,
      32,
      4,
      "second scratch",
      instance,
    );
    let retained: ReturnType<KernelScratchLease["exportPointer"]> | undefined;

    first.withLease((firstLease) => {
      retained = firstLease.exportPointer(0, 1);
      expect(() => second.withLease((secondLease) => {
        secondLease.invokeKernelExport("kernel_send", [
          1,
          retained!,
          1,
          0,
        ]);
      })).toThrow(/another lease/i);
    });
    expect(() => first.withLease((scratch) => {
      scratch.invokeKernelExport("kernel_send", [
        1,
        retained!,
        1,
        0,
      ]);
    })).toThrow(/another lease/i);
    expect(() => first.withLease((scratch) => {
      scratch.invokeKernelExport("kernel_send", [
        1,
        {} as ReturnType<KernelScratchLease["exportPointer"]>,
        1,
        0,
      ]);
    })).toThrow(/owned range token/i);
    expect(() => first.withLease((scratch) => {
      scratch.invokeKernelExport("kernel_send", [
        scratch.exportPointer(0, 1),
        0,
        1,
        0,
      ]);
    })).toThrow(/primitive scalar/i);
    expect(() => first.withLease((scratch) => {
      scratch.invokeKernelExport(
        "kernel_recv",
        [1, scratch.exportPointer(0, 1), 1, 0],
      );
    })).toThrow(/unavailable/i);
    expect(() => first.withLease((scratch) => {
      scratch.invokeKernelExport(
        "kernel_not_reviewed" as "kernel_send",
        [1, scratch.exportPointer(0, 1), 1, 0],
      );
    })).toThrow(/not approved/i);
  });

  it("couples every export pointer to an exact non-negative byte capacity", () => {
    const calls = vi.fn(() => 0);
    const kernelMemory = memory();
    const instance = importedKernelExportInstance(
      kernelMemory,
      "kernel_send",
      ["i32", "i32", "i32", "i32"],
      calls,
    );
    const region = allocateKernelScratchRegion(
      kernelMemory,
      instance.exports.kernel_alloc_scratch as (size: number) => number,
      16,
      4,
      "capacity-coupled scratch",
      instance,
    );

    region.withLease((scratch) => {
      const eightBytes = scratch.exportPointer(0, 8);
      expect(scratch.invokeKernelExport(
        "kernel_send",
        [1, eightBytes, 8, 0],
      )).toBe(0);

      for (const capacity of [
        7,
        9,
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
        BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      ]) {
        expect(() => scratch.invokeKernelExport(
          "kernel_send",
          [1, eightBytes, capacity, 0],
        )).toThrow(KernelScratchError);
      }
      expect(() => scratch.invokeKernelExport(
        "kernel_send",
        [1, scratch.exportPointer(0, 1), 8, 0],
      )).toThrow(/declares 8 bytes but borrows 1/i);
      expect(() => scratch.invokeKernelExport(
        "kernel_send",
        [1, scratch.exportPointer(0, 0), -1, 0],
      )).toThrow(/non-negative safe integer/i);
      expect(() => scratch.invokeKernelExport(
        "kernel_send",
        [1, eightBytes, 8],
      )).toThrow(/expects 4 arguments, received 3/i);
      expect(() => scratch.invokeKernelExport(
        "kernel_send",
        [1, eightBytes, 8, 0, 0],
      )).toThrow(/expects 4 arguments, received 5/i);
    });

    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("rejects misaligned and overlapping mutable export borrows", () => {
    const kernelMemory = memory();
    const socketpair = importedKernelExportInstance(
      kernelMemory,
      "kernel_socketpair",
      ["i32", "i32", "i32", "i32", "i32"],
      () => 0,
    );
    const socketRegion = allocateKernelScratchRegion(
      kernelMemory,
      socketpair.exports.kernel_alloc_scratch as (size: number) => number,
      32,
      4,
      "aligned socketpair scratch",
      socketpair,
    );
    expect(() => socketRegion.withLease((scratch) => {
      scratch.invokeKernelExport("kernel_socketpair", [
        1,
        1,
        0,
        scratch.exportPointer(1, 8),
        8,
      ]);
    })).toThrow(/not 4-byte aligned/i);

    const select = importedKernelExportInstance(
      kernelMemory,
      "kernel_select",
      ["i32", "i32", "i32", "i32", "i32", "i32", "i32", "i32"],
      () => 0,
    );
    const selectRegion = allocateKernelScratchRegion(
      kernelMemory,
      select.exports.kernel_alloc_scratch as (size: number) => number,
      32,
      4,
      "non-overlapping select scratch",
      select,
    );
    expect(() => selectRegion.withLease((scratch) => {
      scratch.invokeKernelExport("kernel_select", [
        4,
        scratch.exportPointer(0, 8),
        8,
        scratch.exportPointer(4, 8),
        8,
        0,
        0,
        0,
      ]);
    })).toThrow(/overlapping borrowed pointer ranges/i);
    expect(() => selectRegion.withLease((scratch) => {
      scratch.invokeKernelExport("kernel_select", [
        4,
        0,
        1,
        0,
        0,
        0,
        0,
        0,
      ]);
    })).toThrow(/declares 1 bytes but borrows 0/i);
  });

  it("accepts only exact-width nulls for select's optional pointers", () => {
    for (const pointerWidth of [4, 8] as const) {
      const calls: Array<Array<number | bigint>> = [];
      const kernelMemory = memory();
      const instance = importedKernelExportInstance(
        kernelMemory,
        "kernel_select",
        pointerWidth === 4
          ? ["i32", "i32", "i32", "i32", "i32", "i32", "i32", "i32"]
          : ["i32", "i64", "i32", "i64", "i32", "i64", "i32", "i32"],
        (...args) => {
          calls.push(args);
          return 0;
        },
      );
      const region = allocateKernelScratchRegion(
        kernelMemory,
        instance.exports.kernel_alloc_scratch as
          (size: number) => number | bigint,
        32,
        pointerWidth,
        "select scratch",
        instance,
      );
      const nullPointer = pointerWidth === 4 ? 0 : 0n;

      region.withLease((scratch) => {
        scratch.invokeKernelExport("kernel_select", [
          4,
          scratch.exportPointer(0, 8),
          8,
          nullPointer,
          0,
          scratch.exportPointer(8, 8),
          8,
          0,
        ]);
      });
      expect(calls[0]).toEqual([
        4,
        pointerWidth === 4 ? 4096 : 4096n,
        8,
        nullPointer,
        0,
        pointerWidth === 4 ? 4104 : 4104n,
        8,
        0,
      ]);
      expect(() => region.withLease((scratch) => {
        scratch.invokeKernelExport("kernel_select", [
          4,
          pointerWidth === 4 ? 0n : 0,
          0,
          nullPointer,
          0,
          nullPointer,
          0,
          0,
        ]);
      })).toThrow(/exact null pointer/i);
    }
  });

  it("seals escaped lease wrappers during wasm-to-host reentry and unseals after traps", () => {
    let escaped: KernelScratchLease | undefined;
    let shouldThrow = false;
    let reentryError: unknown;
    let sealMutationResult: boolean | undefined;
    const kernelMemory = memory();
    const instance = importedKernelExportInstance(
      kernelMemory,
      "kernel_send",
      ["i32", "i32", "i32", "i32"],
      () => {
        sealMutationResult = Reflect.set(
          escaped!,
          "invokingKernelExport",
          false,
        );
        try {
          escaped!.copyOut(0, 1);
        } catch (error) {
          reentryError = error;
        }
        if (shouldThrow) throw new Error("synthetic wasm import trap");
        return 1;
      },
    );
    const region = allocateKernelScratchRegion(
      kernelMemory,
      instance.exports.kernel_alloc_scratch as (size: number) => number,
      32,
      4,
      "reentrant scratch",
      instance,
    );

    region.withLease((scratch) => {
      escaped = scratch;
      const pointer = scratch.exportPointer(0, 1);
      expect(scratch.invokeKernelExport("kernel_send", [1, pointer, 1, 0]))
        .toBe(1);
      expect(sealMutationResult).toBe(false);
      expect(reentryError).toBeInstanceOf(KernelScratchError);
      expect(String(reentryError)).toMatch(/sealed during.*kernel export/i);

      shouldThrow = true;
      expect(() => scratch.invokeKernelExport(
        "kernel_send",
        [1, pointer, 1, 0],
      )).toThrow("synthetic wasm import trap");
      shouldThrow = false;
      expect(scratch.copyOut(0, 1)).toEqual(new Uint8Array(1));
      expect(scratch.invokeKernelExport("kernel_send", [1, pointer, 1, 0]))
        .toBe(1);
    });
  });

  it("seals before reading a caller-owned export argument list", () => {
    let calls = 0;
    const kernelMemory = memory();
    const instance = importedKernelExportInstance(
      kernelMemory,
      "kernel_send",
      ["i32", "i32", "i32", "i32"],
      () => {
        calls++;
        return 0;
      },
    );
    const region = allocateKernelScratchRegion(
      kernelMemory,
      instance.exports.kernel_alloc_scratch as (size: number) => number,
      32,
      4,
      "proxy argument scratch",
      instance,
    );

    region.withLease((scratch) => {
      const pointer = scratch.exportPointer(0, 1);
      let reentryError: unknown;
      const args = new Proxy(
        [1, pointer, 1, 0] as const,
        {
          get(target, property, receiver) {
            if (property === "length") {
              try {
                scratch.invokeKernelExport(
                  "kernel_send",
                  [1, pointer, 1, 0],
                );
              } catch (error) {
                reentryError = error;
              }
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );

      expect(scratch.invokeKernelExport("kernel_send", args)).toBe(0);
      expect(reentryError).toBeInstanceOf(KernelScratchError);
      expect(String(reentryError)).toMatch(/sealed during.*kernel export/i);
      expect(calls).toBe(1);
    });
  });

  it("does not use mutable array push or iteration while materializing pointers", () => {
    const calls: Array<Array<number | bigint>> = [];
    const kernelMemory = memory();
    const instance = importedKernelExportInstance(
      kernelMemory,
      "kernel_send",
      ["i32", "i32", "i32", "i32"],
      (...args) => {
        calls[calls.length] = args;
        return 0;
      },
    );
    const region = allocateKernelScratchRegion(
      kernelMemory,
      instance.exports.kernel_alloc_scratch as (size: number) => number,
      32,
      4,
      "array intrinsic scratch",
      instance,
    );
    const originalPush = Array.prototype.push;
    const originalSome = Array.prototype.some;
    const originalIterator = Array.prototype[Symbol.iterator];
    let observedResult = -1;
    try {
      Array.prototype.push = () => {
        throw new Error("live Array#push must not run");
      };
      Array.prototype.some = () => {
        throw new Error("live Array#some must not run");
      };
      Array.prototype[Symbol.iterator] = () => {
        throw new Error("live array iterator must not run");
      };
      region.withLease((scratch) => {
        scratch.writeAddress(0, 8, 1, "u64-le");
        observedResult = scratch.invokeKernelExport("kernel_send", [
          1,
          scratch.exportPointer(8, 1),
          1,
          0,
        ]);
      });
    } finally {
      Array.prototype.push = originalPush;
      Array.prototype.some = originalSome;
      Array.prototype[Symbol.iterator] = originalIterator;
    }
    expect(observedResult).toBe(0);
    expect(calls).toEqual([[1, 4104, 1, 0]]);
  });

  it("uses captured numeric intrinsics after callback-visible globals are replaced", () => {
    const kernelMemory = memory();
    const instance = importedKernelExportInstance(
      kernelMemory,
      "kernel_send",
      ["i32", "i64", "i32", "i32"],
      () => 0,
    );
    const region = allocateKernelScratchRegion(
      kernelMemory,
      instance.exports.kernel_alloc_scratch as (size: number) => bigint,
      32,
      8,
      "intrinsic scratch",
      instance,
    );
    const originalBigInt = globalThis.BigInt;
    const originalIsInteger = Number.isInteger;
    const originalIsSafeInteger = Number.isSafeInteger;
    const retained: unknown[] = [];
    try {
      globalThis.BigInt = ((value: unknown) => {
        retained.push(value);
        return originalBigInt(value as never);
      }) as BigIntConstructor;
      Number.isInteger = () => true;
      Number.isSafeInteger = () => true;

      region.withLease((scratch) => {
        scratch.writeAddress(0, 8, 1, "u64-le");
        scratch.invokeKernelExport("kernel_send", [
          1,
          scratch.exportPointer(8, 1),
          1,
          0,
        ]);
        expect(() => scratch.copyFrom(new Uint8Array(1), Number.NaN))
          .toThrow(/safe integer/i);
      });
    } finally {
      globalThis.BigInt = originalBigInt;
      Number.isInteger = originalIsInteger;
      Number.isSafeInteger = originalIsSafeInteger;
    }
    expect(retained).toEqual([]);
  });

  it("uses a detached copy without invoking a caller-owned set override", () => {
    const kernelMemory = memory();
    const region = allocateKernelScratchRegion(
      kernelMemory,
      () => 4096,
      32,
      4,
      "test scratch",
    );
    new Uint8Array(kernelMemory.buffer, 4096, 32).fill(0x5a);
    let overrideCalled = false;
    class HostileDestination extends Uint8Array {
      override set(): void {
        overrideCalled = true;
        throw new Error("caller override must not run during a scratch lease");
      }
    }
    const destination = new HostileDestination(32);

    region.withLease((scratch) => scratch.copyTo(destination));

    expect(Uint8Array.from(destination))
      .toEqual(new Uint8Array(32).fill(0x5a));
    expect(overrideCalled).toBe(false);
  });

  it("keeps transfers detached after live byte-access prototypes are replaced", () => {
    const kernelMemory = memory();
    const region = allocateKernelScratchRegion(
      kernelMemory,
      () => 4096,
      32,
      4,
      "test scratch",
    );
    const originalSlice = Uint8Array.prototype.slice;
    const originalSet = Uint8Array.prototype.set;
    const originalFill = Uint8Array.prototype.fill;
    const originalGetUint32 = DataView.prototype.getUint32;
    const originalSetUint32 = DataView.prototype.setUint32;
    let output: Uint8Array | undefined;
    const destination = new Uint8Array(4);
    let scalar = 0;
    try {
      Uint8Array.prototype.slice = function(): Uint8Array {
        return this.subarray();
      };
      Uint8Array.prototype.set = function(): void {
        throw new Error("live set must not run");
      };
      Uint8Array.prototype.fill = function(): Uint8Array {
        throw new Error("live fill must not run");
      };
      DataView.prototype.getUint32 = function(): number {
        throw new Error("live getUint32 must not run");
      };
      DataView.prototype.setUint32 = function(): void {
        throw new Error("live setUint32 must not run");
      };

      region.withLease((scratch) => {
        scratch.copyFrom(Uint8Array.of(1, 2, 3, 4));
        scratch.copyTo(destination, 0, 0, 4);
        const view = scratch.dataView(4, 4);
        view.setUint32(0, 0x1234_5678, true);
        scalar = view.getUint32(0, true);
        scratch.fill(0x5a, 8, 1);
        output = scratch.copyOut(0, 9);
      });
      region.withLease((scratch) => scratch.fill(0xa5, 0, 9));
    } finally {
      Uint8Array.prototype.slice = originalSlice;
      Uint8Array.prototype.set = originalSet;
      Uint8Array.prototype.fill = originalFill;
      DataView.prototype.getUint32 = originalGetUint32;
      DataView.prototype.setUint32 = originalSetUint32;
    }

    expect(Array.from(destination)).toEqual([1, 2, 3, 4]);
    expect(scalar).toBe(0x1234_5678);
    expect(Array.from(output!)).toEqual([
      1, 2, 3, 4, 0x78, 0x56, 0x34, 0x12, 0x5a,
    ]);
    expect(output!.buffer).not.toBe(kernelMemory.buffer);
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
        expect(counter.count()).toBe(0);

        const previousBuffer = kernelMemory.buffer;
        kernelMemory.grow(1);
        expect(kernelMemory.buffer).not.toBe(previousBuffer);

        view.setUint32(4, 0x90ab_cdef, true);
        expect(view.getUint32(0, true)).toBe(0x1234_5678);
        expect(counter.count()).toBe(0);
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
    expect(checkedKernelExportPointer(
      -0x8000_0000,
      4,
      "high wasm32 reservation",
    )).toBe(0x8000_0000);
  });

  it("rejects a wasm32 minimum above u32 before invoking the reserver", () => {
    const reserver = vi.fn(() => ({
      pointer: 4096,
      capacity: 32,
    }));

    expect(() => reserveKernelScratchRegion(
      memory(),
      reserver,
      0x1_0000_0000,
      4,
      "oversized wasm32 reservation",
    )).toThrow(/does not fit a wasm32 usize/);
    expect(reserver).not.toHaveBeenCalled();
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

  it.each([
    ["ArrayBuffer", false],
    ["SharedArrayBuffer", true],
  ] as const)(
    "reads live %s bounds after WebAssembly memory growth",
    (_name, shared) => {
      const kernelMemory = new WebAssembly.Memory({
        initial: 1,
        maximum: 2,
        shared,
      });

      expect(checkedMemoryRange(
        kernelMemory,
        65_504,
        32,
        4,
        "pre-growth output",
      )).toEqual({ pointer: 65_504, length: 32, end: 65_536 });
      expect(() => checkedMemoryRange(
        kernelMemory,
        65_536,
        1,
        4,
        "pre-growth output",
      )).toThrow(/outside.*range/i);

      kernelMemory.grow(1);

      expect(checkedMemoryRange(
        kernelMemory,
        131_040,
        32,
        4,
        "post-growth output",
      )).toEqual({ pointer: 131_040, length: 32, end: 131_072 });
    },
  );

  it("probes each shared-memory buffer kind once across repeated checks", async () => {
    const byteLengthDescriptor = Object.getOwnPropertyDescriptor(
      ArrayBuffer.prototype,
      "byteLength",
    )!;
    const byteLengthGetter = byteLengthDescriptor.get!;
    let arrayBufferGetterCalls = 0;

    try {
      Object.defineProperty(ArrayBuffer.prototype, "byteLength", {
        configurable: byteLengthDescriptor.configurable,
        enumerable: byteLengthDescriptor.enumerable,
        get(this: ArrayBufferLike): number {
          arrayBufferGetterCalls++;
          return Reflect.apply(byteLengthGetter, this, []) as number;
        },
      });
      vi.resetModules();
      const isolated = await import("../src/kernel-scratch");
      const kernelMemory = new WebAssembly.Memory({
        initial: 1,
        maximum: 2,
        shared: true,
      });

      for (let index = 0; index < 1_024; index++) {
        isolated.checkedMemoryRange(
          kernelMemory,
          4096,
          32,
          4,
          "repeated shared-memory output",
        );
      }
      expect(arrayBufferGetterCalls).toBe(1);

      kernelMemory.grow(1);
      for (let index = 0; index < 1_024; index++) {
        isolated.checkedMemoryRange(
          kernelMemory,
          65_536,
          32,
          4,
          "grown repeated shared-memory output",
        );
      }
      expect(arrayBufferGetterCalls).toBe(2);
    } finally {
      Object.defineProperty(
        ArrayBuffer.prototype,
        "byteLength",
        byteLengthDescriptor,
      );
      vi.resetModules();
    }
  });
});
