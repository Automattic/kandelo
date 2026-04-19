/**
 * Test helper for running Wasm programs via CentralizedKernelWorker.
 *
 * Replaces the WasmPosixKernel + ProgramRunner pattern for tests that need
 * to run programs in centralized mode.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";
import { NodeWorkerAdapter } from "../src/worker-adapter";
import { ThreadPageAllocator } from "../src/thread-allocator";
import { detectPtrWidth } from "../src/constants";
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
  const buf = readFileSync(join(__dirname, "../wasm/wasm_posix_kernel.wasm"));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function loadProgramWasm(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
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
  /** Custom PlatformIO (defaults to NodePlatformIO) */
  io?: PlatformIO;
  /** Map of virtual path → .wasm file path for exec targets */
  execPrograms?: Map<string, string>;
  /** Data to provide on stdin (process will see EOF after this data) */
  stdin?: string;
  /** Binary data to provide on stdin (alternative to stdin string) */
  stdinBytes?: Uint8Array;
  /** Callback invoked with the kernel worker after the process starts.
   *  Use this to call appendStdinData() for interactive stdin testing. */
  onStarted?: (kernelWorker: CentralizedKernelWorker, pid: number) => void | Promise<void>;
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
 * Creates a CentralizedKernelWorker, spawns a Worker thread for the program,
 * and captures stdout/stderr output.
 *
 * Exit detection: uses the onExit kernel callback, NOT Worker "exit" messages.
 * When musl calls _exit(), it loops on SYS_EXIT via channel IPC, so the Worker
 * never naturally reaches its postMessage("exit") call. The kernel detects
 * SYS_EXIT and fires onExit, then we terminate the Worker.
 *
 * Stdout capture: WasmPosixKernel handles fd 1/2 via onStdout/onStderr
 * callbacks, not through PlatformIO.write(). We pass these callbacks through
 * the CentralizedKernelWorker's internal kernel instance.
 */
export async function runCentralizedProgram(
  options: RunProgramOptions,
): Promise<RunProgramResult> {
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

  // Promise that resolves when the main process exits (via onExit callback)
  let resolveExit: (status: number) => void;
  let rejectExit: (err: Error) => void;
  const exitPromise = new Promise<number>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });

  // Thread channel allocator: count down from main channel
  const threadAllocator = new ThreadPageAllocator(MAX_PAGES);

  // Track program bytes per pid for fork-after-exec support
  const processProgramBytes = new Map<number, ArrayBuffer>();

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

        // The asyncify fork data buffer lives at channelOffset - 16384 in the
        // parent's memory.  Since we copied parentMemory into childMemory and both
        // use the same channelOffset, the asyncify data is ready for the child to
        // rewind from the fork point.
        const ASYNCIFY_BUF_SIZE = 16384;
        const asyncifyBufAddr = childChannelOffset - ASYNCIFY_BUF_SIZE;

        // Use per-pid program bytes if available (fork-after-exec), else initial program
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
      onExec: async (pid, path, argv, envp) => {
        const wasmPath = options.execPrograms?.get(path);
        if (!wasmPath) return -2; // ENOENT

        const newProgramBytes = loadProgramWasm(wasmPath);
        const newPtrWidth = detectPtrWidth(newProgramBytes);

        // Run kernel exec setup (close CLOEXEC fds, reset signals, set has_exec)
        const setupResult = kernelWorker.kernelExecSetup(pid);
        if (setupResult < 0) return setupResult;

        // Prepare process for replacement (remove old channels, clean up pending retries)
        kernelWorker.prepareProcessForExec(pid);

        // Terminate old worker
        const oldWorker = workers.get(pid);
        if (oldWorker) {
          await oldWorker.terminate().catch(() => {});
          workers.delete(pid);
        }

        // Create fresh memory for the new program
        const newMemory = createProcessMemory(newPtrWidth);
        const newChannelOffset = (MAX_PAGES - 2) * 65536;
        growToMax(newMemory, newPtrWidth, 17);
        new Uint8Array(newMemory.buffer, newChannelOffset, CH_TOTAL_SIZE).fill(0);

        // Register new process with same pid
        kernelWorker.registerProcess(pid, newMemory, [newChannelOffset], { skipKernelCreate: true, ptrWidth: newPtrWidth });

        // Track new program bytes for this pid (for fork-after-exec)
        processProgramBytes.set(pid, newProgramBytes);

        // Create new worker
        const initData: CentralizedWorkerInitMessage = {
          type: "centralized_init",
          pid,
          ppid: 0,
          programBytes: newProgramBytes,
          memory: newMemory,
          channelOffset: newChannelOffset,
          argv,
          env: envp,
          ptrWidth: newPtrWidth,
        };

        const newWorker = workerAdapter.createWorker(initData);
        workers.set(pid, newWorker);
        newWorker.on("error", () => {
        });

        return 0;
      },
      onClone: async (pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory) => {
        // Allocate channel + TLS from pre-allocated memory (counting down from main channel)
        const alloc = threadAllocator.allocate(memory);

        // Register thread channel with kernel worker
        kernelWorker.addChannel(pid, alloc.channelOffset, tid);

        // Spawn thread worker
        const threadInitData: CentralizedThreadInitMessage = {
          type: "centralized_thread_init",
          pid,
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
          kernelWorker.notifyThreadExit(pid, tid);
          kernelWorker.removeChannel(pid, alloc.channelOffset);
          threadAllocator.free(alloc.basePage);
        });

        return tid;
      },
      onExit: (exitPid, exitStatus) => {
        if (exitPid === pid) {
          // Main process exited — full cleanup
          kernelWorker.unregisterProcess(exitPid);
          processProgramBytes.delete(exitPid);
          const w = workers.get(exitPid);
          if (w) {
            w.terminate().catch(() => {});
            workers.delete(exitPid);
          }
          resolveExit(exitStatus);
        } else {
          // Child process exited — deactivate channels but keep in kernel
          // process table as zombie until reaped by wait/waitpid
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

  // Capture stdout/stderr via the public API (merges with existing callbacks).
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

  // Create shared memory for the process (memory64 for wasm64 programs)
  const memory = createProcessMemory(ptrWidth);
  const channelOffset = (MAX_PAGES - 2) * 65536;
  growToMax(memory, ptrWidth, 17);
  new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

  const pid = 100;
  kernelWorker.registerProcess(pid, memory, [channelOffset], { ptrWidth });

  // Provide stdin data if specified
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

  // Fire onStarted callback (for interactive stdin tests)
  if (options.onStarted) {
    await options.onStarted(kernelWorker, pid);
  }

  // Set up timeout
  const timer = setTimeout(() => {
    for (const [, w] of workers) w.terminate().catch(() => {});
    rejectExit(new Error(`Program timed out after ${timeout}ms`));
  }, timeout);

  // Worker error handler
  mainWorker.on("error", (err: Error) => {
    clearTimeout(timer);
    rejectExit(err);
  });

  const exitCode = await exitPromise;
  clearTimeout(timer);

  // Concatenate stdout chunks into a single Uint8Array
  const totalLen = stdoutChunks.reduce((sum, c) => sum + c.length, 0);
  const stdoutBytes = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of stdoutChunks) {
    stdoutBytes.set(chunk, offset);
    offset += chunk.length;
  }

  return { exitCode, stdout, stderr, stdoutBytes };
}
