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
  private terminated = false;
  private terminationPromise: Promise<number> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly handlers = new Map<string, Set<(...args: any[]) => void>>();
  private readonly pendingMessages: Array<{
    message: unknown;
    transfer?: Transferable[];
  }> = [];

  constructor(private readonly create: () => WorkerHandle) {}

  /** Construct the backing Worker exactly once. Returns false after cancel. */
  start(): boolean {
    if (this.terminated) return false;
    if (this.worker) return true;

    let worker: WorkerHandle;
    try {
      worker = this.create();
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
    for (const { message, transfer } of this.pendingMessages.splice(0)) {
      worker.postMessage(message, transfer);
    }
    return true;
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
    let handlers = this.handlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(event, handlers);
    }
    handlers.add(handler);
    if (this.worker) this.worker.on(event as any, handler as any);
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
    this.pendingMessages.splice(0);
    this.terminationPromise = this.worker?.terminate() ?? Promise.resolve(0);
    return this.terminationPromise;
  }
}
