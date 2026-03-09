export interface WorkerHandle {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  on(event: "message", handler: (message: unknown) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  on(event: "exit", handler: (code: number) => void): void;
  terminate(): Promise<number>;
}

export interface WorkerAdapter {
  createWorker(workerData: unknown): WorkerHandle;
}

// --- Mock implementation for testing ---

export class MockWorkerHandle implements WorkerHandle {
  sentMessages: unknown[] = [];
  private messageHandlers: ((msg: unknown) => void)[] = [];
  private errorHandlers: ((err: Error) => void)[] = [];
  private exitHandlers: ((code: number) => void)[] = [];

  postMessage(message: unknown): void {
    this.sentMessages.push(message);
  }

  on(event: "message", handler: (msg: unknown) => void): void;
  on(event: "error", handler: (err: Error) => void): void;
  on(event: "exit", handler: (code: number) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): void {
    switch (event) {
      case "message":
        this.messageHandlers.push(handler as (msg: unknown) => void);
        break;
      case "error":
        this.errorHandlers.push(handler as (err: Error) => void);
        break;
      case "exit":
        this.exitHandlers.push(handler as (code: number) => void);
        break;
    }
  }

  async terminate(): Promise<number> {
    return 0;
  }

  // --- Test helpers ---

  simulateMessage(msg: unknown): void {
    for (const h of this.messageHandlers) h(msg);
  }

  simulateError(err: Error): void {
    for (const h of this.errorHandlers) h(err);
  }

  simulateExit(code: number): void {
    for (const h of this.exitHandlers) h(code);
  }
}

export class MockWorkerAdapter implements WorkerAdapter {
  lastWorker: MockWorkerHandle | null = null;
  lastWorkerData: unknown = null;
  allWorkers: MockWorkerHandle[] = [];

  createWorker(workerData: unknown): WorkerHandle {
    const handle = new MockWorkerHandle();
    this.lastWorker = handle;
    this.lastWorkerData = workerData;
    this.allWorkers.push(handle);
    return handle;
  }
}

// --- Node.js implementation ---

import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

export class NodeWorkerAdapter implements WorkerAdapter {
  private entryUrl: URL;

  constructor(entryUrl?: URL) {
    this.entryUrl =
      entryUrl ?? new URL("./worker-entry.ts", import.meta.url);
  }

  createWorker(workerData: unknown): WorkerHandle {
    // Resolve tsx/esm/api to an absolute file URL so the eval'd worker
    // can import it without relying on bare-specifier resolution.
    const require = createRequire(import.meta.url);
    const tsxApiPath = require.resolve("tsx/esm/api");
    const tsxApiUrl = pathToFileURL(tsxApiPath).href;
    const entryUrl = this.entryUrl.href;

    // Workers cannot use `--import tsx` because Node.js customisation
    // hooks registered via `module.register()` do not propagate to
    // worker threads.  Instead we use an eval bootstrap that registers
    // tsx inside the worker and then dynamically imports the real entry.
    const bootstrap = [
      `import { register } from '${tsxApiUrl}';`,
      `register();`,
      `await import('${entryUrl}');`,
    ].join("\n");

    const worker = new Worker(bootstrap, {
      eval: true,
      workerData,
    });
    return new NodeWorkerHandle(worker);
  }
}

class NodeWorkerHandle implements WorkerHandle {
  constructor(private worker: Worker) {}

  postMessage(message: unknown, transfer?: Transferable[]): void {
    if (transfer) {
      this.worker.postMessage(
        message,
        transfer as import("node:worker_threads").TransferListItem[],
      );
    } else {
      this.worker.postMessage(message);
    }
  }

  on(event: "message", handler: (msg: unknown) => void): void;
  on(event: "error", handler: (err: Error) => void): void;
  on(event: "exit", handler: (code: number) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): void {
    this.worker.on(event, handler);
  }

  async terminate(): Promise<number> {
    return this.worker.terminate();
  }
}
