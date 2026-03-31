/**
 * BrowserKernel — Reusable CentralizedKernelWorker setup for browser examples.
 *
 * Handles memory allocation, fork/clone/exit plumbing, process spawning,
 * and TCP connection injection for service worker bridging.
 */

// Polyfill setImmediate/clearImmediate for browsers (kernel-worker.ts uses them)
if (typeof globalThis.setImmediate === "undefined") {
  (globalThis as any).setImmediate = (fn: (...args: any[]) => void, ...args: any[]) =>
    setTimeout(fn, 0, ...args);
  (globalThis as any).clearImmediate = (id: any) => clearTimeout(id);
}

import { CentralizedKernelWorker } from "../../../host/src/kernel-worker";
import { BrowserWorkerAdapter } from "../../../host/src/worker-adapter-browser";
import { VirtualPlatformIO } from "../../../host/src/vfs/vfs";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { DeviceFileSystem } from "../../../host/src/vfs/device-fs";
import { BrowserTimeProvider } from "../../../host/src/vfs/time";
import { patchWasmForThread } from "../../../host/src/worker-main";
import type {
  CentralizedWorkerInitMessage,
  CentralizedThreadInitMessage,
  WorkerToHostMessage,
} from "../../../host/src/worker-protocol";
import kernelWasmUrl from "../../../host/wasm/wasm_posix_kernel.wasm?url";
import workerEntryUrl from "../../../host/src/worker-entry-browser.ts?worker&url";

const MAX_PAGES = 16384;
const PAGE_SIZE = 65536;
const CH_TOTAL_SIZE = 40 + PAGE_SIZE; // channel header + data buffer
const ASYNCIFY_BUF_SIZE = 16384;

export interface BrowserKernelOptions {
  /** Maximum concurrent workers (default: 4) */
  maxWorkers?: number;
  /** SharedArrayBuffer size for MemoryFileSystem (default: 16MB) */
  fsSize?: number;
  /** Additional VFS mount points */
  extraMounts?: Array<{ mountPoint: string; backend: { open: Function } }>;
  /** Environment variables for spawned processes */
  env?: string[];
  /** Called when a process writes to stdout */
  onStdout?: (data: Uint8Array) => void;
  /** Called when a process writes to stderr */
  onStderr?: (data: Uint8Array) => void;
  /** Called when the kernel wants to resolve an exec path to wasm bytes */
  onExec?: (pid: number, path: string, argv: string[], envp: string[]) => Promise<ArrayBuffer | null>;
  /** Called when a process requests a TCP listener (for service worker bridging) */
  onListenTcp?: (pid: number, fd: number, port: number) => void;
  /** Pre-compiled thread module for clone(). Avoids recompiling large wasm for each thread. */
  threadModule?: WebAssembly.Module;
}

interface ProcessInfo {
  memory: WebAssembly.Memory;
  programBytes: ArrayBuffer;
  worker: ReturnType<BrowserWorkerAdapter["createWorker"]>;
  channelOffset: number;
}

export class BrowserKernel {
  private kernelWorker!: CentralizedKernelWorker;
  private workerAdapter: BrowserWorkerAdapter;
  private memfs: MemoryFileSystem;
  private io: VirtualPlatformIO;
  private processes = new Map<number, ProcessInfo>();
  private nextPid = 1;
  private options: Required<
    Pick<BrowserKernelOptions, "maxWorkers" | "fsSize" | "env">
  > &
    BrowserKernelOptions;
  private kernelInstance: WebAssembly.Instance | null = null;
  private kernelMemory: WebAssembly.Memory | null = null;
  private exitResolvers = new Map<number, (status: number) => void>();

  // Thread channel allocator (counting down from main channel region)
  private nextThreadChannelPage = MAX_PAGES - 4;

  constructor(options: BrowserKernelOptions = {}) {
    this.options = {
      maxWorkers: 4,
      fsSize: 16 * 1024 * 1024,
      env: [
        "HOME=/home",
        "TMPDIR=/tmp",
        "TERM=xterm-256color",
        "LANG=en_US.UTF-8",
        "USER=browser",
      ],
      ...options,
    };

    this.workerAdapter = new BrowserWorkerAdapter(workerEntryUrl);
    this.memfs = MemoryFileSystem.create(
      new SharedArrayBuffer(this.options.fsSize),
    );
    const devfs = new DeviceFileSystem();
    const mounts: Array<{ mountPoint: string; backend: any }> = [
      { mountPoint: "/dev", backend: devfs },
      { mountPoint: "/", backend: this.memfs },
      ...(this.options.extraMounts ?? []),
    ];
    this.io = new VirtualPlatformIO(mounts, new BrowserTimeProvider());

    // Create standard directories
    this.memfs.mkdir("/tmp", 0o777);
    this.memfs.mkdir("/home", 0o755);
    this.memfs.mkdir("/dev", 0o755);
  }

  /** Access the underlying MemoryFileSystem for pre-populating files */
  get fs(): MemoryFileSystem {
    return this.memfs;
  }

  /** Access the VirtualPlatformIO instance */
  get platformIO(): VirtualPlatformIO {
    return this.io;
  }

  /** Initialize the kernel with wasm bytes (fetched automatically if not provided) */
  async init(kernelWasmBytes?: ArrayBuffer): Promise<void> {
    const wasmBytes =
      kernelWasmBytes ??
      (await fetch(kernelWasmUrl).then((r) => r.arrayBuffer()));

    this.kernelWorker = new CentralizedKernelWorker(
      {
        maxWorkers: this.options.maxWorkers,
        dataBufferSize: PAGE_SIZE,
        useSharedMemory: true,
      },
      this.io,
      {
        onFork: (parentPid, childPid, parentMemory) =>
          this.handleFork(parentPid, childPid, parentMemory),
        onExec: async (pid, path, argv, envp) => {
          if (!this.options.onExec) return -38; // ENOSYS
          const bytes = await this.options.onExec(pid, path, argv, envp);
          if (!bytes) return -2; // ENOENT

          // Terminate old worker
          const oldInfo = this.processes.get(pid);
          if (oldInfo?.worker) {
            await oldInfo.worker.terminate().catch(() => {});
          }

          // Create fresh memory for the new program
          const newMemory = new WebAssembly.Memory({
            initial: 17,
            maximum: MAX_PAGES,
            shared: true,
          });
          const newChannelOffset = (MAX_PAGES - 2) * PAGE_SIZE;
          newMemory.grow(MAX_PAGES - 17);
          new Uint8Array(newMemory.buffer, newChannelOffset, CH_TOTAL_SIZE).fill(0);

          // Re-register with fresh memory (kernel pid already exists)
          this.kernelWorker.registerProcess(pid, newMemory, [newChannelOffset], {
            skipKernelCreate: true,
          });

          // Spawn new worker with exec'd program
          const execInitData: CentralizedWorkerInitMessage = {
            type: "centralized_init",
            pid,
            ppid: 0,
            programBytes: bytes,
            memory: newMemory,
            channelOffset: newChannelOffset,
            argv,
            env: envp,
          };

          const newWorker = this.workerAdapter.createWorker(execInitData);
          newWorker.on("error", (err: Error) => {
            console.error(`[BrowserKernel] exec worker error pid=${pid}:`, err.message);
          });

          this.processes.set(pid, {
            memory: newMemory,
            programBytes: bytes,
            worker: newWorker,
            channelOffset: newChannelOffset,
          });

          return 0;
        },
        onClone: (pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory) =>
          this.handleClone(
            pid,
            tid,
            fnPtr,
            argPtr,
            stackPtr,
            tlsPtr,
            ctidPtr,
            memory,
          ),
        onExit: (pid, exitStatus) => this.handleExit(pid, exitStatus),
      },
    );

    // Inject stdout/stderr callbacks
    const kw = this.kernelWorker as any;
    const existingCallbacks = kw.kernel.callbacks || {};
    kw.kernel.callbacks = {
      ...existingCallbacks,
      onStdout: (data: Uint8Array) => this.options.onStdout?.(data),
      onStderr: (data: Uint8Array) => this.options.onStderr?.(data),
      onListenTcp: (_fd: number, port: number) => {
        const pid = kw.currentHandlePid;
        this.options.onListenTcp?.(pid, _fd, port);
      },
    };

    await this.kernelWorker.init(wasmBytes);
    this.kernelInstance = kw.kernelInstance;
    this.kernelMemory = (kw as any).kernelMemory;
  }

  /**
   * Spawn a new process and return a promise that resolves with the exit code.
   */
  async spawn(
    programBytes: ArrayBuffer,
    argv: string[],
    options?: { env?: string[]; cwd?: string; stdin?: Uint8Array },
  ): Promise<number> {
    const pid = this.nextPid++;
    const memory = new WebAssembly.Memory({
      initial: 17,
      maximum: MAX_PAGES,
      shared: true,
    });
    const channelOffset = (MAX_PAGES - 2) * PAGE_SIZE;
    memory.grow(MAX_PAGES - 17);
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

    this.kernelWorker.registerProcess(pid, memory, [channelOffset]);

    if (options?.stdin) {
      this.kernelWorker.setStdinData(pid, options.stdin);
    }

    const exitPromise = new Promise<number>((resolve) => {
      this.exitResolvers.set(pid, resolve);
    });

    const initData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid,
      ppid: 0,
      programBytes,
      memory,
      channelOffset,
      env: options?.env ?? this.options.env,
      argv,
      cwd: options?.cwd,
    };

    const worker = this.workerAdapter.createWorker(initData);
    this.processes.set(pid, { memory, programBytes, worker, channelOffset });

    worker.on("error", (err: Error) => {
      console.error(`[BrowserKernel] Worker error pid=${pid}:`, err.message);
    });

    return exitPromise;
  }

  /**
   * Inject an external HTTP connection into the kernel's listening socket.
   * Returns the recv pipe index (send pipe is recv + 1), or -1 on failure.
   */
  injectConnection(
    pid: number,
    listenerFd: number,
    peerAddr: [number, number, number, number] = [127, 0, 0, 1],
    peerPort: number = 0,
  ): number {
    if (!this.kernelInstance) return -1;
    const injectConnection = this.kernelInstance.exports
      .kernel_inject_connection as (
      pid: number,
      fd: number,
      a: number,
      b: number,
      c: number,
      d: number,
      port: number,
    ) => number;
    const recvPipeIdx = injectConnection(
      pid,
      listenerFd,
      peerAddr[0],
      peerAddr[1],
      peerAddr[2],
      peerAddr[3],
      peerPort,
    );
    if (recvPipeIdx >= 0) {
      (this.kernelWorker as any).scheduleWakeBlockedRetries();
    }
    return recvPipeIdx;
  }

  /**
   * Write data to a kernel pipe (for injecting HTTP request data).
   */
  pipeWrite(pid: number, pipeIdx: number, data: Uint8Array): number {
    if (!this.kernelInstance) return -1;
    const pipeWrite = this.kernelInstance.exports.kernel_pipe_write as (
      pid: number,
      pipeIdx: number,
      bufPtr: number,
      bufLen: number,
    ) => number;
    const scratchOffset = (this.kernelWorker as any).tcpScratchOffset || (this.kernelWorker as any).scratchOffset;
    const mem = new Uint8Array(
      this.kernelMemory!.buffer,
    );
    let written = 0;
    while (written < data.length) {
      const chunk = Math.min(data.length - written, PAGE_SIZE);
      mem.set(data.subarray(written, written + chunk), scratchOffset);
      const n = pipeWrite(pid, pipeIdx, scratchOffset, chunk);
      if (n <= 0) break;
      written += n;
    }
    return written;
  }

  /**
   * Read data from a kernel pipe (for reading HTTP response data).
   */
  pipeRead(pid: number, pipeIdx: number): Uint8Array | null {
    if (!this.kernelInstance) return null;
    const pipeRead = this.kernelInstance.exports.kernel_pipe_read as (
      pid: number,
      pipeIdx: number,
      bufPtr: number,
      bufLen: number,
    ) => number;
    const scratchOffset = (this.kernelWorker as any).tcpScratchOffset || (this.kernelWorker as any).scratchOffset;
    const mem = new Uint8Array(
      this.kernelMemory!.buffer,
    );
    const chunks: Uint8Array[] = [];
    for (;;) {
      const n = pipeRead(pid, pipeIdx, scratchOffset, PAGE_SIZE);
      if (n <= 0) break;
      chunks.push(mem.slice(scratchOffset, scratchOffset + n));
    }
    if (chunks.length === 0) return null;
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  /**
   * Close the write end of a pipe (signals EOF to the reader).
   */
  pipeCloseWrite(pid: number, pipeIdx: number): void {
    if (!this.kernelInstance) return;
    const fn = this.kernelInstance.exports.kernel_pipe_close_write as (
      pid: number,
      pipeIdx: number,
    ) => number;
    fn(pid, pipeIdx);
  }

  /**
   * Close the read end of a pipe.
   */
  pipeCloseRead(pid: number, pipeIdx: number): void {
    if (!this.kernelInstance) return;
    const fn = this.kernelInstance.exports.kernel_pipe_close_read as (
      pid: number,
      pipeIdx: number,
    ) => number;
    fn(pid, pipeIdx);
  }

  /**
   * Check if a pipe's write end is still open.
   */
  pipeIsWriteOpen(pid: number, pipeIdx: number): boolean {
    if (!this.kernelInstance) return false;
    const fn = this.kernelInstance.exports.kernel_pipe_is_write_open as (
      pid: number,
      pipeIdx: number,
    ) => number;
    return fn(pid, pipeIdx) !== 0;
  }

  /**
   * Wake any process blocked on poll/accept watching the given pipe.
   */
  wakeBlockedReaders(pipeIdx: number): void {
    const kw = this.kernelWorker as any;
    const readers = kw.pendingPipeReaders?.get(pipeIdx);
    if (readers && readers.length > 0) {
      kw.pendingPipeReaders.delete(pipeIdx);
      for (const reader of readers) {
        if (kw.processes.has(reader.pid)) {
          kw.retrySyscall(reader.channel);
        }
      }
    }
    kw.scheduleWakeBlockedRetries();
  }

  /** Pick a listener target for the given port (round-robin among fork children) */
  pickListenerTarget(port: number): { pid: number; fd: number } | null {
    return (this.kernelWorker as any).pickListenerTarget(port);
  }

  /** Get the underlying CentralizedKernelWorker (for advanced use) */
  get worker(): CentralizedKernelWorker {
    return this.kernelWorker;
  }

  // --- Private handlers ---

  private async handleFork(
    parentPid: number,
    childPid: number,
    parentMemory: WebAssembly.Memory,
  ): Promise<number[]> {
    const parentInfo = this.processes.get(parentPid);
    if (!parentInfo) throw new Error(`Unknown parent pid ${parentPid}`);

    const parentBuf = new Uint8Array(parentMemory.buffer);
    const parentPages = Math.ceil(parentBuf.byteLength / PAGE_SIZE);
    const childMemory = new WebAssembly.Memory({
      initial: parentPages,
      maximum: MAX_PAGES,
      shared: true,
    });
    if (parentPages < MAX_PAGES) {
      childMemory.grow(MAX_PAGES - parentPages);
    }
    new Uint8Array(childMemory.buffer).set(parentBuf);

    const childChannelOffset = (MAX_PAGES - 2) * PAGE_SIZE;
    new Uint8Array(
      childMemory.buffer,
      childChannelOffset,
      CH_TOTAL_SIZE,
    ).fill(0);

    this.kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], {
      skipKernelCreate: true,
    });

    const asyncifyBufAddr = childChannelOffset - ASYNCIFY_BUF_SIZE;

    const childInitData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid: childPid,
      ppid: parentPid,
      programBytes: parentInfo.programBytes,
      memory: childMemory,
      channelOffset: childChannelOffset,
      isForkChild: true,
      asyncifyBufAddr,
    };

    const childWorker = this.workerAdapter.createWorker(childInitData);
    childWorker.on("error", () => {
      this.kernelWorker.unregisterProcess(childPid);
    });

    this.processes.set(childPid, {
      memory: childMemory,
      programBytes: parentInfo.programBytes,
      worker: childWorker,
      channelOffset: childChannelOffset,
    });

    return [childChannelOffset];
  }

  private async handleClone(
    pid: number,
    tid: number,
    fnPtr: number,
    argPtr: number,
    stackPtr: number,
    tlsPtr: number,
    ctidPtr: number,
    memory: WebAssembly.Memory,
  ): Promise<number> {
    const processInfo = this.processes.get(pid);
    if (!processInfo) throw new Error(`Unknown pid ${pid} for clone`);

    const threadChannelOffset = this.nextThreadChannelPage * PAGE_SIZE;
    const tlsAllocAddr = (this.nextThreadChannelPage - 2) * PAGE_SIZE;
    // Each thread needs 4 pages: 2 for channel (65576 bytes spills past 1 page)
    // + 1 gap page + 1 for TLS
    this.nextThreadChannelPage -= 4;
    new Uint8Array(memory.buffer, threadChannelOffset, CH_TOTAL_SIZE).fill(0);
    new Uint8Array(memory.buffer, tlsAllocAddr, PAGE_SIZE).fill(0);

    this.kernelWorker.addChannel(pid, threadChannelOffset, tid);

    const threadInitData: CentralizedThreadInitMessage = {
      type: "centralized_thread_init",
      pid,
      tid,
      programBytes: processInfo.programBytes,
      programModule: this.options.threadModule,
      memory,
      channelOffset: threadChannelOffset,
      fnPtr,
      argPtr,
      stackPtr,
      tlsPtr,
      ctidPtr,
      tlsAllocAddr,
    };

    const threadWorker = this.workerAdapter.createWorker(threadInitData);
    threadWorker.on("message", (msg: unknown) => {
      const m = msg as WorkerToHostMessage;
      if (m.type === "thread_exit") {
        threadWorker.terminate().catch(() => {});
      }
    });
    threadWorker.on("error", () => {
      this.kernelWorker.notifyThreadExit(pid, tid);
      this.kernelWorker.removeChannel(pid, threadChannelOffset);
    });

    return tid;
  }

  private handleExit(pid: number, exitStatus: number): void {
    const resolver = this.exitResolvers.get(pid);
    const info = this.processes.get(pid);

    if (pid === this.nextPid - 1 || !this.processes.has(pid)) {
      // Last spawned process or already cleaned up
      this.kernelWorker.unregisterProcess(pid);
      if (info?.worker) info.worker.terminate().catch(() => {});
    } else {
      // Child process — deactivate but keep in kernel for waitpid
      this.kernelWorker.deactivateProcess(pid);
    }

    this.processes.delete(pid);
    this.exitResolvers.delete(pid);
    if (resolver) resolver(exitStatus);
  }
}
