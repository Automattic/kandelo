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
 *   Worker → Main: ready, response, exit, stdout, stderr, host_diagnostic,
 *                  pty_output, resolve_exec, lazy_download
 */
import { parentPort } from "node:worker_threads";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPTURED_STDIO,
  CentralizedKernelWorker,
  isCurrentProcessGeneration,
  TERMINAL_STDIO,
} from "./kernel-worker";
import type {
  ForkContinuationContext,
  ResolvedSpawnProgram,
  SpawnProgramResolution,
  ThreadChannelAttachment,
} from "./kernel-worker";
import { NodePlatformIO } from "./platform/node";
import {
  VirtualPlatformIO,
  NodeTimeProvider,
  DEFAULT_MOUNT_SPEC,
  DeviceFileSystem,
  ensureMountParentDirectories,
  HostFileSystem,
  MemoryFileSystem,
  readPreparedPlatformFile,
} from "./vfs";
import { resolveForNodeKernelSession } from "./vfs/default-mounts-node";
import type { MountConfig } from "./vfs/types";
import type { MountSpec } from "./vfs/default-mounts";
import {
  createClosedLazyAssetFetcherFromOwnedAssets,
  createClosedLazyAssetSourceFetcher,
} from "./vfs/closed-lazy-assets";
import { resolveLazyUrl } from "./vfs/lazy-url";
import { prepareHomebrewFlatLazyBoot } from "./homebrew-flat-lazy-boot";
import { TcpNetworkBackend } from "./networking/tcp-backend";
import { findRepoRoot } from "./binary-resolver";
import { NodeWorkerAdapter } from "./worker-adapter";
import { DeferredWorkerHandle } from "./deferred-worker-handle";
import { ThreadPageAllocator } from "./thread-allocator";
import { patchWasmForThread } from "./worker-main";
import { ThreadExitCoordinator } from "./thread-exit-coordinator";
import {
  describeWasmArtifactPolicyFailures,
  detectPtrWidth,
  extractAbiVersion,
  extractHeapBase,
  isWasmModuleBytes,
} from "./constants";
import { CH_TOTAL_SIZE, DEFAULT_MAX_PAGES, PAGES_PER_THREAD, WASM_PAGE_SIZE } from "./constants";
import {
  classifiedSignalOrFallback,
  classifiedTrapExitStatus,
  signalExitStatus,
  SIGSEGV,
} from "./trap-signals";
import {
  removeThreadWorkerRegistryEntry,
  threadWorkerFailureDisposition,
} from "./thread-worker-disposition";
import { VmInterruptTimerManager } from "./vm-interrupt-timer";
import {
  createWorkerQuiescence,
  type WorkerQuiescence,
  waitForExecRetirement,
  waitForWorkerQuiescence,
} from "./worker-quiescence";
import { RootfsSnapshotGate } from "./rootfs-snapshot-gate";
import {
  ForkReplayGateCoordinator,
  observeForkReplayWorker,
} from "./fork-replay-gate";
import { ForkExternrefProcessOwner } from "./fork-externref-process-owner";
import type { ForkExternrefGeneration } from "./fork-reference-broker";
import {
  ForkHostImportOwnerRuntime,
  type ForkHostImportOwnerWorker,
} from "./fork-host-import-runtime";
import {
  acquireForkMemoryClone,
  computeProcessMemoryLayout,
  createProcessMemoryRetirementPressureHook,
  DEFAULT_PROCESS_THREAD_SLOTS,
  deriveProcessMemoryRetirementAdmissionThresholds,
  ProcessMemoryCapacityError,
  ProcessMemoryAllocator,
  ProcessMemoryRetirementBacklogError,
  type ProcessMemoryLayout,
  type ProcessMemoryLease,
} from "./process-memory";
import {
  ExactProcessGenerationDetachLedger,
  type ExactProcessGenerationDetachResult,
} from "./process-generation-detach";
import { ProcessMemoryCreatorGate } from "./process-memory-creator-gate";
import type { PlatformIO } from "./types";
import type {
  CentralizedWorkerInitMessage,
  CentralizedThreadInitMessage,
  WorkerToHostMessage,
} from "./worker-protocol";
import type {
  HostDiagnostic,
  MainToKernelMessage,
  KernelToMainMessage,
  InitMessage,
  SpawnMessage,
  TerminateProcessMessage,
  HttpRequestMessage,
} from "./node-kernel-protocol";
import { kernelRealmDestroyResult } from "./kernel-realm-destroy";

if (!parentPort) {
  throw new Error("node-kernel-worker-entry must run in a worker_thread");
}

const port = parentPort;

// --- State ---

let kernelWorker: CentralizedKernelWorker;
let workerAdapter: NodeWorkerAdapter;
let maxPages: number = DEFAULT_MAX_PAGES;
let defaultThreadSlots: number = DEFAULT_PROCESS_THREAD_SLOTS;
let processMemoryAllocator: ProcessMemoryAllocator;
const reclamationMeasurementPressure = (() => {
  const configured = process.env.KANDELO_RECLAIM_PRESSURE_BYTES;
  if (configured === undefined) return undefined;
  if (process.env.KANDELO_RECLAIM_MEASUREMENT !== "1") {
    throw new Error(
      "KANDELO_RECLAIM_PRESSURE_BYTES is restricted to the reclamation " +
        "measurement harness",
    );
  }
  const bytes = Number(configured);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`invalid KANDELO_RECLAIM_PRESSURE_BYTES: ${configured}`);
  }
  return bytes;
})();
// WHY: 4 MiB is the measured default. Repeated zero-byte controls on current
// Node engines sometimes retained history-proportional RSS and sometimes
// collected it in a later large step; enabled runs reclaimed consistently in
// the same harness. Keep this internal: it is an engine nudge, not a
// user-facing memory ownership or collection guarantee. See
// docs/measurements/2026-07-28-process-memory-retirement-rss.md.
const processMemoryRetirementPressureHook =
  createProcessMemoryRetirementPressureHook(reclamationMeasurementPressure);
let execPrograms: Record<string, string> = {};
let vfsExecIO: PlatformIO | null = null;
let rootfsMemfs: MemoryFileSystem | null = null;
let initReady = false;
let kernelFatalReported = false;
/** Per-boot scratch directory; cleaned up on `destroy`. Only set when the
 *  worker constructs a `VirtualPlatformIO` from the default mount spec. */
let sessionDir: string | null = null;
const ENOEXEC = 8;
// [JSC-TERMINATE-ATOMICS-WAIT-LEAK] destroy-time drain bounds; see handleDestroy.
const DESTROY_KILL_DRAIN_TIMEOUT_MS = 1500;
const DESTROY_KILL_DRAIN_POLL_MS = 15;
const PROCESS_WORKER_QUIESCENCE_WAIT_MS = 100;
const EXEC_WORKER_RETIREMENT_WAIT_MS = 5_000;

// Process tracking
interface ForkReplayContext {
  fnPtr: number;
  argPtr: number;
  forkBufAddr: number;
}

interface ProcessGenerationOwnership {
  memory: WebAssembly.Memory;
  memoryLease: ProcessMemoryLease;
}

interface ProcessInfo extends ProcessGenerationOwnership {
  workerQuiescence: WorkerQuiescence;
  execRetirement: WorkerQuiescence;
  programBytes: ArrayBuffer;
  programModule?: WebAssembly.Module;
  worker: ReturnType<NodeWorkerAdapter["createWorker"]>;
  channelOffset: number;
  ptrWidth: 4 | 8;
  layout: ProcessMemoryLayout;
  threadAllocator: ThreadPageAllocator;
  /** Exact broker authority for this PID's current Wasm image. */
  externrefGeneration: ForkExternrefGeneration;
  /** Non-_start continuation root inherited from a pthread fork until exec. */
  forkReplayContext?: ForkReplayContext;
}
const processes = new Map<number, ProcessInfo>();
const externrefProcessOwner = new ForkExternrefProcessOwner();
const forkHostImportOwnerRuntime =
  new ForkHostImportOwnerRuntime(externrefProcessOwner);
const forkHostImportsByWorker =
  new WeakMap<object, ForkHostImportOwnerWorker>();
const processTeardowns = new Map<ProcessInfo["worker"], Promise<void>>();
const vmInterruptTimers = new VmInterruptTimerManager<ProcessInfo>((pid) =>
  processes.get(pid),
);
const reportedExits = new Set<number>();
const rootfsSnapshotGate = new RootfsSnapshotGate();
const processMemoryCreators = new ProcessMemoryCreatorGate();

// Workers terminated by the kernel-worker entry itself (handleExit /
// handleExec / handleTerminate). The crash safety-net listener checks
// this set so it doesn't fire for our own teardown calls.
const intentionallyTerminated = new WeakSet<object>();

/**
 * Install a safety-net 'exit' listener on a process worker. If the wasm
 * worker_thread exits unexpectedly (e.g. an uncaught wasm trap that
 * bypasses the SYS_exit_group path), no kernel-side exit handler runs and
 * the host's spawn promise would hang waiting for an exit notification
 * that never comes. This listener detects that case — when the worker we
 * registered here is *still* the one bound to `pid` in `processes` and we
 * didn't terminate it ourselves — and synthesizes a SIGSEGV crash exit
 * so the host learns the process is gone. There is no reliable trap
 * reason on this path, so it keeps the generic 128+SIGSEGV convention.
 */
function installCrashSafetyNet(
  worker: ReturnType<NodeWorkerAdapter["createWorker"]>,
  pid: number,
): void {
  worker.on("exit", (code: number) => {
    if (intentionallyTerminated.has(worker as object)) return;
    const cur = processes.get(pid);
    if (!cur || cur.worker !== worker) return; // already torn down or replaced
    // WHY: a cooperative SYS_exit_group starts teardown before the Worker
    // realm closes, but the Worker can finish naturally before our teardown
    // calls terminate(). Remaining registered during that interval is
    // intentional; diagnosing the normal close as a crash races the exact
    // quiescence fence and emits a false SIGSEGV report.
    if (processTeardowns.has(worker)) return;
    const status = signalExitStatus(SIGSEGV);
    reportHostDiagnostic({
      pid,
      status,
      source: "worker exit event",
      message:
        `[process-worker] pid=${pid} crashed ` +
        `(worker exit code=${code}, no SYS_exit_group from wasm)`,
    });
    void finalizeProcessWorker(pid, worker, status, SIGSEGV);
  });
}

function installProcessWorkerListeners(
  worker: ReturnType<NodeWorkerAdapter["createWorker"]>,
  pid: number,
  errorLabel = "worker error",
): void {
  worker.on("error", (error: Error) =>
    finalizeUnexpectedWorkerError(pid, worker, errorLabel, error),
  );
  worker.on("message", (raw: unknown) => {
    const process = processes.get(pid);
    if (!process || process.worker !== worker) return;
    const message = raw as WorkerToHostMessage;
    if (
      message.type === "memory_quiescent" &&
      message.pid === pid &&
      message.tid === undefined
    ) {
      process.workerQuiescence.settle();
      return;
    }
    if (
      message.type === "exec_retired" &&
      message.pid === pid &&
      message.tid === undefined
    ) {
      process.execRetirement.settle();
      return;
    }
    if (message.type === "error" && message.pid === pid) {
      finalizeProcessWorkerError(pid, worker, message.message);
    } else if (message.type === "exit" && message.pid === pid) {
      void finalizeProcessWorker(pid, worker, message.status ?? 0);
    } else if (message.type === "vm_interrupt_timer" && message.pid === pid) {
      handleVmInterruptTimer(message, pid, process);
    } else if (message.type === "fork_host_import") {
      dispatchForkHostImport(worker, message);
    }
  });
  installCrashSafetyNet(worker, pid);
}

// Per-PID thread module cache: lazily compiled on first clone()
const threadModuleCache = new Map<number, WebAssembly.Module>();

// Thread workers per-PID for cleanup
interface ThreadWorkerInfo {
  worker: ReturnType<NodeWorkerAdapter["createWorker"]>;
  channelOffset: number;
  tid: number;
  basePage: number;
  workerQuiescence: WorkerQuiescence;
  execRetirement: WorkerQuiescence;
  termination?: Promise<void>;
}
const threadWorkers = new Map<number, ThreadWorkerInfo[]>();
const threadExits = new ThreadExitCoordinator();

async function terminateTrackedWorker(
  worker: ReturnType<NodeWorkerAdapter["createWorker"]>,
): Promise<void> {
  intentionallyTerminated.add(worker as object);
  forkHostImportsByWorker.get(worker as object)?.close();
  await worker.terminate().catch(() => {});
}

function bindForkHostImports(
  worker: ReturnType<NodeWorkerAdapter["createWorker"]>,
  owner: ForkHostImportOwnerWorker,
): void {
  forkHostImportsByWorker.set(worker as object, owner);
}

function dispatchForkHostImport(
  worker: ReturnType<NodeWorkerAdapter["createWorker"]>,
  message: Extract<WorkerToHostMessage, { type: "fork_host_import" }>,
): void {
  const owner = forkHostImportsByWorker.get(worker as object);
  if (!owner || !owner.dispatch(message.wake)) {
    reportHostDiagnostic({
      pid: message.wake.pid,
      source: "fork host-import protocol",
      message:
        `[kernel-worker] ignored stale or unbound fork host-import wake `
        + `pid=${message.wake.pid} sender=${message.wake.senderId}`,
    }, "warn");
  }
}

async function terminateThreadWorkers(
  pid: number,
  requireExecRetirement = false,
): Promise<boolean> {
  const threads = threadWorkers.get(pid);
  if (!threads) return true;
  threadWorkers.delete(pid);
  const quiescence = await Promise.all(
    threads.map((thread) =>
      requireExecRetirement
        ? waitForExecRetirement(
            thread.execRetirement,
            thread.workerQuiescence,
            EXEC_WORKER_RETIREMENT_WAIT_MS,
          )
        : waitForWorkerQuiescence(
            thread.workerQuiescence,
            PROCESS_WORKER_QUIESCENCE_WAIT_MS,
          ),
    ),
  );
  for (const thread of threads) {
    intentionallyTerminated.add(thread.worker as object);
  }
  for (const t of threads) {
    await (t.termination ?? terminateTrackedWorker(t.worker));
    threadExits.release(pid, t.channelOffset);
  }
  return quiescence.every(Boolean);
}

function reportProcessExit(pid: number, status: number): void {
  if (reportedExits.has(pid)) return;
  reportedExits.add(pid);
  post({ type: "exit", pid, status });
}

function handleVmInterruptTimer(
  msg: {
    pid: number;
    timedOutPtr: number;
    vmInterruptPtr: number;
    seconds: number;
  },
  pid: number,
  process: ProcessInfo,
): void {
  if (msg.pid !== pid) return;
  vmInterruptTimers.handleRequest(pid, process, msg);
}

function signalFromExitStatus(exitStatus: number): number | null {
  return exitStatus >= 128 ? (exitStatus - 128) & 0x7f : null;
}

// PTY index per-PID
const ptyByPid = new Map<number, number>();

const processGenerationDetaches =
  new ExactProcessGenerationDetachLedger<ProcessGenerationOwnership>(
    (pid) => processes.get(pid),
    (pid, exactGeneration) => {
      const current = processes.get(pid);
      if (current !== exactGeneration) return;
      vmInterruptTimers.clear(pid, current);
      processes.delete(pid);
      threadModuleCache.delete(pid);
      ptyByPid.delete(pid);
    },
  );

async function detachExactProcessGeneration(options: {
  pid: number;
  generation: ProcessGenerationOwnership;
  operation: "deactivate" | "unregister" | "none";
  retire: (commit: () => void) => void | Promise<void>;
}): Promise<ExactProcessGenerationDetachResult> {
  const { pid, generation, operation, retire } = options;
  const result = await processGenerationDetaches.detach({
    pid,
    generation,
    memory: generation.memory,
    detach: () => {
      if (operation === "none") return true;
      if (operation === "deactivate") {
        return kernelWorker.deactivateProcess(pid, generation.memory);
      }
      return kernelWorker.unregisterProcess(pid, generation.memory);
    },
    settle: () => {
      if (operation === "none") return;
      return kernelWorker.settleRetiredChannelListeners(pid, generation.memory);
    },
    retire,
  });
  if (result.status === "released" && "postCommitError" in result) {
    try {
      reportHostDiagnostic({
        pid,
        source: "process memory retirement",
        message:
          `[node-kernel-worker] pid ${pid} retired its exact process memory ` +
          `before a cleanup callback failed: ${
            result.postCommitError instanceof Error
              ? result.postCommitError.message
              : String(result.postCommitError)
          }`,
      });
    } catch {
      // Ownership is already committed; a closed diagnostic port cannot turn
      // this into a retry that would consume the lease twice.
    }
  }
  return result;
}

function reportRetainedProcessGeneration(
  pid: number,
  source: string,
  result: Extract<
    ExactProcessGenerationDetachResult,
    { status: "retained-error" }
  >,
  status?: number,
): void {
  const reason =
    result.error instanceof Error ? result.error.message : String(result.error);
  try {
    reportHostDiagnostic({
      pid,
      source,
      ...(status === undefined ? {} : { status }),
      message:
        `[node-kernel-worker] retained pid ${pid}'s exact process memory: ` +
        reason,
    });
  } catch {
    // WHY: the transaction remains in the retry ledger. A closed diagnostic
    // port must not replace the lifecycle error or discard retry authority.
  }
}

// Exec resolution: request ID → resolver
let execResolveId = 0;
const pendingExecResolves = new Map<
  number,
  (bytes: ArrayBuffer | null) => void
>();

// --- Helpers ---

/**
 * Turn an unexpected process-Worker failure into an authoritative signal
 * death, then use the same generation-aware teardown as an ordinary exit.
 *
 * Called from BOTH the `{type:"exit"}` and `{type:"error"}` message
 * handlers below: previously only `exit` ran the cleanup, so a
 * worker that died via `{type:"error"}` (uncaught wasm trap,
 * instantiation failure) left `kernelWorker` with the process still
 * registered. Any concurrent `waitpid` in the parent then hung
 * forever because the kernel never saw the child go zombie.
 *
 * Idempotent: guarded by `cur && cur.worker === worker` so a later
 * `worker.on("exit")` from `installCrashSafetyNet` is a no-op.
 */
async function finalizeProcessWorker(
  pid: number,
  worker: ReturnType<NodeWorkerAdapter["createWorker"]>,
  exitStatus: number,
  crashSignum: number = signalFromExitStatus(exitStatus) ?? SIGSEGV,
): Promise<void> {
  if (intentionallyTerminated.has(worker as object)) return;
  const cur = processes.get(pid);
  if (!cur || cur.worker !== worker) return;

  // A kernel-side exit callback may already be draining this exact Worker
  // generation. Its teardown deliberately keeps channels registered until
  // every backing Worker is gone, so a trailing worker-main exit/error event
  // must not race in here and deactivate the pid early. The browser entry
  // funnels the same events through finishProcessExit(), whose teardown-map
  // guard provides this ordering directly.
  if (processTeardowns.has(worker)) {
    reportProcessExit(pid, exitStatus);
    return;
  }
  // Synthesize a signal-style death before shared teardown in
  // case the worker died without sending SYS_EXIT_GROUP (uncaught
  // wasm trap, instantiation failure → `{type:"error"}` path).
  // Without this, a concurrent waitpid in the parent blocks until
  // destroy because the kernel never marked the child as a zombie.
  // Idempotent via `hostReaped`: when the kernel already processed
  // a clean SYS_EXIT_GROUP for this pid, this is a no-op.
  try {
    kernelWorker.notifyHostProcessCrashed(pid, crashSignum);
  } catch {
    /* best-effort */
  }

  // WHY: ordinary exits and crashes must share one teardown funnel. Keeping a
  // second cleanup sequence here previously let their Worker/channel ordering
  // drift and made it possible to reap Rust state before all Workers stopped.
  await finishProcessExit(pid, exitStatus, worker);
}

function processWorkerErrorDisposition(reason: string | undefined): {
  exitStatus: number;
  signum: number;
} {
  return {
    exitStatus: classifiedTrapExitStatus(reason) ?? -1,
    signum: classifiedSignalOrFallback(reason),
  };
}

function unexpectedWorkerCrashDisposition(reason: unknown): {
  exitStatus: number;
  signum: number;
} {
  const signum = classifiedSignalOrFallback(reason);
  return { exitStatus: signalExitStatus(signum), signum };
}

function finalizeProcessWorkerError(
  pid: number,
  worker: ReturnType<NodeWorkerAdapter["createWorker"]>,
  message: string | undefined,
): void {
  if (intentionallyTerminated.has(worker as object)) return;
  if (processes.get(pid)?.worker !== worker) return;
  const { exitStatus, signum } = processWorkerErrorDisposition(message);
  reportHostDiagnostic({
    pid,
    status: exitStatus,
    source: "worker-main error message",
    message: `[process-worker] ${message ?? "unknown error"}`,
  });
  void finalizeProcessWorker(pid, worker, exitStatus, signum);
}

function finalizeUnexpectedWorkerError(
  pid: number,
  worker: ReturnType<NodeWorkerAdapter["createWorker"]>,
  label: string,
  err: unknown,
): void {
  if (intentionallyTerminated.has(worker as object)) return;
  if (processes.get(pid)?.worker !== worker) return;
  const message =
    err instanceof Error ? (err.message ?? String(err)) : String(err);
  const { exitStatus, signum } = unexpectedWorkerCrashDisposition(err);
  reportHostDiagnostic({
    pid,
    status: exitStatus,
    source: label,
    message: `[kernel-worker] pid=${pid}: ${label}: ${message}`,
  });
  void finalizeProcessWorker(pid, worker, exitStatus, signum);
}

function post(msg: KernelToMainMessage) {
  port.postMessage(msg);
}

function reportHostDiagnostic(
  diagnostic: HostDiagnostic,
  level: "error" | "warn" = "error",
): void {
  if (level === "warn") console.warn(diagnostic.message);
  else console.error(diagnostic.message);
  post({ type: "host_diagnostic", ...diagnostic });
}

function terminatePoisonedKernelWorker(error: Error): void {
  if (kernelFatalReported) return;
  kernelFatalReported = true;
  const detail = error.stack
    ? `${error.message}\n${error.stack}`
    : error.message;
  try {
    try {
      reportHostDiagnostic({
        pid: 0,
        source: "kernel fatal",
        message: `[node-kernel-worker] fatal kernel instance failure: ${detail}`,
      });
    } catch (reportError) {
      console.error(
        "[node-kernel-worker] could not report fatal diagnostic:",
        reportError,
      );
    }
    try {
      post({ type: "kernel_fatal", error: detail });
    } catch (postError) {
      console.error(
        "[node-kernel-worker] could not post fatal state:",
        postError,
      );
    }
  } finally {
    // WHY: a trapped kernel export can strand Rust's global transfer
    // reservation in Executing state. Do not call back into that generation;
    // terminate its process workers directly and stop this worker thread.
    for (const info of processes.values()) {
      intentionallyTerminated.add(info.worker as object);
      void info.worker.terminate().catch(() => {});
    }
    for (const threads of threadWorkers.values()) {
      for (const thread of threads) {
        intentionallyTerminated.add(thread.worker as object);
        void thread.worker.terminate().catch(() => {});
      }
    }
    cleanupSessionDir();
    queueMicrotask(() => process.exit(1));
  }
}

function reportWorkerProtocolError(message: string): void {
  reportHostDiagnostic({
    pid: 0,
    source: "worker protocol",
    message: `[node-kernel-worker] ${message}`,
  });
}

function respond(requestId: number, result: unknown) {
  post({ type: "response", requestId, result });
}

function respondTransferredBytes(requestId: number, result: Uint8Array) {
  port.postMessage(
    { type: "response", requestId, result } satisfies KernelToMainMessage,
    [result.buffer as ArrayBuffer],
  );
}

function respondError(requestId: number, error: string) {
  post({ type: "response", requestId, result: null, error });
}

function threadAllocatorForLayout(
  layout: ProcessMemoryLayout,
  ptrWidth: 4 | 8,
  pid: number,
): ThreadPageAllocator {
  return new ThreadPageAllocator({
    firstSlotStartPage: layout.firstThreadSlotPage,
    maxPageExclusive: layout.threadArenaEndPage,
    ptrWidth,
    reservedSlots: layout.threadSlotCount,
    reserveSlotStartPage: () =>
      kernelWorker.reserveHostRegion(pid, PAGES_PER_THREAD * WASM_PAGE_SIZE) /
      WASM_PAGE_SIZE,
  });
}

async function createFreshProcessMemory(
  pid: number,
  programBytes: ArrayBuffer,
  ptrWidth: 4 | 8,
): Promise<{
  memory: WebAssembly.Memory;
  memoryLease: ProcessMemoryLease;
  layout: ProcessMemoryLayout;
  threadAllocator: ThreadPageAllocator;
}> {
  const heapBase = extractHeapBase(programBytes);
  const layout = computeProcessMemoryLayout({
    maxPages,
    defaultThreadSlots,
    ptrWidth,
    programBytes,
    heapBase,
  });
  const memoryLease = await processMemoryAllocator.acquireWhenAvailable({
    ptrWidth,
    initialPages: layout.initialPages,
    maximumPages: layout.maximumPages,
  });
  try {
    const memory = memoryLease.memory;
    new Uint8Array(memory.buffer, layout.channelOffset, CH_TOTAL_SIZE).fill(0);
    return {
      memory,
      memoryLease,
      layout,
      threadAllocator: threadAllocatorForLayout(layout, ptrWidth, pid),
    };
  } catch (error) {
    // No Worker or kernel registration can exist yet, so the lease still has
    // one owner and may be returned transactionally.
    memoryLease.release();
    throw error;
  }
}

function bufferToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function resolveExecLocal(path: string): ArrayBuffer | null {
  const mapped = execPrograms[path];
  if (mapped && existsSync(mapped)) {
    const bytes = readFileSync(mapped);
    return bufferToArrayBuffer(bytes);
  }
  return null;
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === -2 || code === "ENOENT";
}

async function readExecFromVfs(path: string): Promise<ArrayBuffer | null> {
  const io = vfsExecIO;
  if (!io) return null;
  try {
    const { data, stat } = await readPreparedPlatformFile(io, path);
    if ((stat.mode & 0o170000) === 0o040000) return null;
    return bufferToArrayBuffer(data);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

async function resolveExec(path: string): Promise<ArrayBuffer | null> {
  const local = resolveExecLocal(path);
  if (local) return local;

  const vfs = await readExecFromVfs(path);
  if (vfs) return vfs;

  // Ask main thread to resolve
  const requestId = ++execResolveId;
  return new Promise<ArrayBuffer | null>((resolve) => {
    pendingExecResolves.set(requestId, resolve);
    post({ type: "resolve_exec", requestId, path });
  });
}

const MAX_SHEBANG_DEPTH = 4;

function parseShebang(
  bytes: ArrayBuffer,
): { interpreter: string; arg?: string } | null {
  const view = new Uint8Array(bytes);
  if (view.length < 2 || view[0] !== 0x23 || view[1] !== 0x21) return null;
  let end = 2;
  while (end < view.length && view[end] !== 0x0a && end < 4096) end++;
  const line = new TextDecoder()
    .decode(view.subarray(2, end))
    .replace(/\r$/, "")
    .trim();
  if (!line) return null;
  const match = line.match(/^(\S+)(?:\s+(.*))?$/);
  if (!match) return null;
  return { interpreter: match[1], arg: match[2] };
}

async function resolveExecutableForLaunch(
  path: string,
  argv: string[],
  depth = 0,
): Promise<ResolvedSpawnProgram | { errno: number } | null> {
  if (depth > MAX_SHEBANG_DEPTH) return null;
  const bytes = await resolveExec(path);
  if (!bytes) return null;

  const shebang = parseShebang(bytes);
  if (!shebang) {
    if (!isWasmModuleBytes(bytes)) return { errno: ENOEXEC };
    const artifactFailures = describeWasmArtifactPolicyFailures(bytes, {
      expectedAbi: kernelWorker.getKernelAbiVersion(),
    });
    if (artifactFailures.length > 0) return { errno: ENOEXEC };
    let programModule: WebAssembly.Module;
    try {
      programModule = await WebAssembly.compile(bytes);
    } catch (error) {
      if (error instanceof WebAssembly.CompileError) return { errno: ENOEXEC };
      throw error;
    }
    const declaredAbi = extractAbiVersion(bytes);
    if (
      declaredAbi !== null &&
      declaredAbi !== kernelWorker.getKernelAbiVersion()
    ) {
      return { errno: ENOEXEC };
    }
    return { programBytes: bytes, programModule, argv };
  }

  const scriptArgv = [
    shebang.interpreter,
    ...(shebang.arg ? [shebang.arg] : []),
    path,
    ...argv.slice(1),
  ];
  return resolveExecutableForLaunch(shebang.interpreter, scriptArgv, depth + 1);
}

// --- Init ---

/**
 * Materialise the default mount spec into a `VirtualPlatformIO` backed by
 * the rootfs image at `/` and per-boot host-fs scratch dirs everywhere
 * else. The session dir is created once per boot and torn down by
 * `cleanupSessionDir` on `destroy`.
 */
async function buildVirtualPlatformIO(
  rootfsImage: ArrayBuffer,
  rootfsMountSpec?: MountSpec[],
  extraMounts?: Array<{
    mountPoint: string;
    hostPath: string;
    readonly?: boolean;
    uid?: number;
    gid?: number;
  }>,
  rootfsLazyUrlBase?: InitMessage["rootfsLazyUrlBase"],
  rootfsLazyAssets?: InitMessage["rootfsLazyAssets"],
  rootfsLazyAssetSources?: InitMessage["rootfsLazyAssetSources"],
): Promise<VirtualPlatformIO> {
  const bootSessionDir = mkdtempSync(join(tmpdir(), "wasm-posix-session-"));
  sessionDir = bootSessionDir;
  let specMounts: MountConfig[];
  try {
    specMounts = await resolveForNodeKernelSession(
      DEFAULT_MOUNT_SPEC,
      new Uint8Array(rootfsImage),
      bootSessionDir,
    );
  } catch (error) {
    // WHY: imported-seal rejection occurs before scratch setup, but the Node
    // worker already owns its per-boot session directory. Release that
    // ownership before surfacing the failed initialization.
    cleanupSessionDir();
    throw error;
  }
  const shmSab = new SharedArrayBuffer(16 * 1024 * 1024);
  const shmfs = MemoryFileSystem.create(shmSab);
  shmfs.chmod("/", 0o1777);
  const extras: MountConfig[] = (extraMounts ?? []).map((m) => ({
    mountPoint: m.mountPoint,
    backend: new HostFileSystem(m.hostPath, m.mountPoint, {
      uid: m.uid,
      gid: m.gid,
    }),
    readonly: m.readonly,
  }));
  const mounts = [
    { mountPoint: "/dev/shm", backend: shmfs },
    { mountPoint: "/dev", backend: new DeviceFileSystem() },
    ...specMounts,
    ...extras,
  ];
  const rootMount = mounts.find((m) => m.mountPoint === "/");
  rootfsMemfs =
    rootMount?.backend instanceof MemoryFileSystem ? rootMount.backend : null;
  if (rootfsMemfs) {
    ensureMountParentDirectories(
      rootfsMemfs,
      extras.map((m) => m.mountPoint),
    );
    if (rootfsLazyUrlBase !== undefined) {
      rootfsMemfs.rewriteLazyFileUrls((url) =>
        resolveLazyUrl(rootfsLazyUrlBase, url),
      );
      rootfsMemfs.rewriteLazyArchiveUrls((url) =>
        resolveLazyUrl(rootfsLazyUrlBase, url),
      );
    }
    rootfsMemfs.subscribeLazyDownloads((event) => {
      post({ type: "lazy_download", event });
    });
    const lazyFetcher =
      rootfsLazyAssets !== undefined
        ? createClosedLazyAssetFetcherFromOwnedAssets(rootfsLazyAssets)
        : rootfsLazyAssetSources !== undefined
          ? createClosedLazyAssetSourceFetcher(rootfsLazyAssetSources)
          : async (url: string) => {
              if (/^https?:\/\//.test(url)) return globalThis.fetch(url);
              const path = url.startsWith("file://")
                ? fileURLToPath(url)
                : join(findRepoRoot(), url.replace(/^\/+/, ""));
              if (!existsSync(path)) return new Response(null, { status: 404 });
              const bytes = new Uint8Array(readFileSync(path));
              return new Response(bytes, {
                status: 200,
                headers: { "content-length": String(bytes.byteLength) },
              });
            };
    rootfsMemfs.setLazyFetcher(lazyFetcher);
    await prepareHomebrewFlatLazyBoot(rootfsMemfs);
  }
  return new VirtualPlatformIO(mounts, new NodeTimeProvider());
}

function cleanupSessionDir(): void {
  if (sessionDir) {
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // best-effort: tests should still pass even if cleanup races a hold
    }
  }
  sessionDir = null;
  vfsExecIO = null;
  rootfsMemfs = null;
}

async function handleInit(msg: InitMessage) {
  initReady = false;
  maxPages = msg.config.maxPages ?? DEFAULT_MAX_PAGES;
  defaultThreadSlots =
    msg.config.defaultThreadSlots ?? DEFAULT_PROCESS_THREAD_SLOTS;
  processMemoryAllocator = new ProcessMemoryAllocator({
    maxMemories: Math.max(
      1,
      Math.floor(msg.config.maxProcessMemoryBytes / WASM_PAGE_SIZE),
    ),
    maxTotalBytes: msg.config.maxProcessMemoryBytes,
    ...deriveProcessMemoryRetirementAdmissionThresholds(
      msg.config.maxWorkers,
      msg.config.maxProcessMemoryBytes,
    ),
    retirementPressureHook: processMemoryRetirementPressureHook,
  });
  execPrograms = msg.execPrograms ?? {};
  workerAdapter = new NodeWorkerAdapter();

  const io: PlatformIO = msg.rootfsImage
    ? await buildVirtualPlatformIO(
        msg.rootfsImage,
        msg.rootfsMountSpec,
        msg.extraMounts,
        msg.rootfsLazyUrlBase,
        msg.rootfsLazyAssets,
        msg.rootfsLazyAssetSources,
      )
    : new NodePlatformIO();
  vfsExecIO = msg.rootfsImage ? io : null;
  if (msg.enableTcpNetwork) {
    io.network = new TcpNetworkBackend();
  }

  kernelWorker = new CentralizedKernelWorker(
    {
      maxWorkers: msg.config.maxWorkers,
      dataBufferSize: msg.config.dataBufferSize ?? 65536,
      useSharedMemory: msg.config.useSharedMemory ?? true,
      defaultThreadSlots,
      enableSyscallLog: !!process.env.KERNEL_SYSCALL_LOG,
    },
    io,
    {
      onProcessMemoryTarget: (memory, target) => {
        processMemoryAllocator.observeTarget(memory, target);
      },
      onKernelFatal: terminatePoisonedKernelWorker,
      onFork: ({ parentPid, childPid, parentMemory, continuation }) => {
        return processMemoryCreators.run("a fork process Worker", () => {
          // Notify the main thread of every kernel-side process event so
          // Inspector-style UIs (Kandelo) can refresh their process table
          // event-driven. Mirrors the browser-side worker entry.
          post({
            type: "proc_event",
            kind: "spawn",
            pid: childPid,
            ppid: parentPid,
          });
          return handleFork(parentPid, childPid, parentMemory, continuation);
        });
      },
      onExec: (pid, path, argv, envp, callerTid) =>
        processMemoryCreators.run("an exec process Worker", async () => {
          const previousWorker = processes.get(pid)?.worker;
          const result = await handleExec(pid, path, argv, envp, callerTid);
          // Notify after handleExec refreshes kernel-side Process.argv so
          // process-table consumers don't refetch stale command names. A
          // post-commit signal death also returns 0 because the old syscall
          // can no longer return; only emit exec when a replacement exists.
          const installedWorker = processes.get(pid)?.worker;
          if (
            result === 0 &&
            installedWorker &&
            installedWorker !== previousWorker &&
            kernelWorker.isProcessExecutionActive(pid)
          ) {
            post({ type: "proc_event", kind: "exec", pid });
          }
          return result;
        }),
      onResolveSpawn: handlePosixSpawnResolve,
      onSpawn: (parentPid, childPid, program, envp) =>
        processMemoryCreators.run("a posix_spawn process Worker", () =>
          handlePosixSpawn(parentPid, childPid, program, envp),
        ),
      onClone: (attachment) =>
        processMemoryCreators.run("a pthread Worker", () =>
          handleClone(attachment),
        ),
      onThreadExit: (pid, _tid, channelOffset) =>
        handleThreadExit(pid, channelOffset),
      onExit: handleExit,
    },
  );

  kernelWorker.setOutputCallbacks({
    onStdout: (data: Uint8Array) => {
      post({
        type: "stdout",
        pid: (kernelWorker as any).currentHandlePid || 0,
        data: new Uint8Array(data),
      });
    },
    onStderr: (data: Uint8Array) => {
      post({
        type: "stderr",
        pid: (kernelWorker as any).currentHandlePid || 0,
        data: new Uint8Array(data),
      });
    },
  });

  await kernelWorker.init(msg.kernelWasmBytes);

  initReady = true;
  post({ type: "ready" });
}

// --- Spawn ---

async function handleSpawn(msg: SpawnMessage) {
  let releaseMutation: (() => void) | undefined;
  let createdPid: number | undefined;
  let createdMemoryLease: ProcessMemoryLease | undefined;
  let createdMemoryRegistered = false;
  let workerCreationAttempted = false;
  let createdWorker: ProcessInfo["worker"] | undefined;
  let createdGeneration: ProcessInfo | undefined;
  let createdExternrefGeneration: ForkExternrefGeneration | undefined;
  let createdForkHostImports: ForkHostImportOwnerWorker | undefined;
  try {
    releaseMutation = rootfsSnapshotGate.beginMutation("spawn a process");
    const hasProgramBytes = msg.programBytes !== undefined;
    const hasProgramPath = msg.programPath !== undefined;
    if (hasProgramBytes === hasProgramPath) {
      respondError(
        msg.requestId,
        "spawn requires exactly one of programBytes or programPath",
      );
      return;
    }
    const programBytes =
      msg.programBytes ?? (await readExecFromVfs(msg.programPath!));
    const programModule = hasProgramBytes ? msg.programModule : undefined;
    if (programBytes === null) {
      respondError(msg.requestId, `ENOENT: ${msg.programPath}`);
      return;
    }
    if (!isWasmModuleBytes(programBytes)) {
      respondError(
        msg.requestId,
        "ENOEXEC: program is not a WebAssembly module",
      );
      return;
    }

    const pid = kernelWorker.createProcess(
      msg.pty ? TERMINAL_STDIO : CAPTURED_STDIO,
    );
    createdPid = pid;
    const ptrWidth = detectPtrWidth(programBytes);
    const { memory, memoryLease, layout, threadAllocator } =
      await createFreshProcessMemory(pid, programBytes, ptrWidth);
    createdMemoryLease = memoryLease;
    const channelOffset = layout.channelOffset;

    kernelWorker.registerProcess(pid, memory, [channelOffset], {
      ptrWidth,
      argv: msg.argv,
      env: msg.env ?? [],
      brkBase: layout.brkBase,
      mmapBase: layout.mmapBase,
      maxAddr: layout.maxAddr,
    });
    createdMemoryRegistered = true;

    kernelWorker.setCredentials(pid, { uid: msg.uid, gid: msg.gid });
    if (msg.cwd) {
      kernelWorker.setCwd(pid, msg.cwd);
    }

    if (msg.maxAddr != null) {
      kernelWorker.setMaxAddr(pid, msg.maxAddr);
    }

    if (msg.pty) {
      const ptyIdx = kernelWorker.setupPty(pid);
      ptyByPid.set(pid, ptyIdx);
      // Apply initial winsize before the wasm program starts. Without this,
      // the program's first TIOCGWINSZ returns the kernel default (80x24)
      // and TUI renderers (ink, blessed) cache the wrong width before the
      // post-spawn pty_resize lands, causing redraw corruption.
      if (msg.ptyCols != null && msg.ptyRows != null) {
        kernelWorker.ptySetWinsize(ptyIdx, msg.ptyRows, msg.ptyCols);
      }
      kernelWorker.onPtyOutput(ptyIdx, (data: Uint8Array) => {
        post({ type: "pty_output", pid, data });
      });
    } else {
      if (msg.stdin) {
        const stdinData =
          msg.stdin instanceof Uint8Array
            ? msg.stdin
            : new Uint8Array(msg.stdin);
        kernelWorker.setStdinData(pid, stdinData);
      }
    }

    const externrefGeneration = externrefProcessOwner.startGeneration(pid);
    createdExternrefGeneration = externrefGeneration;
    let worker: ReturnType<NodeWorkerAdapter["createWorker"]>;
    const forkHostImports = forkHostImportOwnerRuntime.createWorker({
      pid,
      generationId: externrefGeneration.id,
      authorizeSender: () => {
        const current = processes.get(pid);
        if (
          !current
          || current.worker !== worker
          || current.externrefGeneration !== externrefGeneration
        ) {
          throw new Error(`stale fork host-import sender for pid=${pid}`);
        }
      },
    });
    createdForkHostImports = forkHostImports;
    const initData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid,
      programBytes,
      programModule,
      memory,
      channelOffset,
      externrefGenerationId: externrefGeneration.id,
      forkHostImports: forkHostImports.init,
      env: msg.env,
      argv: msg.argv,
      ptrWidth,
      kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
    };

    // A constructor may expose Memory to a partially created Worker before it
    // throws, so any failure from this point uses forced retirement.
    workerCreationAttempted = true;
    worker = workerAdapter.createWorker(initData);
    createdWorker = worker;
    bindForkHostImports(worker, forkHostImports);
    createdGeneration = {
      memory,
      memoryLease,
      workerQuiescence: createWorkerQuiescence(),
      execRetirement: createWorkerQuiescence(),
      programBytes,
      programModule,
      worker,
      channelOffset,
      ptrWidth,
      layout,
      threadAllocator,
      externrefGeneration,
    };
    processes.set(pid, createdGeneration);

    installProcessWorkerListeners(worker, pid);
    createdMemoryLease = undefined;
    createdPid = undefined;
    createdExternrefGeneration = undefined;
    createdForkHostImports = undefined;

    respond(msg.requestId, pid);
  } catch (e) {
    createdForkHostImports?.close();
    if (createdExternrefGeneration) {
      externrefProcessOwner.releaseGeneration(createdExternrefGeneration);
    }
    if (createdPid !== undefined) {
      if (createdWorker) await terminateTrackedWorker(createdWorker);
      const lease = createdGeneration?.memoryLease ?? createdMemoryLease;
      if (lease) {
        const generation = createdGeneration ?? {
          memory: lease.memory,
          memoryLease: lease,
        };
        const detachResult = await detachExactProcessGeneration({
          pid: createdPid,
          generation,
          operation: createdMemoryRegistered ? "unregister" : "none",
          retire: (commit) => {
            if (workerCreationAttempted) {
              lease.releaseAfterForcedTermination();
            } else {
              lease.release();
            }
            commit();
          },
        });
        if (detachResult.status !== "released") {
          reportRetainedProcessGeneration(
            createdPid,
            "initial spawn rollback",
            detachResult,
          );
        }
      }
      if (!createdMemoryRegistered) {
        try {
          kernelWorker.removeProcessFromKernelTable(createdPid);
        } catch {
          // Preserve the original spawn failure in the response.
        }
      }
    }
    respondError(msg.requestId, String(e));
  } finally {
    releaseMutation?.();
  }
}

// --- Process lifecycle callbacks ---

async function handleFork(
  parentPid: number,
  childPid: number,
  parentMemory: WebAssembly.Memory,
  continuation: ForkContinuationContext,
): Promise<number[]> {
  const parentInfo = processes.get(parentPid);
  const parentProgram = parentInfo?.programBytes;
  if (!parentProgram || parentInfo.memory !== parentMemory) {
    throw new Error(`Unknown parent generation for pid ${parentPid}`);
  }

  const ptrWidth = parentInfo.ptrWidth;
  const childLayout = parentInfo.layout;
  // WHY: compilation below yields. A sibling exec may then retire the parent's
  // exact generation, so the committed fork must own its clone before the
  // first await.
  const childMemoryLease = acquireForkMemoryClone(
    processMemoryAllocator,
    parentMemory,
    ptrWidth,
    childLayout.maximumPages,
  );
  const childMemory = childMemoryLease.memory;
  const childChannelOffset = childLayout.channelOffset;
  let childWorker: DeferredWorkerHandle | undefined;
  let registered = false;
  let workerStartAttempted = false;
  let lifecycleTeardownStarted = false;
  let childGeneration: ProcessInfo | undefined;
  let childExternrefGeneration: ForkExternrefGeneration | undefined;
  let childForkHostImports: ForkHostImportOwnerWorker | undefined;
  const forkReplay = new ForkReplayGateCoordinator(
    `fork child pid=${childPid}`,
  );
  try {
    // The committed child already owns its exact syscall-time snapshot.
    // Delay only Worker launch while a short retirement burst drains.
    await processMemoryAllocator.waitForRetirementBacklogCapacity(
      childMemory.buffer.byteLength,
    );
    if (!parentInfo.programModule) {
      parentInfo.programModule = await WebAssembly.compile(parentProgram);
    }
    if (!kernelWorker.shouldLaunchPendingChild(childPid)) {
      childMemoryLease.release();
      return [];
    }

    new Uint8Array(childMemory.buffer, childChannelOffset, CH_TOTAL_SIZE).fill(
      0,
    );
    kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], {
      ptrWidth,
      maxAddr: childLayout.maxAddr,
      mmapBase: childLayout.mmapBase,
    });
    registered = true;
    kernelWorker.inheritProcessSharedMappings(parentPid, childPid);

    const activeForkBufAddr = continuation.forkBufAddr;
    const forkReplayContext: ForkReplayContext | undefined =
      continuation.kind === "thread"
        ? {
            fnPtr: continuation.fnPtr,
            argPtr: continuation.argPtr,
            forkBufAddr: activeForkBufAddr,
          }
        : parentInfo.forkReplayContext
          ? { ...parentInfo.forkReplayContext, forkBufAddr: activeForkBufAddr }
          : undefined;
    const forkBufAddr = activeForkBufAddr;
    const externrefGrant =
      externrefProcessOwner.forkGenerationFromContinuation(
        parentInfo.externrefGeneration,
        childPid,
        parentMemory,
        ptrWidth,
        forkBufAddr,
      );
    childExternrefGeneration = externrefGrant.generation;
    let launchedWorker: DeferredWorkerHandle;
    const forkHostImports = forkHostImportOwnerRuntime.createWorker({
      pid: childPid,
      generationId: externrefGrant.generation.id,
      authorizeSender: () => {
        const current = processes.get(childPid);
        if (
          !current
          || current.worker !== launchedWorker
          || current.externrefGeneration !== externrefGrant.generation
        ) {
          throw new Error(
            `stale fork host-import sender for child pid=${childPid}`,
          );
        }
      },
    });
    childForkHostImports = forkHostImports;
    const childInitData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid: childPid,
      programBytes: parentProgram,
      programModule: parentInfo.programModule,
      memory: childMemory,
      channelOffset: childChannelOffset,
      externrefGenerationId: externrefGrant.generation.id,
      forkHostImports: forkHostImports.init,
      isForkChild: true,
      forkBufAddr,
      forkReplayGate: forkReplay.gate,
      forkChildThreadFnPtr: forkReplayContext?.fnPtr,
      forkChildThreadArgPtr: forkReplayContext?.argPtr,
      ptrWidth,
      kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
    };

    childWorker = new DeferredWorkerHandle(() =>
      workerAdapter.createWorker(childInitData),
    );
    const worker = childWorker;
    launchedWorker = worker;
    bindForkHostImports(worker, forkHostImports);
    childGeneration = {
      memory: childMemory,
      memoryLease: childMemoryLease,
      workerQuiescence: createWorkerQuiescence(),
      execRetirement: createWorkerQuiescence(),
      programBytes: parentProgram,
      programModule: parentInfo.programModule,
      worker,
      channelOffset: childChannelOffset,
      ptrWidth,
      layout: childLayout,
      threadAllocator: threadAllocatorForLayout(
        childLayout,
        ptrWidth,
        childPid,
      ),
      forkReplayContext,
      externrefGeneration: externrefGrant.generation,
    };
    processes.set(childPid, childGeneration);

    observeForkReplayWorker(
      forkReplay,
      launchedWorker,
      childPid,
      () => processes.get(childPid)?.worker === launchedWorker,
    );
    installProcessWorkerListeners(worker, childPid);
    const startDisposition = kernelWorker.startProcessWorkerWhenRunnable(
      childPid,
      childMemory,
      () => {
        workerStartAttempted = true;
        worker.start();
      },
      () => {
        forkReplay.cancel(
          new Error(
            `Fork child ${childPid} launch was cancelled before replay readiness`,
          ),
        );
        forkHostImports.close();
        void launchedWorker.terminate();
      },
    );
    if (startDisposition === "stale") {
      throw new Error(
        `Fork child ${childPid} changed generation before Worker launch`,
      );
    }
    if (startDisposition === "dead") {
      forkReplay.cancel(
        new Error(`Fork child ${childPid} exited before Worker launch`),
      );
      forkHostImports.close();
      await terminateTrackedWorker(worker);
      processes.get(childPid)?.workerQuiescence.settle();
      const signal = kernelWorker.finalizePendingChildTermination(childPid);
      lifecycleTeardownStarted = true;
      await awaitFinalizedProcessTeardown(
        childPid,
        signal > 0 ? signalExitStatus(signal) : 0,
        worker,
      );
      return [];
    }
    await forkReplay.waitUntilReady();
    if (processes.get(childPid)?.worker !== launchedWorker) {
      throw new Error(
        `Fork child ${childPid} changed generation before replay commit`,
      );
    }
    if (!kernelWorker.shouldLaunchPendingChild(childPid)) {
      throw new Error(`Fork child ${childPid} exited before replay commit`);
    }
    // WHY: only this commit wakes the child inside the inherited fork import.
    // Resolve onFork afterward so the parent cannot observe a child whose
    // continuation has not proved it reached the copied activation.
    forkReplay.commit();
  } catch (error) {
    if (lifecycleTeardownStarted) throw error;
    forkReplay.cancel(error);
    childForkHostImports?.close();
    if (childWorker) await terminateTrackedWorker(childWorker);
    if (childExternrefGeneration) {
      externrefProcessOwner.releaseGeneration(childExternrefGeneration);
    }
    const generation = childGeneration ?? {
      memory: childMemory,
      memoryLease: childMemoryLease,
    };
    const detachResult = await detachExactProcessGeneration({
      pid: childPid,
      generation,
      operation: registered ? "deactivate" : "none",
      retire: (commit) => {
        if (workerStartAttempted) {
          childMemoryLease.releaseAfterForcedTermination();
        } else {
          childMemoryLease.release();
        }
        commit();
      },
    });
    if (detachResult.status !== "released") {
      reportRetainedProcessGeneration(childPid, "fork rollback", detachResult);
    }
    throw error;
  }

  return [childChannelOffset];
}

async function handleExec(
  pid: number,
  path: string,
  argv: string[],
  envp: string[],
  callerTid: number,
): Promise<number> {
  const initiatingInfo = processes.get(pid);
  if (!initiatingInfo) return -3; // ESRCH
  const resolved = await resolveExecutableForLaunch(path, argv);
  if (!resolved) return -2; // ENOENT
  if ("errno" in resolved) return -resolved.errno;
  const { programBytes, programModule, argv: launchArgv } = resolved;
  const newPtrWidth = detectPtrWidth(programBytes);
  const metadataResult = kernelWorker.validateExecMetadata(
    launchArgv,
    envp,
    initiatingInfo.ptrWidth,
  );
  if (metadataResult < 0) return metadataResult;
  let prepared: Awaited<ReturnType<typeof createFreshProcessMemory>>;
  try {
    prepared = await createFreshProcessMemory(pid, programBytes, newPtrWidth);
  } catch (error) {
    if (error instanceof ProcessMemoryRetirementBacklogError) return -11;
    if (error instanceof ProcessMemoryCapacityError) return -12;
    throw error;
  }
  let preparedTransferred = false;
  let preparedLeaseConsumed = false;
  let replacementRegistered = false;
  let oldMemoryRetirementSafe = false;
  let initiatingLeaseConsumed = false;

  // Resolution/compilation yielded to the event loop. Another exec may have
  // replaced the host execution generation for this persistent PID; a stale
  // continuation must not commit exec state against it.
  if (
    processes.get(pid) !== initiatingInfo ||
    kernelWorker.isExecHandoffActive(pid) ||
    !kernelWorker.isProcessExecutionActive(pid)
  ) {
    prepared.memoryLease.release();
    return -3; // ESRCH
  }
  const prepareResult = kernelWorker.kernelExecPrepare(pid, callerTid);
  if (prepareResult < 0) {
    prepared.memoryLease.release();
    return prepareResult;
  }
  const addressSpaceResult = kernelWorker.prepareAddressSpaceForExec(pid);
  if (addressSpaceResult < 0) {
    prepared.memoryLease.release();
    return addressSpaceResult;
  }
  let replacementWorker: ReturnType<NodeWorkerAdapter["createWorker"]> | undefined;
  let replacementExternrefGeneration: ForkExternrefGeneration | undefined;
  let replacementForkHostImports: ForkHostImportOwnerWorker | undefined;
  try {
    const setupResult = kernelWorker.kernelExecSetup(pid, callerTid);
    if (setupResult < 0) {
      prepared.memoryLease.release();
      return setupResult;
    }
    vmInterruptTimers.clear(pid, initiatingInfo);

    // Wake the exact old execution generation through the internal exec
    // retirement path. worker-main returns without exiting the persistent
    // kernel process, then worker-entry publishes both exec_retired and
    // memory_quiescent. Those messages are the only proof that the old realm
    // stopped using its Shared Memory; Worker.terminate() alone is not such a
    // fence on every Node-compatible engine.
    if (initiatingInfo.worker) {
      intentionallyTerminated.add(initiatingInfo.worker as object);
    }
    for (const thread of threadWorkers.get(pid) ?? []) {
      intentionallyTerminated.add(thread.worker as object);
    }
    const retiredOffsets = kernelWorker.wakeProcessWorkersForExecRetirement(
      pid,
      initiatingInfo.memory,
    );
    const mainRetirementStarted = retiredOffsets.has(
      initiatingInfo.channelOffset,
    );
    if (!kernelWorker.prepareProcessForExec(pid, initiatingInfo.memory)) {
      throw new Error(`Exec pid ${pid} changed generation during commit`);
    }
    replacementExternrefGeneration = externrefProcessOwner.replaceGeneration(
      initiatingInfo.externrefGeneration,
    );

    const finalizeResult = kernelWorker.finalizeAddressSpaceForExec(pid);
    if (finalizeResult < 0) {
      throw new Error("failed to detach the discarded address space");
    }

    const [mainQuiescent, threadsQuiescent] = await Promise.all([
      mainRetirementStarted
        ? waitForExecRetirement(
            initiatingInfo.execRetirement,
            initiatingInfo.workerQuiescence,
            EXEC_WORKER_RETIREMENT_WAIT_MS,
          )
        : Promise.resolve(false),
      terminateThreadWorkers(pid, true),
    ]);
    oldMemoryRetirementSafe = mainQuiescent && threadsQuiescent;
    if (initiatingInfo.worker) {
      await terminateTrackedWorker(initiatingInfo.worker);
    }
    if (mainQuiescent) {
      // Thread fences retire their own exact listeners during slot reclaim.
      // Settle the main listener separately so one unresponsive sibling does
      // not retain an otherwise quiescent generation.
      await kernelWorker.settleRetiredChannelListeners(
        pid,
        initiatingInfo.memory,
        initiatingInfo.channelOffset,
      );
    }
    const handoffExitSignal = kernelWorker.finalizeExecHandoffTermination(pid);
    if (handoffExitSignal > 0) {
      prepared.memoryLease.release();
      preparedLeaseConsumed = true;
      externrefProcessOwner.releaseGeneration(
        replacementExternrefGeneration,
      );
      replacementExternrefGeneration = undefined;
      await awaitFinalizedProcessTeardown(
        pid,
        signalExitStatus(handoffExitSignal),
        initiatingInfo.worker,
      );
      return 0;
    }

    const {
      memory: newMemory,
      memoryLease: newMemoryLease,
      layout: newLayout,
      threadAllocator: newThreadAllocator,
    } = prepared;
    const newChannelOffset = newLayout.channelOffset;
    replacementForkHostImports = forkHostImportOwnerRuntime.createWorker({
      pid,
      generationId: replacementExternrefGeneration.id,
      authorizeSender: () => {
        const current = processes.get(pid);
        if (
          !replacementWorker
          || !current
          || current.worker !== replacementWorker
          || current.externrefGeneration !== replacementExternrefGeneration
        ) {
          throw new Error(`stale fork host-import sender for exec pid=${pid}`);
        }
      },
    });

    const initData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid,
      programBytes,
      programModule,
      memory: newMemory,
      channelOffset: newChannelOffset,
      externrefGenerationId: replacementExternrefGeneration.id,
      forkHostImports: replacementForkHostImports.init,
      argv: launchArgv,
      env: envp,
      ptrWidth: newPtrWidth,
      kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
    };

    replacementWorker = new DeferredWorkerHandle(() =>
      workerAdapter.createWorker(initData),
    );
    kernelWorker.registerProcess(pid, newMemory, [newChannelOffset], {
      preserveProcessState: true,
      ptrWidth: newPtrWidth,
      metadataPtrWidth: initiatingInfo.ptrWidth,
      brkBase: newLayout.brkBase,
      mmapBase: newLayout.mmapBase,
      maxAddr: newLayout.maxAddr,
      // Refresh kernel-side Process.argv and environment so procfs and
      // kernel APIs reflect the replacement image.
      argv: launchArgv,
      env: envp,
    });
    replacementRegistered = true;
    bindForkHostImports(replacementWorker, replacementForkHostImports);

    // Clear thread module cache — new program binary is different
    threadModuleCache.delete(pid);

    processes.set(pid, {
      memory: newMemory,
      memoryLease: newMemoryLease,
      workerQuiescence: createWorkerQuiescence(),
      execRetirement: createWorkerQuiescence(),
      programBytes,
      programModule,
      worker: replacementWorker,
      channelOffset: newChannelOffset,
      ptrWidth: newPtrWidth,
      layout: newLayout,
      threadAllocator: newThreadAllocator,
      externrefGeneration: replacementExternrefGeneration,
    });
    preparedTransferred = true;

    // WHY: only terminal messages from every old Worker prove that no realm
    // can still touch this address space. A timeout uses forced retirement,
    // which drops the kernel alias but never recycles the backing.
    if (oldMemoryRetirementSafe) initiatingInfo.memoryLease.release();
    else initiatingInfo.memoryLease.releaseAfterForcedTermination();
    initiatingLeaseConsumed = true;

    installProcessWorkerListeners(replacementWorker, pid, "exec worker error");
    const startDisposition = kernelWorker.startProcessWorkerWhenRunnable(
      pid,
      newMemory,
      () => { (replacementWorker as DeferredWorkerHandle).start(); },
      () => {
        replacementForkHostImports?.close();
        void replacementWorker?.terminate();
      },
    );
    if (startDisposition === "stale") {
      throw new Error(
        `Exec pid ${pid} changed generation before Worker launch`,
      );
    }
    if (startDisposition === "dead") {
      replacementForkHostImports.close();
      await terminateTrackedWorker(replacementWorker);
      kernelWorker.finishProcessExecHandoff(pid);
      const signal = kernelWorker.finalizeExecHandoffTermination(pid);
      await awaitFinalizedProcessTeardown(
        pid,
        signal > 0 ? signalExitStatus(signal) : 0,
        replacementWorker,
      );
      return 0;
    }
    kernelWorker.finishProcessExecHandoff(pid);
    return 0;
  } catch (err) {
    replacementForkHostImports?.close();
    if (replacementExternrefGeneration) {
      externrefProcessOwner.releaseGeneration(replacementExternrefGeneration);
      replacementExternrefGeneration = undefined;
    }
    // A kernel trap can leave the commit point uncertain. We cannot safely
    // return to the caller, so invalidate the old generation before yielding
    // and report a truthful signal death.
    if (initiatingInfo.worker) {
      intentionallyTerminated.add(initiatingInfo.worker as object);
    }
    try {
      const failedGenerationMemory =
        preparedTransferred || replacementRegistered
          ? prepared.memoryLease.memory
          : initiatingInfo.memory;
      kernelWorker.prepareProcessForExec(pid, failedGenerationMemory);
    } catch {
      // Continue with best-effort process death below.
    }
    if (replacementWorker && processes.get(pid)?.worker !== replacementWorker) {
      await terminateTrackedWorker(replacementWorker);
    }
    if (!preparedTransferred && !preparedLeaseConsumed) {
      const replacementGeneration = {
        memory: prepared.memoryLease.memory,
        memoryLease: prepared.memoryLease,
      };
      const detachResult = await detachExactProcessGeneration({
        pid,
        generation: replacementGeneration,
        operation: replacementRegistered ? "deactivate" : "none",
        // A non-transferred DeferredWorker was never started, so this
        // replacement still has exact single-realm ownership.
        retire: (commit) => {
          prepared.memoryLease.release();
          commit();
        },
      });
      if (detachResult.status === "released") {
        preparedLeaseConsumed = true;
      } else {
        reportRetainedProcessGeneration(
          pid,
          "exec replacement rollback",
          detachResult,
          signalExitStatus(SIGSEGV),
        );
      }
    }
    if (preparedTransferred && !initiatingLeaseConsumed) {
      if (oldMemoryRetirementSafe) initiatingInfo.memoryLease.release();
      else initiatingInfo.memoryLease.releaseAfterForcedTermination();
      initiatingLeaseConsumed = true;
    }

    const message = err instanceof Error ? err.message : String(err);
    try {
      reportHostDiagnostic({
        pid,
        status: signalExitStatus(SIGSEGV),
        source: "exec post-commit transition",
        message: `[exec] post-commit transition failed: ${message}`,
      });
    } catch {
      // A closed host port must not prevent kernel-side reap.
    }
    try {
      kernelWorker.notifyHostProcessCrashed(pid, SIGSEGV);
    } catch {
      /* best-effort */
    }
    handleExit(pid, signalExitStatus(SIGSEGV));
    return 0;
  }
}

/**
 * Handle SYS_SPAWN (non-forking posix_spawn).
 *
 * The kernel has already constructed the child Process descriptor in its
 * ProcessTable under `childPid` (with attrs and file actions applied).
 * This callback resolves the program bytes for `path`, allocates a fresh
 * Memory for the child, attaches it to the existing kernel Process, and
 * launches a Worker for it.
 *
 * Distinct from handleExec (which replaces the calling worker) and
 * handleFork (which clones the parent's Memory): handlePosixSpawn always
 * creates a fresh Memory and runs the new program from `_start`.
 *
 * Returns 0 on success, negative errno on failure (e.g. -ENOENT).
 */
/**
 * Pre-flight resolver for SYS_SPAWN. Side-effect-free: looks up program
 * bytes for `path` (via the same execPrograms map + main-thread fallback
 * `resolveExec` already uses for execve), follows shebangs, and compiles the
 * final Wasm module. Returns null on ENOENT and `{ errno }` when the located
 * target cannot be launched.
 *
 * `handleSpawn` in `host/src/kernel-worker.ts` calls this BEFORE
 * `kernel_spawn_process` so that file_actions (which the kernel runs
 * inside `spawn_child`) never execute on a doomed PATH iteration —
 * see the POSIX "exactly once" rule.
 */
async function handlePosixSpawnResolve(
  path: string,
  argv: string[],
): Promise<SpawnProgramResolution | null> {
  return resolveExecutableForLaunch(path, argv);
}

/**
 * Launch a worker for a SYS_SPAWN child whose program has already been
 * resolved and compiled by `handlePosixSpawnResolve`. The kernel has built
 * the child Process descriptor + applied file actions by the time we get
 * here, so this just allocates a Memory, registers the process, and spawns
 * the worker.
 */
async function handlePosixSpawn(
  parentPid: number,
  childPid: number,
  program: ResolvedSpawnProgram,
  envp: string[],
): Promise<number> {
  // Preserve a child that became a zombie before launch, but do not resurrect
  // it by registering a new execution generation.
  if (!kernelWorker.shouldLaunchPendingChild(childPid)) return 0;
  post({ type: "proc_event", kind: "spawn", pid: childPid, ppid: parentPid });

  const { programBytes, programModule, argv } = program;
  const ptrWidth = detectPtrWidth(programBytes);
  let fresh: Awaited<ReturnType<typeof createFreshProcessMemory>>;
  try {
    fresh = await createFreshProcessMemory(childPid, programBytes, ptrWidth);
  } catch (error) {
    if (error instanceof ProcessMemoryRetirementBacklogError) {
      return -11; // EAGAIN
    }
    if (error instanceof ProcessMemoryCapacityError) return -12; // ENOMEM
    throw error;
  }
  const { memory, memoryLease, layout, threadAllocator } = fresh;
  // Allocation admission yielded. Never attach a Worker to a child that
  // became a zombie while the short retirement admission gate drained.
  if (!kernelWorker.shouldLaunchPendingChild(childPid)) {
    memoryLease.release();
    return 0;
  }
  const channelOffset = layout.channelOffset;
  let newWorker: DeferredWorkerHandle | undefined;
  let registered = false;
  let workerStartAttempted = false;
  let lifecycleTeardownStarted = false;
  let childGeneration: ProcessInfo | undefined;
  let externrefGeneration: ForkExternrefGeneration | undefined;
  let forkHostImports: ForkHostImportOwnerWorker | undefined;
  try {
    // The kernel already created the child Process via kernel_spawn_process.
    kernelWorker.registerProcess(childPid, memory, [channelOffset], {
      ptrWidth,
      brkBase: layout.brkBase,
      mmapBase: layout.mmapBase,
      maxAddr: layout.maxAddr,
    });
    registered = true;

    externrefGeneration = externrefProcessOwner.startGeneration(childPid);
    const processExternrefGeneration = externrefGeneration;
    const processForkHostImports = forkHostImportOwnerRuntime.createWorker({
      pid: childPid,
      generationId: processExternrefGeneration.id,
      authorizeSender: () => {
        const current = processes.get(childPid);
        if (
          !newWorker
          || !current
          || current.worker !== newWorker
          || current.externrefGeneration !== processExternrefGeneration
        ) {
          throw new Error(
            `stale fork host-import sender for spawn pid=${childPid}`,
          );
        }
      },
    });
    forkHostImports = processForkHostImports;
    const initData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid: childPid,
      programBytes,
      programModule,
      memory,
      channelOffset,
      externrefGenerationId: processExternrefGeneration.id,
      forkHostImports: processForkHostImports.init,
      argv,
      env: envp,
      ptrWidth,
      kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
    };

    newWorker = new DeferredWorkerHandle(() =>
      workerAdapter.createWorker(initData),
    );
    const worker = newWorker;
    bindForkHostImports(worker, processForkHostImports);
    childGeneration = {
      memory,
      memoryLease,
      workerQuiescence: createWorkerQuiescence(),
      execRetirement: createWorkerQuiescence(),
      programBytes,
      programModule,
      worker,
      channelOffset,
      ptrWidth,
      layout,
      threadAllocator,
      externrefGeneration: processExternrefGeneration,
    };
    processes.set(childPid, childGeneration);

    installProcessWorkerListeners(worker, childPid, "spawn worker error");
    const startDisposition = kernelWorker.startProcessWorkerWhenRunnable(
      childPid,
      memory,
      () => {
        workerStartAttempted = true;
        worker.start();
      },
      () => {
        processForkHostImports.close();
        void worker.terminate();
      },
    );
    if (startDisposition === "stale") {
      throw new Error(
        `Spawn child ${childPid} changed generation before Worker launch`,
      );
    }
    if (startDisposition === "dead") {
      processForkHostImports.close();
      await terminateTrackedWorker(worker);
      processes.get(childPid)?.workerQuiescence.settle();
      const signal = kernelWorker.finalizePendingChildTermination(childPid);
      lifecycleTeardownStarted = true;
      await awaitFinalizedProcessTeardown(
        childPid,
        signal > 0 ? signalExitStatus(signal) : 0,
        worker,
      );
      return 0;
    }
  } catch (error) {
    if (lifecycleTeardownStarted) throw error;
    if (newWorker) await terminateTrackedWorker(newWorker);
    forkHostImports?.close();
    if (externrefGeneration) {
      externrefProcessOwner.releaseGeneration(externrefGeneration);
    }
    const generation = childGeneration ?? { memory, memoryLease };
    const detachResult = await detachExactProcessGeneration({
      pid: childPid,
      generation,
      operation: registered ? "deactivate" : "none",
      retire: (commit) => {
        if (workerStartAttempted) {
          memoryLease.releaseAfterForcedTermination();
        } else {
          memoryLease.release();
        }
        commit();
      },
    });
    if (detachResult.status !== "released") {
      reportRetainedProcessGeneration(
        childPid,
        "posix_spawn rollback",
        detachResult,
      );
    }
    throw error;
  }

  return 0;
}

async function handleClone(attachment: ThreadChannelAttachment): Promise<void> {
  const { pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory } =
    attachment;
  const processInfo = processes.get(pid);
  if (!processInfo) throw new Error(`Unknown pid ${pid} for clone`);

  // Auto-compile thread module if not already cached per-PID
  let threadModule = threadModuleCache.get(pid);
  let cacheCompiledModule = false;
  if (!threadModule) {
    const patched = patchWasmForThread(processInfo.programBytes);
    threadModule = await WebAssembly.compile(patched);
    cacheCompiledModule = true;
  }

  // Compilation yields. A sibling pthread may have committed exec while this
  // clone continuation was suspended; never attach the old program/Memory to
  // the replacement exec image for the same process identity.
  if (
    !isCurrentProcessGeneration(
      processes,
      pid,
      processInfo,
      memory,
      kernelWorker.isExecHandoffActive(pid),
    ) ||
    !kernelWorker.isProcessExecutionActive(pid)
  ) {
    throw new Error(`Process ${pid} changed generation during clone`);
  }
  if (cacheCompiledModule) threadModuleCache.set(pid, threadModule);

  let alloc: ReturnType<ThreadPageAllocator["allocate"]>;
  try {
    alloc = processInfo.threadAllocator.allocate(memory);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    reportHostDiagnostic({
      pid,
      source: "clone allocation",
      message: `[kernel-worker] pid=${pid}: ${message}`,
    });
    throw e;
  }
  // Register fnPtr/argPtr so that handleFork can route a fork() from
  // this thread back through its entry point (see ForkContinuationContext
  // in kernel-worker.ts).
  try {
    kernelWorker.attachThreadChannel(attachment, alloc.channelOffset);
  } catch (err) {
    processInfo.threadAllocator.free(alloc.basePage);
    throw err;
  }

  let threadWorker: DeferredWorkerHandle;
  let threadEntry: ThreadWorkerInfo;
  const forkHostImports = forkHostImportOwnerRuntime.createWorker({
    pid,
    generationId: processInfo.externrefGeneration.id,
    authorizeSender: () => {
      const entries = threadWorkers.get(pid);
      if (
        !belongsToCurrentProcessImage()
        || !threadEntry
        || threadEntry.worker !== threadWorker
        || !entries?.includes(threadEntry)
      ) {
        throw new Error(
          `stale fork host-import sender for pid=${pid} tid=${tid}`,
        );
      }
    },
  });
  const threadInitData: CentralizedThreadInitMessage = {
    type: "centralized_thread_init",
    pid,
    tid,
    programBytes: processInfo.programBytes,
    programModule: threadModule,
    memory,
    processChannelOffset: processInfo.channelOffset,
    channelOffset: alloc.channelOffset,
    externrefGenerationId: processInfo.externrefGeneration.id,
    forkHostImports: forkHostImports.init,
    fnPtr,
    argPtr,
    stackPtr,
    tlsPtr,
    ctidPtr,
    tlsOffset: alloc.tlsOffset,
    tlsAllocAddr: alloc.tlsAllocAddr,
    ptrWidth: processInfo.ptrWidth,
    kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
  };

  threadWorker = new DeferredWorkerHandle(
    () => workerAdapter.createWorker(threadInitData),
  );
  bindForkHostImports(threadWorker, forkHostImports);
  if (!threadWorkers.has(pid)) threadWorkers.set(pid, []);
  threadEntry = {
    worker: threadWorker,
    channelOffset: alloc.channelOffset,
    tid,
    basePage: alloc.slotStartPage,
    workerQuiescence: createWorkerQuiescence(),
    execRetirement: createWorkerQuiescence(),
  };
  threadWorkers.get(pid)!.push(threadEntry);

  const belongsToCurrentProcessImage = () =>
    isCurrentProcessGeneration(
      processes,
      pid,
      processInfo,
      memory,
      kernelWorker.isExecHandoffActive(pid),
    );
  let reclaimed = false;
  const reclaimThread = async () => {
    if (reclaimed) return;
    reclaimed = true;
    // The Worker is stopped at this point, so waking the retired host
    // waitAsync listener cannot race the guest or a newly reused thread slot.
    await kernelWorker.settleRetiredChannelListeners(
      pid,
      memory,
      alloc.channelOffset,
    );
    processInfo.threadAllocator.free(alloc.basePage);
    if (belongsToCurrentProcessImage()) {
      threadExits.release(pid, alloc.channelOffset);
    }
    removeThreadWorkerRegistryEntry(threadWorkers, pid, threadEntry);
  };
  const terminateThreadEntry = (): Promise<void> => {
    if (!threadEntry.termination) {
      threadEntry.termination =
        terminateTrackedWorker(threadWorker).then(reclaimThread);
    }
    return threadEntry.termination;
  };
  threadExits.register(pid, alloc.channelOffset, terminateThreadEntry);

  const isCurrentThreadGeneration = () =>
    !intentionallyTerminated.has(threadWorker as object) &&
    belongsToCurrentProcessImage();
  const failThread = (reason: string, awaitQuiescence = false) => {
    if (!isCurrentThreadGeneration()) {
      void terminateThreadEntry();
      return;
    }
    const disposition = threadWorkerFailureDisposition(reason);
    reportHostDiagnostic({
      pid,
      status:
        disposition.kind === "guest-fatal-trap"
          ? disposition.exitStatus
          : undefined,
      source: "thread worker failure",
      message: `[kernel-worker] pid=${pid} tid=${tid}: ${reason}`,
    });
    kernelWorker.finalizeThreadExit(pid, tid, alloc.channelOffset);
    if (!awaitQuiescence) void terminateThreadEntry();
    if (disposition.kind === "guest-fatal-trap") {
      try {
        kernelWorker.notifyHostProcessCrashed(pid, disposition.signum);
      } catch {
        /* best-effort */
      }
      void finishProcessExit(pid, disposition.exitStatus);
    }
  };
  threadWorker.on("message", (msg: unknown) => {
    const m = msg as WorkerToHostMessage;
    if (m.type === "exec_retired" && m.tid === tid) {
      threadEntry.execRetirement.settle();
    } else if (m.type === "thread_exit") {
      if (!isCurrentThreadGeneration()) {
        void terminateThreadEntry();
        return;
      }
      // memory_quiescent follows after worker-main returns; terminating here
      // would discard the exact ownership fence.
    } else if (m.type === "memory_quiescent" && m.tid === tid) {
      threadEntry.workerQuiescence.settle();
      void terminateThreadEntry();
    } else if (m.type === "error") {
      failThread(m.message, true);
    } else if (m.type === "vm_interrupt_timer") {
      if (isCurrentThreadGeneration() && m.pid === pid) {
        handleVmInterruptTimer(m, pid, processInfo);
      }
    } else if (m.type === "fork_host_import") {
      dispatchForkHostImport(threadWorker, m);
    }
  });
  threadWorker.on("error", (err: Error) =>
    failThread(`worker error: ${err.message ?? err}`),
  );

  let startDisposition: ReturnType<
    CentralizedKernelWorker["startProcessWorkerWhenRunnable"]
  >;
  try {
    startDisposition = kernelWorker.startProcessWorkerWhenRunnable(
      pid,
      memory,
      () => { threadWorker.start(); },
      () => {
        forkHostImports.close();
        void threadWorker.terminate();
      },
      () => {
        kernelWorker.finalizeThreadExit(pid, tid, alloc.channelOffset);
        const failedClone = kernelWorker.failDeferredCloneLaunch(pid, tid, 12);
        void terminateThreadEntry();
        return failedClone;
      },
    );
  } catch (error) {
    kernelWorker.finalizeThreadExit(pid, tid, alloc.channelOffset);
    void terminateThreadEntry();
    throw error;
  }
  if (startDisposition === "stale") {
    void terminateThreadEntry();
    throw new Error(
      `Process ${pid} changed generation before thread Worker launch`,
    );
  }
}

function handleThreadExit(pid: number, channelOffset: number): boolean {
  // The semantic thread exit precedes worker-main's terminal fence. The
  // memory_quiescent message drives Worker termination and slot reclamation.
  void pid;
  void channelOffset;
  return true;
}

function handleExit(pid: number, exitStatus: number): void {
  void finishProcessExit(pid, exitStatus, processes.get(pid)?.worker);
}

async function awaitFinalizedProcessTeardown(
  pid: number,
  exitStatus: number,
  expectedWorker: ProcessInfo["worker"],
): Promise<void> {
  if (!processTeardowns.has(expectedWorker)) {
    void finishProcessExit(pid, exitStatus, expectedWorker);
  }
  await processTeardowns.get(expectedWorker);
}

async function finishProcessExit(
  pid: number,
  exitStatus: number,
  expectedWorker = processes.get(pid)?.worker,
): Promise<void> {
  if (!expectedWorker) return;
  const info = processes.get(pid);
  if (!info || info.worker !== expectedWorker) return;
  vmInterruptTimers.clear(pid, info);

  const existingTeardown = processTeardowns.get(expectedWorker);
  if (existingTeardown) {
    reportProcessExit(pid, exitStatus);
    return;
  }

  const teardown = (async () => {
    // Keep the pid registered until the process worker is gone. musl's
    // _Exit() loops on SYS_exit after SYS_exit_group returns; while worker
    // termination is in flight those duplicate exits still need channel
    // completions, otherwise the worker can park in Atomics.wait with no
    // registered listener left to wake it.
    const [workerQuiescent, threadsQuiescent] = await Promise.all([
      waitForWorkerQuiescence(
        info.workerQuiescence,
        PROCESS_WORKER_QUIESCENCE_WAIT_MS,
      ),
      terminateThreadWorkers(pid),
    ]);
    await terminateTrackedWorker(expectedWorker);

    // Deactivate process (zombie until reaped or destroy) after worker
    // termination so no further guest syscalls can arrive on its channel.
    const detachResult = await detachExactProcessGeneration({
      pid,
      generation: info,
      operation: "deactivate",
      retire: (commit) => {
        if (workerQuiescent && threadsQuiescent) {
          info.memoryLease.release();
        } else {
          info.memoryLease.releaseAfterForcedTermination();
        }
        commit();
      },
    });
    if (detachResult.status !== "released") {
      reportRetainedProcessGeneration(
        pid,
        "process channel teardown",
        detachResult,
        exitStatus,
      );
      return;
    }

    externrefProcessOwner.releaseGeneration(info.externrefGeneration);

    // A superseded old image must not reap the persistent PID that now belongs
    // to its exec successor.
    if (!detachResult.mayReapPid) return;
    try {
      kernelWorker.reapHostOwnedExitedProcess(pid);
    } catch (error) {
      reportHostDiagnostic({
        pid,
        status: exitStatus,
        source: "host-owned process reap",
        message:
          `[node-kernel-worker] failed to reap completed host-owned pid ${pid}: ` +
          (error instanceof Error ? error.message : String(error)),
      });
    }
  })();
  processTeardowns.set(expectedWorker, teardown);

  // The process is already a kernel-side zombie at this point. Report the
  // exit before worker-thread teardown so a slow termination cannot make
  // NodeKernelHost.spawn() look like the guest process never exited. The
  // teardown promise remains tracked so destroy() still waits for cleanup.
  reportProcessExit(pid, exitStatus);

  try {
    await teardown;
  } finally {
    processTeardowns.delete(expectedWorker);
  }
}

// --- Terminate ---

async function handleTerminate(msg: TerminateProcessMessage) {
  const pid = msg.pid;
  const info = processes.get(pid);
  if (info) vmInterruptTimers.clear(pid, info);

  // Terminate thread workers
  const threads = threadWorkers.get(pid);
  if (threads) {
    for (const t of threads) {
      intentionallyTerminated.add(t.worker as object);
      forkHostImportsByWorker.get(t.worker as object)?.close();
      await t.worker.terminate().catch(() => {});
      try {
        kernelWorker.notifyThreadExit(pid, t.tid);
        kernelWorker.removeChannel(pid, t.channelOffset);
      } catch {}
    }
    threadWorkers.delete(pid);
  }

  // Terminate main process worker
  if (info?.worker) {
    await terminateTrackedWorker(info.worker);
  }
  if (info) {
    externrefProcessOwner.releaseGeneration(info.externrefGeneration);
  }

  if (info) {
    const detachResult = await detachExactProcessGeneration({
      pid,
      generation: info,
      operation: "unregister",
      // terminate_process is an externally forced boundary, not a
      // cooperative terminal fence. Drop this realm's alias, but never treat
      // the backing as reusable even if Worker.terminate() has resolved.
      retire: (commit) => {
        info.memoryLease.releaseAfterForcedTermination();
        commit();
      },
    });
    if (detachResult.status !== "released") {
      reportRetainedProcessGeneration(
        pid,
        "terminate_process teardown",
        detachResult,
        msg.status,
      );
      respondError(
        msg.requestId,
        `failed to detach exact process generation for pid ${pid}`,
      );
      return;
    }
  } else {
    try {
      kernelWorker.unregisterProcess(pid);
    } catch (error) {
      respondError(
        msg.requestId,
        `failed to unregister unknown pid ${pid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    threadModuleCache.delete(pid);
    ptyByPid.delete(pid);
  }
  respond(msg.requestId, true);
}

// --- Destroy ---

async function performDestroy() {
  // [JSC-TERMINATE-ATOMICS-WAIT-LEAK] — WORKAROUND, remove when the engine bug
  // is fixed; see docs/jsc-terminate-atomics-wait-workaround.md.
  //
  // On JSC-based runtimes, `Worker.terminate()` cannot free a worker parked in
  // Atomics.wait on its syscall channel — the state every blocked process/thread
  // worker sits in — so terminating them directly leaks their threads + committed
  // memory. This host entry backs BOTH Node.js (V8) and Bun (JSC); on Bun the
  // leak is live, so we must first wake every blocked worker into a cooperative
  // exit (killAllBlockedForTeardown queues SIGKILL + EINTR; the guest glue runs
  // kernel_exit → wasm trap → the worker idles → terminate() reclaims it). This
  // is harmless on V8, so we do it unconditionally rather than sniff the engine,
  // matching the browser host (which does the same and is likewise a no-op cost
  // on Chrome/V8). Phases mirror browser-kernel-worker-entry.ts performDestroy.
  let woken = new Set<number>();
  try { woken = await kernelWorker.killAllBlockedForTeardown(); } catch (e) {
    console.error(`[node-kernel-worker] killAllBlockedForTeardown failed: ${e}`);
  }
  // Drain only for the pids we woke — a process we did not wake (e.g. one
  // already exited via a sibling thread) never posts {exit} and is
  // force-terminated below instead of waited on.
  const drainDeadline = Date.now() + DESTROY_KILL_DRAIN_TIMEOUT_MS;
  const stillDraining = () => {
    for (const pid of woken) if (processes.has(pid)) return true;
    return false;
  };
  while (stillDraining() && Date.now() < drainDeadline) {
    await new Promise((r) => setTimeout(r, DESTROY_KILL_DRAIN_POLL_MS));
  }
  if (stillDraining()) {
    console.warn(
      `[node-kernel-worker] destroy drain timed out with woken process(es) still live; force-terminating`,
    );
  }

  const retireCurrentGenerations = async (): Promise<void> => {
    for (const [pid, info] of [...processes.entries()]) {
      vmInterruptTimers.clear(pid, info);
      const [workerQuiescent, threadsQuiescent] = await Promise.all([
        waitForWorkerQuiescence(
          info.workerQuiescence,
          PROCESS_WORKER_QUIESCENCE_WAIT_MS,
        ),
        terminateThreadWorkers(pid),
      ]);
      await terminateTrackedWorker(info.worker);
      externrefProcessOwner.releaseGeneration(info.externrefGeneration);
      const detachResult = await detachExactProcessGeneration({
        pid,
        generation: info,
        operation: "unregister",
        retire: (commit) => {
          if (workerQuiescent && threadsQuiescent) {
            info.memoryLease.release();
          } else {
            info.memoryLease.releaseAfterForcedTermination();
          }
          commit();
        },
      });
      if (detachResult.status !== "released") {
        reportRetainedProcessGeneration(
          pid,
          "destroy process teardown",
          detachResult,
        );
      }
    }
  };
  await retireCurrentGenerations();
  await Promise.allSettled([...processTeardowns.values()]);
  // A teardown await can race an exec successor into the PID map. Sweep the
  // now-current exact objects, then retry only transactions whose ownership
  // remained unknown because a prior phase threw.
  await retireCurrentGenerations();
  const retryResults = await processGenerationDetaches.retryPending();
  for (const result of retryResults) {
    if (result.status !== "released") {
      console.warn(
        "[node-kernel-worker] destroy retained an exact process generation: " +
          (result.error instanceof Error
            ? result.error.message
            : String(result.error)),
      );
    }
  }
  // Process workers can still have pthread/JS-worker children. Terminate
  // them explicitly before clearing the map so destroy does not leave worker
  // threads keeping the Vitest fork alive.
  for (const threads of threadWorkers.values()) {
    for (const t of threads) {
      intentionallyTerminated.add(t.worker as object);
      forkHostImportsByWorker.get(t.worker as object)?.close();
      t.worker.terminate().catch(() => {});
    }
  }
  // Only exact-generation transactions may remove map entries. The enclosing
  // creator gate proves no later spawn/exec/fork/clone continuation can install
  // another Worker alias after this check.
  let gracefulDetachComplete =
    processGenerationDetaches.pendingCount === 0 && processes.size === 0;
  vmInterruptTimers.clearAll();
  processTeardowns.clear();
  reportedExits.clear();
  threadModuleCache.clear();
  threadWorkers.clear();
  ptyByPid.clear();
  if (gracefulDetachComplete) {
    try {
      processMemoryAllocator.clear();
    } catch (error) {
      gracefulDetachComplete = false;
      console.warn(
        "[node-kernel-worker] process memory allocator retained an unsafe " +
          `lease during destroy: ${error}`,
      );
    }
  }
  if (!gracefulDetachComplete) {
    console.warn(
      "[node-kernel-worker] destroy retained exact process-generation " +
        "ownership; terminating this kernel Worker realm is the final release " +
        "fallback",
    );
  }
  cleanupSessionDir();
  return kernelRealmDestroyResult(gracefulDetachComplete);
}

async function handleDestroy(msg: { requestId: number }) {
  // WHY: message and syscall callbacks overlap across awaits. The shared gate
  // closes admission synchronously, drains every creator that entered first,
  // and runs this terminal sweep only once. The outer worker-realm termination
  // remains the bounded fallback if an admitted creator does not finish.
  const result =
    await processMemoryCreators.closeAndRunAfterDrain(performDestroy);
  respond(msg.requestId, result);
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

// --- Generic host-owned kernel pipes ---

function handlePipeRead(
  msg: Extract<MainToKernelMessage, { type: "pipe_read" }>,
) {
  if (!initReady) {
    respond(msg.requestId, uninitializedKernelPipeResult("read"));
    return;
  }
  respond(msg.requestId, kernelWorker.readHostPipe(msg.pid, msg.pipeIdx));
}

function handlePipeWrite(
  msg: Extract<MainToKernelMessage, { type: "pipe_write" }>,
) {
  if (!initReady) {
    respond(msg.requestId, uninitializedKernelPipeResult("write"));
    return;
  }
  respond(
    msg.requestId,
    kernelWorker.writeHostPipe(msg.pid, msg.pipeIdx, msg.data),
  );
}

function handleInjectConnection(
  msg: Extract<MainToKernelMessage, { type: "inject_connection" }>,
) {
  if (!initReady) {
    respond(msg.requestId, uninitializedKernelPipeResult("inject"));
    return;
  }
  respond(
    msg.requestId,
    kernelWorker.injectHostConnection(
      msg.pid,
      msg.fd,
      msg.peerAddr,
      msg.peerPort,
    ),
  );
}

// --- External HTTP request bridge ---

async function handleHttpRequest(msg: HttpRequestMessage) {
  try {
    const response = await kernelWorker.sendHttpRequest(msg.port, msg.request, {
      timeoutMs: msg.timeoutMs,
      maxResponseBytes: msg.maxResponseBytes,
    });
    respond(msg.requestId, response);
  } catch (e) {
    respondError(msg.requestId, String(e));
  }
}

async function handleExportRootfsImage(
  msg: Extract<MainToKernelMessage, { type: "export_rootfs_image" }>,
) {
  if (!rootfsMemfs) {
    respondError(msg.requestId, "rootfs export requires a VFS-backed kernel");
    return;
  }
  if (!initReady) {
    respondError(msg.requestId, "rootfs export requires an initialized kernel");
    return;
  }
  try {
    const image = await rootfsSnapshotGate.runSnapshot(async () => {
      if (processes.size !== 0 || processTeardowns.size !== 0) {
        throw new Error(
          "rootfs export requires a quiescent kernel with no live or tearing-down processes",
        );
      }
      return rootfsMemfs!.saveImage();
    });
    respondTransferredBytes(msg.requestId, image);
  } catch (error) {
    respondError(
      msg.requestId,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleReadVfsFile(
  msg: Extract<MainToKernelMessage, { type: "read_vfs_file" }>,
) {
  const io = vfsExecIO;
  if (!io) {
    respond(msg.requestId, null);
    return;
  }
  let releaseMutation: (() => void) | undefined;
  try {
    // A read can materialize a deferred file/tree, so it participates in the
    // same exclusion contract as process launches and rootfs snapshots.
    releaseMutation = rootfsSnapshotGate.beginMutation(
      "read or materialize a rootfs file",
    );
    const { data, stat } = await readPreparedPlatformFile(io, msg.path);
    if ((stat.mode & 0o170000) !== 0o100000) {
      respond(msg.requestId, null);
      return;
    }
    respondTransferredBytes(msg.requestId, data);
  } catch (error) {
    if (isMissingPathError(error)) respond(msg.requestId, null);
    else {
      respondError(
        msg.requestId,
        error instanceof Error ? error.message : String(error),
      );
    }
  } finally {
    releaseMutation?.();
  }
}

// --- Message dispatch ---

port.on("message", (msg: MainToKernelMessage) => {
  switch (msg.type) {
    case "init":
      void handleInit(msg).catch((error) => {
        cleanupSessionDir();
        initReady = false;
        post({
          type: "init_error",
          error: error instanceof Error ? error.message : String(error),
        });
      });
      break;
    case "spawn":
      void processMemoryCreators
        .run("a host-spawned process Worker", () => handleSpawn(msg))
        .catch((error) => {
          respondError(
            msg.requestId,
            error instanceof Error ? error.message : String(error),
          );
        });
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
    case "pick_listener_target":
      respond(
        msg.requestId,
        initReady
          ? kernelWorker.pickListenerTarget(msg.port)
          : uninitializedKernelPipeResult("pick-listener"),
      );
      break;
    case "inject_connection":
      handleInjectConnection(msg);
      break;
    case "pipe_read":
      handlePipeRead(msg);
      break;
    case "pipe_write":
      handlePipeWrite(msg);
      break;
    case "pipe_close_read":
      if (initReady) kernelWorker.closeHostPipeRead(msg.pid, msg.pipeIdx);
      break;
    case "pipe_close_write":
      if (initReady) kernelWorker.closeHostPipeWrite(msg.pid, msg.pipeIdx);
      break;
    case "pipe_is_write_open":
      respond(
        msg.requestId,
        initReady
          ? kernelWorker.isHostPipeWriteOpen(msg.pid, msg.pipeIdx)
          : uninitializedKernelPipeResult("is-write-open"),
      );
      break;
    case "wake_blocked_readers":
      if (initReady) kernelWorker.wakeHostPipeReaders(msg.pipeIdx);
      break;
    case "wake_blocked_writers":
      if (initReady) kernelWorker.wakeHostPipeWriters(msg.pipeIdx);
      break;
    case "terminate_process":
      void handleTerminate(msg);
      break;
    case "destroy":
      void handleDestroy(msg);
      break;
    case "export_rootfs_image":
      void handleExportRootfsImage(msg);
      break;
    case "read_vfs_file":
      void handleReadVfsFile(msg);
      break;
    case "get_fork_count": {
      // Round-trip access to the kernel's per-process fork counter for
      // tests asserting SYS_SPAWN didn't fall back to fork. Result is a
      // u64 BigInt (kernel returns u64::MAX as a "pid not found" sentinel).
      try {
        const count = kernelWorker.getForkCount(msg.pid);
        post({ type: "response", requestId: msg.requestId, result: count });
      } catch (err) {
        post({
          type: "response",
          requestId: msg.requestId,
          result: undefined,
          error: (err as Error)?.message ?? String(err),
        });
      }
      break;
    }
    case "get_kernel_memory_pages": {
      try {
        post({
          type: "response",
          requestId: msg.requestId,
          result: kernelWorker.getKernelMemoryPages(),
        });
      } catch (err) {
        post({
          type: "response",
          requestId: msg.requestId,
          result: undefined,
          error: (err as Error)?.message ?? String(err),
        });
      }
      break;
    }
    case "get_spawn_scratch_capacity": {
      try {
        post({
          type: "response",
          requestId: msg.requestId,
          result: kernelWorker.getSpawnScratchCapacity(),
        });
      } catch (err) {
        post({
          type: "response",
          requestId: msg.requestId,
          result: undefined,
          error: (err as Error)?.message ?? String(err),
        });
      }
      break;
    }
    case "enum_procs": {
      // Snapshot the kernel's process table for the Inspector → Procs tab.
      // Mirrors the Browser-side handler in browser-kernel-worker-entry.ts.
      try {
        post({
          type: "response",
          requestId: msg.requestId,
          result: kernelWorker.enumProcs(),
        });
      } catch (err) {
        post({
          type: "response",
          requestId: msg.requestId,
          result: undefined,
          error: (err as Error)?.message ?? String(err),
        });
      }
      break;
    }
    case "read_proc_maps": {
      try {
        post({
          type: "response",
          requestId: msg.requestId,
          result: kernelWorker.readProcMaps(msg.pid),
        });
      } catch (err) {
        post({
          type: "response",
          requestId: msg.requestId,
          result: undefined,
          error: (err as Error)?.message ?? String(err),
        });
      }
      break;
    }
    case "set_syscall_trace": {
      if (msg.enabled) kernelWorker.enableSyscallTrace();
      else kernelWorker.disableSyscallTrace();
      break;
    }
    case "drain_syscall_trace": {
      try {
        post({
          type: "response",
          requestId: msg.requestId,
          result: kernelWorker.drainSyscallTrace(),
        });
      } catch (err) {
        post({
          type: "response",
          requestId: msg.requestId,
          result: undefined,
          error: (err as Error)?.message ?? String(err),
        });
      }
      break;
    }
    case "resolve_exec_response": {
      const resolve = pendingExecResolves.get(msg.requestId);
      if (resolve) {
        pendingExecResolves.delete(msg.requestId);
        resolve(msg.programBytes);
      }
      break;
    }
    case "http_request":
      handleHttpRequest(msg);
      break;
    case "kms_attach_canvas":
      kernelWorker.attachKmsCanvas(msg.crtcId, msg.canvas, msg.stats, msg.opts);
      break;
    case "kms_attach_stats":
      kernelWorker.attachKmsStats(msg.crtcId, msg.stats);
      break;
    default: {
      const exhaustive: never = msg;
      void exhaustive;
      reportWorkerProtocolError(
        `unknown main-thread message type: ${String((msg as { type?: unknown }).type)}`,
      );
      break;
    }
  }
});
