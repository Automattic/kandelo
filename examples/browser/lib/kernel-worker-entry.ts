/**
 * Kernel Worker Entry Point — Dedicated web worker that hosts the
 * CentralizedKernelWorker and manages all process lifecycle.
 *
 * The main thread is a thin UI proxy; this worker owns the kernel Wasm
 * instance, process spawning (fork/exec/clone), and the HTTP connection pump.
 */

// Polyfill setImmediate for the web worker context.
// CentralizedKernelWorker uses setImmediate for yielding between syscall
// batches and waking blocked retries. In a dedicated worker there's no UI
// to starve, so we can use a simple MessageChannel polyfill.
if (typeof globalThis.setImmediate === "undefined") {
  const _immQueue: Array<{ id: number; fn: (...args: any[]) => void; args: any[] }> = [];
  let _immNextId = 0;
  let _immScheduled = false;
  let _immFlushing = false;
  const _immCancelled = new Set<number>();

  const _immChannel = new MessageChannel();
  _immChannel.port1.onmessage = _immFlush;

  function _immFlush() {
    _immScheduled = false;
    _immFlushing = true;
    // Process only items queued at flush start — items added during the flush
    // are deferred to a new macrotask so onmessage handlers can interleave.
    const count = _immQueue.length;
    for (let i = 0; i < count && _immQueue.length > 0; i++) {
      const entry = _immQueue.shift()!;
      if (_immCancelled.has(entry.id)) {
        _immCancelled.delete(entry.id);
        continue;
      }
      try {
        entry.fn(...entry.args);
      } catch (e) {
        console.error("[setImmediate] callback threw:", e);
      }
    }
    _immFlushing = false;
    // Schedule another flush if new items were added during processing
    if (_immQueue.length > 0 && !_immScheduled) {
      _immScheduled = true;
      _immChannel.port2.postMessage(null);
    }
  }

  (globalThis as any).setImmediate = (fn: (...args: any[]) => void, ...args: any[]) => {
    const id = ++_immNextId;
    _immQueue.push({ id, fn, args });
    if (!_immScheduled && !_immFlushing) {
      _immScheduled = true;
      _immChannel.port2.postMessage(null);
    }
    return id;
  };
  (globalThis as any).clearImmediate = (id: number) => {
    _immCancelled.add(id);
  };
}

import { CentralizedKernelWorker } from "../../../host/src/kernel-worker";
import { BrowserWorkerAdapter } from "../../../host/src/worker-adapter-browser";
import { VirtualPlatformIO } from "../../../host/src/vfs/vfs";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { DeviceFileSystem } from "../../../host/src/vfs/device-fs";
import { BrowserTimeProvider } from "../../../host/src/vfs/time";
import { TlsNetworkBackend } from "./tls-network-backend";
import { patchWasmForThread } from "../../../host/src/worker-main";
import type {
  CentralizedWorkerInitMessage,
  CentralizedThreadInitMessage,
  WorkerToHostMessage,
} from "../../../host/src/worker-protocol";
import { ThreadPageAllocator } from "../../../host/src/thread-allocator";
import type {
  MainToKernelMessage,
  KernelToMainMessage,
} from "./kernel-worker-protocol";

const DEFAULT_MAX_PAGES = 16384;
const PAGE_SIZE = 65536;
const CH_TOTAL_SIZE = 72 + PAGE_SIZE;
const ASYNCIFY_BUF_SIZE = 16384;

// State
let kernelWorker: CentralizedKernelWorker;
let workerAdapter: BrowserWorkerAdapter;
let memfs: MemoryFileSystem;
let io: VirtualPlatformIO;
let maxPages = DEFAULT_MAX_PAGES;
let defaultEnv: string[] = [];
let threadAllocator: ThreadPageAllocator;

// Process tracking
interface ProcessInfo {
  memory: WebAssembly.Memory;
  programBytes: ArrayBuffer;
  programModule?: WebAssembly.Module;
  worker: ReturnType<BrowserWorkerAdapter["createWorker"]>;
  channelOffset: number;
}
const processes = new Map<number, ProcessInfo>();

// Per-PID thread module cache: lazily compiled on first clone(), shared across
// all threads of the same process. Keyed by PID of the process that spawned threads.
const threadModuleCache = new Map<number, WebAssembly.Module>();
const threadWorkers = new Map<number, Array<{
  worker: ReturnType<BrowserWorkerAdapter["createWorker"]>;
  channelOffset: number;
  tid: number;
}>>();
const ptyByPid = new Map<number, number>();

// Kernel wasm exports cache
let kernelInstance: WebAssembly.Instance | null = null;
let kernelMemory: WebAssembly.Memory | null = null;

// HTTP bridge port (transferred from main thread → service worker comms)
let bridgePort: MessagePort | null = null;
let bridgeTargetPort: number | null = null; // The specific HTTP port to route bridge requests to

function post(msg: KernelToMainMessage, transfer?: Transferable[]) {
  (globalThis as any).postMessage(msg, transfer ?? []);
}

function respond(requestId: number, result: unknown) {
  post({ type: "response", requestId, result });
}

function respondError(requestId: number, error: string) {
  post({ type: "response", requestId, result: null, error });
}

// ── Init ──

async function handleInit(msg: Extract<MainToKernelMessage, { type: "init" }>) {
  maxPages = msg.config.maxMemoryPages;
  threadAllocator = new ThreadPageAllocator(maxPages);
  defaultEnv = msg.config.env;

  // Create VFS from shared SABs
  memfs = MemoryFileSystem.fromExisting(msg.fsSab);
  const shmfs = MemoryFileSystem.fromExisting(msg.shmSab);
  const devfs = new DeviceFileSystem();
  const mounts: Array<{ mountPoint: string; backend: any }> = [
    { mountPoint: "/dev/shm", backend: shmfs },
    { mountPoint: "/dev", backend: devfs },
    { mountPoint: "/", backend: memfs },
  ];
  io = new VirtualPlatformIO(mounts, new BrowserTimeProvider());

  // Create TLS-MITM network backend. Programs do real TLS handshakes via
  // their compiled-in OpenSSL; the backend terminates TLS locally, makes
  // real fetch() requests, and re-encrypts the responses.
  // In dev mode, use the vite CORS proxy middleware for cross-origin fetches.
  // In production, the service worker handles CORS proxying transparently.
  const devCorsProxy = import.meta.env.DEV ? "/cors-proxy?url=" : undefined;
  const tlsBackend = new TlsNetworkBackend(
    devCorsProxy ? { corsProxyUrl: devCorsProxy } : undefined,
  );
  await tlsBackend.init();
  io.network = tlsBackend;

  // Install the MITM CA certificate in the VFS so OpenSSL trusts it.
  const caCertPem = tlsBackend.getCACertPEM();
  try {
    try { memfs.mkdir("/etc/ssl", 0o755); } catch { /* exists */ }
    try { memfs.mkdir("/etc/ssl/certs", 0o755); } catch { /* exists */ }
    const certBytes = new TextEncoder().encode(caCertPem);
    const certFd = memfs.open("/etc/ssl/certs/ca-certificates.crt", 0o1101, 0o644);
    memfs.write(certFd, certBytes, 0, certBytes.length);
    memfs.close(certFd);
  } catch (e) {
    console.error("[kernel-worker] Failed to write CA cert to VFS:", e);
  }

  // Create worker adapter for spawning sub-workers
  workerAdapter = new BrowserWorkerAdapter(msg.workerEntryUrl);

  // Create CentralizedKernelWorker
  kernelWorker = new CentralizedKernelWorker(
    {
      maxWorkers: msg.config.maxWorkers,
      dataBufferSize: PAGE_SIZE,
      useSharedMemory: true,
    },
    io,
    {
      onFork: (parentPid, childPid, parentMemory) =>
        handleFork(parentPid, childPid, parentMemory),
      onExec: async (pid, path, argv, envp) =>
        handleExec(pid, path, argv, envp),
      onClone: (pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory) =>
        handleClone(pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory),
      onExit: (pid, exitStatus) => handleExit(pid, exitStatus),
    },
  );

  // In a dedicated worker, use Atomics.waitAsync directly — no V8 microtask
  // chain freeze bug (that's main-thread-only).
  kernelWorker.usePolling = false;
  // Process a small batch of syscalls via microtask before yielding to the
  // event loop via setImmediate. Batch size 8 is a good balance: it gives
  // ~8x throughput vs batch-1 while still yielding frequently enough for
  // pump timers, message handlers, and rendering to interleave.
  (kernelWorker as any).relistenBatchSize = 8;

  // Inject stdout/stderr/listen callbacks
  const kw = kernelWorker as any;
  const existingCallbacks = kw.kernel.callbacks || {};
  kw.kernel.callbacks = {
    ...existingCallbacks,
    onStdout: (data: Uint8Array) => post({ type: "stdout", pid: kw.currentHandlePid || 0, data }),
    onStderr: (data: Uint8Array) => post({ type: "stderr", pid: kw.currentHandlePid || 0, data }),
    onNetListen: (_fd: number, port: number, addr: [number, number, number, number]) => {
      const pid = kw.currentHandlePid;
      if (pid !== 0) {
        // Register the listener target for pickListenerTarget
        kw.startTcpListener(pid, _fd, port);
      }
      post({ type: "listen_tcp", pid, fd: _fd, port });
      return 0;
    },
  };

  await kernelWorker.init(msg.kernelWasmBytes);
  kernelInstance = kw.kernelInstance;
  kernelMemory = kw.kernelMemory;

  // Accept bridge port for HTTP request handling
  if (msg.bridgePort) {
    bridgePort = msg.bridgePort;
  }

  post({ type: "ready" });
}

// ── Spawn ──

function handleSpawn(msg: Extract<MainToKernelMessage, { type: "spawn" }>) {
  try {
    let programBytes: ArrayBuffer;
    if (msg.programBytes) {
      programBytes = msg.programBytes;
    } else if (msg.programPath) {
      // Read from shared filesystem
      const bytes = readFileFromFs(msg.programPath);
      if (!bytes) {
        respondError(msg.requestId, `ENOENT: ${msg.programPath}`);
        return;
      }
      programBytes = bytes;
    } else {
      respondError(msg.requestId, "No programBytes or programPath");
      return;
    }

    const pid = msg.pid;
    const pages = msg.maxPages ?? maxPages;
    const memory = new WebAssembly.Memory({
      initial: pages,
      maximum: pages,
      shared: true,
    });
    const channelOffset = (pages - 2) * PAGE_SIZE;
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

    kernelWorker.registerProcess(pid, memory, [channelOffset]);

    if (msg.cwd) {
      kernelWorker.setCwd(pid, msg.cwd);
    }

    if (msg.pty) {
      const ptyIdx = kernelWorker.setupPty(pid);
      ptyByPid.set(pid, ptyIdx);
    } else if (msg.stdin) {
      const stdinData = msg.stdin instanceof Uint8Array ? msg.stdin : new Uint8Array(msg.stdin);
      kernelWorker.setStdinData(pid, stdinData);
    }

    const initData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid,
      ppid: 0,
      programBytes,
      memory,
      channelOffset,
      env: msg.env ?? defaultEnv,
      argv: msg.argv,
      cwd: msg.cwd,
    };

    const worker = workerAdapter.createWorker(initData);
    processes.set(pid, { memory, programBytes, worker, channelOffset });

    worker.on("error", (err: Error) => {
      console.error(`[kernel-worker] Worker error pid=${pid}:`, err.message);
      handleExit(pid, 127);
    });
    worker.on("message", (msg: unknown) => {
      const m = msg as { type?: string; message?: string; pid?: number };
      if (m.type === "error") {
        console.error(`[kernel-worker] Process error pid=${pid}:`, m.message);
        handleExit(pid, 127);
      }
    });

    respond(msg.requestId, pid);
  } catch (e) {
    respondError(msg.requestId, String(e));
  }
}

// ── Process lifecycle callbacks ──

async function handleFork(
  parentPid: number,
  childPid: number,
  parentMemory: WebAssembly.Memory,
): Promise<number[]> {
  const parentInfo = processes.get(parentPid);
  if (!parentInfo) throw new Error(`Unknown parent pid ${parentPid}`);

  // Pre-compile module for TurboFan-optimized code (smaller stack frames).
  if (!parentInfo.programModule) {
    parentInfo.programModule = await WebAssembly.compile(parentInfo.programBytes);
  }

  const parentBuf = new Uint8Array(parentMemory.buffer);
  const parentPages = Math.ceil(parentBuf.byteLength / PAGE_SIZE);
  const childMemory = new WebAssembly.Memory({
    initial: parentPages,
    maximum: maxPages,
    shared: true,
  });
  if (parentPages < maxPages) {
    childMemory.grow(maxPages - parentPages);
  }
  new Uint8Array(childMemory.buffer).set(parentBuf);

  const childChannelOffset = (maxPages - 2) * PAGE_SIZE;
  new Uint8Array(childMemory.buffer, childChannelOffset, CH_TOTAL_SIZE).fill(0);

  kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], {
    skipKernelCreate: true,
  });

  const asyncifyBufAddr = childChannelOffset - ASYNCIFY_BUF_SIZE;
  const childInitData: CentralizedWorkerInitMessage = {
    type: "centralized_init",
    pid: childPid,
    ppid: parentPid,
    programBytes: parentInfo.programBytes,
    programModule: parentInfo.programModule,
    memory: childMemory,
    channelOffset: childChannelOffset,
    isForkChild: true,
    asyncifyBufAddr,
  };

  const childWorker = workerAdapter.createWorker(childInitData);
  childWorker.on("message", (msg: unknown) => {
    const m = msg as { type?: string; pid?: number; status?: number; message?: string };
    if (m?.type === "exit") {
      kernelWorker.unregisterProcess(childPid);
      processes.delete(childPid);
    } else if (m?.type === "error") {
      console.error(`[kernel-worker] fork child=${childPid} error: ${m.message}`);
      kernelWorker.unregisterProcess(childPid);
      processes.delete(childPid);
    }
  });
  childWorker.on("error", (err: Error) => {
    console.error(`[kernel-worker] fork child=${childPid} worker error:`, err);
    kernelWorker.unregisterProcess(childPid);
    processes.delete(childPid);
  });

  processes.set(childPid, {
    memory: childMemory,
    programBytes: parentInfo.programBytes,
    programModule: parentInfo.programModule,
    worker: childWorker,
    channelOffset: childChannelOffset,
  });

  return [childChannelOffset];
}

async function handleExec(
  pid: number,
  path: string,
  argv: string[],
  envp: string[],
): Promise<number> {
  // Materialize lazy file if needed (async fetch avoids sync XHR + SW deadlock)
  await memfs.ensureMaterialized(path);

  // Read binary from the shared filesystem
  const bytes = readFileFromFs(path);
  if (!bytes) return -2; // ENOENT

  // Program found — run kernel exec setup
  const setupResult = kernelWorker.kernelExecSetup(pid);
  if (setupResult < 0) return setupResult;

  kernelWorker.prepareProcessForExec(pid);

  // Terminate old worker
  const oldInfo = processes.get(pid);
  if (oldInfo?.worker) {
    await oldInfo.worker.terminate().catch(() => {});
  }

  // Create fresh memory
  const newMemory = new WebAssembly.Memory({
    initial: maxPages,
    maximum: maxPages,
    shared: true,
  });
  const newChannelOffset = (maxPages - 2) * PAGE_SIZE;
  new Uint8Array(newMemory.buffer, newChannelOffset, CH_TOTAL_SIZE).fill(0);

  kernelWorker.registerProcess(pid, newMemory, [newChannelOffset], {
    skipKernelCreate: true,
  });

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

  const newWorker = workerAdapter.createWorker(execInitData);
  newWorker.on("error", (err: Error) => {
    console.error(`[kernel-worker] exec worker error pid=${pid}:`, err.message);
  });

  // Clear cached thread module — the new program binary is different
  threadModuleCache.delete(pid);

  processes.set(pid, {
    memory: newMemory,
    programBytes: bytes,
    worker: newWorker,
    channelOffset: newChannelOffset,
  });

  return 0;
}

async function handleClone(
  pid: number,
  tid: number,
  fnPtr: number,
  argPtr: number,
  stackPtr: number,
  tlsPtr: number,
  ctidPtr: number,
  memory: WebAssembly.Memory,
): Promise<number> {
  const processInfo = processes.get(pid);
  if (!processInfo) throw new Error(`Unknown pid ${pid} for clone`);

  // Auto-compile thread module if not already cached.
  // The cache is per-PID so each process's module is compiled once and reused
  // for all its threads. Async compilation is fine since clone() blocks on the channel.
  // We keep this separate from processInfo.programModule (which is the unpatched
  // module used for fork children) to avoid conflating the two.
  let threadModule = threadModuleCache.get(pid);
  if (!threadModule) {
    const patched = patchWasmForThread(processInfo.programBytes);
    threadModule = await WebAssembly.compile(patched);
    threadModuleCache.set(pid, threadModule);
  }

  const alloc = threadAllocator.allocate(memory);

  kernelWorker.addChannel(pid, alloc.channelOffset, tid);

  const threadInitData: CentralizedThreadInitMessage = {
    type: "centralized_thread_init",
    pid,
    tid,
    programBytes: processInfo.programBytes,
    programModule: threadModule,
    memory,
    channelOffset: alloc.channelOffset,
    fnPtr,
    argPtr,
    stackPtr,
    tlsPtr,
    ctidPtr,
    tlsAllocAddr: alloc.tlsAllocAddr,
  };

  const threadWorker = workerAdapter.createWorker(threadInitData);
  if (!threadWorkers.has(pid)) threadWorkers.set(pid, []);
  const threadEntry = { worker: threadWorker, channelOffset: alloc.channelOffset, tid, basePage: alloc.basePage };
  threadWorkers.get(pid)!.push(threadEntry);

  const reclaimThread = () => {
    threadAllocator.free(alloc.basePage);
    const threads = threadWorkers.get(pid);
    if (threads) {
      const idx = threads.indexOf(threadEntry);
      if (idx >= 0) threads.splice(idx, 1);
    }
  };

  threadWorker.on("message", (msg: unknown) => {
    const m = msg as WorkerToHostMessage;
    if (m.type === "thread_exit") {
      threadWorker.terminate().catch(() => {});
      reclaimThread();
    }
  });
  threadWorker.on("error", () => {
    kernelWorker.notifyThreadExit(pid, tid);
    kernelWorker.removeChannel(pid, alloc.channelOffset);
    reclaimThread();
  });

  return tid;
}

function handleExit(pid: number, exitStatus: number): void {
  const info = processes.get(pid);

  // Check if this is a "top-level" process or a fork child
  // For now, always deactivate — the main thread tracks exit promises
  kernelWorker.deactivateProcess(pid);

  if (info?.worker) {
    info.worker.terminate().catch(() => {});
  }
  processes.delete(pid);
  threadModuleCache.delete(pid);
  ptyByPid.delete(pid);

  // Notify main thread
  post({ type: "exit", pid, status: exitStatus });
}

// ── Terminate ──

async function handleTerminateProcess(msg: Extract<MainToKernelMessage, { type: "terminate_process" }>) {
  const pid = msg.pid;

  // Terminate thread workers
  const threads = threadWorkers.get(pid);
  if (threads) {
    for (const t of threads) {
      await t.worker.terminate().catch(() => {});
      try {
        kernelWorker.notifyThreadExit(pid, t.tid);
        kernelWorker.removeChannel(pid, t.channelOffset);
      } catch {}
    }
    threadWorkers.delete(pid);
  }

  // Terminate main process worker
  const info = processes.get(pid);
  if (info?.worker) {
    await info.worker.terminate().catch(() => {});
  }

  try {
    kernelWorker.unregisterProcess(pid);
  } catch {}

  processes.delete(pid);
  threadModuleCache.delete(pid);
  ptyByPid.delete(pid);
  respond(msg.requestId, true);
}

// ── Pipe operations ──

function handlePipeRead(msg: Extract<MainToKernelMessage, { type: "pipe_read" }>) {
  if (!kernelInstance) { respond(msg.requestId, null); return; }
  const pipeRead = kernelInstance.exports.kernel_pipe_read as (
    pid: number, pipeIdx: number, bufPtr: bigint, bufLen: number,
  ) => number;
  const scratchOffset = (kernelWorker as any).tcpScratchOffset || (kernelWorker as any).scratchOffset;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const n = pipeRead(msg.pid, msg.pipeIdx, BigInt(scratchOffset), PAGE_SIZE);
    if (n <= 0) break;
    const mem = new Uint8Array(kernelMemory!.buffer);
    chunks.push(mem.slice(scratchOffset, scratchOffset + n));
  }
  if (chunks.length === 0) { respond(msg.requestId, null); return; }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  respond(msg.requestId, result);
}

function handlePipeWrite(msg: Extract<MainToKernelMessage, { type: "pipe_write" }>) {
  if (!kernelInstance) { respond(msg.requestId, -1); return; }
  const pipeWrite = kernelInstance.exports.kernel_pipe_write as (
    pid: number, pipeIdx: number, bufPtr: bigint, bufLen: number,
  ) => number;
  const scratchOffset = (kernelWorker as any).tcpScratchOffset || (kernelWorker as any).scratchOffset;
  let written = 0;
  const data = msg.data;
  while (written < data.length) {
    const chunk = Math.min(data.length - written, PAGE_SIZE);
    let mem = new Uint8Array(kernelMemory!.buffer);
    mem.set(data.subarray(written, written + chunk), scratchOffset);
    const n = pipeWrite(msg.pid, msg.pipeIdx, BigInt(scratchOffset), chunk);
    if (n <= 0) break;
    written += n;
  }
  // After writing, wake any blocked readers on this pipe
  const kw = kernelWorker as any;
  const readers = kw.pendingPipeReaders?.get(msg.pipeIdx);
  if (readers && readers.length > 0) {
    kw.pendingPipeReaders.delete(msg.pipeIdx);
    for (const reader of readers) {
      if (kw.processes.has(reader.pid)) {
        kw.retrySyscall(reader.channel);
      }
    }
  }
  kw.scheduleWakeBlockedRetries();
  respond(msg.requestId, written);
}

function handlePipeCloseRead(msg: Extract<MainToKernelMessage, { type: "pipe_close_read" }>) {
  if (!kernelInstance) return;
  const fn = kernelInstance.exports.kernel_pipe_close_read as (pid: number, pipeIdx: number) => number;
  fn(msg.pid, msg.pipeIdx);
}

function handlePipeCloseWrite(msg: Extract<MainToKernelMessage, { type: "pipe_close_write" }>) {
  if (!kernelInstance) return;
  const fn = kernelInstance.exports.kernel_pipe_close_write as (pid: number, pipeIdx: number) => number;
  fn(msg.pid, msg.pipeIdx);
}

function handlePipeIsWriteOpen(msg: Extract<MainToKernelMessage, { type: "pipe_is_write_open" }>) {
  if (!kernelInstance) { respond(msg.requestId, false); return; }
  const fn = kernelInstance.exports.kernel_pipe_is_write_open as (pid: number, pipeIdx: number) => number;
  respond(msg.requestId, fn(msg.pid, msg.pipeIdx) === 1);
}

function handleInjectConnection(msg: Extract<MainToKernelMessage, { type: "inject_connection" }>) {
  if (!kernelInstance) { respond(msg.requestId, -1); return; }
  const injectConnection = kernelInstance.exports.kernel_inject_connection as (
    pid: number, fd: number, a: number, b: number, c: number, d: number, port: number,
  ) => number;
  const recvPipeIdx = injectConnection(
    msg.pid, msg.fd,
    msg.peerAddr[0], msg.peerAddr[1], msg.peerAddr[2], msg.peerAddr[3],
    msg.peerPort,
  );
  if (recvPipeIdx >= 0) {
    (kernelWorker as any).scheduleWakeBlockedRetries();
  }
  respond(msg.requestId, recvPipeIdx);
}

function handleWakeBlockedReaders(msg: Extract<MainToKernelMessage, { type: "wake_blocked_readers" }>) {
  const kw = kernelWorker as any;
  const readers = kw.pendingPipeReaders?.get(msg.pipeIdx);
  if (readers && readers.length > 0) {
    kw.pendingPipeReaders.delete(msg.pipeIdx);
    for (const reader of readers) {
      if (kw.processes.has(reader.pid)) {
        kw.retrySyscall(reader.channel);
      }
    }
  }
  kw.scheduleWakeBlockedRetries();
}

function handleWakeBlockedWriters(msg: Extract<MainToKernelMessage, { type: "wake_blocked_writers" }>) {
  const kw = kernelWorker as any;
  const writers = kw.pendingPipeWriters?.get(msg.pipeIdx);
  if (writers && writers.length > 0) {
    kw.pendingPipeWriters.delete(msg.pipeIdx);
    for (const writer of writers) {
      if (kw.processes.has(writer.pid)) {
        kw.retrySyscall(writer.channel);
      }
    }
  }
  kw.scheduleWakeBlockedRetries();
}

function handleIsStdinConsumed(msg: Extract<MainToKernelMessage, { type: "is_stdin_consumed" }>) {
  const kw = kernelWorker as any;
  respond(msg.requestId, kw.stdinFinite.has(msg.pid) && !kw.stdinBuffers.has(msg.pid));
}

function handlePickListenerTarget(msg: Extract<MainToKernelMessage, { type: "pick_listener_target" }>) {
  const kw = kernelWorker as any;
  const result = kw.pickListenerTarget(msg.port);
  respond(msg.requestId, result);
}

function handleDestroy(msg: Extract<MainToKernelMessage, { type: "destroy" }>) {
  // Terminate all process workers
  for (const [pid, info] of processes) {
    if (info.worker) info.worker.terminate().catch(() => {});
    try { kernelWorker.unregisterProcess(pid); } catch {}
  }
  processes.clear();
  threadModuleCache.clear();
  respond(msg.requestId, true);
}

// ── PTY ──

function handlePtyWrite(msg: Extract<MainToKernelMessage, { type: "pty_write" }>) {
  const ptyIdx = ptyByPid.get(msg.pid);
  if (ptyIdx === undefined) return;
  kernelWorker.ptyMasterWrite(ptyIdx, msg.data);
}

function handlePtyResize(msg: Extract<MainToKernelMessage, { type: "pty_resize" }>) {
  const ptyIdx = ptyByPid.get(msg.pid);
  if (ptyIdx === undefined) return;
  kernelWorker.ptySetWinsize(ptyIdx, msg.rows, msg.cols);
}

function handleRegisterPtyOutput(msg: Extract<MainToKernelMessage, { type: "register_pty_output" }>) {
  const ptyIdx = ptyByPid.get(msg.pid);
  if (ptyIdx === undefined) return;
  kernelWorker.onPtyOutput(ptyIdx, (data: Uint8Array) => {
    post({ type: "pty_output", pid: msg.pid, data });
  });
}

// ── Connection Pump (runs inside kernel worker) ──

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function handleHttpRequest(requestId: number, request: any) {
  if (!kernelInstance || !bridgePort) return;

  const url = request.url || "?";

  // Find a listener target for the bridge's target HTTP port.
  const kw = kernelWorker as any;
  let target: { pid: number; fd: number } | null = null;
  if (bridgeTargetPort !== null) {
    target = kw.pickListenerTarget(bridgeTargetPort);
  } else {
    // Fallback: try all registered listener ports
    const targetPorts: number[] = Array.from(kw.tcpListenerTargets?.keys() ?? []);
    for (const port of targetPorts) {
      target = kw.pickListenerTarget(port);
      if (target) break;
    }
  }
  if (!target) {
    console.warn(`[bridge] no listener target for req#${requestId} ${url}`);
    bridgePort.postMessage({
      type: "http-error",
      requestId,
      error: "No listener target available",
    });
    return;
  }

  const injectConnection = kernelInstance.exports.kernel_inject_connection as (
    pid: number, fd: number, a: number, b: number, c: number, d: number, port: number,
  ) => number;
  const recvPipeIdx = injectConnection(
    target.pid, target.fd,
    127, 0, 0, 1,
    Math.floor(Math.random() * 60000) + 1024,
  );
  if (recvPipeIdx < 0) {
    console.warn(`[bridge] inject failed for req#${requestId} ${url} → pid=${target.pid} err=${recvPipeIdx}`);
    bridgePort.postMessage({
      type: "http-error",
      requestId,
      error: "Failed to inject connection",
    });
    return;
  }

  const sendPipeIdx = recvPipeIdx + 1;
  const rawRequest = buildRawHttpRequest(request);

  console.log(`[bridge] req#${requestId} ${request.method} ${url} → pid=${target.pid}`);

  // Write request directly to pipe (synchronous)
  const written = pipeWriteDirect(target.pid, recvPipeIdx, rawRequest);
  if (written < rawRequest.length) {
    console.warn(`[bridge] req#${requestId} partial write: ${written}/${rawRequest.length}`);
  }

  // Wake blocked readers on the recv pipe
  const readers = kw.pendingPipeReaders?.get(recvPipeIdx);
  if (readers && readers.length > 0) {
    kw.pendingPipeReaders.delete(recvPipeIdx);
    for (const reader of readers) {
      if (kw.processes.has(reader.pid)) {
        kw.retrySyscall(reader.channel);
      }
    }
  }

  // Directly wake the target process's pending poll — scheduleWakeBlockedRetries
  // uses setImmediate which may be delayed by busy pump loops, causing the poll
  // to wait for its full 5000ms fallback timer. Synchronous wake guarantees the
  // nginx worker accepts injected connections immediately.
  for (const [key, entry] of kw.pendingPollRetries) {
    if (entry.channel.pid === target.pid) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      kw.pendingPollRetries.delete(key);
      if (kw.processes.has(target.pid)) {
        kw.retrySyscall(entry.channel);
      }
      break;
    }
  }
  // Also schedule broad wake for other processes that might care
  kw.scheduleWakeBlockedRetries();

  // Pump response
  pumpResponse(requestId, target.pid, sendPipeIdx, recvPipeIdx, url);
}

function pipeWriteDirect(pid: number, pipeIdx: number, data: Uint8Array): number {
  const pipeWrite = kernelInstance!.exports.kernel_pipe_write as (
    pid: number, pipeIdx: number, bufPtr: bigint, bufLen: number,
  ) => number;
  const scratchOffset = (kernelWorker as any).tcpScratchOffset || (kernelWorker as any).scratchOffset;
  let written = 0;
  while (written < data.length) {
    const chunk = Math.min(data.length - written, PAGE_SIZE);
    // Re-create view before each Wasm call — memory.grow detaches the ArrayBuffer.
    let mem = new Uint8Array(kernelMemory!.buffer);
    mem.set(data.subarray(written, written + chunk), scratchOffset);
    const n = pipeWrite(pid, pipeIdx, BigInt(scratchOffset), chunk);
    if (n <= 0) break;
    written += n;
  }
  return written;
}

function pipeReadDirect(pid: number, pipeIdx: number): Uint8Array | null {
  const pipeRead = kernelInstance!.exports.kernel_pipe_read as (
    pid: number, pipeIdx: number, bufPtr: bigint, bufLen: number,
  ) => number;
  const scratchOffset = (kernelWorker as any).tcpScratchOffset || (kernelWorker as any).scratchOffset;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const n = pipeRead(pid, pipeIdx, BigInt(scratchOffset), PAGE_SIZE);
    if (n <= 0) break;
    // Re-create view after each Wasm call — memory.grow during pipe read
    // (e.g. wakeup Vec realloc) detaches the previous ArrayBuffer.
    const mem = new Uint8Array(kernelMemory!.buffer);
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

function pipeIsWriteOpenDirect(pid: number, pipeIdx: number): boolean {
  const fn = kernelInstance!.exports.kernel_pipe_is_write_open as (pid: number, pipeIdx: number) => number;
  return fn(pid, pipeIdx) === 1;
}

function pipeCloseReadDirect(pid: number, pipeIdx: number): void {
  const fn = kernelInstance!.exports.kernel_pipe_close_read as (pid: number, pipeIdx: number) => number;
  fn(pid, pipeIdx);
}

function pipeCloseWriteDirect(pid: number, pipeIdx: number): void {
  const fn = kernelInstance!.exports.kernel_pipe_close_write as (pid: number, pipeIdx: number) => number;
  fn(pid, pipeIdx);
}

function buildRawHttpRequest(request: any): Uint8Array {
  let header = `${request.method} ${request.url} HTTP/1.1\r\n`;
  const headerKeys = Object.keys(request.headers).map((k: string) => k.toLowerCase());
  for (const [key, value] of Object.entries(request.headers)) {
    header += `${key}: ${value}\r\n`;
  }
  if (request.body && !headerKeys.includes("content-length")) {
    header += `Content-Length: ${request.body.length}\r\n`;
  }
  if (!headerKeys.includes("connection")) {
    header += `Connection: close\r\n`;
  }
  header += `\r\n`;

  const headerBytes = encoder.encode(header);
  if (!request.body || request.body.length === 0) return headerBytes;

  const result = new Uint8Array(headerBytes.length + request.body.length);
  result.set(headerBytes, 0);
  result.set(request.body, headerBytes.length);
  return result;
}

const HTTP_PUMP_TIMEOUT_MS = 60_000;

function pumpResponse(
  requestId: number,
  pid: number,
  sendPipeIdx: number,
  recvPipeIdx: number,
  debugUrl?: string,
) {
  const chunks: Uint8Array[] = [];
  let sawWriteOpen = false;
  const startTime = Date.now();
  let totalBytes = 0;

  let pumpIter = 0;
  const pump = () => {
    pumpIter++;
    if (Date.now() - startTime > HTTP_PUMP_TIMEOUT_MS) {
      // Timeout — clean up and send error response
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.warn(`[bridge] TIMEOUT req#${requestId} after ${elapsed}s, ${totalBytes} bytes received, sawWriteOpen=${sawWriteOpen}, url=${debugUrl}`);
      pipeCloseReadDirect(pid, sendPipeIdx);
      pipeCloseWriteDirect(pid, recvPipeIdx);
      bridgePort!.postMessage({
        type: "http-response",
        requestId,
        status: 504,
        headers: {},
        body: new Uint8Array(0),
      });
      return;
    }

    const data = pipeReadDirect(pid, sendPipeIdx);
    if (data) {
      chunks.push(data);
      totalBytes += data.length;
      // Wake blocked writers
      const kw = kernelWorker as any;
      const writers = kw.pendingPipeWriters?.get(sendPipeIdx);
      if (writers && writers.length > 0) {
        kw.pendingPipeWriters.delete(sendPipeIdx);
        for (const writer of writers) {
          if (kw.processes.has(writer.pid)) {
            kw.retrySyscall(writer.channel);
          }
        }
      }
      kw.scheduleWakeBlockedRetries();
    }

    const writeOpen = (kernelInstance!.exports.kernel_pipe_is_write_open as (pid: number, pipeIdx: number) => number)(pid, sendPipeIdx) === 1;
    if (writeOpen && !sawWriteOpen) sawWriteOpen = true;

    if (sawWriteOpen && !writeOpen && !data) {
      // Response complete
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[bridge] DONE req#${requestId} ${elapsed}s ${totalBytes}B ${debugUrl}`);
      pipeCloseReadDirect(pid, sendPipeIdx);
      pipeCloseWriteDirect(pid, recvPipeIdx);
      const rawResponse = concatChunks(chunks);
      const parsed = parseRawHttpResponse(rawResponse);
      bridgePort!.postMessage({
        type: "http-response",
        requestId,
        status: parsed.status,
        headers: parsed.headers,
        body: parsed.body,
      });
      return;
    }

    setTimeout(pump, data ? 0 : 2);
  };

  pump();
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function parseRawHttpResponse(data: Uint8Array): { status: number; headers: Record<string, string>; body: Uint8Array } {
  const text = decoder.decode(data);
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd < 0) return { status: 200, headers: {}, body: data };

  const headerText = text.slice(0, headerEnd);
  const lines = headerText.split("\r\n");
  const statusMatch = lines[0].match(/^HTTP\/[\d.]+ (\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 200;

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(": ");
    if (colon >= 0) {
      const key = lines[i].slice(0, colon);
      const value = lines[i].slice(colon + 2);
      if (key.toLowerCase() === "set-cookie" && headers[key]) {
        headers[key] += "\n" + value;
      } else {
        headers[key] = value;
      }
    }
  }

  let byteHeaderEnd = 0;
  for (let i = 0; i < data.length - 3; i++) {
    if (data[i] === 13 && data[i + 1] === 10 && data[i + 2] === 13 && data[i + 3] === 10) {
      byteHeaderEnd = i + 4;
      break;
    }
  }
  let body = data.subarray(byteHeaderEnd);

  const te = headers["Transfer-Encoding"] || headers["transfer-encoding"];
  if (te && te.toLowerCase().includes("chunked")) {
    body = decodeChunked(body);
    delete headers["Transfer-Encoding"];
    delete headers["transfer-encoding"];
  }

  return { status, headers, body: new Uint8Array(body) };
}

function decodeChunked(data: Uint8Array): Uint8Array {
  const result: Uint8Array[] = [];
  let pos = 0;
  while (pos < data.length) {
    let lineEnd = -1;
    for (let i = pos; i < data.length - 1; i++) {
      if (data[i] === 0x0d && data[i + 1] === 0x0a) { lineEnd = i; break; }
    }
    if (lineEnd < 0) break;
    const sizeLine = decoder.decode(data.subarray(pos, lineEnd)).trim();
    const chunkSize = parseInt(sizeLine, 16);
    if (isNaN(chunkSize) || chunkSize === 0) break;
    const chunkStart = lineEnd + 2;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > data.length) break;
    result.push(data.subarray(chunkStart, chunkEnd));
    pos = chunkEnd + 2;
  }
  return concatChunks(result);
}

// ── Filesystem helpers ──

function readFileFromFs(path: string): ArrayBuffer | null {
  try {
    const fd = memfs.open(path, 0 /* O_RDONLY */, 0);
    try {
      const stat = memfs.fstat(fd);
      const size = stat.size;
      if (size <= 0) { memfs.close(fd); return null; }
      const buf = new Uint8Array(size);
      const nread = memfs.read(fd, buf, null, size);
      memfs.close(fd);
      if (nread <= 0) return null;
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + nread);
    } catch {
      memfs.close(fd);
      return null;
    }
  } catch {
    return null;
  }
}

// ── Message dispatch ──

const sw = globalThis as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

sw.onmessage = (e: MessageEvent) => {
  const msg = e.data as MainToKernelMessage;
  switch (msg.type) {
    case "init": handleInit(msg); break;
    case "spawn": handleSpawn(msg); break;
    case "terminate_process": handleTerminateProcess(msg); break;
    case "append_stdin_data": kernelWorker.appendStdinData(msg.pid, msg.data); break;
    case "set_stdin_data": kernelWorker.setStdinData(msg.pid, msg.data); break;
    case "pty_write": handlePtyWrite(msg); break;
    case "pty_resize": handlePtyResize(msg); break;
    case "register_pty_output": handleRegisterPtyOutput(msg); break;
    case "inject_connection": handleInjectConnection(msg); break;
    case "pipe_read": handlePipeRead(msg); break;
    case "pipe_write": handlePipeWrite(msg); break;
    case "pipe_close_read": handlePipeCloseRead(msg); break;
    case "pipe_close_write": handlePipeCloseWrite(msg); break;
    case "pipe_is_write_open": handlePipeIsWriteOpen(msg); break;
    case "wake_blocked_readers": handleWakeBlockedReaders(msg); break;
    case "wake_blocked_writers": handleWakeBlockedWriters(msg); break;
    case "is_stdin_consumed": handleIsStdinConsumed(msg); break;
    case "pick_listener_target": handlePickListenerTarget(msg); break;
    case "destroy": handleDestroy(msg); break;
    case "register_lazy_files": memfs.importLazyEntries(msg.entries); break;
    default: {
      // Handle non-protocol messages (e.g., bridge port transfer)
      const raw = e.data as any;
      if (raw?.type === "set_bridge_port" && raw.bridgePort) {
        bridgePort = raw.bridgePort;
        if (typeof raw.httpPort === "number") {
          bridgeTargetPort = raw.httpPort;
        }
        // Wire up connection pump
        if (bridgePort) {
          bridgePort.onmessage = (event: MessageEvent) => {
            const m = event.data;
            if (m?.type === "http-request") {
              handleHttpRequest(m.requestId, m);
            }
          };
        }
      } else {
        console.warn("[kernel-worker] Unknown message type:", raw?.type);
      }
    }
  }
};
