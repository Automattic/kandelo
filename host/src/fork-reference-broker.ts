/**
 * Process-generation bookkeeping for opaque `externref` handles.
 *
 * WebAssembly treats an externref as an opaque identity. A fork child runs in
 * a fresh Worker, so copying a JavaScript object into that Worker is neither
 * generally possible nor identity preserving.
 *
 * Nothing registers a host value with this broker any more: the cross-worker
 * host-import transport that did so was deleted (stage E1 of removing host
 * externrefs across fork) because no production import ever used it. Every
 * generation's handle set is therefore empty in production, and a fork that
 * carries a raw host externref fails at capture, where the worker has no
 * handle to name it by. What remains -- generations, the fork grant, and the
 * worker-local token cache -- is what stage E2 replaces with an EOPNOTSUPP
 * refusal on every host.
 */

const GENERATION_TOKEN = Symbol("kandelo.fork.externref-generation");
const HANDLE_TOKEN = Symbol("kandelo.fork.externref-handle");
const WORKER_GENERATION_TOKEN =
  Symbol("kandelo.fork.externref-worker-generation");
const MAX_WIRE_ID = 0xffff_ffff;

export interface ForkExternrefToken {
  readonly [HANDLE_TOKEN]: number;
  readonly [WORKER_GENERATION_TOKEN]: number;
}

/**
 * Exact lifetime of one process Wasm image.
 *
 * A PID survives exec, so it is not sufficient authority for a host-owned
 * externref. The broker issues a fresh token for every execution generation
 * and rejects a token as soon as that generation is replaced or released.
 */
export interface ForkExternrefGeneration {
  readonly id: number;
  readonly pid: number;
  readonly [GENERATION_TOKEN]: true;
}

export interface ForkExternrefLease {
  readonly generation: ForkExternrefGeneration;
  readonly handleCount: number;
}

interface BrokerEntry {
  holders: Set<BrokerGenerationState>;
}

interface BrokerForkLeaseState {
  readonly generation: BrokerGenerationState;
  readonly handles: Set<number>;
  released: boolean;
}

interface BrokerGenerationState {
  readonly token: ForkExternrefGeneration;
  readonly forkHandleCounts: Map<number, number>;
  readonly handles: Set<number>;
  readonly forkLeases: Set<BrokerForkLeaseState>;
  status: "active" | "released" | "replaced";
}

function assertProcessId(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid > MAX_WIRE_ID) {
    throw new RangeError(`invalid externref holder pid ${pid}`);
  }
}

function assertHandle(handle: number): void {
  if (!Number.isInteger(handle) || handle <= 0 || handle > MAX_WIRE_ID) {
    throw new RangeError(`invalid externref handle ${handle}`);
  }
}

function assertWireLimit(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_WIRE_ID) {
    throw new RangeError(`${name} must be a positive unsigned 32-bit integer`);
  }
}

/**
 * Kernel-side owner of externref process generations.
 *
 * Ownership is deliberately generation-scoped and set-valued. Ten globals or
 * graph edges that alias one externref require one owner entry, not ten
 * reference counts.
 */
export class ForkExternrefBroker {
  private nextGeneration = 1;
  private readonly entries = new Map<number, BrokerEntry>();
  private readonly generations =
    new WeakMap<ForkExternrefGeneration, BrokerGenerationState>();
  private readonly currentGenerations = new Map<number, BrokerGenerationState>();

  /**
   * Begin one exact process-image lifetime.
   *
   * Creating a replacement for the same PID retires the old generation before
   * the new token is returned. WHY: delayed worker teardown must never use an
   * old PID-only capability to resolve values for the post-exec image.
   */
  createGeneration(pid: number): ForkExternrefGeneration {
    assertProcessId(pid);
    if (this.nextGeneration > MAX_WIRE_ID) {
      throw new RangeError("externref generation space exhausted");
    }
    const id = this.nextGeneration++;
    const token: ForkExternrefGeneration = Object.freeze({
      id,
      pid,
      [GENERATION_TOKEN]: true as const,
    });
    const state: BrokerGenerationState = {
      token,
      forkHandleCounts: new Map(),
      handles: new Set(),
      forkLeases: new Set(),
      status: "active",
    };

    const previous = this.currentGenerations.get(pid);
    if (previous) this.closeGeneration(previous, "replaced");
    this.generations.set(token, state);
    this.currentGenerations.set(pid, state);
    return token;
  }

  /**
   * Duplicate a parent's unique handle set for a fork child.
   *
   * WHY validation and mutation are separate passes: a corrupt recipe must not
   * leave the child holding the valid prefix of an otherwise rejected
   * snapshot. The mutation pass also has an explicit rollback so any future
   * bookkeeping that can fail preserves that all-or-nothing boundary.
   */
  acquireFork(
    parentGeneration: ForkExternrefGeneration,
    childGeneration: ForkExternrefGeneration,
    uniqueHandles: Iterable<number>,
  ): ForkExternrefLease {
    const parent = this.requireActiveGeneration(parentGeneration);
    const child = this.requireActiveGeneration(childGeneration);
    if (parent === child || parent.token.pid === child.token.pid) {
      throw new Error("externref fork requires distinct process generations");
    }

    const handles = new Set<number>();
    for (const handle of uniqueHandles) {
      assertHandle(handle);
      handles.add(handle);
    }

    const validated: Array<[number, BrokerEntry]> = [];
    for (const handle of handles) {
      const entry = this.requireEntry(handle);
      if (!parent.handles.has(handle) || !entry.holders.has(parent)) {
        throw new Error(
          `externref generation ${parent.token.id} for pid ${parent.token.pid} `
          + `does not own handle ${handle}`,
        );
      }
      if (child.handles.has(handle) !== entry.holders.has(child)) {
        throw new Error(
          `externref generation ${child.token.id} has inconsistent ownership `
          + `for handle ${handle}`,
        );
      }
      const childLeaseCount = child.forkHandleCounts.get(handle) ?? 0;
      if (childLeaseCount >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError(
          `externref fork lease count overflow for handle ${handle}`,
        );
      }
      validated.push([handle, entry]);
    }

    const leaseState: BrokerForkLeaseState = {
      generation: child,
      handles: new Set(),
      released: false,
    };
    const applied: Array<[number, BrokerEntry, number, boolean]> = [];
    try {
      for (const [handle, entry] of validated) {
        const previousCount = child.forkHandleCounts.get(handle) ?? 0;
        const addedOwnership = !child.handles.has(handle);
        // Record the old state before the first mutation so every partial step
        // in this iteration is included in rollback.
        applied.push([handle, entry, previousCount, addedOwnership]);
        child.forkHandleCounts.set(handle, previousCount + 1);
        if (addedOwnership) {
          child.handles.add(handle);
          entry.holders.add(child);
        }
        leaseState.handles.add(handle);
      }
      child.forkLeases.add(leaseState);
    } catch (error) {
      for (let index = applied.length - 1; index >= 0; index--) {
        const [handle, entry, previousCount, addedOwnership] = applied[index]!;
        if (previousCount === 0) child.forkHandleCounts.delete(handle);
        else child.forkHandleCounts.set(handle, previousCount);
        if (addedOwnership) {
          child.handles.delete(handle);
          entry.holders.delete(child);
        }
      }
      throw error;
    }
    return Object.freeze({
      generation: child.token,
      handleCount: leaseState.handles.size,
    });
  }

  /** Retire every handle and lease owned by one exact execution generation. */
  releaseGeneration(generation: ForkExternrefGeneration): boolean {
    const state = this.generationState(generation);
    if (state.status !== "active") return false;
    this.closeGeneration(state, "released");
    return true;
  }

  private closeGeneration(
    generation: BrokerGenerationState,
    status: "released" | "replaced",
  ): void {
    if (generation.status !== "active") return;
    generation.status = status;
    if (this.currentGenerations.get(generation.token.pid) === generation) {
      this.currentGenerations.delete(generation.token.pid);
    }
    for (const lease of generation.forkLeases) {
      lease.handles.clear();
      lease.released = true;
    }
    generation.forkLeases.clear();
    generation.forkHandleCounts.clear();
    for (const handle of generation.handles) {
      const entry = this.entries.get(handle);
      if (!entry) continue;
      entry.holders.delete(generation);
      if (entry.holders.size === 0) this.entries.delete(handle);
    }
    generation.handles.clear();
  }

  private generationState(
    generation: ForkExternrefGeneration,
  ): BrokerGenerationState {
    if (
      typeof generation !== "object"
      || generation === null
      || generation[GENERATION_TOKEN] !== true
    ) {
      throw new Error("unknown externref generation token");
    }
    const state = this.generations.get(generation);
    if (!state) throw new Error("externref generation belongs to another broker");
    return state;
  }

  private requireActiveGeneration(
    generation: ForkExternrefGeneration,
  ): BrokerGenerationState {
    const state = this.generationState(generation);
    if (
      state.status !== "active"
      || this.currentGenerations.get(state.token.pid) !== state
    ) {
      throw new Error(
        `stale externref generation ${state.token.id} for pid ${state.token.pid}`,
      );
    }
    return state;
  }

  private requireEntry(handle: number): BrokerEntry {
    const entry = this.entries.get(handle);
    if (entry) return entry;
    throw new Error(`unknown externref handle ${handle}`);
  }
}

/**
 * Worker-local canonical tokens for broker handles.
 *
 * A child never receives the parent's token object. It recreates exactly one
 * local token per handle, which preserves all identity observations available
 * to Wasm while keeping the actual object under broker ownership.
 */
export class ForkExternrefTokenCache {
  private readonly tokens = new Map<number, WeakRef<ForkExternrefToken>>();

  constructor(readonly generationId: number) {
    assertWireLimit(generationId, "externref worker generation");
  }

  materialize(handle: number): ForkExternrefToken {
    assertHandle(handle);
    let token = this.tokens.get(handle)?.deref();
    if (!token) {
      token = Object.freeze({
        [HANDLE_TOKEN]: handle,
        [WORKER_GENERATION_TOKEN]: this.generationId,
      });
      this.tokens.set(handle, new WeakRef(token));
    }
    return token;
  }

  encode(value: unknown): number | null {
    if (
      typeof value !== "object"
      || value === null
      || !(HANDLE_TOKEN in value)
      || !(WORKER_GENERATION_TOKEN in value)
    ) {
      return null;
    }
    if (
      (value as ForkExternrefToken)[WORKER_GENERATION_TOKEN]
        !== this.generationId
    ) {
      return null;
    }
    const handle = (value as ForkExternrefToken)[HANDLE_TOKEN];
    assertHandle(handle);
    return handle;
  }

  clear(): void {
    // Weak references do not own the tokens; clearing merely forgets canonical
    // lookup entries at exec/process teardown.
    this.tokens.clear();
  }
}
