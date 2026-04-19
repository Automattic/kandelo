/**
 * NodeKernelHost — Main-thread proxy that communicates with a dedicated
 * kernel worker_thread via messages. The kernel worker owns the Wasm
 * instance and all process lifecycle (fork/exec/clone/exit).
 *
 * Analogous to BrowserKernel but for Node.js: no SharedArrayBuffer VFS,
 * no worker entry URLs, TCP bridging handled natively by NodePlatformIO.
 *
 * Usage:
 *   const host = new NodeKernelHost({ onStdout: (pid, data) => ... });
 *   await host.init();
 *   const exitCode = await host.spawn(programBytes, ["hello"], { env: [...] });
 *   await host.destroy();
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { Worker as NodeThreadWorker } from "node:worker_threads";
import type {
  MainToKernelMessage,
  KernelToMainMessage,
  ResolveExecRequestMessage,
} from "./node-kernel-protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface NodeKernelHostOptions {
  /** Maximum concurrent workers (default: 4) */
  maxWorkers?: number;
  /** Maximum wasm memory pages per process (default: 16384 = 1GB) */
  maxPages?: number;
  /** Virtual path → host filesystem path for exec resolution inside the worker */
  execPrograms?: Record<string, string>;
  /** Called when a process writes to stdout */
  onStdout?: (pid: number, data: Uint8Array) => void;
  /** Called when a process writes to stderr */
  onStderr?: (pid: number, data: Uint8Array) => void;
  /** Called when a process writes PTY output */
  onPtyOutput?: (pid: number, data: Uint8Array) => void;
  /**
   * Called when the worker can't resolve an exec path locally.
   * Return the program bytes or null if not found.
   */
  onResolveExec?: (path: string) => ArrayBuffer | null | Promise<ArrayBuffer | null>;
}

export interface SpawnOptions {
  env?: string[];
  cwd?: string;
  stdin?: Uint8Array;
  pty?: boolean;
  /** Limit heap growth to protect thread channel pages */
  maxAddr?: number;
  /** Called after the process has been created and started */
  onStarted?: (pid: number) => void | Promise<void>;
}

export class NodeKernelHost {
  private worker!: NodeThreadWorker;
  private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  private exitResolvers = new Map<number, (status: number) => void>();
  private _nextRequestId = 1;
  private options: NodeKernelHostOptions;

  constructor(options?: NodeKernelHostOptions) {
    this.options = options ?? {};
  }

  /** Initialize the kernel by spawning a dedicated worker_thread */
  async init(kernelWasmBytes?: ArrayBuffer): Promise<void> {
    const wasmBytes = kernelWasmBytes ?? loadKernelWasm();

    this.worker = spawnKernelWorkerThread();

    this.worker.on("message", (msg: KernelToMainMessage) => {
      this.handleWorkerMessage(msg);
    });
    this.worker.on("error", (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const [, { reject }] of this.pendingRequests) {
        reject(error);
      }
      this.pendingRequests.clear();
    });

    // Send init and wait for ready
    await new Promise<void>((resolve) => {
      const readyHandler = (msg: KernelToMainMessage) => {
        if (msg.type === "ready") {
          this.worker.removeListener("message", readyHandler);
          resolve();
        }
      };
      this.worker.on("message", readyHandler);

      const initMsg: MainToKernelMessage = {
        type: "init",
        kernelWasmBytes: wasmBytes,
        config: {
          maxWorkers: this.options.maxWorkers ?? 4,
          maxPages: this.options.maxPages,
          dataBufferSize: 65536,
          useSharedMemory: true,
        },
        execPrograms: this.options.execPrograms,
      };
      this.worker.postMessage(initMsg);
    });
  }

  /**
   * Spawn a new process. Returns a promise that resolves with the exit code.
   */
  async spawn(
    programBytes: ArrayBuffer,
    argv: string[],
    options?: SpawnOptions,
  ): Promise<number> {
    const requestId = this._nextRequestId++;

    const pid = await this.request(requestId, {
      type: "spawn",
      requestId,
      programBytes,
      argv,
      env: options?.env,
      cwd: options?.cwd,
      pty: options?.pty,
      stdin: options?.stdin,
      maxAddr: options?.maxAddr,
    }) as number;

    const exitPromise = new Promise<number>((resolve) => {
      this.exitResolvers.set(pid, resolve);
    });

    // Process is now running
    if (options?.onStarted) {
      await options.onStarted(pid);
    }

    return exitPromise;
  }

  /** Append data to a process's stdin buffer (process sees more data, no EOF) */
  appendStdinData(pid: number, data: Uint8Array): void {
    this.sendToWorker({ type: "append_stdin_data", pid, data });
  }

  /** Set a process's stdin data (complete buffer with implicit EOF) */
  setStdinData(pid: number, data: Uint8Array): void {
    this.sendToWorker({ type: "set_stdin_data", pid, data });
  }

  /** Write data to the PTY master for a process */
  ptyWrite(pid: number, data: Uint8Array): void {
    this.sendToWorker({ type: "pty_write", pid, data });
  }

  /** Resize the PTY for a process */
  ptyResize(pid: number, rows: number, cols: number): void {
    this.sendToWorker({ type: "pty_resize", pid, rows, cols });
  }

  /** Terminate a specific process */
  async terminateProcess(pid: number, status = -1): Promise<void> {
    const requestId = this._nextRequestId++;
    await this.request(requestId, {
      type: "terminate_process",
      requestId,
      pid,
      status,
    });
    const resolver = this.exitResolvers.get(pid);
    this.exitResolvers.delete(pid);
    if (resolver) resolver(status);
  }

  /** Destroy the kernel and release all resources */
  async destroy(): Promise<void> {
    const requestId = this._nextRequestId++;
    try {
      await this.request(requestId, { type: "destroy", requestId });
    } catch {
      // Worker may have already exited
    }
    this.worker.terminate();
    this.exitResolvers.clear();
    this.pendingRequests.clear();
  }

  // ── Private ──

  private sendToWorker(msg: MainToKernelMessage): void {
    this.worker.postMessage(msg);
  }

  private request(requestId: number, msg: MainToKernelMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      this.sendToWorker(msg);
    });
  }

  private handleWorkerMessage(msg: KernelToMainMessage): void {
    switch (msg.type) {
      case "response": {
        const pending = this.pendingRequests.get(msg.requestId);
        if (pending) {
          this.pendingRequests.delete(msg.requestId);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.result);
          }
        }
        break;
      }
      case "exit": {
        const resolver = this.exitResolvers.get(msg.pid);
        if (resolver) {
          this.exitResolvers.delete(msg.pid);
          resolver(msg.status);
        }
        break;
      }
      case "stdout":
        this.options.onStdout?.(msg.pid, msg.data);
        break;
      case "stderr":
        this.options.onStderr?.(msg.pid, msg.data);
        break;
      case "pty_output":
        this.options.onPtyOutput?.(msg.pid, msg.data);
        break;
      case "resolve_exec":
        this.handleResolveExec(msg);
        break;
    }
  }

  private async handleResolveExec(msg: ResolveExecRequestMessage): Promise<void> {
    let programBytes: ArrayBuffer | null = null;
    if (this.options.onResolveExec) {
      programBytes = await this.options.onResolveExec(msg.path);
    }
    this.sendToWorker({
      type: "resolve_exec_response",
      requestId: msg.requestId,
      programBytes,
    });
  }
}

// ── Module-level helpers ──

function loadKernelWasm(): ArrayBuffer {
  const buf = readFileSync(join(__dirname, "../wasm/wasm_posix_kernel.wasm"));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Spawn a worker_thread running node-kernel-worker-entry.ts */
function spawnKernelWorkerThread(): NodeThreadWorker {
  const entryTs = join(__dirname, "node-kernel-worker-entry.ts");
  const entryJs = join(__dirname, "node-kernel-worker-entry.js");
  const distJs = entryTs.replace(/\/src\/([^/]+)\.ts$/, "/dist/$1.js");

  // Check for compiled .js version first (much faster startup)
  if (existsSync(distJs)) {
    return new NodeThreadWorker(distJs);
  }
  if (existsSync(entryJs)) {
    return new NodeThreadWorker(entryJs);
  }

  // Fallback: tsx eval bootstrap
  const require = createRequire(import.meta.url);
  const tsxApiPath = require.resolve("tsx/esm/api");
  const tsxApiUrl = pathToFileURL(tsxApiPath).href;
  const entryUrl = pathToFileURL(entryTs).href;
  const bootstrap = [
    `import { register } from '${tsxApiUrl}';`,
    `register();`,
    `await import('${entryUrl}');`,
  ].join("\n");
  return new NodeThreadWorker(bootstrap, { eval: true });
}
