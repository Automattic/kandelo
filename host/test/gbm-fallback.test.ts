import { expect, it, vi } from "vitest";

// Capability absence is supported independently of memory-constructor
// provenance. Exercise it even on engines where the native helper works.
vi.mock("../src/process-snapshot-comparator", async importOriginal => ({
  ...await importOriginal<typeof import("../src/process-snapshot-comparator")>(),
  getSnapshotComparatorModule: () => undefined,
}));

import { allocateByteSnapshot, publishMappedBytes } from "../src/dri/byte-snapshot";
import { recordComparisonMemoryShape } from "../src/process-snapshot-comparator";

it("preserves stale canonical bytes and concurrent stores without a native comparator", () => {
  const memory = new WebAssembly.Memory({ initial: 3, maximum: 3, shared: true });
  recordComparisonMemoryShape(memory, 4, true, 3);
  const length = 65539, address = 19;
  const baseline = allocateByteSnapshot(length, memory);
  expect(baseline.snapshotMemory).toBeUndefined();
  expect(baseline.snapshot.byteLength).toBe(length);
  const destination = new Uint8Array(length); destination.fill(73);
  expect(publishMappedBytes(memory, address, baseline, destination, length)).toBe(false);
  expect(destination.every(byte => byte === 73)).toBe(true);

  const source = new Uint8Array(memory.buffer, address, length);
  source[32] = 91; source[length - 1] = 55;
  const nativeSet = Uint8Array.prototype.set;
  let injected = false;
  const copy = vi.spyOn(Uint8Array.prototype, "set").mockImplementation(function (
    this: Uint8Array, bytes: ArrayLike<number>, offset = 0,
  ) {
    nativeSet.call(this, bytes, offset);
    if (this.buffer === destination.buffer && !injected) {
      injected = true; source[32] = 92; source[1] = 17;
    }
  });
  try { expect(publishMappedBytes(memory, address, baseline, destination, length)).toBe(true); }
  finally { copy.mockRestore(); }
  expect(injected).toBe(true);
  expect(destination[32]).toBe(91);
  expect(destination[1]).toBe(73);
  expect(destination[length - 1]).toBe(55);
  expect(publishMappedBytes(memory, address, baseline, destination, length)).toBe(true);
  expect(destination[32]).toBe(92);
  expect(destination[1]).toBe(17);
  expect(destination[100]).toBe(73);
});
