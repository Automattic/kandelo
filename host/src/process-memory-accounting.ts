/** Numeric guest-backing accounting. These are mappings, never host RSS/PSS.
 * Sources and page identities stay in the disposable kernel Worker; only the
 * numeric report crosses to the session/UI. */
export interface ProcessMemoryAccounting {
  groupId: string;
  virtualBytes: number;
  privateBytes: number;
  sharedBytes: number;
  attributedBytes: number;
}

export interface ProcessMemoryGroupAccounting {
  id: string;
  kind: "linear" | "shared-group";
  processCount: number;
  uniqueMappedBytes: number;
  runtimeOverheadBytes: number;
  retainedBytes: number;
  reusableBytes: number;
  unaccountedBytes: number;
  unallocatedBytes: number;
  backingBufferBytes: number;
  allocationExtentBytes: number;
  maximumBytes?: number;
}

export interface MemoryAccountingRoot {
  memory: object;
  virtualBytes: number;
  pages: Iterable<number>;
}

export interface MemoryAccountingGroupSource {
  snapshot(): {
    pageSize: number;
    backingBufferBytes: number;
    allocationExtentBytes: number;
    maximumBytes?: number;
    roots: MemoryAccountingRoot[];
    runtimePages: Iterable<number>;
    reusablePages: Iterable<number>;
    pinnedPages: Iterable<number>;
  };
}

const sources = new Set<WeakRef<MemoryAccountingGroupSource>>();
const memberships = new WeakMap<object, MemoryAccountingGroupSource>();
const ids = new WeakMap<object, string>();
let nextId = 0;

export function registerMemoryAccountingGroup(source: MemoryAccountingGroupSource): void {
  sources.add(new WeakRef(source));
}

export function registerProcessMemoryAccounting(memory: object, source: MemoryAccountingGroupSource): void {
  if (memberships.has(memory)) throw new Error("memory accounting already registered");
  memberships.set(memory, source);
}

function groupId(identity: object): string {
  let id = ids.get(identity);
  if (!id) { id = `memory-${++nextId}`; ids.set(identity, id); }
  return id;
}

export function inspectProcessMemory(registrations: Iterable<{ pid: number; memory: WebAssembly.Memory }>): {
  processes: Map<number, ProcessMemoryAccounting>;
  groups: ProcessMemoryGroupAccounting[];
} {
  const processes = new Map<number, ProcessMemoryAccounting>();
  const groups: ProcessMemoryGroupAccounting[] = [];
  const bySource = new Map<MemoryAccountingGroupSource, Array<{ pid: number; memory: object }>>();
  const linear = new Map<WebAssembly.Memory, number[]>();
  for (const { pid, memory } of registrations) {
    const source = memberships.get(memory);
    if (source) {
      const entries = bySource.get(source) ?? [];
      entries.push({ pid, memory }); bySource.set(source, entries);
    } else {
      const pids = linear.get(memory) ?? [];
      pids.push(pid); linear.set(memory, pids);
    }
  }
  // An allocator can still own backing after its last process has retired.
  // Weak references observe it without extending the allocator's lifetime.
  for (const ref of sources) {
    const source = ref.deref();
    if (!source) sources.delete(ref);
    else if (!bySource.has(source)) bySource.set(source, []);
  }
  for (const [memory, pids] of linear) {
    const bytes = memory.buffer.byteLength, id = groupId(memory);
    for (const pid of pids) processes.set(pid, {
      groupId: id, virtualBytes: bytes,
      privateBytes: pids.length === 1 ? bytes : 0,
      sharedBytes: pids.length > 1 ? bytes : 0,
      attributedBytes: bytes / pids.length,
    });
    groups.push({ id, kind: "linear", processCount: pids.length,
      uniqueMappedBytes: bytes, runtimeOverheadBytes: 0, retainedBytes: 0,
      reusableBytes: 0, unaccountedBytes: 0, unallocatedBytes: 0,
      backingBufferBytes: bytes, allocationExtentBytes: bytes });
  }
  for (const [source, entries] of bySource) {
    const sample = source.snapshot(), id = groupId(source), pageSize = sample.pageSize;
    const extent = sample.allocationExtentBytes / pageSize;
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || !Number.isSafeInteger(extent)
      || extent < 0 || sample.allocationExtentBytes > sample.backingBufferBytes) {
      throw new Error("invalid memory accounting extent");
    }
    const pages = (values: Iterable<number>) => {
      const result = new Set(values);
      for (const page of result) if (!Number.isSafeInteger(page) || page < 0 || page >= extent)
        throw new Error("invalid memory accounting page");
      return result;
    };
    const roots = new Map(sample.roots.map(root => [root.memory, { ...root, pages: pages(root.pages) }]));
    const counts = new Map<number, number>();
    for (const { memory } of entries) {
      const root = roots.get(memory);
      if (!root) throw new Error("registered process missing from memory accounting source");
      // Deduplicate aliases within a process before counting process sharers.
      for (const page of root.pages) counts.set(page, (counts.get(page) ?? 0) + 1);
    }
    for (const { pid, memory } of entries) {
      const root = roots.get(memory)!;
      let privateBytes = 0, sharedBytes = 0;
      const shares = new Map<number, number>();
      for (const page of root.pages) {
        const count = counts.get(page)!;
        if (count === 1) privateBytes += pageSize; else sharedBytes += pageSize;
        shares.set(count, (shares.get(count) ?? 0) + 1);
      }
      // Divide after combining equal-share pages to avoid accumulating one
      // floating-point rounding error per page (e.g. three-way OPcache).
      const attributedBytes = [...shares].reduce((sum, [count, pages]) => sum + pages * pageSize / count, 0);
      processes.set(pid, { groupId: id, virtualBytes: root.virtualBytes,
        privateBytes, sharedBytes, attributedBytes });
    }
    const runtime = pages(sample.runtimePages), reusable = pages(sample.reusablePages);
    const retained = pages(sample.pinnedPages);
    for (const root of roots.values()) for (const page of root.pages) retained.add(page);
    for (const page of counts.keys()) retained.delete(page);
    for (const page of runtime) retained.delete(page);
    // These disjoint buckets reconcile to the allocator's extent. Unknown
    // allocations remain explicit rather than being called runtime overhead.
    const accounted = new Set(counts.keys());
    for (const bucket of [runtime, retained, reusable]) for (const page of bucket) {
      if (accounted.has(page)) throw new Error("overlapping memory accounting buckets");
      accounted.add(page);
    }
    groups.push({ id, kind: "shared-group", processCount: entries.length,
      uniqueMappedBytes: counts.size * pageSize, runtimeOverheadBytes: runtime.size * pageSize,
      retainedBytes: retained.size * pageSize, reusableBytes: reusable.size * pageSize,
      unaccountedBytes: (extent - accounted.size) * pageSize,
      unallocatedBytes: sample.backingBufferBytes - sample.allocationExtentBytes,
      backingBufferBytes: sample.backingBufferBytes,
      allocationExtentBytes: sample.allocationExtentBytes, maximumBytes: sample.maximumBytes });
  }
  return { processes, groups };
}
