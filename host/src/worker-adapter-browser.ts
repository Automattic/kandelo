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
    this.worker.terminate();
    if (!this.terminated) {
      this.terminated = true;
      for (const h of this.handlers.get("exit") ?? []) h(0);
    }
    return 0;
  }
}
