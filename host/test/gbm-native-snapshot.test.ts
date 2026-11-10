import { describe, expect, it, vi } from "vitest";
import { allocateByteSnapshot, publishMappedBytes } from "../src/dri/byte-snapshot";
import { lookupComparisonMemoryShape, recordComparisonMemoryShape } from "../src/process-snapshot-comparator";
import { GbmBoRegistry } from "../src/dri/registry";

describe("bounded native GBM comparisons", () => {
  it.each([4, 8] as const)("compares exact ranges of a real %i-byte-address memory", width => {
    const memory = new WebAssembly.Memory((width === 8
      ? { initial: 4n, maximum: 5n, shared: true, address: "i64" }
      : { initial: 4, maximum: 5, shared: true }) as unknown as WebAssembly.MemoryDescriptor);
    recordComparisonMemoryShape(memory, width, true, 5);
    const size = 65539, address = 19;
    const baseline = allocateByteSnapshot(size, memory);
    expect(baseline.snapshotMemory).toBeDefined();
    expect(baseline.snapshotMemory!.buffer.byteLength).toBe(2 * 65536);
    expect(lookupComparisonMemoryShape(baseline.snapshotMemory!)?.maximumPages).toBe(2);
    const destination = new Uint8Array(size); destination.fill(73);
    // An unchanged stale view cannot erase newer canonical bytes.
    expect(publishMappedBytes(memory, address, baseline, destination, size)).toBe(false);
    expect(destination.every(byte => byte === 73)).toBe(true);
    const source = new Uint8Array(memory.buffer, address, size);
    for (const offset of [0, 1, 15, 16, 65534, 65535, 65536, size - 1]) source[offset] = 91;
    const oracle = Uint8Array.from(destination);
    source.forEach((byte, offset) => { if (byte !== 0) oracle[offset] = byte; });
    expect(publishMappedBytes(memory, address, baseline, destination, size)).toBe(true);
    expect(destination).toEqual(oracle);
    expect(baseline.snapshot).toEqual(source);
    expect(publishMappedBytes(memory, address, baseline, destination, size)).toBe(false);
    // Growing the source invalidates old JS views, not the original Memory.
    (memory.grow as (n: number | bigint) => number)(width === 8 ? 1n : 1);
    new Uint8Array(memory.buffer, address, size)[31] = 55;
    expect(publishMappedBytes(memory, address, baseline, destination, size)).toBe(true);
    expect(destination[31]).toBe(55);
  });

  it("uses owned byte arrays when constructor provenance is unknown", () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const baseline = allocateByteSnapshot(65536, memory);
    expect(baseline.snapshotMemory).toBeUndefined();
    const destination = new Uint8Array(65536);
    new Uint8Array(memory.buffer)[7] = 91;
    expect(publishMappedBytes(memory, 0, baseline, destination, 65536)).toBe(true);
    expect(destination[7]).toBe(91);
  });

  it("gives a small surviving mapping its own baseline after splitting a native snapshot", () => {
    const memory = new WebAssembly.Memory({ initial: 3, maximum: 3, shared: true });
    recordComparisonMemoryShape(memory, 4, true, 3);
    const registry = new GbmBoRegistry({ getProcessMemory: () => memory });
    registry.create({ pid: 100, bo_id: 1, size: 131072, w: 256, h: 128, stride: 1024 });
    registry.bind(100, 1, 0, 131072);
    expect(registry.primeBindFromSab(100, 1, memory)).toBe(true);
    const pixels = new Uint8Array(131072); pixels.fill(1); pixels.fill(3, 98304);
    expect(registry.publishDevicePixels(1, pixels)).toBe(true);
    registry.unbind(100, 1, 65536, 32768);
    new Uint8Array(memory.buffer, 98304, 32768).fill(1);
    registry.syncToSab(1);
    expect(registry.readPixelView(1)!.subarray(98304).every(byte => byte === 1)).toBe(true);
  });

  it("does not mark a store made during native-assisted publication clean", () => {
    const memory = new WebAssembly.Memory({ initial: 3, maximum: 3, shared: true });
    recordComparisonMemoryShape(memory, 4, true, 3);
    const baseline = allocateByteSnapshot(131072, memory);
    const source = new Uint8Array(memory.buffer);
    const destination = new Uint8Array(131072);
    source[32] = 91;
    const nativeSet = Uint8Array.prototype.set;
    let injected = false;
    const copy = vi.spyOn(Uint8Array.prototype, "set").mockImplementation(function (
      this: Uint8Array, bytes: ArrayLike<number>, offset = 0,
    ) {
      nativeSet.call(this, bytes, offset);
      if (this.buffer === destination.buffer && !injected) {
        injected = true;
        source[32] = 92;
        source[1] = 73;
      }
    });
    try { expect(publishMappedBytes(memory, 0, baseline, destination, destination.length)).toBe(true); }
    finally { copy.mockRestore(); }
    expect(injected).toBe(true);
    expect(destination[32]).toBe(91);
    expect(destination[1]).toBe(0);
    expect(publishMappedBytes(memory, 0, baseline, destination, destination.length)).toBe(true);
    expect(destination[32]).toBe(92);
    expect(destination[1]).toBe(73);
  });
});
