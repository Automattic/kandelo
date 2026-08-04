import type { WorkerHandle } from "./worker-adapter";

/**
 * Keep a small number of pristine process-worker realms ahead of demand.
 *
 * A physical worker leaves this reserve forever as soon as it receives process
 * initialization. The ordinary process lifecycle still terminates that worker
 * after its exact memory-quiescence fence, so no realm or guest Memory is ever
 * shared with a later process.
 */
export const DEFAULT_PRESTARTED_WORKER_POOL_SIZE = 4;

/** Bound pristine runners by both the machine admission limit and a small cap. */
export function prestartedWorkerPoolSize(maxWorkers: number): number {
  return Math.min(maxWorkers, DEFAULT_PRESTARTED_WORKER_POOL_SIZE);
}

type ManagedWorkerState = "idle" | "leased" | "retiring" | "exited";

interface ManagedWorker {
  readonly handle: WorkerHandle;
  state: ManagedWorkerState;
  termination: Promise<number> | null;
  readonly onError: (...args: unknown[]) => void;
  readonly onExit: (...args: unknown[]) => void;
}

/**
 * A bounded reserve of one-shot physical Workers.
 *
 * Construction starts the reserve before any guest process asks for it. A
 * lease is irreversible: used workers remain in `leased` state until the
 * kernel-owned process lifecycle physically terminates them, while a new,
 * untouched worker is started for the reserve. `destroy()` also terminates
 * both pristine and currently leased workers as a final ownership backstop.
 */
export class PrestartedWorkerPool {
  private readonly workers = new Set<ManagedWorker>();
  private readonly idleWorkers: ManagedWorker[] = [];
  private destroyed = false;

  constructor(
    private readonly createPhysicalWorker: () => WorkerHandle,
    private readonly targetSize = DEFAULT_PRESTARTED_WORKER_POOL_SIZE,
  ) {
    if (!Number.isSafeInteger(targetSize) || targetSize < 0) {
      throw new Error(`invalid prestarted worker pool size: ${targetSize}`);
    }

    try {
      this.fillReserve();
    } catch (error) {
      // A constructor cannot expose `destroy()`. Terminate any workers that
      // were already started before surfacing the resource-creation failure.
      for (const worker of this.workers) void this.retire(worker);
      throw error;
    }
  }

  createWorker(initData: unknown): WorkerHandle {
    if (this.destroyed) {
      throw new Error("prestarted worker pool is destroyed");
    }

    const worker = this.idleWorkers.shift() ?? this.createManagedWorker("leased");
    worker.state = "leased";
    try {
      worker.handle.postMessage(initData);
    } catch (error) {
      // Structured-clone rejection must not leave a worker waiting forever for
      // an initialization that it can never receive.
      void this.retire(worker);
      throw error;
    }

    // WHY: createWorker() callers attach failure listeners immediately after
    // it returns. Replenish in the next microtask so starting the replacement
    // cannot delay that attachment or the leased process's first instruction.
    queueMicrotask(() => this.fillReserveBestEffort());
    return worker.handle;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.idleWorkers.splice(0);
    await Promise.allSettled([...this.workers].map((worker) => this.retire(worker)));
  }

  private fillReserve(): void {
    while (!this.destroyed && this.idleWorkers.length < this.targetSize) {
      this.idleWorkers.push(this.createManagedWorker("idle"));
    }
  }

  private fillReserveBestEffort(): void {
    try {
      this.fillReserve();
    } catch {
      // A reserve is a latency optimization, not authoritative capacity. If
      // speculative creation fails, the next real lease retries synchronously
      // and exposes a persistent Worker-creation failure through the normal
      // process path.
    }
  }

  private createManagedWorker(state: ManagedWorkerState): ManagedWorker {
    const handle = this.createPhysicalWorker();
    let worker!: ManagedWorker;
    worker = {
      handle,
      state,
      termination: null,
      onError: () => {
        // No process owns an idle worker, so there is nobody else to retire a
        // realm whose module failed to initialize. Leased failures remain on
        // the normal process error/teardown path.
        if (worker.state === "idle") void this.retire(worker);
      },
      onExit: () => this.remove(worker),
    };
    handle.on("error", worker.onError);
    handle.on("exit", worker.onExit);
    this.workers.add(worker);
    return worker;
  }

  private remove(worker: ManagedWorker): void {
    if (worker.state === "exited") return;
    worker.state = "exited";
    this.workers.delete(worker);
    const idleIndex = this.idleWorkers.indexOf(worker);
    if (idleIndex >= 0) this.idleWorkers.splice(idleIndex, 1);
    worker.handle.off("error", worker.onError);
    worker.handle.off("exit", worker.onExit);
  }

  private retire(worker: ManagedWorker): Promise<number> {
    if (worker.termination) return worker.termination;
    if (worker.state === "exited") return Promise.resolve(0);
    worker.state = "retiring";
    const idleIndex = this.idleWorkers.indexOf(worker);
    if (idleIndex >= 0) this.idleWorkers.splice(idleIndex, 1);
    worker.termination = Promise.resolve()
      .then(() => worker.handle.terminate())
      .catch(() => 1)
      .finally(() => this.remove(worker));
    return worker.termination;
  }
}
