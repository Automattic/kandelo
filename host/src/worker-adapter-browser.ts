import type { WorkerAdapter, WorkerHandle } from "./worker-adapter";
import { PrestartedWorkerPool } from "./prestarted-worker-pool";

export class BrowserWorkerAdapter implements WorkerAdapter {
  private entryUrl: string | URL;
  private readonly workerPool: PrestartedWorkerPool | null;

  constructor(entryUrl: string | URL, prestartedWorkers?: number) {
    this.entryUrl = entryUrl;
    // Only the machine-owned adapter opts into retention and has a matching
    // destroy boundary. Other public callers keep one Worker per handle.
    this.workerPool = prestartedWorkers === undefined
      ? null
      : new PrestartedWorkerPool(
          () => this.createPhysicalWorker(),
          prestartedWorkers,
        );
  }

  createWorker(workerData: unknown): WorkerHandle {
    // Web Workers don't have workerData. A reserved realm receives exactly one
    // initialization message and is never returned to the reserve afterward.
    if (this.workerPool) return this.workerPool.createWorker(workerData);
    const handle = this.createPhysicalWorker();
    handle.postMessage(workerData);
    return handle;
  }

  async destroy(): Promise<void> {
    await this.workerPool?.destroy();
  }

  private createPhysicalWorker(): WorkerHandle {
    return new BrowserWorkerHandle(
      new Worker(this.entryUrl, { type: "module" }),
    );
  }
}

class BrowserWorkerHandle implements WorkerHandle {
  private worker: Worker;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlers = new Map<string, Set<(...args: any[]) => void>>();
  private terminated = false;
  private terminationPromise: Promise<number> | null = null;

  constructor(worker: Worker) {
    this.worker = worker;
    worker.onmessage = (e: MessageEvent) => {
      for (const h of this.handlers.get("message") ?? []) h(e.data);
    };
    worker.onerror = (e: ErrorEvent) => {
      for (const h of this.handlers.get("error") ?? []) h(new Error(e.message));
      // Worker errors are unrecoverable — synthesize an exit event
      if (!this.terminated) {
        this.terminated = true;
        for (const h of this.handlers.get("exit") ?? []) h(1);
      }
      this.releaseCallbacks();
    };
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.worker.postMessage(message, transfer ?? []);
  }

  on(event: "message", handler: (message: unknown) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  on(event: "exit", handler: (code: number) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, handler: (...args: any[]) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  async terminate(): Promise<number> {
    if (this.terminationPromise) return this.terminationPromise;
    this.terminationPromise = this.terminateOnce();
    return this.terminationPromise;
  }

  private async terminateOnce(): Promise<number> {
    // Terminate immediately, with no cooperative "please shut down" handshake.
    // A process worker is never idle in its JS event loop while alive: it is
    // always either executing wasm or parked in an in-wasm Atomics.wait on the
    // syscall channel (e.g. musl's post-exit_group _Exit loop, or a blocked
    // read/accept). In neither state can it observe a postMessage, so the old
    // handshake never got an ack and just stalled ~500ms per teardown before
    // force-terminating anyway — 500ms that landed on the critical path of the
    // *next* command via waitForProcessTeardowns(). The kernel owns all
    // authoritative process state (kernel worker + shared memory), so hard
    // termination loses nothing. Matches the Node host, whose
    // NodeWorkerHandle.terminate() has always terminated immediately.
    this.worker.terminate();
    if (!this.terminated) {
      this.terminated = true;
      for (const h of this.handlers.get("exit") ?? []) h(0);
    }
    this.releaseCallbacks();
    return 0;
  }

  private releaseCallbacks(): void {
    // WHY: the native Worker owns these closures, and each closure owns this
    // handle's process listeners. Leaving them attached after termination can
    // retain the just-finished process's Module and SharedArrayBuffer graph
    // until cycle collection, even though that worker realm is never reused.
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.handlers.clear();
  }
}
