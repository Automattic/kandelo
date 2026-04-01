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
import type { CentralizedWorkerInitMessage, CentralizedThreadInitMessage, WorkerToHostMessage } from "../src/worker-protocol";
import type { PlatformIO } from "../src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_PAGES = 16384;
const CH_TOTAL_SIZE = 40 + 65536;

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
  /** Callback invoked with the kernel worker after the process starts.
   *  Use this to call appendStdinData() for interactive stdin testing. */
  onStarted?: (kernelWorker: CentralizedKernelWorker, pid: number) => void | Promise<void>;
}

export interface RunProgramResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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

  let stdout = "";
  let stderr = "";
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
  let nextThreadChannelPage = MAX_PAGES - 4; // main channel is at MAX_PAGES - 2

  const kernelWorker = new CentralizedKernelWorker(
    { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
    io,
    {
      onFork: async (parentPid, childPid, parentMemory) => {
        const parentBuf = new Uint8Array(parentMemory.buffer);
        const parentPages = Math.ceil(parentBuf.byteLength / 65536);
        const childMemory = new WebAssembly.Memory({
          initial: parentPages,
          maximum: MAX_PAGES,
          shared: true,
        });
        if (parentPages < MAX_PAGES) {
          childMemory.grow(MAX_PAGES - parentPages);
        }
        new Uint8Array(childMemory.buffer).set(parentBuf);

        const childChannelOffset = (MAX_PAGES - 2) * 65536;
        new Uint8Array(childMemory.buffer, childChannelOffset, CH_TOTAL_SIZE).fill(0);

        kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], { skipKernelCreate: true });

        // The asyncify fork data buffer lives at channelOffset - 16384 in the
        // parent's memory.  Since we copied parentMemory into childMemory and both
        // use the same channelOffset, the asyncify data is ready for the child to
        // rewind from the fork point.
        const ASYNCIFY_BUF_SIZE = 16384;
        const asyncifyBufAddr = childChannelOffset - ASYNCIFY_BUF_SIZE;

        const childInitData: CentralizedWorkerInitMessage = {
          type: "centralized_init",
          pid: childPid,
          ppid: parentPid,
          programBytes,
          memory: childMemory,
          channelOffset: childChannelOffset,
          isForkChild: true,
          asyncifyBufAddr,
        };

        const childWorker = workerAdapter.createWorker(childInitData);
        workers.set(childPid, childWorker);
        childWorker.on("error", () => {
          kernelWorker.unregisterProcess(childPid);
          workers.delete(childPid);
        });

        return [childChannelOffset];
      },
      onExec: async (pid, path, argv, envp) => {
        const wasmPath = options.execPrograms?.get(path);
        if (!wasmPath) return -2; // ENOENT

        const newProgramBytes = loadProgramWasm(wasmPath);

        // Terminate old worker
        const oldWorker = workers.get(pid);
        if (oldWorker) {
          await oldWorker.terminate().catch(() => {});
          workers.delete(pid);
        }

        // Create fresh memory for the new program
        const newMemory = new WebAssembly.Memory({
          initial: 17,
          maximum: MAX_PAGES,
          shared: true,
        });
        const newChannelOffset = (MAX_PAGES - 2) * 65536;
        newMemory.grow(MAX_PAGES - 17);
        new Uint8Array(newMemory.buffer, newChannelOffset, CH_TOTAL_SIZE).fill(0);

        // Register new process with same pid (kernel process table already cleaned by exec_setup)
        kernelWorker.registerProcess(pid, newMemory, [newChannelOffset], { skipKernelCreate: true });

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
        };

        const newWorker = workerAdapter.createWorker(initData);
        workers.set(pid, newWorker);
        newWorker.on("error", (err: Error) => {
          console.error(`[exec] worker error for pid ${pid}:`, err);
        });

        return 0;
      },
      onClone: async (pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory) => {
        // Allocate channel + TLS from pre-allocated memory (counting down from main channel)
        // 3 pages: 2 for channel (header + 64KB data) + 1 for Wasm TLS
        const threadChannelOffset = nextThreadChannelPage * 65536;
        const tlsAllocAddr = (nextThreadChannelPage - 2) * 65536;
        nextThreadChannelPage -= 3;
        new Uint8Array(memory.buffer, threadChannelOffset, CH_TOTAL_SIZE).fill(0);
        new Uint8Array(memory.buffer, tlsAllocAddr, 65536).fill(0);

        // Register thread channel with kernel worker
        kernelWorker.addChannel(pid, threadChannelOffset, tid);

        // Spawn thread worker
        const threadInitData: CentralizedThreadInitMessage = {
          type: "centralized_thread_init",
          pid,
          tid,
          programBytes,
          memory,
          channelOffset: threadChannelOffset,
          fnPtr,
          argPtr,
          stackPtr,
          tlsPtr,
          ctidPtr,
          tlsAllocAddr,
        };

        const threadWorker = workerAdapter.createWorker(threadInitData);
        threadWorker.on("message", (msg: unknown) => {
          const m = msg as WorkerToHostMessage;
          if (m.type === "thread_exit") {
            threadWorker.terminate().catch(() => {});
          }
        });
        threadWorker.on("error", () => {
          kernelWorker.notifyThreadExit(pid, tid);
          kernelWorker.removeChannel(pid, threadChannelOffset);
        });

        return tid;
      },
      onExit: (pid, exitStatus) => {
        if (pid === 1) {
          // Main process exited — full cleanup
          kernelWorker.unregisterProcess(pid);
          const w = workers.get(pid);
          if (w) {
            w.terminate().catch(() => {});
            workers.delete(pid);
          }
          resolveExit(exitStatus);
        } else {
          // Child process exited — deactivate channels but keep in kernel
          // process table as zombie until reaped by wait/waitpid
          kernelWorker.deactivateProcess(pid);
          const w = workers.get(pid);
          if (w) {
            w.terminate().catch(() => {});
            workers.delete(pid);
          }
        }
      },
    },
  );

  // Inject stdout/stderr capture callbacks into the kernel's internal instance.
  // WasmPosixKernel handles fd 1/2 via callbacks, not PlatformIO.write().
  // Merge with existing callbacks to preserve onAlarm, onPosixTimer, onNetListen.
  const existingCallbacks = (kernelWorker as any).kernel.callbacks || {};
  (kernelWorker as any).kernel.callbacks = {
    ...existingCallbacks,
    onStdout: (data: Uint8Array) => {
      stdout += new TextDecoder().decode(data);
    },
    onStderr: (data: Uint8Array) => {
      stderr += new TextDecoder().decode(data);
    },
  };

  await kernelWorker.init(kernelWasmBytes);

  // Create shared memory for the process
  const memory = new WebAssembly.Memory({
    initial: 17,
    maximum: MAX_PAGES,
    shared: true,
  });
  const channelOffset = (MAX_PAGES - 2) * 65536;
  memory.grow(MAX_PAGES - 17);
  new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

  const pid = 1;
  kernelWorker.registerProcess(pid, memory, [channelOffset]);

  // Provide stdin data if specified
  if (options.stdin != null) {
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

  return { exitCode, stdout, stderr };
}
