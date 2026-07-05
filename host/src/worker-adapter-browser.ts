import type { WorkerAdapter, WorkerHandle } from "./worker-adapter";

export class BrowserWorkerAdapter implements WorkerAdapter {
  private entryUrl: string | URL;

  constructor(entryUrl: string | URL) {
    this.entryUrl = entryUrl;
  }

  createWorker(workerData: unknown): WorkerHandle {
    const worker = new Worker(this.entryUrl, { type: "module" });
    // Web Workers don't have workerData — send init data via postMessage
    const handle = new BrowserWorkerHandle(worker);
    worker.postMessage(workerData);
    return handle;
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
    return 0;
  }
}
