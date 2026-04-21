/**
 * Node.js kernel worker entry point — general-purpose, message-based.
 *
 * Runs CentralizedKernelWorker in a dedicated worker_thread so the kernel's
 * Atomics.waitAsync event loop runs independently of the main thread's libuv
 * loop. This eliminates the 3-4x throughput penalty observed when the kernel
 * shares the main thread.
 *
 * Protocol (see node-kernel-protocol.ts):
 *   Main → Worker: init, spawn, append_stdin_data, set_stdin_data,
 *                  pty_write, pty_resize, terminate_process, destroy,
 *                  resolve_exec_response
 *   Worker → Main: ready, response, exit, stdout, stderr, pty_output,
 *                  resolve_exec
 */
import { parentPort } from "node:worker_threads";
import { readFileSync, existsSync } from "node:fs";
import { CentralizedKernelWorker } from "./kernel-worker";
import { NodePlatformIO } from "./platform/node";
import { NodeWorkerAdapter } from "./worker-adapter";
import { ThreadPageAllocator } from "./thread-allocator";
import { patchWasmForThread } from "./worker-main";
import { detectPtrWidth } from "./constants";
import { CH_TOTAL_SIZE, DEFAULT_MAX_PAGES, PAGES_PER_THREAD } from "./constants";
import type {
  CentralizedWorkerInitMessage,
  CentralizedThreadInitMessage,
  WorkerToHostMessage,
} from "./worker-protocol";
import type {
  MainToKernelMessage,
  KernelToMainMessage,
  InitMessage,
  SpawnMessage,
  TerminateProcessMessage,
} from "./node-kernel-protocol";

if (!parentPort) {
  throw new Error("node-kernel-worker-entry must run in a worker_thread");
}

const port = parentPort;

// --- State ---

let kernelWorker: CentralizedKernelWorker;
let workerAdapter: NodeWorkerAdapter;
let threadAllocator: ThreadPageAllocator;
let maxPages = DEFAULT_MAX_PAGES;
let execPrograms: Record<string, string> = {};

// Process tracking
interface ProcessInfo {
  memory: WebAssembly.Memory;
  programBytes: ArrayBuffer;
  worker: ReturnType<NodeWorkerAdapter["createWorker"]>;
  channelOffset: number;
  ptrWidth: 4 | 8;
}
const processes = new Map<number, ProcessInfo>();

// Spawn PID counter. Starts at 100 so user programs never occupy pid 1 —
// POSIX tests (e.g. libc-test regression/daemon-failure) treat `getppid() == 1`
// as the signal that a daemon has reparented to init, so a test binary running
// at pid 1 would make its forked children misdiagnose themselves as orphaned.
let nextSpawnPid = 100;

// Per-PID thread module cache: lazily compiled on first clone()
const threadModuleCache = new Map<number, WebAssembly.Module>();

// Thread workers per-PID for cleanup
const threadWorkers = new Map<number, Array<{
  worker: ReturnType<NodeWorkerAdapter["createWorker"]>;
  channelOffset: number;
  tid: number;
  basePage: number;
}>>();

// PTY index per-PID
const ptyByPid = new Map<number, number>();

// Exec resolution: request ID → resolver
let execResolveId = 0;
const pendingExecResolves = new Map<number, (bytes: ArrayBuffer | null) => void>();

// --- Helpers ---

function post(msg: KernelToMainMessage) {
  port.postMessage(msg);
}

function respond(requestId: number, result: unknown) {
  post({ type: "response", requestId, result });
}

function respondError(requestId: number, error: string) {
  post({ type: "response", requestId, result: null, error });
}

function createProcessMemory(ptrWidth: 4 | 8, initialPages = 17): WebAssembly.Memory {
  if (ptrWidth === 8) {
    return new WebAssembly.Memory({
      initial: BigInt(initialPages) as any,
      maximum: BigInt(maxPages) as any,
      shared: true,
      address: "i64",
    } as any);
  }
  return new WebAssembly.Memory({
    initial: initialPages,
    maximum: maxPages,
    shared: true,
  });
}

function growToMax(memory: WebAssembly.Memory, ptrWidth: 4 | 8, currentPages: number): void {
  const pagesToGrow = maxPages - currentPages;
  if (pagesToGrow > 0) {
    if (ptrWidth === 8) {
      memory.grow(BigInt(pagesToGrow) as any);
    } else {
      memory.grow(pagesToGrow);
    }
  }
}

function resolveExecLocal(path: string): ArrayBuffer | null {
  const mapped = execPrograms[path];
  if (mapped && existsSync(mapped)) {
    const bytes = readFileSync(mapped);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  return null;
}

async function resolveExec(path: string): Promise<ArrayBuffer | null> {
  const local = resolveExecLocal(path);
  if (local) return local;

  // Ask main thread to resolve
  const requestId = ++execResolveId;
  return new Promise<ArrayBuffer | null>((resolve) => {
    pendingExecResolves.set(requestId, resolve);
    post({ type: "resolve_exec", requestId, path });
  });
}

// --- Init ---

async function handleInit(msg: InitMessage) {
  maxPages = msg.config.maxPages ?? DEFAULT_MAX_PAGES;
  execPrograms = msg.execPrograms ?? {};
  threadAllocator = new ThreadPageAllocator(maxPages);
  workerAdapter = new NodeWorkerAdapter();

  const io = new NodePlatformIO();

  kernelWorker = new CentralizedKernelWorker(
    {
      maxWorkers: msg.config.maxWorkers,
      dataBufferSize: msg.config.dataBufferSize ?? 65536,
      useSharedMemory: msg.config.useSharedMemory ?? true,
    },
    io,
    {
      onFork: handleFork,
      onExec: handleExec,
      onClone: handleClone,
      onExit: handleExit,
    },
  );

  kernelWorker.setOutputCallbacks({
    onStdout: (data: Uint8Array) => {
      post({ type: "stdout", pid: 0, data: new Uint8Array(data) });
    },
    onStderr: (data: Uint8Array) => {
      post({ type: "stderr", pid: 0, data: new Uint8Array(data) });
    },
  });

  await kernelWorker.init(msg.kernelWasmBytes);

  post({ type: "ready" });
}

// --- Spawn ---

function handleSpawn(msg: SpawnMessage) {
  try {
    // Allocate PID internally — skip any PIDs already occupied by fork children
    while (processes.has(nextSpawnPid)) {
      nextSpawnPid++;
    }
    const pid = nextSpawnPid++;

    const ptrWidth = detectPtrWidth(msg.programBytes);
    const memory = createProcessMemory(ptrWidth);
    const channelOffset = (maxPages - 2) * 65536;
    growToMax(memory, ptrWidth, 17);
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

    kernelWorker.registerProcess(pid, memory, [channelOffset], {
      ptrWidth,
      argv: msg.argv,
    });

    if (msg.cwd) {
      kernelWorker.setCwd(pid, msg.cwd);
    }

    if (msg.maxAddr != null) {
      kernelWorker.setMaxAddr(pid, msg.maxAddr);
    }

    if (msg.pty) {
      const ptyIdx = kernelWorker.setupPty(pid);
      ptyByPid.set(pid, ptyIdx);
      kernelWorker.onPtyOutput(ptyIdx, (data: Uint8Array) => {
        post({ type: "pty_output", pid, data });
      });
    } else if (msg.stdin) {
      const stdinData = msg.stdin instanceof Uint8Array ? msg.stdin : new Uint8Array(msg.stdin);
      kernelWorker.setStdinData(pid, stdinData);
    }

    const initData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid,
      ppid: 0,
      programBytes: msg.programBytes,
      memory,
      channelOffset,
      env: msg.env,
      argv: msg.argv,
      ptrWidth,
      kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
    };

    const worker = workerAdapter.createWorker(initData);
    processes.set(pid, {
      memory,
      programBytes: msg.programBytes,
      worker,
      channelOffset,
      ptrWidth,
    });

    worker.on("error", (err: Error) => {
      console.error(`[kernel-worker] Worker error pid=${pid}:`, err.message);
    });

    respond(msg.requestId, pid);
  } catch (e) {
    respondError(msg.requestId, String(e));
  }
}

// --- Process lifecycle callbacks ---

async function handleFork(
  parentPid: number,
  childPid: number,
  parentMemory: WebAssembly.Memory,
): Promise<number[]> {
  const parentInfo = processes.get(parentPid);
  const parentProgram = parentInfo?.programBytes;
  if (!parentProgram) throw new Error(`Unknown parent pid ${parentPid}`);

  const ptrWidth = parentInfo.ptrWidth;
  const parentBuf = new Uint8Array(parentMemory.buffer);
  const parentPages = Math.ceil(parentBuf.byteLength / 65536);
  const childMemory = createProcessMemory(ptrWidth, parentPages);
  growToMax(childMemory, ptrWidth, parentPages);
  new Uint8Array(childMemory.buffer).set(parentBuf);

  const childChannelOffset = (maxPages - 2) * 65536;
  new Uint8Array(childMemory.buffer, childChannelOffset, CH_TOTAL_SIZE).fill(0);

  kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], {
    skipKernelCreate: true,
    ptrWidth,
  });

  const ASYNCIFY_BUF_SIZE = 16384;
  const asyncifyBufAddr = childChannelOffset - ASYNCIFY_BUF_SIZE;

  const childInitData: CentralizedWorkerInitMessage = {
    type: "centralized_init",
    pid: childPid,
    ppid: parentPid,
    programBytes: parentProgram,
    memory: childMemory,
    channelOffset: childChannelOffset,
    isForkChild: true,
    asyncifyBufAddr,
    ptrWidth,
    kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
  };

  const childWorker = workerAdapter.createWorker(childInitData);
  processes.set(childPid, {
    memory: childMemory,
    programBytes: parentProgram,
    worker: childWorker,
    channelOffset: childChannelOffset,
    ptrWidth,
  });

  childWorker.on("error", () => {
    kernelWorker.unregisterProcess(childPid);
    processes.delete(childPid);
  });

  return [childChannelOffset];
}

async function handleExec(
  pid: number,
  path: string,
  argv: string[],
  envp: string[],
): Promise<number> {
  const resolved = await resolveExec(path);
  if (!resolved) return -2; // ENOENT

  const newPtrWidth = detectPtrWidth(resolved);
  const setupResult = kernelWorker.kernelExecSetup(pid);
  if (setupResult < 0) return setupResult;

  kernelWorker.prepareProcessForExec(pid);

  const oldInfo = processes.get(pid);
  if (oldInfo?.worker) {
    await oldInfo.worker.terminate().catch(() => {});
  }

  const newMemory = createProcessMemory(newPtrWidth);
  const newChannelOffset = (maxPages - 2) * 65536;
  growToMax(newMemory, newPtrWidth, 17);
  new Uint8Array(newMemory.buffer, newChannelOffset, CH_TOTAL_SIZE).fill(0);

  kernelWorker.registerProcess(pid, newMemory, [newChannelOffset], {
    skipKernelCreate: true,
    ptrWidth: newPtrWidth,
  });

  // Clear thread module cache — new program binary is different
  threadModuleCache.delete(pid);

  const initData: CentralizedWorkerInitMessage = {
    type: "centralized_init",
    pid,
    ppid: 0,
    programBytes: resolved,
    memory: newMemory,
    channelOffset: newChannelOffset,
    argv,
    env: envp,
    ptrWidth: newPtrWidth,
    kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
  };

  const newWorker = workerAdapter.createWorker(initData);
  processes.set(pid, {
    memory: newMemory,
    programBytes: resolved,
    worker: newWorker,
    channelOffset: newChannelOffset,
    ptrWidth: newPtrWidth,
  });

  newWorker.on("error", (err: Error) => {
    console.error(`[exec] worker error for pid ${pid}:`, err.message);
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

  // Auto-compile thread module if not already cached per-PID
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
    ptrWidth: processInfo.ptrWidth,
    kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
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

  // Deactivate process (zombie until reaped or destroy)
  kernelWorker.deactivateProcess(pid);

  if (info?.worker) {
    info.worker.terminate().catch(() => {});
  }

  // Terminate any surviving thread workers for this process; the main
  // process worker exiting means their shared state is gone.
  const threads = threadWorkers.get(pid);
  if (threads) {
    for (const t of threads) {
      t.worker.terminate().catch(() => {});
    }
    threadWorkers.delete(pid);
  }

  processes.delete(pid);
  threadModuleCache.delete(pid);
  ptyByPid.delete(pid);

  // Notify main thread
  post({ type: "exit", pid, status: exitStatus });
}

// --- Terminate ---

async function handleTerminate(msg: TerminateProcessMessage) {
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

// --- Destroy ---

function handleDestroy(msg: { requestId: number }) {
  for (const [pid, info] of processes) {
    if (info.worker) info.worker.terminate().catch(() => {});
    try { kernelWorker.unregisterProcess(pid); } catch {}
  }
  processes.clear();
  threadModuleCache.clear();
  threadWorkers.clear();
  ptyByPid.clear();
  respond(msg.requestId, true);
}

// --- PTY ---

function handlePtyWrite(pid: number, data: Uint8Array) {
  const ptyIdx = ptyByPid.get(pid);
  if (ptyIdx === undefined) return;
  kernelWorker.ptyMasterWrite(ptyIdx, data);
}

function handlePtyResize(pid: number, rows: number, cols: number) {
  const ptyIdx = ptyByPid.get(pid);
  if (ptyIdx === undefined) return;
  kernelWorker.ptySetWinsize(ptyIdx, rows, cols);
}

// --- Message dispatch ---

port.on("message", (msg: MainToKernelMessage) => {
  switch (msg.type) {
    case "init":
      handleInit(msg);
      break;
    case "spawn":
      handleSpawn(msg);
      break;
    case "append_stdin_data":
      kernelWorker.appendStdinData(msg.pid, msg.data);
      break;
    case "set_stdin_data":
      kernelWorker.setStdinData(msg.pid, msg.data);
      break;
    case "pty_write":
      handlePtyWrite(msg.pid, msg.data);
      break;
    case "pty_resize":
      handlePtyResize(msg.pid, msg.rows, msg.cols);
      break;
    case "terminate_process":
      handleTerminate(msg);
      break;
    case "destroy":
      handleDestroy(msg);
      break;
    case "resolve_exec_response": {
      const resolve = pendingExecResolves.get(msg.requestId);
      if (resolve) {
        pendingExecResolves.delete(msg.requestId);
        resolve(msg.programBytes);
      }
      break;
    }
  }
});
