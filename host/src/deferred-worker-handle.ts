import type { WorkerHandle } from "./worker-adapter";

/**
 * A WorkerHandle whose backing Worker is constructed only when `start()` is
 * called. Process setup can therefore publish memory, channels, and host
 * metadata while a job-control-stopped process remains unable to execute a
 * single guest instruction. Listeners are installed on the eventual Worker
 * as one generation, and `terminate()` before `start()` permanently cancels
 * the launch.
 */
export class DeferredWorkerHandle implements WorkerHandle {
  private worker: WorkerHandle | null = null;
  #constructionAttempted = false;
  #absenceSealed = false;
  #backingTerminationCompleted = false;
  private terminated = false;
  private terminationPromise: Promise<number> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly handlers = new Map<string, Set<(...args: any[]) => void>>();
  private readonly pendingMessages: Array<{
    message: unknown;
    transfer?: Transferable[];
  }> = [];

  constructor(private create: (() => WorkerHandle) | null) {}

  /** Construct the backing Worker exactly once. Returns false after cancel. */
  start(): boolean {
    if (this.#absenceSealed || this.terminated) return false;
    if (this.worker) return true;
    const create = this.create;
    if (!create) return false;
    // WHY: the factory normally closes over initData, including process
    // Memory. Clear it before construction so the DeferredWorkerHandle cannot
    // retain that generation after start or a synchronous constructor failure.
    this.create = null;

    // WHY: construction can publish a realm before throwing or reentering
    // host cleanup. Mark the attempt BEFORE factory entry; a null backing
    // handle, a constructor exception, and terminate() never prove absence.
    this.#constructionAttempted = true;
    let worker: WorkerHandle;
    try {
      worker = create();
    } catch (error) {
      this.terminated = true;
      this.pendingMessages.splice(0);
      // Construction is part of fork/spawn/exec/clone setup. Propagate a
      // synchronous failure to that operation's existing rollback/error path;
      // emitting an error event here would race the same failure through host
      // teardown while callers incorrectly continue as if launch succeeded.
      throw error;
    }

    this.worker = worker;
    for (const [event, handlers] of this.handlers) {
      for (const handler of handlers) worker.on(event as any, handler as any);
    }
    this.handlers.clear();
    for (const { message, transfer } of this.pendingMessages.splice(0)) {
      worker.postMessage(message, transfer);
    }
    return true;
  }

  /** Atomically seal only the exact implementation whose start we own. */
  static sealNeverStarted(worker: WorkerHandle): boolean {
    // WHY: an unknown, proxied or derived handle can construct outside this
    // private start path. Do not trust a public "not started" claim or call a
    // virtual terminate method before accepting absence as ownership proof.
    if (!(#constructionAttempted in worker)
        || Object.getPrototypeOf(worker) !== DeferredWorkerHandle.prototype
        || worker.#constructionAttempted) return false;
    // Seal before releasing init roots. A later continue wake must never
    // construct a realm after absence allowed its slot/backing to be reused.
    worker.#absenceSealed = true;
    worker.terminated = true;
    worker.create = null;
    worker.pendingMessages.splice(0);
    worker.handlers.clear();
    return true;
  }

  /** Fulfillment of a returned backing's terminate promise, never an ACK.
   * Node's adapter joins at this edge; the browser adapter does not. */
  static hasCompletedBackingTermination(worker: WorkerHandle): boolean {
    return #constructionAttempted in worker
      && Object.getPrototypeOf(worker) === DeferredWorkerHandle.prototype
      && worker.#backingTerminationCompleted;
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    if (this.terminated) return;
    if (this.worker) {
      this.worker.postMessage(message, transfer);
      return;
    }
    this.pendingMessages.push({ message, transfer });
  }

  on(event: "message", handler: (message: unknown) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  on(event: "exit", handler: (code: number) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): void {
    if (this.worker) {
      this.worker.on(event as any, handler as any);
      return;
    }
    let handlers = this.handlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(event, handlers);
    }
    handlers.add(handler);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, handler: (...args: any[]) => void): void {
    this.handlers.get(event)?.delete(handler);
    if (this.worker) this.worker.off(event, handler);
  }

  terminate(): Promise<number> {
    if (this.terminationPromise) return this.terminationPromise;
    if (this.terminated) return Promise.resolve(0);
    this.terminated = true;
    // A canceled deferred launch must release its captured initData even
    // though no backing Worker ever existed.
    this.create = null;
    this.pendingMessages.splice(0);
    this.handlers.clear();
    const worker = this.worker;
    this.worker = null;
    this.terminationPromise = worker
      ? worker.terminate().then((code) => {
          this.#backingTerminationCompleted = true;
          return code;
        })
      : Promise.resolve(0);
    return this.terminationPromise;
  }
}

/** A local absence proof, deliberately separate from Worker message fences. */
export interface WorkerAbsence {
  readonly proven: boolean;
  seal(): boolean;
}

/** Shared by both hosts; unknown WorkerHandle implementations stay unproven. */
export function createWorkerAbsence(
  worker: WorkerHandle,
  onProven: () => void,
): WorkerAbsence {
  let proven = false;
  return {
    get proven() { return proven; },
    seal() {
      if (proven) return true;
      if (!DeferredWorkerHandle.sealNeverStarted(worker)) {
        return false;
      }
      proven = true;
      onProven();
      return true;
    },
  };
}
