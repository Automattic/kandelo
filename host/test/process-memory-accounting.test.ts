import { describe, expect, it } from "vitest";
import { CommonMemoryPageOwnership } from "../src/common-memory-page-ownership";
import {
  inspectProcessMemory, registerMemoryAccountingGroup, registerProcessMemoryAccounting,
  type MemoryAccountingGroupSource,
} from "../src/process-memory-accounting";

const PAGE = 65536;
function fixture(roots: Array<{ memory: object; virtualBytes: number; pages: number[] }>, extra: {
  runtimePages?: number[]; reusablePages?: number[]; pinnedPages?: number[];
} = {}) {
  const sample = { pageSize: PAGE, backingBufferBytes: 16 * PAGE,
    allocationExtentBytes: 12 * PAGE, maximumBytes: 32 * PAGE,
    roots, runtimePages: [0], reusablePages: [], pinnedPages: [], ...extra };
  const source: MemoryAccountingGroupSource = { snapshot: () => sample };
  registerMemoryAccountingGroup(source);
  for (const root of roots) registerProcessMemoryAccounting(root.memory, source);
  const entry = (pid: number, memory: object) => ({ pid, memory: memory as WebAssembly.Memory });
  return { source, sample, entry };
}

describe("guest backing accounting", () => {
  it("counts a shared page once, splits its cost, and deduplicates intra-process aliases", () => {
    const a = {}, b = {};
    const { entry } = fixture([
      { memory: a, virtualBytes: 8 * PAGE, pages: [1, 2, 2, 3] },
      { memory: b, virtualBytes: 9 * PAGE, pages: [3, 4] },
    ]);
    const result = inspectProcessMemory([entry(100, a), entry(101, b)]);
    expect(result.processes.get(100)).toMatchObject({ virtualBytes: 8 * PAGE,
      privateBytes: 2 * PAGE, sharedBytes: PAGE, attributedBytes: 2.5 * PAGE });
    expect(result.processes.get(101)).toMatchObject({ privateBytes: PAGE,
      sharedBytes: PAGE, attributedBytes: 1.5 * PAGE });
    const group = result.groups.find(g => g.id === result.processes.get(100)!.groupId)!;
    expect(group.uniqueMappedBytes).toBe(4 * PAGE);
    expect([...result.processes.values()].reduce((sum, p) => sum + p.attributedBytes, 0)).toBe(group.uniqueMappedBytes);
  });

  it("implements the four-worker 20 MiB private + 32 MiB cache example", () => {
    const shared = Array.from({ length: 512 }, (_, i) => i + 1);
    const roots = Array.from({ length: 4 }, (_, i) => ({ memory: {}, virtualBytes: 60 * 1024 ** 2,
      pages: [...shared, ...Array.from({ length: 320 }, (_, j) => 513 + i * 320 + j)] }));
    const { entry, sample } = fixture(roots);
    sample.allocationExtentBytes = 1793 * PAGE;
    sample.backingBufferBytes = 2048 * PAGE;
    sample.maximumBytes = 2048 * PAGE;
    const result = inspectProcessMemory(roots.map((r, i) => entry(100 + i, r.memory)));
    for (const process of result.processes.values()) expect(process).toMatchObject({
      privateBytes: 20 * 1024 ** 2, sharedBytes: 32 * 1024 ** 2, attributedBytes: 28 * 1024 ** 2,
    });
    expect(result.groups.find(g => g.id === result.processes.get(100)!.groupId)!.uniqueMappedBytes).toBe(112 * 1024 ** 2);
  });

  it("keeps pins/unlisted roots, runtime, reuse and unknown allocations in disjoint buckets", () => {
    const a = {}, retired = {};
    const { entry } = fixture([
      { memory: a, virtualBytes: 8 * PAGE, pages: [1, 2] },
      { memory: retired, virtualBytes: 8 * PAGE, pages: [2, 3] },
    ], { runtimePages: [0, 4], reusablePages: [7, 8], pinnedPages: [2, 5] });
    const result = inspectProcessMemory([entry(100, a)]);
    const group = result.groups.find(g => g.id === result.processes.get(100)!.groupId)!;
    expect(group).toMatchObject({ uniqueMappedBytes: 2 * PAGE, runtimeOverheadBytes: 2 * PAGE,
      retainedBytes: 2 * PAGE, reusableBytes: 2 * PAGE, unaccountedBytes: 4 * PAGE,
      unallocatedBytes: 4 * PAGE });
    expect(group.uniqueMappedBytes + group.runtimeOverheadBytes + group.retainedBytes
      + group.reusableBytes + group.unaccountedBytes + group.unallocatedBytes).toBe(group.backingBufferBytes);
    const empty = inspectProcessMemory([]).groups.find(g => g.id === group.id)!;
    expect(empty).toMatchObject({ processCount: 0, uniqueMappedBytes: 0, retainedBytes: 4 * PAGE });
  });

  it("treats an ordinary shared address space once per process and follows growth", () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 5 });
    const entries = [{ pid: 100, memory }, { pid: 101, memory }];
    const first = inspectProcessMemory(entries);
    expect(first.processes.get(100)).toMatchObject({ privateBytes: 0, sharedBytes: 2 * PAGE, attributedBytes: PAGE });
    memory.grow(1);
    const next = inspectProcessMemory(entries);
    expect(next.processes.get(100)).toMatchObject({ groupId: first.processes.get(100)!.groupId,
      virtualBytes: 3 * PAGE, attributedBytes: 1.5 * PAGE });
    expect(next.groups.find(g => g.id === next.processes.get(100)!.groupId)!.maximumBytes).toBeUndefined();
  });

  it("reclassifies a formerly shared mapping when its peer disappears", () => {
    const a = {}, b = {};
    const { sample, entry } = fixture([
      { memory: a, virtualBytes: 8 * PAGE, pages: [1] },
      { memory: b, virtualBytes: 8 * PAGE, pages: [1] },
    ]);
    expect(inspectProcessMemory([entry(100, a), entry(101, b)]).processes.get(100)!.privateBytes).toBe(0);
    sample.roots.pop();
    expect(inspectProcessMemory([entry(100, a)]).processes.get(100)).toMatchObject({
      privateBytes: PAGE, sharedBytes: 0, attributedBytes: PAGE,
    });
  });

  it("keeps equal page numbers in independent backing groups separate", () => {
    const a = {}, b = {};
    const first = fixture([{ memory: a, virtualBytes: PAGE, pages: [1] }]);
    const second = fixture([{ memory: b, virtualBytes: PAGE, pages: [1] }]);
    const report = inspectProcessMemory([first.entry(100, a), second.entry(101, b)]);
    expect(report.processes.get(100)!.groupId).not.toBe(report.processes.get(101)!.groupId);
    for (const process of report.processes.values()) expect(process).toMatchObject({ privateBytes: PAGE, sharedBytes: 0, attributedBytes: PAGE });
  });

  it("refuses inconsistent allocation metadata instead of presenting plausible totals", () => {
    const a = {};
    const source: MemoryAccountingGroupSource = { snapshot: () => ({
      pageSize: PAGE, backingBufferBytes: 4 * PAGE, allocationExtentBytes: 4 * PAGE,
      roots: [{ memory: a, virtualBytes: PAGE, pages: [1] }],
      runtimePages: [0], reusablePages: [1], pinnedPages: [],
    }) };
    registerProcessMemoryAccounting(a, source);
    expect(() => inspectProcessMemory([{ pid: 100, memory: a as WebAssembly.Memory }])).toThrow('overlapping');
  });

  it("accounts for a fork pin after final root retirement, then shows the reusable backing", () => {
    const ledger = new CommonMemoryPageOwnership(() => 4), memory = {}, pin = {};
    const owner = ledger.trackRoot(memory, [1], () => [2, 3], () => {});
    ledger.pin(pin, [3]);
    const source: MemoryAccountingGroupSource = { snapshot: () => {
      const sample = ledger.accountingSnapshot();
      return { ...sample, roots: sample.roots.map(root => ({ ...root, virtualBytes: 2 * PAGE })),
        runtimePages: [0, ...sample.runtimePages], pageSize: PAGE,
        backingBufferBytes: 8 * PAGE, allocationExtentBytes: 4 * PAGE };
    } };
    registerMemoryAccountingGroup(source); registerProcessMemoryAccounting(memory, source);
    const id = inspectProcessMemory([{ pid: 100, memory: memory as WebAssembly.Memory }]).processes.get(100)!.groupId;
    owner.prepareRetirement('quiescent')();
    expect(inspectProcessMemory([]).groups.find(g => g.id === id)).toMatchObject({
      processCount: 0, uniqueMappedBytes: 0, runtimeOverheadBytes: PAGE,
      retainedBytes: PAGE, reusableBytes: 2 * PAGE, unaccountedBytes: 0,
    });
    ledger.disposeSnapshot(pin);
    expect(inspectProcessMemory([]).groups.find(g => g.id === id)).toMatchObject({ retainedBytes: 0, reusableBytes: 3 * PAGE });
  });
});
