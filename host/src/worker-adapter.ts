export interface WorkerHandle {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  on(event: "message", handler: (message: unknown) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  on(event: "exit", handler: (code: number) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  terminate(): Promise<number>;
}

export interface WorkerAdapter {
  createWorker(workerData: unknown): WorkerHandle;
  destroy?(): Promise<void>;
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, handler: (...args: any[]) => void): void {
    switch (event) {
      case "message": {
        const idx = this.messageHandlers.indexOf(handler as (msg: unknown) => void);
        if (idx >= 0) this.messageHandlers.splice(idx, 1);
        break;
      }
      case "error": {
        const idx = this.errorHandlers.indexOf(handler as (err: Error) => void);
        if (idx >= 0) this.errorHandlers.splice(idx, 1);
        break;
      }
      case "exit": {
        const idx = this.exitHandlers.indexOf(handler as (code: number) => void);
        if (idx >= 0) this.exitHandlers.splice(idx, 1);
        break;
      }
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

  async destroy(): Promise<void> {}
}

// --- Node.js implementation ---

import { Worker, type WorkerOptions } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { NODE_WORKER_INIT_BY_MESSAGE } from "./node-worker-initialization";
import { PrestartedWorkerPool } from "./prestarted-worker-pool";

// Wasm guest stacks consume the embedding worker's native stack when engines
// recurse through Wasm frames. Keep the default high enough for stack-heavy
// POSIX workloads while retaining an environment override for constrained
// embedders.
const DEFAULT_NODE_WORKER_STACK_SIZE_MB = 32;

function currentModuleUrl(): string {
  if (typeof __filename !== "undefined") return pathToFileURL(__filename).href;
  return import.meta.url;
}

/** @internal Exported so the host policy can be validated without spawning a worker. */
export function nodeWorkerStackSizeMb(
  raw = process.env.KANDELO_NODE_WORKER_STACK_SIZE_MB,
): number {
  if (raw === undefined || raw === "") return DEFAULT_NODE_WORKER_STACK_SIZE_MB;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid KANDELO_NODE_WORKER_STACK_SIZE_MB: ${raw}`);
  }
  return parsed;
}

/** @internal Exported so tests can verify resource-limit composition. */
export function nodeWorkerOptions(
  workerData: unknown,
  options: WorkerOptions = {},
): WorkerOptions {
  return {
    ...options,
    workerData,
    resourceLimits: {
      ...options.resourceLimits,
      stackSizeMb: nodeWorkerStackSizeMb(),
    },
  };
}

/** @internal Exported so the process-memory ownership policy stays testable. */
export function nodeWorkerInitialization(
  init: unknown,
  initializeByMessage: boolean,
):
  | {
    transport: "worker-data";
    workerDataValue: unknown;
  }
  | {
    transport: "message";
    workerDataValue: typeof NODE_WORKER_INIT_BY_MESSAGE;
    initialMessage: unknown;
  } {
  if (!initializeByMessage) {
    return {
      transport: "worker-data",
      workerDataValue: init,
    };
  }
  // WHY: built-in process init carries Shared WebAssembly.Memory. Node exposes
  // the structured clone as the worker module's workerData value. The matched
  // lifecycle reached lower peak RSS when Kandelo avoided that startup route.
  // A message keeps the same structured-clone semantics while letting its
  // listener and activation-owned value be released after delivery.
  return {
    transport: "message",
    workerDataValue: NODE_WORKER_INIT_BY_MESSAGE,
    initialMessage: init,
  };
}

export class NodeWorkerAdapter implements WorkerAdapter {
  private entryUrl: URL;
  private _compiledEntry: URL | false | undefined;
  private readonly initializeByMessage: boolean;
  private readonly workerPool: PrestartedWorkerPool | null;

  constructor(
    entryUrl?: URL,
    prestartedWorkers?: number,
  ) {
    // WHY: arbitrary custom entries may read workerData directly and do not
    // understand Kandelo's marker/message protocol. Only the built-in entry can
    // safely select the new transport without changing the public custom-entry
    // contract.
    this.initializeByMessage = entryUrl === undefined;
    this.entryUrl =
      entryUrl ?? new URL("./worker-entry.ts", currentModuleUrl());
    // The machine-owned adapter starts a bounded reserve of pristine runners.
    // Direct/public adapter callers retain their historical one-shot Worker
    // lifetime unless they opt in explicitly.
    this.workerPool = this.initializeByMessage && prestartedWorkers !== undefined
      ? new PrestartedWorkerPool(() =>
          new NodeWorkerHandle(
            this.createWorkerThread(NODE_WORKER_INIT_BY_MESSAGE),
          ), prestartedWorkers)
      : null;
  }

  /**
   * Try to find a compiled .js version of the entry file.
   * Checks: ../dist/<basename>.js (tsup output), then sibling .js.
   */
  private resolveCompiledEntry(): URL | null {
    if (this._compiledEntry !== undefined) {
      return this._compiledEntry || null;
    }
    if (this.entryUrl.protocol !== "file:") {
      this._compiledEntry = false;
      return null;
    }
    const href = this.entryUrl.href;

    // Check tsup dist output: src/worker-entry.ts → dist/worker-entry.js
    const distUrl = new URL(href.replace(/\/src\/([^/]+)\.ts$/, "/dist/$1.js"));
    if (distUrl.href !== href && existsSync(distUrl)) {
      this._compiledEntry = distUrl;
      return distUrl;
    }

    // Check sibling .js file
    const jsUrl = new URL(href.replace(/\.ts$/, ".js"));
    if (jsUrl.href !== href && existsSync(jsUrl)) {
      this._compiledEntry = jsUrl;
      return jsUrl;
    }

    this._compiledEntry = false;
    return null;
  }

  private initializeWorker(
    worker: Worker,
    initialization: ReturnType<typeof nodeWorkerInitialization>,
  ): WorkerHandle {
    if (initialization.transport === "message") {
      try {
        worker.postMessage(initialization.initialMessage);
      } catch (error) {
        // The Worker exists by this point. Do not leave a realm waiting
        // forever for an init value that structured clone rejected.
        void worker.terminate();
        throw error;
      }
    }
    return new NodeWorkerHandle(worker);
  }

  private createWorkerThread(workerData: unknown): Worker {
    // Try the compiled JS entry first (much faster startup — avoids tsx
    // bootstrap which takes >500ms with 10+ concurrent workers).
    const compiledEntry = this.resolveCompiledEntry();
    if (compiledEntry) {
      return new Worker(compiledEntry, nodeWorkerOptions(workerData));
    }

    // Fallback: tsx eval bootstrap for running from TypeScript source.
    const require = createRequire(currentModuleUrl());
    const tsxApiPath = require.resolve("tsx/esm/api");
    const tsxApiUrl = pathToFileURL(tsxApiPath).href;
    const entryUrl = this.entryUrl.href;

    const bootstrap = [
      `import { register } from '${tsxApiUrl}';`,
      `register();`,
      `await import('${entryUrl}');`,
    ].join("\n");

    return new Worker(
      bootstrap,
      nodeWorkerOptions(workerData, { eval: true }),
    );
  }

  createWorker(workerData: unknown): WorkerHandle {
    if (this.workerPool) return this.workerPool.createWorker(workerData);

    const initialization = nodeWorkerInitialization(
      workerData,
      this.initializeByMessage,
    );
    return this.initializeWorker(
      this.createWorkerThread(initialization.workerDataValue),
      initialization,
    );
  }

  async destroy(): Promise<void> {
    await this.workerPool?.destroy();
  }
}

class NodeWorkerHandle implements WorkerHandle {
  private terminationPromise: Promise<number> | null = null;

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, handler: (...args: any[]) => void): void {
    this.worker.off(event, handler);
  }

  async terminate(): Promise<number> {
    if (this.terminationPromise) return this.terminationPromise;
    const termination = this.worker.terminate();
    this.terminationPromise = termination;
    return termination;
  }
}
