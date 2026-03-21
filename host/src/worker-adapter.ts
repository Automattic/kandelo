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
}

// --- Node.js implementation ---

import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

export class NodeWorkerAdapter implements WorkerAdapter {
  private entryUrl: URL;
  private _compiledEntry: URL | false | undefined;

  constructor(entryUrl?: URL) {
    this.entryUrl =
      entryUrl ?? new URL("./worker-entry.ts", import.meta.url);
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

  createWorker(workerData: unknown): WorkerHandle {
    // Try the compiled JS entry first (much faster startup — avoids tsx
    // bootstrap which takes >500ms with 10+ concurrent workers).
    const compiledEntry = this.resolveCompiledEntry();
    if (compiledEntry) {
      const worker = new Worker(compiledEntry, { workerData });
      return new NodeWorkerHandle(worker);
    }

    // Fallback: tsx eval bootstrap for running from TypeScript source.
    const require = createRequire(import.meta.url);
    const tsxApiPath = require.resolve("tsx/esm/api");
    const tsxApiUrl = pathToFileURL(tsxApiPath).href;
    const entryUrl = this.entryUrl.href;

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, handler: (...args: any[]) => void): void {
    this.worker.off(event, handler);
  }

  async terminate(): Promise<number> {
    return this.worker.terminate();
  }
}
