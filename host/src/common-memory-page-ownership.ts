import type { ProcessBackingOwner, ProcessBackingRetirementMode } from "./process-memory-backing";

interface Root {
  readonly identity: object;
  readonly reserved: readonly number[];
  readonly mapped: () => Iterable<number>;
  readonly revoke: () => void;
  phase: "live" | "quarantined";
}
interface Block { first: number; pages: number }

/** Kernel-realm ownership of physical pages in an experimental shared group.
 * Page numbers, not virtual addresses. Only the normal allocator's final
 * exact-alias release authorizes retirement. Shared PTEs and captured fork
 * snapshots pin payload independently of the process that allocated it.
 * No inference from PID disappearance, Worker exit events, weak refs or GC.
 */
export class CommonMemoryPageOwnership {
  private readonly roots = new Map<object, Root>();
  private readonly pins = new Map<object, Set<number>>();
  private readonly pending = new Set<number>();
  private free: Block[] = [];
  private retiredRoots = 0;
  private reusedPages = 0;

  constructor(private readonly highWater: () => number) {}

  trackRoot(identity: object, reserved: Iterable<number>, mapped: () => Iterable<number>, revoke: () => void): ProcessBackingOwner {
    if (this.roots.has(identity)) throw new Error("common-memory root already owned");
    const root: Root = { identity, reserved: [...reserved], mapped, revoke, phase: "live" };
    this.validate(root.reserved);
    this.roots.set(identity, root);
    return { memoryModel: "shared-group-v2", prepareRetirement: mode => this.prepareRetirement(root, mode) };
  }

  assertLive(identity: object): void {
    if (this.roots.get(identity)?.phase !== "live") throw new Error("retired common-memory generation");
  }

  pin(snapshot: object, pages: Iterable<number>): void {
    if (this.pins.has(snapshot)) throw new Error("fork snapshot already pinned");
    const values = new Set(pages); this.validate(values);
    this.pins.set(snapshot, values);
  }

  disposeSnapshot(snapshot: object): void {
    if (!this.pins.has(snapshot)) return;
    // Compute before mutation, so invalid metadata leaves pins intact.
    const plan = this.plan([], undefined, snapshot);
    this.pins.delete(snapshot);
    this.publish(plan);
  }

  reclaimUnmapped(pages: Iterable<number>): void {
    this.publish(this.plan(pages));
  }

  /** Zero before the new owner can publish any mapping/root. */
  take(pages: number, zero: (first: number, pages: number) => void): number | undefined {
    if (!Number.isSafeInteger(pages) || pages <= 0) throw new RangeError("invalid page extent");
    const index = this.free.findIndex(block => block.pages >= pages);
    if (index < 0) return undefined;
    const block = this.free[index], first = block.first;
    zero(first, pages);
    block.first += pages; block.pages -= pages;
    if (!block.pages) this.free.splice(index, 1);
    this.reusedPages += pages;
    return first;
  }

  stats(): { rootsTracked: number; quarantinedRoots: number; pendingSnapshots: number; freePages: number; deferredPages: number; retiredRoots: number; reusedPages: number } {
    return { rootsTracked: this.roots.size,
      quarantinedRoots: [...this.roots.values()].filter(root => root.phase === "quarantined").length,
      pendingSnapshots: this.pins.size, freePages: this.free.reduce((n, block) => n + block.pages, 0),
      deferredPages: this.pending.size, retiredRoots: this.retiredRoots, reusedPages: this.reusedPages };
  }

  freeExtents(): ReadonlyArray<Readonly<Block>> {
    return this.free.map(block => ({ ...block }));
  }

  /** Read-only diagnostic sample, including quarantined roots and fork pins.
   * Do not infer reclamation from this report; retirement owns that decision. */
  accountingSnapshot(): {
    roots: Array<{ memory: object; pages: number[] }>;
    runtimePages: number[]; reusablePages: number[]; pinnedPages: number[];
  } {
    const roots = [...this.roots.values()].map(root => ({ memory: root.identity, pages: [...root.mapped()] }));
    const runtimePages = [...this.roots.values()].flatMap(root => [...root.reserved]);
    const reusablePages = this.free.flatMap(block => Array.from({ length: block.pages }, (_, i) => block.first + i));
    const pinnedPages = [...this.pins.values()].flatMap(pages => [...pages]);
    this.validate([...runtimePages, ...reusablePages, ...pinnedPages, ...roots.flatMap(root => root.pages)]);
    return { roots, runtimePages, reusablePages, pinnedPages };
  }

  private prepareRetirement(root: Root, mode: ProcessBackingRetirementMode): () => void {
    if (this.roots.get(root.identity) !== root || root.phase !== "live") throw new Error("common-memory generation already retired");
    if (mode === "forced") {
      let done = false;
      // No ACK/join proof: do not mutate its header, PTEs or backing pages.
      return () => {
        if (done) return;
        this.assertLive(root.identity);
        root.phase = "quarantined"; done = true;
      };
    }
    this.plan([...root.reserved, ...root.mapped()], root);
    let done = false;
    return () => {
      if (done) return;
      this.assertLive(root.identity);
      const plan = this.plan([...root.reserved, ...root.mapped()], root);
      root.revoke();
      this.roots.delete(root.identity);
      this.publish(plan);
      this.retiredRoots++;
      done = true;
    };
  }

  private validate(pages: Iterable<number>): void {
    const high = this.highWater();
    for (const page of pages) {
      if (!Number.isSafeInteger(page) || page <= 0 || page >= high) throw new Error("unallocated common-memory page");
    }
  }

  private plan(pages: Iterable<number>, retired?: Root, disposedSnapshot?: object): { free: Block[]; pending: Set<number> } {
    const candidates = new Set(pages); this.validate(candidates);
    for (const page of candidates) {
      if (this.free.some(block => page >= block.first && page < block.first + block.pages)) throw new Error("duplicate common-memory page release");
    }
    for (const page of this.pending) candidates.add(page);
    const live = new Set<number>();
    for (const root of this.roots.values()) {
      if (root === retired) continue;
      for (const page of root.reserved) live.add(page);
      for (const page of root.mapped()) live.add(page);
    }
    for (const [snapshot, pinned] of this.pins) {
      if (snapshot !== disposedSnapshot) for (const page of pinned) live.add(page);
    }
    this.validate(live);
    const pending = new Set<number>(), eligible: Block[] = [];
    for (const page of candidates) {
      if (live.has(page)) pending.add(page);
      else eligible.push({ first: page, pages: 1 });
    }
    const blocks = [...this.free, ...eligible].sort((a, b) => a.first - b.first), merged: Block[] = [];
    for (const block of blocks) {
      const prior = merged.at(-1);
      if (prior && prior.first + prior.pages > block.first) throw new Error("overlapping common-memory free extents");
      if (prior && prior.first + prior.pages === block.first) prior.pages += block.pages;
      else merged.push({ ...block });
    }
    return { free: merged, pending };
  }

  private publish(plan: { free: Block[]; pending: Set<number> }): void {
    this.free = plan.free;
    this.pending.clear();
    for (const page of plan.pending) this.pending.add(page);
  }
}
