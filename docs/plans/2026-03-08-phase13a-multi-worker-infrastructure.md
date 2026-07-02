# Phase 13a: Multi-Worker Infrastructure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the infrastructure for running POSIX processes as separate worker threads, each with its own Wasm kernel instance, coordinated by a host-side ProcessManager.

**Architecture:** A `ProcessManager` in the main thread manages a process table and spawns workers. Each worker loads the Wasm module, creates its own `WasmPosixKernel` + `NodePlatformIO`, initializes the kernel with its assigned PID, and communicates lifecycle events via `postMessage`. A `WorkerAdapter` interface abstracts over Node.js `worker_threads` and Web Workers. Phase 13a covers only the initial spawn infrastructure — fork, exec, waitpid, cross-process pipes, and signals come in later phases.

**Tech Stack:** TypeScript, Node.js `worker_threads`, vitest, tsup

**Design doc:** `docs/plans/2026-03-08-multi-worker-design.md`

---

### Task 1: Worker Message Protocol Types

**Files:**
- Create: `host/src/worker-protocol.ts`

**Step 1: Create the protocol types file**

```typescript
// host/src/worker-protocol.ts
import type { KernelConfig } from "./types";

// --- Host → Worker messages ---

export type HostToWorkerMessage =
  | WorkerInitMessage
  | WorkerTerminateMessage;

export interface WorkerInitMessage {
  type: "init";
  pid: number;
  ppid: number;
  wasmBytes: ArrayBuffer;
  kernelConfig: KernelConfig;
  env?: string[];
  cwd?: string;
}

export interface WorkerTerminateMessage {
  type: "terminate";
}

// --- Worker → Host messages ---

export type WorkerToHostMessage =
  | WorkerReadyMessage
  | WorkerExitMessage
  | WorkerErrorMessage;

export interface WorkerReadyMessage {
  type: "ready";
  pid: number;
}

export interface WorkerExitMessage {
  type: "exit";
  pid: number;
  status: number;
}

export interface WorkerErrorMessage {
  type: "error";
  pid: number;
  message: string;
}
```

**Step 2: Verify it compiles**

Run: `cd host && npx tsc --noEmit src/worker-protocol.ts`
Expected: No errors

**Step 3: Commit**

```bash
git add host/src/worker-protocol.ts
git commit -m "feat: add worker message protocol types for multi-worker IPC"
```

---

### Task 2: WorkerAdapter Interface + Mock Implementation

**Files:**
- Create: `host/src/worker-adapter.ts`
- Test: `host/test/worker-adapter.test.ts`

**Step 1: Write the failing test**

```typescript
// host/test/worker-adapter.test.ts
import { describe, it, expect } from "vitest";
import {
  MockWorkerAdapter,
  type WorkerHandle,
} from "../src/worker-adapter";

describe("MockWorkerAdapter", () => {
  it("should create a worker handle and capture workerData", () => {
    const adapter = new MockWorkerAdapter();
    const data = { type: "init", pid: 1 };
    const handle = adapter.createWorker(data);
    expect(handle).toBeDefined();
    expect(adapter.lastWorker).not.toBeNull();
    expect(adapter.lastWorkerData).toEqual(data);
  });

  it("should dispatch messages to registered handlers", () => {
    const adapter = new MockWorkerAdapter();
    const handle = adapter.createWorker({});
    const messages: unknown[] = [];
    handle.on("message", (msg) => messages.push(msg));

    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 1 });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: "ready", pid: 1 });
  });

  it("should dispatch error events to registered handlers", () => {
    const adapter = new MockWorkerAdapter();
    const handle = adapter.createWorker({});
    const errors: Error[] = [];
    handle.on("error", (err) => errors.push(err));

    adapter.lastWorker!.simulateError(new Error("boom"));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("boom");
  });

  it("should dispatch exit events to registered handlers", () => {
    const adapter = new MockWorkerAdapter();
    const handle = adapter.createWorker({});
    const codes: number[] = [];
    handle.on("exit", (code) => codes.push(code));

    adapter.lastWorker!.simulateExit(42);

    expect(codes).toHaveLength(1);
    expect(codes[0]).toBe(42);
  });

  it("should capture sent messages via postMessage", () => {
    const adapter = new MockWorkerAdapter();
    const handle = adapter.createWorker({});

    handle.postMessage({ type: "terminate" });

    expect(adapter.lastWorker!.sentMessages).toEqual([
      { type: "terminate" },
    ]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd host && npx vitest run test/worker-adapter.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// host/src/worker-adapter.ts

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
  on(event: string, handler: (...args: unknown[]) => void): void {
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

  createWorker(workerData: unknown): WorkerHandle {
    const handle = new MockWorkerHandle();
    this.lastWorker = handle;
    this.lastWorkerData = workerData;
    return handle;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd host && npx vitest run test/worker-adapter.test.ts`
Expected: 5 tests PASS

**Step 5: Commit**

```bash
git add host/src/worker-adapter.ts host/test/worker-adapter.test.ts
git commit -m "feat: add WorkerAdapter interface and mock implementation"
```

---

### Task 3: NodeWorkerAdapter

**Files:**
- Modify: `host/src/worker-adapter.ts` (add NodeWorkerAdapter)
- Modify: `host/package.json` (add tsx devDependency)
- Create: `host/src/worker-entry.ts` (minimal — needed for NodeWorkerAdapter to reference)

**Step 1: Install tsx for TypeScript worker support**

```bash
cd host && npm install -D tsx
```

tsx allows Node.js `worker_threads` to load TypeScript files directly via `--import tsx`.

**Step 2: Create a minimal worker entry point stub**

The worker entry will be fleshed out in Task 4. For now, create a stub so NodeWorkerAdapter has something to reference.

```typescript
// host/src/worker-entry.ts
import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) {
  throw new Error("worker-entry.ts must be run as a worker thread");
}

// Full implementation in Task 4
parentPort.postMessage({ type: "error", pid: 0, message: "not yet implemented" });
```

**Step 3: Add NodeWorkerAdapter to worker-adapter.ts**

Append to `host/src/worker-adapter.ts`:

```typescript
// --- Node.js implementation ---

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

export class NodeWorkerAdapter implements WorkerAdapter {
  private entryUrl: URL;

  constructor(entryUrl?: URL) {
    this.entryUrl =
      entryUrl ?? new URL("./worker-entry.ts", import.meta.url);
  }

  createWorker(workerData: unknown): WorkerHandle {
    const worker = new Worker(fileURLToPath(this.entryUrl), {
      workerData,
      execArgv: ["--import", "tsx"],
    });
    return new NodeWorkerHandle(worker);
  }
}

class NodeWorkerHandle implements WorkerHandle {
  constructor(private worker: Worker) {}

  postMessage(message: unknown, transfer?: Transferable[]): void {
    if (transfer) {
      this.worker.postMessage(message, transfer);
    } else {
      this.worker.postMessage(message);
    }
  }

  on(event: "message", handler: (msg: unknown) => void): void;
  on(event: "error", handler: (err: Error) => void): void;
  on(event: "exit", handler: (code: number) => void): void;
  on(event: string, handler: (...args: unknown[]) => void): void {
    this.worker.on(event, handler);
  }

  async terminate(): Promise<number> {
    return this.worker.terminate();
  }
}
```

**Step 4: Verify compilation**

Run: `cd host && npx tsc --noEmit`
Expected: No errors

**Step 5: Verify existing tests still pass**

Run: `cd host && npx vitest run test/worker-adapter.test.ts`
Expected: All 5 tests PASS

**Step 6: Commit**

```bash
git add host/src/worker-adapter.ts host/src/worker-entry.ts host/package.json host/package-lock.json
git commit -m "feat: add NodeWorkerAdapter using worker_threads + tsx"
```

---

### Task 4: Worker Entry Point

**Files:**
- Modify: `host/src/worker-entry.ts` (full implementation)
- Test: `host/test/worker-entry.test.ts`

The worker entry initializes a `WasmPosixKernel` in the worker thread. For testability, the main logic is in an exported `workerMain()` function that accepts a message port and init data.

**Step 1: Write the failing test**

```typescript
// host/test/worker-entry.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { workerMain } from "../src/worker-entry";
import type { WorkerInitMessage } from "../src/worker-protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadWasmBytes(): ArrayBuffer {
  const wasmPath = join(__dirname, "../wasm/kandelo-kernel.wasm");
  const buf = readFileSync(wasmPath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function createMockPort() {
  const messages: unknown[] = [];
  return {
    postMessage(msg: unknown) {
      messages.push(msg);
    },
    on(_event: string, _handler: Function) {},
    messages,
  };
}

describe("workerMain", () => {
  it("should initialize kernel and send ready message", async () => {
    const port = createMockPort();
    const initData: WorkerInitMessage = {
      type: "init",
      pid: 1,
      ppid: 0,
      wasmBytes: loadWasmBytes(),
      kernelConfig: {
        maxWorkers: 1,
        dataBufferSize: 65536,
        useSharedMemory: false,
      },
    };

    await workerMain(port as any, initData);

    expect(port.messages).toHaveLength(1);
    expect(port.messages[0]).toEqual({ type: "ready", pid: 1 });
  });

  it("should send error message on invalid wasm bytes", async () => {
    const port = createMockPort();
    const initData: WorkerInitMessage = {
      type: "init",
      pid: 2,
      ppid: 0,
      wasmBytes: new ArrayBuffer(0),
      kernelConfig: {
        maxWorkers: 1,
        dataBufferSize: 65536,
        useSharedMemory: false,
      },
    };

    await workerMain(port as any, initData);

    expect(port.messages).toHaveLength(1);
    expect((port.messages[0] as any).type).toBe("error");
    expect((port.messages[0] as any).pid).toBe(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd host && npx vitest run test/worker-entry.test.ts`
Expected: FAIL — `workerMain` is not exported or doesn't match expected behavior

**Step 3: Implement the worker entry**

```typescript
// host/src/worker-entry.ts
import { parentPort, workerData } from "node:worker_threads";
import { WasmPosixKernel } from "./kernel";
import { NodePlatformIO } from "./platform/node";
import type { WorkerInitMessage, WorkerToHostMessage, HostToWorkerMessage } from "./worker-protocol";

interface MessagePort {
  postMessage(msg: unknown): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

export async function workerMain(
  port: MessagePort,
  initData: WorkerInitMessage,
): Promise<void> {
  try {
    const kernel = new WasmPosixKernel(initData.kernelConfig, new NodePlatformIO());
    await kernel.init(initData.wasmBytes);

    const instance = kernel.getInstance()!;
    const kernelInit = instance.exports.kernel_init as (pid: number) => void;
    kernelInit(initData.pid);

    port.postMessage({
      type: "ready",
      pid: initData.pid,
    } satisfies WorkerToHostMessage);

    // Listen for messages from host
    port.on("message", (msg: unknown) => {
      const m = msg as HostToWorkerMessage;
      switch (m.type) {
        case "terminate":
          port.postMessage({
            type: "exit",
            pid: initData.pid,
            status: 0,
          } satisfies WorkerToHostMessage);
          break;
      }
    });
  } catch (err) {
    port.postMessage({
      type: "error",
      pid: initData.pid,
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerToHostMessage);
  }
}

// When running as an actual worker thread
if (parentPort) {
  workerMain(parentPort, workerData as WorkerInitMessage);
}
```

**Step 4: Run test to verify it passes**

Run: `cd host && npx vitest run test/worker-entry.test.ts`
Expected: 2 tests PASS

**Step 5: Commit**

```bash
git add host/src/worker-entry.ts host/test/worker-entry.test.ts
git commit -m "feat: implement worker entry point with kernel initialization"
```

---

### Task 5: ProcessManager Class

**Files:**
- Create: `host/src/process-manager.ts`
- Test: `host/test/process-manager.test.ts`

**Step 1: Write the failing tests**

```typescript
// host/test/process-manager.test.ts
import { describe, it, expect } from "vitest";
import { ProcessManager } from "../src/process-manager";
import { MockWorkerAdapter } from "../src/worker-adapter";

function createTestPM() {
  const adapter = new MockWorkerAdapter();
  const pm = new ProcessManager({
    wasmBytes: new ArrayBuffer(0),
    kernelConfig: { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: false },
    workerAdapter: adapter,
  });
  return { pm, adapter };
}

describe("ProcessManager", () => {
  it("should spawn a process and assign PID 1", async () => {
    const { pm, adapter } = createTestPM();

    const spawnPromise = pm.spawn();

    // Worker was created
    expect(adapter.lastWorker).not.toBeNull();
    // Init data was passed
    expect(adapter.lastWorkerData).toMatchObject({
      type: "init",
      pid: 1,
      ppid: 0,
    });

    // Simulate worker ready
    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 1 });

    const pid = await spawnPromise;
    expect(pid).toBe(1);
  });

  it("should track process state as running after ready", async () => {
    const { pm, adapter } = createTestPM();

    const spawnPromise = pm.spawn();
    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 1 });
    await spawnPromise;

    const info = pm.getProcess(1);
    expect(info).toBeDefined();
    expect(info!.state).toBe("running");
    expect(info!.pid).toBe(1);
    expect(info!.ppid).toBe(0);
  });

  it("should assign incrementing PIDs", async () => {
    const { pm, adapter } = createTestPM();

    const p1 = pm.spawn();
    const worker1 = adapter.lastWorker!;
    worker1.simulateMessage({ type: "ready", pid: 1 });
    expect(await p1).toBe(1);

    const p2 = pm.spawn();
    const worker2 = adapter.lastWorker!;
    worker2.simulateMessage({ type: "ready", pid: 2 });
    expect(await p2).toBe(2);

    expect(pm.getProcessCount()).toBe(2);
  });

  it("should reject spawn if worker sends error", async () => {
    const { pm, adapter } = createTestPM();

    const spawnPromise = pm.spawn();
    adapter.lastWorker!.simulateMessage({
      type: "error",
      pid: 1,
      message: "wasm init failed",
    });

    await expect(spawnPromise).rejects.toThrow("wasm init failed");
  });

  it("should reject spawn if worker exits during init", async () => {
    const { pm, adapter } = createTestPM();

    const spawnPromise = pm.spawn();
    adapter.lastWorker!.simulateExit(1);

    await expect(spawnPromise).rejects.toThrow("Worker exited with code 1");
  });

  it("should reject spawn if worker throws error event", async () => {
    const { pm, adapter } = createTestPM();

    const spawnPromise = pm.spawn();
    adapter.lastWorker!.simulateError(new Error("thread crashed"));

    await expect(spawnPromise).rejects.toThrow("thread crashed");
  });

  it("should transition to zombie state on exit message", async () => {
    const { pm, adapter } = createTestPM();

    const spawnPromise = pm.spawn();
    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 1 });
    await spawnPromise;

    adapter.lastWorker!.simulateMessage({ type: "exit", pid: 1, status: 42 });

    const info = pm.getProcess(1);
    expect(info!.state).toBe("zombie");
    expect(info!.exitStatus).toBe(42);
  });

  it("should terminate a process and remove it", async () => {
    const { pm, adapter } = createTestPM();

    const spawnPromise = pm.spawn();
    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 1 });
    await spawnPromise;

    await pm.terminate(1);

    expect(pm.getProcess(1)).toBeUndefined();
    expect(pm.getProcessCount()).toBe(0);
  });

  it("should pass ppid option to worker init data", async () => {
    const { pm, adapter } = createTestPM();

    const spawnPromise = pm.spawn({ ppid: 5 });
    expect(adapter.lastWorkerData).toMatchObject({ ppid: 5 });

    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 1 });
    await spawnPromise;

    expect(pm.getProcess(1)!.ppid).toBe(5);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd host && npx vitest run test/process-manager.test.ts`
Expected: FAIL — module not found

**Step 3: Implement ProcessManager**

```typescript
// host/src/process-manager.ts
import type { WorkerAdapter, WorkerHandle } from "./worker-adapter";
import type { KernelConfig } from "./types";
import type {
  WorkerInitMessage,
  WorkerToHostMessage,
} from "./worker-protocol";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  worker: WorkerHandle;
  state: "starting" | "running" | "zombie";
  exitStatus?: number;
}

export interface ProcessManagerConfig {
  wasmBytes: ArrayBuffer;
  kernelConfig: KernelConfig;
  workerAdapter: WorkerAdapter;
}

export interface SpawnOptions {
  ppid?: number;
  env?: string[];
  cwd?: string;
}

export class ProcessManager {
  private processes = new Map<number, ProcessInfo>();
  private nextPid = 1;
  private config: ProcessManagerConfig;

  constructor(config: ProcessManagerConfig) {
    this.config = config;
  }

  async spawn(options?: SpawnOptions): Promise<number> {
    const pid = this.nextPid++;
    const ppid = options?.ppid ?? 0;

    const initData: WorkerInitMessage = {
      type: "init",
      pid,
      ppid,
      wasmBytes: this.config.wasmBytes,
      kernelConfig: this.config.kernelConfig,
      env: options?.env,
      cwd: options?.cwd,
    };

    const worker = this.config.workerAdapter.createWorker(initData);

    const info: ProcessInfo = {
      pid,
      ppid,
      pgid: pid,
      sid: pid,
      worker,
      state: "starting",
    };

    this.processes.set(pid, info);

    return new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Process ${pid} timed out during initialization`));
      }, 10_000);

      worker.on("message", (msg: unknown) => {
        const m = msg as WorkerToHostMessage;
        switch (m.type) {
          case "ready":
            if (info.state === "starting") {
              clearTimeout(timeout);
              info.state = "running";
              resolve(pid);
            }
            break;
          case "exit":
            if (info.state === "starting") {
              clearTimeout(timeout);
              reject(new Error(`Worker exited with status ${m.status}`));
            }
            info.state = "zombie";
            info.exitStatus = m.status;
            break;
          case "error":
            if (info.state === "starting") {
              clearTimeout(timeout);
              reject(new Error(m.message));
            }
            break;
        }
      });

      worker.on("error", (err: Error) => {
        if (info.state === "starting") {
          clearTimeout(timeout);
          reject(err);
        }
      });

      worker.on("exit", (code: number) => {
        if (info.state === "starting") {
          clearTimeout(timeout);
          reject(new Error(`Worker exited with code ${code} during init`));
        }
      });
    });
  }

  getProcess(pid: number): ProcessInfo | undefined {
    return this.processes.get(pid);
  }

  getProcessCount(): number {
    return this.processes.size;
  }

  async terminate(pid: number): Promise<void> {
    const info = this.processes.get(pid);
    if (!info) return;
    await info.worker.terminate();
    this.processes.delete(pid);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd host && npx vitest run test/process-manager.test.ts`
Expected: 8 tests PASS

**Step 5: Commit**

```bash
git add host/src/process-manager.ts host/test/process-manager.test.ts
git commit -m "feat: implement ProcessManager with process table and spawn lifecycle"
```

---

### Task 6: Integration Test — Real Worker Thread

**Files:**
- Create: `host/test/multi-worker.test.ts`

This test verifies end-to-end: `ProcessManager` + `NodeWorkerAdapter` + real worker thread + Wasm kernel initialization.

**Step 1: Write the integration test**

```typescript
// host/test/multi-worker.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessManager } from "../src/process-manager";
import { NodeWorkerAdapter } from "../src/worker-adapter";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadWasmBytes(): ArrayBuffer {
  const wasmPath = join(__dirname, "../wasm/kandelo-kernel.wasm");
  const buf = readFileSync(wasmPath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe("Multi-Worker Integration", () => {
  it("should spawn PID 1 in a real worker thread", async () => {
    const pm = new ProcessManager({
      wasmBytes: loadWasmBytes(),
      kernelConfig: {
        maxWorkers: 4,
        dataBufferSize: 65536,
        useSharedMemory: false,
      },
      workerAdapter: new NodeWorkerAdapter(),
    });

    const pid = await pm.spawn();
    expect(pid).toBe(1);

    const info = pm.getProcess(1);
    expect(info).toBeDefined();
    expect(info!.state).toBe("running");

    await pm.terminate(1);
  }, 15_000); // generous timeout for worker startup

  it("should spawn multiple processes in separate workers", async () => {
    const pm = new ProcessManager({
      wasmBytes: loadWasmBytes(),
      kernelConfig: {
        maxWorkers: 4,
        dataBufferSize: 65536,
        useSharedMemory: false,
      },
      workerAdapter: new NodeWorkerAdapter(),
    });

    const pid1 = await pm.spawn();
    const pid2 = await pm.spawn();

    expect(pid1).toBe(1);
    expect(pid2).toBe(2);
    expect(pm.getProcessCount()).toBe(2);

    await pm.terminate(1);
    await pm.terminate(2);
  }, 15_000);
});
```

**Step 2: Run the integration test**

Run: `cd host && npx vitest run test/multi-worker.test.ts`
Expected: 2 tests PASS

If the test fails because `tsx` `--import` isn't working, try adjusting the `NodeWorkerAdapter` constructor to pass the compiled entry path, or check that `tsx` is installed correctly.

**Step 3: Commit**

```bash
git add host/test/multi-worker.test.ts
git commit -m "test: add multi-worker integration tests with real worker threads"
```

---

### Task 7: Update Exports and Build Config

**Files:**
- Modify: `host/src/index.ts`
- Modify: `host/tsup.config.ts`

**Step 1: Update index.ts exports**

Add new exports to `host/src/index.ts`:

```typescript
export { WasmPosixKernel } from "./kernel";
export { SyscallChannel, ChannelStatus } from "./channel";
export { NodePlatformIO } from "./platform/node";
export { ProcessManager } from "./process-manager";
export { NodeWorkerAdapter, MockWorkerAdapter } from "./worker-adapter";
export type { KernelConfig, PlatformIO, StatResult } from "./types";
export type { WorkerAdapter, WorkerHandle } from "./worker-adapter";
export type { ProcessInfo, ProcessManagerConfig, SpawnOptions } from "./process-manager";
export type {
  HostToWorkerMessage,
  WorkerToHostMessage,
  WorkerInitMessage,
  WorkerReadyMessage,
  WorkerExitMessage,
  WorkerErrorMessage,
} from "./worker-protocol";
```

**Step 2: Update tsup.config.ts to include worker entry**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/worker-entry.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  splitting: false,
});
```

**Step 3: Verify build succeeds**

Run: `cd host && npm run build`
Expected: Build completes, `dist/index.js`, `dist/index.cjs`, `dist/worker-entry.js`, `dist/worker-entry.cjs` are created

**Step 4: Run all tests**

Run: `cd host && npx vitest run`
Expected: All tests PASS (kernel test + worker-adapter + worker-entry + process-manager + multi-worker integration)

Also verify Rust tests still pass:

Run: `cargo test --target $(rustc -vV | grep host | awk '{print $2}') -p kandelo`
Expected: 286 tests PASS

**Step 5: Commit**

```bash
git add host/src/index.ts host/tsup.config.ts
git commit -m "feat: export ProcessManager and worker types, add worker-entry build target"
```

---

### Task 8: Update POSIX Status Documentation

**Files:**
- Modify: `docs/posix-status.md`

**Step 1: Add Phase 13a entry to posix-status.md**

In the Implementation Priority section, add Phase 13a:

```markdown
### Phase 13a — Multi-Worker Infrastructure
- ProcessManager with process table and worker lifecycle
- WorkerAdapter abstraction (Node.js worker_threads + mock)
- Worker entry point: kernel initialization in worker thread
- Message protocol for host ↔ worker communication
```

**Step 2: Commit**

```bash
git add docs/posix-status.md
git commit -m "docs: add Phase 13a multi-worker infrastructure to POSIX status"
```
