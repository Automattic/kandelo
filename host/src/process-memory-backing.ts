/** Internal backing ownership for opt-in process-memory implementations.
 *
 * This is called by the allocator's final alias release, after the normal
 * exact-generation teardown. Exit observers and GC must never call it.
 * A forced release quarantines a backing; it does not authorize reuse.
 */
export type ProcessBackingRetirementMode = "quiescent" | "forced";

export interface ProcessBackingOwner {
  readonly memoryModel?: "shared-group-v2";
  /** Request a native Wasm stop trap; ownership remains live until its fence. */
  requestExecutionStop?(): void;
  /** Validate without changing ownership. Commit is synchronous, idempotent,
   * and must perform all fallible checks before publishing reclaimed pages. */
  prepareRetirement(mode: ProcessBackingRetirementMode): () => void;
  /** Only a construction owner that knows whether the backing escaped can
   * supply this receipt. Unknown/exposed backings must remain quarantined. */
  prepareRejectedAllocation?(): () => void;
}

const backings = new WeakMap<object, { owner: ProcessBackingOwner; admitted: boolean }>();
const snapshots = new WeakMap<object, () => void>();

/** Report the actual registered backing, never an application-supplied flag. */
export function processBackingMemoryModel(memory: object): 0 | 2 {
  return backings.get(memory)?.owner.memoryModel === "shared-group-v2" ? 2 : 0;
}

export function supportsProcessBackingExecutionStop(memory: object): boolean {
  const backing = backings.get(memory);
  return backing?.admitted === true && backing.owner.memoryModel === "shared-group-v2"
    && typeof backing.owner.requestExecutionStop === "function";
}

export function requestProcessBackingExecutionStop(memory: object): void {
  const backing = backings.get(memory);
  if (!backing?.admitted || backing.owner.memoryModel !== "shared-group-v2"
    || !backing.owner.requestExecutionStop) throw new Error("backing lacks execution-stop capability");
  backing.owner.requestExecutionStop();
}

/** Construction-time registration, inside the owning kernel realm only. */
export function registerProcessBacking(memory: object, owner: ProcessBackingOwner): void {
  if (backings.has(memory)) throw new Error("process backing already has an owner");
  if (owner.memoryModel !== undefined && owner.memoryModel !== "shared-group-v2") {
    throw new Error("unsupported process backing memory model");
  }
  backings.set(memory, { owner, admitted: false });
}

export function admitProcessBacking(memory: object): void {
  const backing = backings.get(memory);
  if (backing) backing.admitted = true;
}

/** Failed async factory admission must not dispose a previously admitted
 * backing maliciously/incorrectly returned a second time by that factory. */
export function rejectUnpublishedProcessBacking(memory: object): void {
  const backing = backings.get(memory);
  if (!backing || backing.admitted || !backing.owner.prepareRejectedAllocation) return;
  backing.owner.prepareRejectedAllocation()();
  backings.delete(memory);
}

export function prepareProcessBackingRetirement(
  memory: object,
  mode: ProcessBackingRetirementMode,
): (() => void) | undefined {
  const backing = backings.get(memory);
  if (!backing) return undefined;
  const commit = backing.owner.prepareRetirement(mode);
  let committed = false;
  return () => {
    if (committed) return;
    // A failed preflight/commit keeps the lease retryable. The backing owner
    // must not throw after publishing its ownership change.
    commit();
    committed = true;
    backings.delete(memory);
  };
}

/** A captured fork snapshot owns pins until copy completion or cancellation.
 * The async allocator closes it in finally, including factory/admission errors.
 */
export function registerProcessForkSnapshot(snapshot: object, dispose: () => void): void {
  if (snapshots.has(snapshot)) throw new Error("fork snapshot already has an owner");
  snapshots.set(snapshot, dispose);
}

export function disposeProcessForkSnapshot(snapshot: object | undefined): void {
  if (!snapshot) return;
  const dispose = snapshots.get(snapshot);
  if (!dispose) return;
  dispose();
  snapshots.delete(snapshot);
}
