import {
  ForkExternrefBroker,
  type ForkExternrefGeneration,
} from "./fork-reference-broker";

/**
 * Where the parent leaves the externref handles its capture interned, in the
 * host-private control prefix below the process main channel's fork buffer.
 *
 * Two slots, both read as `u64` regardless of the guest's pointer width. The
 * dlopen slots in `worker-main.ts` come in wasm32/wasm64 pairs because
 * INSTRUMENTED WASM reads them and must find them at its own width. These are
 * host-to-host only -- a process worker writes them, the kernel worker reads
 * them, and no guest ever touches them -- so one layout serves both widths and
 * there is no second constant to drift.
 *
 * Offsets are BELOW the control address, like the dlopen slots, and sit past
 * the furthest of those (48) with room to spare inside the 4 KiB prefix.
 * `fork-externref-handover.test.ts` pins that they do not collide.
 */
export const EXTERNREF_HANDOVER_ADDR_OFFSET = 64;
export const EXTERNREF_HANDOVER_COUNT_OFFSET = 72;

/**
 * Read the handle list a parent staged before its fork syscall.
 *
 * A zero address means the parent staged nothing, which is the normal case for
 * a capture that interned no externrefs -- distinct from a count of zero at a
 * live address, and both yield an empty list.
 */
export function readCapturedExternrefHandover(
  memory: WebAssembly.Memory,
  controlAddress: number,
  label = "fork externref handover",
): readonly number[] {
  const view = new DataView(memory.buffer);
  const address = Number(
    view.getBigUint64(controlAddress - EXTERNREF_HANDOVER_ADDR_OFFSET, true),
  );
  const count = Number(
    view.getBigUint64(controlAddress - EXTERNREF_HANDOVER_COUNT_OFFSET, true),
  );
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${label}: staged handle count ${count} is not a length`);
  }
  if (address === 0) {
    // No address means the parent staged nothing, which is the normal case for
    // a capture that interned no externrefs. A COUNT with no address is not
    // that: it is a parent that recorded a length and failed to stage, and
    // reading it would take `count` words from the guest's null page and lease
    // whatever they happened to contain.
    if (count !== 0) {
      throw new Error(
        `${label}: ${count} staged handle(s) reported with no address`,
      );
    }
    return [];
  }
  if (address + count * 4 > memory.buffer.byteLength) {
    throw new Error(
      `${label}: staged handles at ${address} run past the parent's memory`,
    );
  }
  return [...new Uint32Array(memory.buffer, address, count)];
}

/** Write the handle list a child will inherit, from the parent's worker. */
export function writeCapturedExternrefHandover(
  memory: WebAssembly.Memory,
  controlAddress: number,
  address: number,
  count: number,
): void {
  const view = new DataView(memory.buffer);
  view.setBigUint64(
    controlAddress - EXTERNREF_HANDOVER_ADDR_OFFSET,
    BigInt(address),
    true,
  );
  view.setBigUint64(
    controlAddress - EXTERNREF_HANDOVER_COUNT_OFFSET,
    BigInt(count),
    true,
  );
}

export interface ForkExternrefForkGrant {
  readonly generation: ForkExternrefGeneration;
  readonly handleCount: number;
}

/**
 * Kernel-Worker owner for opaque host references across process lifetimes.
 *
 * Process and pthread Workers receive only `generation.id`, which stamps their
 * Worker-local handle tokens. No host import registers a real JavaScript value
 * here any more (the cross-worker host-import transport was removed), so a
 * generation's handle set is empty in production.
 *
 * This is intentionally independent of activation-frame layout: fork leases
 * are acquired from the process-wide reference-recipe record already copied
 * through linear memory, so supporting an externref adds no bytes to each
 * activation frame.
 */
export class ForkExternrefProcessOwner {
  private readonly current = new Map<number, ForkExternrefGeneration>();

  constructor(
    private readonly broker = new ForkExternrefBroker(),
  ) {}

  /** Start a PID that does not already have a live Wasm image. */
  startGeneration(pid: number): ForkExternrefGeneration {
    if (this.current.has(pid)) {
      throw new Error(`externref process pid ${pid} already has a live generation`);
    }
    const generation = this.broker.createGeneration(pid);
    this.current.set(pid, generation);
    return generation;
  }

  /**
   * Replace one exact process image at exec's irreversible commit point.
   *
   * The broker retires the old token before returning the replacement, so an
   * async callback from the discarded Worker cannot authorize a post-exec
   * operation merely because the PID stayed the same.
   */
  replaceGeneration(
    expected: ForkExternrefGeneration,
  ): ForkExternrefGeneration {
    this.requireCurrent(expected);
    const replacement = this.broker.createGeneration(expected.pid);
    this.current.set(expected.pid, replacement);
    return replacement;
  }

  /**
   * Grant a fresh fork child the externref handles its parent captured.
   *
   * # Why the parent reports these instead of this worker deriving them
   *
   * This method used to read the parked parent's KFMS arena, run the full
   * segmented-transaction parser and semantic validator over it, and scan the
   * decoded nodes for externref kinds. That needed `fork-module-state` (3825
   * lines) and `fork-reference-wire` (1131) -- about 4,956 lines of host decoder
   * re-deriving a set the parent already had: the fork module is GIVEN each
   * broker handle on `fm_capture_intern`, so the capture knows them exactly.
   *
   * Three things follow from moving it. The work disappears rather than moving,
   * since the parent records handles at intern time. It leaves the KERNEL
   * worker, which is the single thread every process's syscalls serialize
   * through, so a parse here stalls unrelated processes; the parent is already
   * blocked in `fork()` and has nothing else to do. And it stops this worker
   * reading a parked parent's live arena, a constraint the old code called out.
   *
   * # What is given up, and why it is bounded
   *
   * This worker no longer independently derives the set, so it trusts a process
   * worker's list. That trust is bounded by the broker, not by this method:
   * `acquireFork` refuses any handle the parent does not hold
   * (`!parent.handles.has(handle) || !entry.holders.has(parent)`). A wrong list
   * can therefore only over- or under-claim WITHIN the parent's own generation;
   * it can never reach another process's references.
   */
  forkGenerationFromCapturedHandles(
    parent: ForkExternrefGeneration,
    childPid: number,
    handles: Iterable<number>,
    label = `fork child pid=${childPid}: externref owner`,
  ): ForkExternrefForkGrant {
    this.requireCurrent(parent);
    if (this.current.has(childPid)) {
      throw new Error(
        `externref fork child pid ${childPid} already has a live generation`,
      );
    }
    const unique = new Set<number>();
    for (const handle of handles) {
      if (!Number.isInteger(handle) || handle <= 0 || handle > 0xffff_ffff) {
        throw new Error(`${label}: invalid captured externref handle ${handle}`);
      }
      unique.add(handle);
    }

    const child = this.broker.createGeneration(childPid);
    try {
      const lease = this.broker.acquireFork(parent, child, unique);
      this.current.set(childPid, child);
      return Object.freeze({
        generation: child,
        handleCount: lease.handleCount,
      });
    } catch (error) {
      this.broker.releaseGeneration(child);
      throw error;
    }
  }

  releaseGeneration(generation: ForkExternrefGeneration): boolean {
    const current = this.current.get(generation.pid);
    if (current === generation) this.current.delete(generation.pid);
    return this.broker.releaseGeneration(generation);
  }

  private requireCurrent(
    generation: ForkExternrefGeneration,
  ): ForkExternrefGeneration {
    if (this.current.get(generation.pid) !== generation) {
      throw new Error(
        `stale externref process generation ${generation.id} `
        + `for pid ${generation.pid}`,
      );
    }
    return generation;
  }
}
