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
import { CAPTURED_STDIO, CentralizedKernelWorker } from "../src/kernel-worker";
import { resolveBinary } from "../src/binary-resolver";
import { NodePlatformIO } from "../src/platform/node";
import { NodeWorkerAdapter } from "../src/worker-adapter";
import { ThreadPageAllocator } from "../src/thread-allocator";
import { detectPtrWidth, extractHeapBase, PAGES_PER_THREAD, WASM_PAGE_SIZE } from "../src/constants";
import {
  computeProcessMemoryLayout,
  createProcessMemory,
  FORK_SAVE_BUFFER_SIZE,
  type ProcessMemoryLayout,
} from "../src/process-memory";
import { NodeKernelHost } from "../src/node-kernel-host";
import type { HostDiagnostic } from "../src/host-diagnostic";
import type { CentralizedWorkerInitMessage, CentralizedThreadInitMessage, WorkerToHostMessage } from "../src/worker-protocol";
import type { PlatformIO } from "../src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_PAGES = 16384;
const SIGSEGV = 11;
const CH_TOTAL_SIZE = 72 + 65536;

function createSharedProcessMemory(
  ptrWidth: 4 | 8,
  initialPages: number,
  maximumPages: number,
): WebAssembly.Memory {
  if (ptrWidth === 8) {
    return new WebAssembly.Memory({
      initial: BigInt(initialPages) as any,
      maximum: BigInt(maximumPages) as any,
      shared: true,
      address: "i64",
    } as any);
  }
  return new WebAssembly.Memory({
    initial: initialPages,
    maximum: maximumPages,
    shared: true,
  });
}

function threadAllocatorForLayout(
  layout: ProcessMemoryLayout,
  ptrWidth: 4 | 8,
  reserveSlotStartPage?: () => number,
): ThreadPageAllocator {
  return new ThreadPageAllocator({
    firstBasePage: layout.firstThreadBasePage,
    maxPageExclusive: layout.threadArenaEndPage,
    ptrWidth,
    reservedSlots: layout.threadSlotCount,
    reserveSlotStartPage,
  });
}

function createFreshProcessMemory(
  programBytes: ArrayBuffer,
  ptrWidth: 4 | 8,
  reserveSlotStartPage?: () => number,
): {
  memory: WebAssembly.Memory;
  layout: ProcessMemoryLayout;
  threadAllocator: ThreadPageAllocator;
} {
  const heapBase = extractHeapBase(programBytes);
  const layout = computeProcessMemoryLayout({
    maxPages: MAX_PAGES,
    ptrWidth,
    programBytes,
    heapBase,
  });
  const memory = createProcessMemory(ptrWidth, layout);
  new Uint8Array(memory.buffer, layout.channelOffset, CH_TOTAL_SIZE).fill(0);
  return {
    memory,
    layout,
    threadAllocator: threadAllocatorForLayout(layout, ptrWidth, reserveSlotStartPage),
  };
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
  /** Optional pre-compiled module for programPath. */
  programModule?: WebAssembly.Module;
  /** Environment variables as KEY=VALUE strings */
  env?: string[];
  /** Program arguments */
  argv?: string[];
  /** Timeout in ms (default: 30000) */
  timeout?: number;
  /** Custom PlatformIO (defaults to NodePlatformIO).
   *  When provided, forces main-thread mode (PlatformIO can't be serialized). */
  io?: PlatformIO;
  /** Attach `TcpNetworkBackend` inside the kernel worker_thread so wasm
   *  programs can dial external hosts via real Node sockets. Worker-thread
   *  mode only — incompatible with `io`. */
  enableTcpNetwork?: boolean;
  /** Map of virtual path → .wasm file path for exec targets */
  execPrograms?: Map<string, string>;
  /** Data to provide on stdin (process will see EOF after this data) */
  stdin?: string;
  /** Binary data to provide on stdin (alternative to stdin string) */
  stdinBytes?: Uint8Array;
  /** Callback invoked after the process starts.
   *  Use this to call appendStdinData() for interactive stdin testing. */
  onStarted?: (kernelProxy: KernelStdinProxy, pid: number) => void | Promise<void>;
  /** If `true`, the helper queries `kernel_get_fork_count(pid)` after the
   *  program exits and surfaces the value on `RunProgramResult.forkCount`.
   *  Used by the non-forking-spawn regression tests. Worker-thread mode
   *  only (NodeKernelHost.getForkCount); main-thread mode falls back to
   *  reading from the kernel instance directly. */
  captureForkCount?: boolean;
  /** Use the canonical rootfs image in worker-thread mode. Defaults to true. */
  useDefaultRootfs?: boolean;
  /** Exact VFS image for tests that stage package runtime files. Overrides
   * `useDefaultRootfs`; omitted means the canonical image. */
  rootfsImage?: "default" | ArrayBuffer | Uint8Array;
  /** Observe process lifecycle events emitted by NodeKernelHost. Worker-thread mode only. */
  onProcessEvent?: (event: {
    kind: "spawn" | "exec" | "exit";
    pid: number;
    ppid?: number;
    exitStatus?: number;
  }) => void;
}

export interface RunProgramResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Host-owned lifecycle/protocol diagnostics, never guest fd 2 bytes. */
  hostDiagnostics: HostDiagnostic[];
  /** Raw stdout bytes (for binary output like compressed data) */
  stdoutBytes: Uint8Array;
  /** Per-process fork counter for the spawned process, captured immediately
   *  before the kernel is destroyed. Only populated when
   *  `captureForkCount: true` is set on the run options. */
  forkCount?: bigint;
}

/**
 * Run a Wasm program using the shared-kernel architecture.
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
  const hostDiagnostics: HostDiagnostic[] = [];
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
  } else if (!options.onStarted) {
    stdinData = new Uint8Array();
  }

  // Default to mount-based VFS (rootfs.vfs at /, scratch dirs at /tmp etc.).
  // Tests that need raw host filesystem access opt out by passing
  // `io: new NodePlatformIO()` (which routes through `runOnMainThread` and
  // does not engage NodeKernelHost at all).
  const host = new NodeKernelHost({
    maxWorkers: 4,
    execPrograms,
    rootfsImage: options.rootfsImage
      ?? (options.useDefaultRootfs === false ? undefined : "default"),
    enableTcpNetwork: options.enableTcpNetwork,
    onStdout: (_pid: number, data: Uint8Array) => {
      stdout += new TextDecoder().decode(data);
      stdoutChunks.push(new Uint8Array(data));
    },
    onStderr: (_pid: number, data: Uint8Array) => {
      stderr += new TextDecoder().decode(data);
    },
    onHostDiagnostic: (diagnostic) => {
      hostDiagnostics.push(diagnostic);
    },
    onProcessEvent: options.onProcessEvent,
  });

  await host.init();

  // Capture the spawned pid so we can read kernel-side fork_count before
  // destroy. The user-supplied onStarted (if any) still runs.
  let capturedPid: number | undefined;
  const onStartedWrapper = (pid: number) => {
    capturedPid = pid;
    if (!options.onStarted) return;
    const proxy: KernelStdinProxy = {
      appendStdinData(stdinPid: number, data: Uint8Array) {
        host.appendStdinData(stdinPid, data);
      },
    };
    return options.onStarted(proxy, pid);
  };

  const exitPromise = host.spawn(programBytes, options.argv ?? [options.programPath], {
    env: options.env,
    stdin: stdinData,
    programModule: options.programModule,
    onStarted: onStartedWrapper,
  });

  // Race spawn exit against timeout
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Program timed out after ${timeout}ms`)),
      timeout,
    );
  });

  let exitCode: number;
  let forkCount: bigint | undefined;
  try {
    exitCode = await Promise.race([exitPromise, timeoutPromise]);
    if (options.captureForkCount && capturedPid !== undefined) {
      forkCount = await host.getForkCount(capturedPid);
    }
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    await host.destroy().catch(() => {});
  }

  const totalLen = stdoutChunks.reduce((sum, c) => sum + c.length, 0);
  const stdoutBytes = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of stdoutChunks) {
    stdoutBytes.set(chunk, offset);
    offset += chunk.length;
  }

  return { exitCode, stdout, stderr, hostDiagnostics, stdoutBytes, forkCount };
}

// ---------------------------------------------------------------------------
// Main-thread mode (fallback for custom PlatformIO)
// ---------------------------------------------------------------------------

interface ForkReplayContext {
  fnPtr: number;
  argPtr: number;
  forkBufAddr: number;
}

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

  const processProgramBytes = new Map<number, ArrayBuffer>();
  const processLayouts = new Map<number, ProcessMemoryLayout>();
  const threadAllocators = new Map<number, ThreadPageAllocator>();
  const processPtrWidths = new Map<number, 4 | 8>();
  const forkReplayContexts = new Map<number, ForkReplayContext>();
  let mainThreadForkCount: bigint | undefined;

  const pid = 100;

  const kernelWorker = new CentralizedKernelWorker(
    { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true, enableSyscallLog: !!process.env.KERNEL_SYSCALL_LOG },
    io,
    {
      onFork: async (parentPid, childPid, parentMemory, threadFork) => {
        const parentBuf = new Uint8Array(parentMemory.buffer);
        const parentPages = Math.ceil(parentBuf.byteLength / 65536);
        const childLayout = processLayouts.get(parentPid);
        if (!childLayout) throw new Error(`Unknown layout for parent pid ${parentPid}`);
        const parentPtrWidth = processPtrWidths.get(parentPid) ?? ptrWidth;
        const childMemory = createSharedProcessMemory(
          parentPtrWidth,
          parentPages,
          childLayout.maximumPages,
        );
        new Uint8Array(childMemory.buffer).set(parentBuf);

        const childChannelOffset = childLayout.channelOffset;
        new Uint8Array(childMemory.buffer, childChannelOffset, CH_TOTAL_SIZE).fill(0);

        kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], {
          skipKernelCreate: true,
          ptrWidth: parentPtrWidth,
          maxAddr: childLayout.maxAddr,
          mmapBase: childLayout.mmapBase,
        });
        kernelWorker.inheritProcessSharedMappings(parentPid, childPid);

        const FORK_BUF_SIZE = FORK_SAVE_BUFFER_SIZE;
        const forkReplayContext: ForkReplayContext | undefined = threadFork
          ? {
              fnPtr: threadFork.fnPtr,
              argPtr: threadFork.argPtr,
              forkBufAddr: threadFork.forkBufAddr,
            }
          : forkReplayContexts.get(parentPid);
        const forkBufAddr = forkReplayContext?.forkBufAddr ?? childChannelOffset - FORK_BUF_SIZE;

        const parentProgram = processProgramBytes.get(parentPid) ?? programBytes;

        const childInitData: CentralizedWorkerInitMessage = {
          type: "centralized_init",
          pid: childPid,
          ppid: parentPid,
          programBytes: parentProgram,
          memory: childMemory,
          channelOffset: childChannelOffset,
          isForkChild: true,
          forkBufAddr,
          forkChildThreadFnPtr: forkReplayContext?.fnPtr,
          forkChildThreadArgPtr: forkReplayContext?.argPtr,
          ptrWidth: parentPtrWidth,
        };

        const childWorker = workerAdapter.createWorker(childInitData);
        workers.set(childPid, childWorker);
        processProgramBytes.set(childPid, parentProgram);
        processLayouts.set(childPid, childLayout);
        threadAllocators.set(childPid, threadAllocatorForLayout(
          childLayout,
          parentPtrWidth,
          () => kernelWorker.reserveHostRegion(
            childPid,
            PAGES_PER_THREAD * WASM_PAGE_SIZE,
          ) / WASM_PAGE_SIZE,
        ));
        processPtrWidths.set(childPid, parentPtrWidth);
        if (forkReplayContext) forkReplayContexts.set(childPid, forkReplayContext);
        const finalizeChildWorkerError = (reason: unknown): void => {
          // Match the production hosts: an unexpected worker failure is a
          // signal-style process death, not an unregister that makes the
          // child disappear while its parent remains blocked in waitpid().
          // The worker identity guard also prevents a late event from an old
          // generation tearing down a replacement process after exec.
          if (workers.get(childPid) !== childWorker) return;
          const message = reason instanceof Error ? reason.message : String(reason);
          stderr += `[fork child ${childPid}] ${message}\n`;
          try { kernelWorker.notifyHostProcessCrashed(childPid, SIGSEGV); } catch { /* best-effort */ }
          try { kernelWorker.deactivateProcess(childPid); } catch { /* best-effort */ }
          workers.delete(childPid);
          processProgramBytes.delete(childPid);
          processLayouts.delete(childPid);
          threadAllocators.delete(childPid);
          processPtrWidths.delete(childPid);
          forkReplayContexts.delete(childPid);
          childWorker.terminate().catch(() => {});
        };
        childWorker.on("error", finalizeChildWorkerError);
        childWorker.on("message", (msg: unknown) => {
          const m = msg as WorkerToHostMessage;
          if (m.type === "error" && m.pid === childPid) {
            finalizeChildWorkerError(m.message);
          }
        });

        return [childChannelOffset];
      },
      onExec: async (execPid, path, argv, envp, callerTid) => {
        const wasmPath = options.execPrograms?.get(path);
        if (!wasmPath) return -2;
        if (!kernelWorker.supportsExecMetadataReplacement()) return -38;

        const newProgramBytes = loadProgramWasm(wasmPath);
        const newPtrWidth = detectPtrWidth(newProgramBytes);
        const sourcePtrWidth = processPtrWidths.get(execPid) ?? newPtrWidth;
        const metadataResult = kernelWorker.validateExecMetadata(argv, envp, sourcePtrWidth);
        if (metadataResult < 0) return metadataResult;

        const {
          memory: newMemory,
          layout: newLayout,
          threadAllocator: newThreadAllocator,
        } = createFreshProcessMemory(
          newProgramBytes,
          newPtrWidth,
          () => kernelWorker.reserveHostRegion(
            execPid,
            PAGES_PER_THREAD * WASM_PAGE_SIZE,
          ) / WASM_PAGE_SIZE,
        );
        const newChannelOffset = newLayout.channelOffset;

        const prepareResult = kernelWorker.kernelExecPrepare(execPid, callerTid);
        if (prepareResult < 0) return prepareResult;
        const addressSpaceResult = kernelWorker.prepareAddressSpaceForExec(execPid);
        if (addressSpaceResult < 0) return addressSpaceResult;
        let replacementWorker: ReturnType<NodeWorkerAdapter["createWorker"]> | undefined;
        try {
          const setupResult = kernelWorker.kernelExecSetup(execPid, callerTid);
          if (setupResult < 0) return setupResult;
          kernelWorker.prepareProcessForExec(execPid);

          const finalizeResult = kernelWorker.finalizeAddressSpaceForExec(execPid);
          if (finalizeResult < 0) {
            throw new Error("failed to detach the discarded address space");
          }

          const oldWorker = workers.get(execPid);
          if (oldWorker) {
            await oldWorker.terminate().catch(() => {});
            workers.delete(execPid);
          }
          if (kernelWorker.finalizeExecHandoffTermination(execPid) > 0) return 0;

          kernelWorker.registerProcess(execPid, newMemory, [newChannelOffset], {
            skipKernelCreate: true,
            ptrWidth: newPtrWidth,
            metadataPtrWidth: sourcePtrWidth,
            brkBase: newLayout.brkBase,
            mmapBase: newLayout.mmapBase,
            maxAddr: newLayout.maxAddr,
            argv,
            env: envp,
          });
          processProgramBytes.set(execPid, newProgramBytes);
          processLayouts.set(execPid, newLayout);
          threadAllocators.set(execPid, newThreadAllocator);
          processPtrWidths.set(execPid, newPtrWidth);
          forkReplayContexts.delete(execPid);

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

          replacementWorker = workerAdapter.createWorker(initData);
          workers.set(execPid, replacementWorker);
          replacementWorker.on("error", (err: Error) => {
            console.error(`[exec] worker error for pid ${execPid}:`, err);
          });
          kernelWorker.finishProcessExecHandoff(execPid);
          return 0;
        } catch (err) {
          try { kernelWorker.prepareProcessForExec(execPid); } catch { /* best-effort */ }
          if (replacementWorker && workers.get(execPid) !== replacementWorker) {
            await replacementWorker.terminate().catch(() => {});
          }
          const currentWorker = workers.get(execPid);
          if (currentWorker) {
            await currentWorker.terminate().catch(() => {});
            workers.delete(execPid);
          }
          try { kernelWorker.notifyHostProcessCrashed(execPid, SIGSEGV); } catch { /* best-effort */ }
          try { kernelWorker.deactivateProcess(execPid); } catch { /* best-effort */ }
          processProgramBytes.delete(execPid);
          processLayouts.delete(execPid);
          threadAllocators.delete(execPid);
          processPtrWidths.delete(execPid);
          forkReplayContexts.delete(execPid);
          const message = err instanceof Error ? err.message : String(err);
          stderr += `[exec] post-commit transition failed: ${message}\n`;
          if (execPid === pid) resolveExit(128 + SIGSEGV);
          return 0;
        }
      },
      onClone: async (clonePid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory) => {
        const threadAllocator = threadAllocators.get(clonePid);
        if (!threadAllocator) throw new Error(`Unknown thread allocator for pid ${clonePid}`);
        const clonePtrWidth = processPtrWidths.get(clonePid) ?? ptrWidth;
        const processChannelOffset = processLayouts.get(clonePid)?.channelOffset;
        if (processChannelOffset === undefined) {
          throw new Error(`Unknown process channel for pid ${clonePid}`);
        }
        const alloc = threadAllocator.allocate(memory);
        try {
          kernelWorker.addChannel(clonePid, alloc.channelOffset, tid, fnPtr, argPtr, memory);
        } catch (err) {
          threadAllocator.free(alloc.basePage);
          throw err;
        }

        const threadInitData: CentralizedThreadInitMessage = {
          type: "centralized_thread_init",
          pid: clonePid,
          tid,
          programBytes: processProgramBytes.get(clonePid) ?? programBytes,
          memory,
          processChannelOffset,
          channelOffset: alloc.channelOffset,
          fnPtr,
          argPtr,
          stackPtr,
          tlsPtr,
          ctidPtr,
          tlsOffset: alloc.tlsOffset,
          tlsAllocAddr: alloc.tlsAllocAddr,
          ptrWidth: clonePtrWidth,
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
          if (options.captureForkCount) {
            mainThreadForkCount = kernelWorker.getForkCount(exitPid);
          }
          kernelWorker.unregisterProcess(exitPid);
          processProgramBytes.delete(exitPid);
          processLayouts.delete(exitPid);
          threadAllocators.delete(exitPid);
          processPtrWidths.delete(exitPid);
          forkReplayContexts.delete(exitPid);
          const w = workers.get(exitPid);
          if (w) {
            w.terminate().catch(() => {});
            workers.delete(exitPid);
          }
          resolveExit(exitStatus);
        } else {
          kernelWorker.deactivateProcess(exitPid);
          processProgramBytes.delete(exitPid);
          processLayouts.delete(exitPid);
          threadAllocators.delete(exitPid);
          processPtrWidths.delete(exitPid);
          forkReplayContexts.delete(exitPid);
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

  const {
    memory,
    layout,
    threadAllocator,
  } = createFreshProcessMemory(
    programBytes,
    ptrWidth,
    () => kernelWorker.reserveHostRegion(
      pid,
      PAGES_PER_THREAD * WASM_PAGE_SIZE,
    ) / WASM_PAGE_SIZE,
  );
  const channelOffset = layout.channelOffset;

  kernelWorker.registerProcess(pid, memory, [channelOffset], {
    ptrWidth,
    brkBase: layout.brkBase,
    mmapBase: layout.mmapBase,
    maxAddr: layout.maxAddr,
    stdio: CAPTURED_STDIO,
  });
  processProgramBytes.set(pid, programBytes);
  processLayouts.set(pid, layout);
  threadAllocators.set(pid, threadAllocator);
  processPtrWidths.set(pid, ptrWidth);

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

  return {
    exitCode,
    stdout,
    stderr,
    hostDiagnostics: [],
    stdoutBytes,
    forkCount: mainThreadForkCount,
  };
}
