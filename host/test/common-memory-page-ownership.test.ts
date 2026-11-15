import { describe, expect, it, vi } from "vitest";
import { CommonMemoryPageOwnership } from "../src/common-memory-page-ownership";

describe("common-memory page retirement", () => {
  it("reclaims roots, scratch and private pages without freeing a peer's shared page", () => {
    const ledger = new CommonMemoryPageOwnership(() => 100);
    const a = {}, b = {}, revoke = vi.fn();
    const owner = ledger.trackRoot(a, [1, 2], () => [3, 4], revoke);
    const peer = ledger.trackRoot(b, [5, 6], () => [4, 7], () => {});
    const commit = owner.prepareRetirement("quiescent"); commit(); commit();
    expect(revoke).toHaveBeenCalledOnce();
    expect(() => ledger.assertLive(a)).toThrow("retired");
    ledger.assertLive(b);
    expect(ledger.stats()).toMatchObject({ rootsTracked: 1, freePages: 3, deferredPages: 1 });
    peer.prepareRetirement("quiescent")();
    expect(ledger.stats()).toMatchObject({ rootsTracked: 0, freePages: 7, deferredPages: 0 });
  });

  it("holds shared payload after source retirement until a snapshot is explicitly cancelled", () => {
    const ledger = new CommonMemoryPageOwnership(() => 100), snapshot = {};
    const owner = ledger.trackRoot({}, [1, 2], () => [3, 4], () => {});
    ledger.pin(snapshot, [4]); owner.prepareRetirement("quiescent")();
    expect(ledger.stats()).toMatchObject({ freePages: 3, pendingSnapshots: 1, deferredPages: 1 });
    ledger.disposeSnapshot(snapshot); ledger.disposeSnapshot(snapshot);
    expect(ledger.stats()).toMatchObject({ freePages: 4, pendingSnapshots: 0, deferredPages: 0 });
  });

  it("quarantines forced generations without modifying or recycling their bytes", () => {
    const ledger = new CommonMemoryPageOwnership(() => 100), identity = {}, revoke = vi.fn();
    ledger.trackRoot(identity, [1, 2], () => [3, 4], revoke).prepareRetirement("forced")();
    expect(revoke).not.toHaveBeenCalled();
    expect(ledger.stats()).toMatchObject({ rootsTracked: 1, quarantinedRoots: 1, freePages: 0 });
    expect(() => ledger.assertLive(identity)).toThrow("retired");
    expect(ledger.accountingSnapshot()).toEqual({ roots: [{ memory: identity, pages: [3, 4] }],
      runtimePages: [1, 2], reusablePages: [], pinnedPages: [] });
  });

  it("keeps a fixed physical pool bounded over repeated generations and zeros before publication", () => {
    const ledger = new CommonMemoryPageOwnership(() => 5), zero = vi.fn();
    ledger.reclaimUnmapped([1, 2, 3, 4]);
    for (let i = 0; i < 256; i++) {
      const first = ledger.take(4, zero); expect(first).toBe(1);
      ledger.trackRoot({}, [first!, first! + 1], () => [3, 4], () => {}).prepareRetirement("quiescent")();
    }
    expect(zero).toHaveBeenCalledTimes(256);
    expect(ledger.stats()).toMatchObject({ rootsTracked: 0, freePages: 4, reusedPages: 1024 });
  });

  it("leaves free ownership intact if zeroing fails, and rejects invalid or repeated releases", () => {
    const ledger = new CommonMemoryPageOwnership(() => 10);
    ledger.reclaimUnmapped([1, 2]);
    expect(() => ledger.take(2, () => { throw Error("zero refused"); })).toThrow("zero refused");
    expect(ledger.stats().freePages).toBe(2);
    expect(() => ledger.reclaimUnmapped([1])).toThrow("duplicate");
    expect(() => ledger.reclaimUnmapped([10])).toThrow("unallocated");
    expect(ledger.take(2, () => {})).toBe(1);
  });

  it("rechecks a prepared retirement against intervening allocations", () => {
    const ledger = new CommonMemoryPageOwnership(() => 10);
    ledger.reclaimUnmapped([5, 6]);
    const owner = ledger.trackRoot({}, [1, 2], () => [3], () => {});
    const commit = owner.prepareRetirement("quiescent");
    expect(ledger.take(2, () => {})).toBe(5);
    ledger.trackRoot({}, [5], () => [6], () => {});
    commit();
    expect(ledger.stats()).toMatchObject({ rootsTracked: 1, freePages: 3 });
    expect(ledger.take(4, () => {})).toBeUndefined();
  });
});
