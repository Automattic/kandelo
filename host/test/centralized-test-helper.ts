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
import type { CentralizedWorkerInitMessage, WorkerToHostMessage } from "../src/worker-protocol";
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
  let mainWorker: ReturnType<NodeWorkerAdapter["createWorker"]> | null = null;

  const io = options.io ?? new NodePlatformIO();
  const workerAdapter = new NodeWorkerAdapter();

  // Promise that resolves when the main process exits (via onExit callback)
  let resolveExit: (status: number) => void;
  let rejectExit: (err: Error) => void;
  const exitPromise = new Promise<number>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });

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

        const childInitData: CentralizedWorkerInitMessage = {
          type: "centralized_init",
          pid: childPid,
          ppid: parentPid,
          programBytes,
          memory: childMemory,
          channelOffset: childChannelOffset,
        };

        const childWorker = workerAdapter.createWorker(childInitData);
        childWorker.on("error", () => {
          kernelWorker.unregisterProcess(childPid);
        });

        return [childChannelOffset];
      },
      onExec: async () => -38, // ENOSYS
      onExit: (pid, exitStatus) => {
        kernelWorker.unregisterProcess(pid);
        if (pid === 1) {
          // Main process exited — terminate the Worker (stuck in _exit loop)
          if (mainWorker) {
            mainWorker.terminate().catch(() => {});
          }
          resolveExit(exitStatus);
        }
      },
    },
  );

  // Inject stdout/stderr capture callbacks into the kernel's internal instance.
  // WasmPosixKernel handles fd 1/2 via callbacks, not PlatformIO.write().
  (kernelWorker as any).kernel.callbacks = {
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

  mainWorker = workerAdapter.createWorker(initData);

  // Set up timeout
  const timer = setTimeout(() => {
    if (mainWorker) mainWorker.terminate().catch(() => {});
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
