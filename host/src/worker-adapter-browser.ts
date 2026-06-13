import type { WorkerAdapter, WorkerHandle } from "./worker-adapter";

const WORKER_SHUTDOWN_MESSAGE = "__kandelo_worker_shutdown";
const WORKER_SHUTDOWN_ACK_MESSAGE = "__kandelo_worker_shutdown_ack";
const WORKER_SHUTDOWN_ACK_TIMEOUT_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  private pendingMessages = new Map<string, unknown[]>();
  private terminated = false;
  private terminationPromise: Promise<number> | null = null;
  private shutdownAckResolver: (() => void) | null = null;

  constructor(worker: Worker) {
    this.worker = worker;
    worker.onmessage = (e: MessageEvent) => {
      if (
        e.data &&
        typeof e.data === "object" &&
        (e.data as { type?: string }).type === WORKER_SHUTDOWN_ACK_MESSAGE
      ) {
        this.shutdownAckResolver?.();
        this.shutdownAckResolver = null;
        return;
      }
      this.dispatchOrBuffer("message", e.data);
    };
    worker.onerror = (e: ErrorEvent) => {
      this.dispatchOrBuffer("error", new Error(e.message));
      // Worker errors are unrecoverable — synthesize an exit event
      if (!this.terminated) {
        this.terminated = true;
        this.shutdownAckResolver?.();
        this.shutdownAckResolver = null;
        this.dispatchOrBuffer("exit", 1);
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

    const pending = this.pendingMessages.get(event);
    if (pending && pending.length > 0) {
      this.pendingMessages.delete(event);
      for (const message of pending) {
        handler(message);
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, handler: (...args: any[]) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  private dispatchOrBuffer(event: string, message: unknown): void {
    const handlers = this.handlers.get(event);
    if (!handlers || handlers.size === 0) {
      const pending = this.pendingMessages.get(event);
      if (pending) {
        pending.push(message);
      } else {
        this.pendingMessages.set(event, [message]);
      }
      return;
    }

    for (const h of handlers) h(message);
  }

  async terminate(): Promise<number> {
    if (this.terminationPromise) return this.terminationPromise;
    this.terminationPromise = this.terminateOnce();
    return this.terminationPromise;
  }

  private async terminateOnce(): Promise<number> {
    if (!this.terminated) {
      let acked = false;
      try {
        const ack = new Promise<void>((resolve) => {
          this.shutdownAckResolver = () => {
            acked = true;
            resolve();
          };
        });
        this.worker.postMessage({ type: WORKER_SHUTDOWN_MESSAGE });
        await Promise.race([ack, delay(WORKER_SHUTDOWN_ACK_TIMEOUT_MS)]);
      } catch {
        // Fall back to immediate termination for workers that cannot process
        // the cooperative shutdown message.
      } finally {
        if (!acked && this.shutdownAckResolver) {
          this.shutdownAckResolver = null;
        }
      }
    }

    this.worker.terminate();
    if (!this.terminated) {
      this.terminated = true;
      this.dispatchOrBuffer("exit", 0);
    }
    return 0;
  }
}
