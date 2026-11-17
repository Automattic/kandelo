import { getSnapshotComparatorModule, lookupComparisonMemoryShape,
  recordComparisonMemoryShape } from "../process-snapshot-comparator";
import { mergeChangedByteRuns } from "../shared-byte-runs";
import { runtimeMemoryProfileSignals } from "../runtime-memory-profile";

const Page = 65536;
const Memory = WebAssembly.Memory;
const Instance = WebAssembly.Instance;
const buffer = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, "buffer")!.get!;
const apply = Reflect.apply;

export type ByteSnapshot = { snapshot: Uint8Array; snapshotMemory?: WebAssembly.Memory };

/** Independent device bookkeeping in the kernel worker, never a guest address
 * space. The maximum equals its actual rounded allocation, not an arena ceiling.
 * Unknown constructor provenance keeps the existing owned-array implementation. */
export function allocateByteSnapshot(length: number, source: WebAssembly.Memory | null): ByteSnapshot {
  // JSC spends materially more reservation capacity on fixed Wasm baselines
  // than equal-sized arrays. Keep its existing array path without reducing
  // guest ceilings; native comparison is optional device bookkeeping.
  const chargesReservations = runtimeMemoryProfileSignals({
    userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
  }).chargesDeclaredCeilings
    || (typeof process !== "undefined" && typeof process.versions?.bun === "string");
  const shape = source ? lookupComparisonMemoryShape(source) : undefined;
  if (chargesReservations || length < Page || !shape || !getSnapshotComparatorModule(shape, shape))
    return { snapshot: new Uint8Array(length), snapshotMemory: undefined };
  const pages = Math.ceil(length / Page);
  const snapshotMemory = new Memory({ initial: pages, maximum: pages });
  recordComparisonMemoryShape(snapshotMemory, 4, false, pages);
  return { snapshot: new Uint8Array(apply(buffer, snapshotMemory, []), 0, length), snapshotMemory };
}

/** Caller has checked the exact live mapping, address-space identity and both
 * complete ranges. Borrow only on this stack; cache no Instance or export that
 * could retain a retired guest memory. A differing block still publishes only
 * actual changed bytes, preserving concurrent and stale-reader semantics. */
export function publishMappedBytes(memory: WebAssembly.Memory, address: number,
  baseline: ByteSnapshot, destination: Uint8Array, length: number): boolean {
  const source = new Uint8Array(apply(buffer, memory, []), address, length);
  const module = baseline.snapshotMemory && getSnapshotComparatorModule(
    lookupComparisonMemoryShape(baseline.snapshotMemory), lookupComparisonMemoryShape(memory));
  if (!module) return mergeChangedByteRuns(source, 0, baseline.snapshot, 0, destination, 0, length, true);
  const instance = new Instance(module, {env: {kernel: baseline.snapshotMemory!, process: memory}});
  const compare = instance.exports.compare as (a: bigint, b: bigint, n: number) => number;
  let changed = false;
  for (let offset = 0; offset < length; offset += Page) {
    const count = Math.min(Page, length - offset);
    const result = compare(BigInt(offset), BigInt(address + offset), count);
    if (result !== 0 && result !== 1) throw new Error("Invalid mapped-byte comparison result");
    if (result === 1 && mergeChangedByteRuns(source, offset, baseline.snapshot, offset,
      destination, offset, count, true)) changed = true;
  }
  return changed;
}
