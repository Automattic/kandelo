/**
 * Test helper for running Wasm programs via CentralizedKernelWorker.
 *
 * By default, runs the kernel in a dedicated worker_thread via NodeKernelHost
 * for optimal performance. Falls back to main-thread mode when a custom
 * PlatformIO is provided (PlatformIO can't be serialized across threads).
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import { resolveBinary } from "../src/binary-resolver";
import { NodePlatformIO } from "../src/platform/node";
import { NodeWorkerAdapter } from "../src/worker-adapter";
import { ThreadPageAllocator } from "../src/thread-allocator";
import { detectPtrWidth } from "../src/constants";
import { NodeKernelHost } from "../src/node-kernel-host";
import type { CentralizedWorkerInitMessage, CentralizedThreadInitMessage, WorkerToHostMessage } from "../src/worker-protocol";
import type { PlatformIO } from "../src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_PAGES = 16384;
const CH_TOTAL_SIZE = 72 + 65536;

/** Create a WebAssembly.Memory of the right type (memory32 or memory64) */
function createProcessMemory(ptrWidth: 4 | 8, initialPages: number = 17): WebAssembly.Memory {
  if (ptrWidth === 8) {
    return new WebAssembly.Memory({
      initial: BigInt(initialPages) as any,
      maximum: BigInt(MAX_PAGES) as any,
      shared: true,
      address: "i64",
    } as any);
  }
  return new WebAssembly.Memory({
    initial: initialPages,
    maximum: MAX_PAGES,
    shared: true,
  });
}

/** Grow process memory to max pages */
function growToMax(memory: WebAssembly.Memory, ptrWidth: 4 | 8, currentPages: number): void {
  const pagesToGrow = MAX_PAGES - currentPages;
  if (pagesToGrow > 0) {
    if (ptrWidth === 8) {
      memory.grow(BigInt(pagesToGrow) as any);
    } else {
      memory.grow(pagesToGrow);
    }
  }
}

function loadKernelWasm(): ArrayBuffer {
  const buf = readFileSync(resolveBinary("kernel.wasm"));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function loadProgramWasm(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Proxy for sending stdin data to the kernel when it runs in a worker_thread */
export interface KernelStdinProxy {
  appendStdinData(pid: number, data: Uint8Array): void;
}

export interface RunProgramOptions {
  /** Path to the .wasm program file */
  programPath: string;
  /** Environment variables as KEY=VALUE strings */
  env?: string[];
  /** Program arguments */
  argv?: string[];
  /** Timeout in ms (default: 30000) */
  timeout?: number;
  /** Custom PlatformIO (defaults to NodePlatformIO).
   *  When provided, forces main-thread mode (PlatformIO can't be serialized). */
  io?: PlatformIO;
  /** Map of virtual path → .wasm file path for exec targets */
  execPrograms?: Map<string, string>;
  /** Data to provide on stdin (process will see EOF after this data) */
  stdin?: string;
  /** Binary data to provide on stdin (alternative to stdin string) */
  stdinBytes?: Uint8Array;
  /** Callback invoked after the process starts.
   *  Use this to call appendStdinData() for interactive stdin testing. */
  onStarted?: (kernelProxy: KernelStdinProxy, pid: number) => void | Promise<void>;
}

export interface RunProgramResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Raw stdout bytes (for binary output like compressed data) */
  stdoutBytes: Uint8Array;
}

/**
 * Run a Wasm program using the centralized kernel architecture.
 *
 * By default, spawns the kernel in a dedicated worker_thread for optimal
 * syscall throughput. Falls back to main-thread mode when `options.io` is
 * provided (custom PlatformIO instances can't be serialized across threads).
 */
export async function runCentralizedProgram(
  options: RunProgramOptions,
): Promise<RunProgramResult> {
  if (options.io) {
    return runOnMainThread(options);
  }
  return runInWorkerThread(options);
}

// ---------------------------------------------------------------------------
// Worker-thread mode (default, fast path) — uses NodeKernelHost
// ---------------------------------------------------------------------------

async function runInWorkerThread(options: RunProgramOptions): Promise<RunProgramResult> {
  const programBytes = loadProgramWasm(options.programPath);
  const timeout = options.timeout ?? 30_000;

  let stdout = "";
  let stderr = "";
  const stdoutChunks: Uint8Array[] = [];

  // Convert execPrograms Map to plain object for the worker
  let execPrograms: Record<string, string> | undefined;
  if (options.execPrograms) {
    execPrograms = {};
    for (const [k, v] of options.execPrograms) {
      execPrograms[k] = v;
    }
  }

  // Prepare stdin
  let stdinData: Uint8Array | undefined;
  if (options.stdinBytes != null) {
    stdinData = options.stdinBytes;
  } else if (options.stdin != null) {
    stdinData = new TextEncoder().encode(options.stdin);
  }

  const host = new NodeKernelHost({
    maxWorkers: 4,
    execPrograms,
    onStdout: (_pid: number, data: Uint8Array) => {
      stdout += new TextDecoder().decode(data);
      stdoutChunks.push(new Uint8Array(data));
    },
    onStderr: (_pid: number, data: Uint8Array) => {
      stderr += new TextDecoder().decode(data);
    },
  });

  await host.init();

  const exitPromise = host.spawn(programBytes, options.argv ?? [options.programPath], {
    env: options.env,
    stdin: stdinData,
    onStarted: options.onStarted
      ? async (pid: number) => {
          const proxy: KernelStdinProxy = {
            appendStdinData(stdinPid: number, data: Uint8Array) {
              host.appendStdinData(stdinPid, data);
            },
          };
          await options.onStarted!(proxy, pid);
        }
      : undefined,
  });

  // Race spawn exit against timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Program timed out after ${timeout}ms`)), timeout);
  });

  let exitCode: number;
  try {
    exitCode = await Promise.race([exitPromise, timeoutPromise]);
  } finally {
    await host.destroy().catch(() => {});
  }

  const totalLen = stdoutChunks.reduce((sum, c) => sum + c.length, 0);
  const stdoutBytes = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of stdoutChunks) {
    stdoutBytes.set(chunk, offset);
    offset += chunk.length;
  }

  return { exitCode, stdout, stderr, stdoutBytes };
}

// ---------------------------------------------------------------------------
// Main-thread mode (fallback for custom PlatformIO)
// ---------------------------------------------------------------------------

async function runOnMainThread(options: RunProgramOptions): Promise<RunProgramResult> {
  const kernelWasmBytes = loadKernelWasm();
  const programBytes = loadProgramWasm(options.programPath);
  const timeout = options.timeout ?? 30_000;
  const ptrWidth = detectPtrWidth(programBytes);

  let stdout = "";
  let stderr = "";
  const stdoutChunks: Uint8Array[] = [];
  const workers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();

  const io = options.io ?? new NodePlatformIO();
  const workerAdapter = new NodeWorkerAdapter();

  let resolveExit: (status: number) => void;
  let rejectExit: (err: Error) => void;
  const exitPromise = new Promise<number>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });

  const threadAllocator = new ThreadPageAllocator(MAX_PAGES);
  const processProgramBytes = new Map<number, ArrayBuffer>();

  const pid = 100;

  const kernelWorker = new CentralizedKernelWorker(
    { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true, enableSyscallLog: !!process.env.KERNEL_SYSCALL_LOG },
    io,
    {
      onFork: async (parentPid, childPid, parentMemory) => {
        const parentBuf = new Uint8Array(parentMemory.buffer);
        const parentPages = Math.ceil(parentBuf.byteLength / 65536);
        const childMemory = createProcessMemory(ptrWidth, parentPages);
        growToMax(childMemory, ptrWidth, parentPages);
        new Uint8Array(childMemory.buffer).set(parentBuf);

        const childChannelOffset = (MAX_PAGES - 2) * 65536;
        new Uint8Array(childMemory.buffer, childChannelOffset, CH_TOTAL_SIZE).fill(0);

        kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], { skipKernelCreate: true, ptrWidth });

        const ASYNCIFY_BUF_SIZE = 16384;
        const asyncifyBufAddr = childChannelOffset - ASYNCIFY_BUF_SIZE;

        const parentProgram = processProgramBytes.get(parentPid) ?? programBytes;

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
        };

        const childWorker = workerAdapter.createWorker(childInitData);
        workers.set(childPid, childWorker);
        processProgramBytes.set(childPid, parentProgram);
        childWorker.on("error", (err: Error) => {
          kernelWorker.unregisterProcess(childPid);
          workers.delete(childPid);
        });

        return [childChannelOffset];
      },
      onExec: async (execPid, path, argv, envp) => {
        const wasmPath = options.execPrograms?.get(path);
        if (!wasmPath) return -2;

        const newProgramBytes = loadProgramWasm(wasmPath);
        const newPtrWidth = detectPtrWidth(newProgramBytes);

        const setupResult = kernelWorker.kernelExecSetup(execPid);
        if (setupResult < 0) return setupResult;

        kernelWorker.prepareProcessForExec(execPid);

        const oldWorker = workers.get(execPid);
        if (oldWorker) {
          await oldWorker.terminate().catch(() => {});
          workers.delete(execPid);
        }

        const newMemory = createProcessMemory(newPtrWidth);
        const newChannelOffset = (MAX_PAGES - 2) * 65536;
        growToMax(newMemory, newPtrWidth, 17);
        new Uint8Array(newMemory.buffer, newChannelOffset, CH_TOTAL_SIZE).fill(0);

        kernelWorker.registerProcess(execPid, newMemory, [newChannelOffset], { skipKernelCreate: true, ptrWidth: newPtrWidth });
        processProgramBytes.set(execPid, newProgramBytes);

        const initData: CentralizedWorkerInitMessage = {
          type: "centralized_init",
          pid: execPid,
          ppid: 0,
          programBytes: newProgramBytes,
          memory: newMemory,
          channelOffset: newChannelOffset,
          argv,
          env: envp,
          ptrWidth: newPtrWidth,
        };

        const newWorker = workerAdapter.createWorker(initData);
        workers.set(execPid, newWorker);
        newWorker.on("error", (err: Error) => {
          console.error(`[exec] worker error for pid ${execPid}:`, err);
        });

        return 0;
      },
      onClone: async (clonePid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory) => {
        const alloc = threadAllocator.allocate(memory);
        kernelWorker.addChannel(clonePid, alloc.channelOffset, tid);

        const threadInitData: CentralizedThreadInitMessage = {
          type: "centralized_thread_init",
          pid: clonePid,
          tid,
          programBytes,
          memory,
          channelOffset: alloc.channelOffset,
          fnPtr,
          argPtr,
          stackPtr,
          tlsPtr,
          ctidPtr,
          tlsAllocAddr: alloc.tlsAllocAddr,
          ptrWidth,
        };

        const threadWorker = workerAdapter.createWorker(threadInitData);
        threadWorker.on("message", (msg: unknown) => {
          const m = msg as WorkerToHostMessage;
          if (m.type === "thread_exit") {
            threadAllocator.free(alloc.basePage);
            threadWorker.terminate().catch(() => {});
          }
        });
        threadWorker.on("error", () => {
          kernelWorker.notifyThreadExit(clonePid, tid);
          kernelWorker.removeChannel(clonePid, alloc.channelOffset);
          threadAllocator.free(alloc.basePage);
        });

        return tid;
      },
      onExit: (exitPid, exitStatus) => {
        if (exitPid === pid) {
          kernelWorker.unregisterProcess(exitPid);
          processProgramBytes.delete(exitPid);
          const w = workers.get(exitPid);
          if (w) {
            w.terminate().catch(() => {});
            workers.delete(exitPid);
          }
          resolveExit(exitStatus);
        } else {
          kernelWorker.deactivateProcess(exitPid);
          processProgramBytes.delete(exitPid);
          const w = workers.get(exitPid);
          if (w) {
            w.terminate().catch(() => {});
            workers.delete(exitPid);
          }
        }
      },
    },
  );

  kernelWorker.setOutputCallbacks({
    onStdout: (data: Uint8Array) => {
      stdout += new TextDecoder().decode(data);
      stdoutChunks.push(new Uint8Array(data));
    },
    onStderr: (data: Uint8Array) => {
      stderr += new TextDecoder().decode(data);
    },
  });

  await kernelWorker.init(kernelWasmBytes);

  const memory = createProcessMemory(ptrWidth);
  const channelOffset = (MAX_PAGES - 2) * 65536;
  growToMax(memory, ptrWidth, 17);
  new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

  kernelWorker.registerProcess(pid, memory, [channelOffset], { ptrWidth });

  if (options.stdinBytes != null) {
    kernelWorker.setStdinData(pid, options.stdinBytes);
  } else if (options.stdin != null) {
    kernelWorker.setStdinData(pid, new TextEncoder().encode(options.stdin));
  }

  const initData: CentralizedWorkerInitMessage = {
    type: "centralized_init",
    pid,
    ppid: 0,
    programBytes,
    memory,
    channelOffset,
    env: options.env,
    argv: options.argv ?? [options.programPath],
    ptrWidth,
  };

  const mainWorker = workerAdapter.createWorker(initData);
  workers.set(pid, mainWorker);

  if (options.onStarted) {
    await options.onStarted(kernelWorker, pid);
  }

  const timer = setTimeout(() => {
    for (const [, w] of workers) w.terminate().catch(() => {});
    rejectExit(new Error(`Program timed out after ${timeout}ms`));
  }, timeout);

  mainWorker.on("error", (err: Error) => {
    clearTimeout(timer);
    rejectExit(err);
  });

  // The worker posts {type:"error"} from its top-level catch (e.g. ABI
  // mismatch, instantiate failure). Without a handler here the test would
  // wait for an "exit" message that's never coming and look like a 5s/30s
  // timeout instead of surfacing the real error. Reject the exit promise
  // so the failure shows the kernel's diagnostic verbatim.
  mainWorker.on("message", (msg: unknown) => {
    const m = msg as WorkerToHostMessage;
    if (m.type === "error" && m.pid === pid) {
      clearTimeout(timer);
      for (const [, w] of workers) w.terminate().catch(() => {});
      rejectExit(new Error(m.message));
    }
  });

  const exitCode = await exitPromise;
  clearTimeout(timer);

  const totalLen = stdoutChunks.reduce((sum, c) => sum + c.length, 0);
  const stdoutBytes = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of stdoutChunks) {
    stdoutBytes.set(chunk, offset);
    offset += chunk.length;
  }

  return { exitCode, stdout, stderr, stdoutBytes };
}
