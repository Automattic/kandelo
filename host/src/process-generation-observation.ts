import type { ProcessGenerationDetachObservation } from "./process-generation-detach";

/** Correlation within one host instance/kernel realm, not an authority to
 * release Memory. executionId is the authenticated externref process-image ID,
 * not the PID, allocator backing ID, or browser display generation. */
export type ProcessGenerationEventData =
  | { readonly kind: "admitted"; readonly pid: number; readonly executionId: number }
  | { readonly kind: "exited"; readonly pid: number; readonly executionId: number; readonly status: number }
  | {
      readonly kind: "retired";
      readonly pid: number;
      readonly executionId: number;
      readonly leaseDisposition: "quiescent" | "forced" | "unobserved";
      readonly postCommitFailed: boolean;
      readonly registration: "removed-or-absent" | "superseded";
      readonly mainFence: "acknowledged" | "missing";
      readonly threadFences: "acknowledged" | "missing";
      readonly threads: number;
      readonly acknowledgedThreads: number;
    };

/** Public identity is scoped to this host instance AND its actual kernel
 * realm. A reboot can restart executionId; realmId never wraps or repeats. */
export type ProcessGenerationEvent = ProcessGenerationEventData & { readonly realmId: number };

/** Optional observers never participate in the ownership transaction. */
export function deliverProcessGenerationEvent<T extends ProcessGenerationEventData>(
  event: T,
  observer: ((event: T) => void) | undefined,
): void {
  try {
    const result: unknown = observer?.(Object.freeze({ ...event }));
    // A JS caller may supply an async observer despite the void contract.
    // Observe rejection without awaiting it or retaining lifecycle authority.
    if (result !== null && (typeof result === "object" || typeof result === "function")
        && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(() => {});
    }
  } catch { /* observer only */ }
}

interface Observation {
  readonly pid: number;
  readonly executionId: number;
  mainFence: boolean;
  readonly threads: WeakMap<object, { acknowledged: boolean }>;
  threadCount: number;
  acknowledgedThreads: number;
  exited: boolean;
  retired: boolean;
}

/** Weak keys preserve the real lifecycle's ownership, without retaining an
 * extra ProcessInfo/Worker/Memory reference. Only authenticated listener paths
 * call the fence methods; existing synthetic quiescence.settle() is not an ACK.
 * A retired event records committed lease disposition, not blanket quiescence.
 * Only acknowledged fence fields prove guest return, never native join/GC. */
export class ProcessGenerationObservations {
  private readonly records = new WeakMap<object, Observation>();
  private enabled = false;

  constructor(private readonly emit: (event: ProcessGenerationEventData) => void) {}

  /** Called only by normal init, before process admission. No runtime polling. */
  enable(): void { this.enabled = true; }

  admit(pid: number, generation: object, executionId: number): boolean {
    if (!this.enabled) return false;
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(executionId)
        || executionId <= 0) return false;
    const prior = this.records.get(generation);
    if (prior) return prior.pid === pid && prior.executionId === executionId;
    this.records.set(generation, { pid, executionId, mainFence: false,
      threads: new WeakMap(), threadCount: 0, acknowledgedThreads: 0,
      exited: false, retired: false });
    deliverProcessGenerationEvent({ kind: "admitted", pid, executionId }, this.emit);
    return true;
  }

  mainQuiescent(generation: object): void {
    const row = this.records.get(generation);
    if (row && !row.retired) row.mainFence = true;
  }

  threadAdmitted(generation: object, thread: object): void {
    const row = this.records.get(generation);
    if (!row || row.retired || row.threads.has(thread)) return;
    row.threads.set(thread, { acknowledged: false });
    row.threadCount++;
  }

  threadQuiescent(generation: object, thread: object): void {
    const row = this.records.get(generation);
    const state = row?.threads.get(thread);
    if (!row || row.retired || !state || state.acknowledged) return;
    state.acknowledged = true;
    row.acknowledgedThreads++;
  }

  exited(generation: object, status: number): void {
    const row = this.records.get(generation);
    if (!row || row.exited || row.retired) return;
    row.exited = true;
    deliverProcessGenerationEvent({ kind: "exited", pid: row.pid,
      executionId: row.executionId, status }, this.emit);
  }

  /** Called by the actual detach ledger's durable completed edge, including
   * retries; map absence or an exit callback must never call this directly. */
  retired(generation: object, result: ProcessGenerationDetachObservation): void {
    const row = this.records.get(generation);
    if (!row || row.retired) return;
    row.retired = true;
    deliverProcessGenerationEvent({ kind: "retired", pid: row.pid,
      executionId: row.executionId, leaseDisposition: result.leaseDisposition,
      postCommitFailed: result.postCommitFailed,
      registration: result.detachDisposition,
      mainFence: row.mainFence ? "acknowledged" : "missing",
      threadFences: row.threadCount === row.acknowledgedThreads ? "acknowledged" : "missing",
      threads: row.threadCount, acknowledgedThreads: row.acknowledgedThreads }, this.emit);
  }
}
