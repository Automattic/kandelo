/**
 * Kernel Worker Entry Point — Dedicated web worker that hosts the
 * CentralizedKernelWorker and manages all process lifecycle.
 *
 * The main thread is a thin UI proxy; this worker owns the kernel Wasm
 * instance, process spawning (fork/exec/clone), and the HTTP connection pump.
 */

import { installBrowserSetImmediatePolyfill } from "./browser-immediate-polyfill";

installBrowserSetImmediatePolyfill();

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
import { BrowserWorkerAdapter } from "./worker-adapter-browser";
import { DeferredWorkerHandle } from "./deferred-worker-handle";
import {
  readPreparedPlatformFile,
  VirtualPlatformIO,
} from "./vfs/vfs";
import { MemoryFileSystem } from "./vfs/memory-fs";
import { createClosedLazyAssetFetcherFromOwnedAssets } from "./vfs/closed-lazy-assets";
import { createBrowserLazyFetcher } from "./vfs/browser-lazy-fetcher";
import { resolveLazyUrl } from "./vfs/lazy-url";
import { prepareHomebrewFlatLazyBoot } from "./homebrew-flat-lazy-boot";
import { DeviceFileSystem } from "./vfs/device-fs";
import { BrowserTimeProvider } from "./vfs/time";
import { restoreBrowserKernelInitMounts } from "./browser-kernel-vfs-init";
import type { MountConfig } from "./vfs/types";
import { TlsNetworkBackend } from "./networking/tls-network-backend";
import { patchWasmForThread } from "./worker-main";
import { detectPtrWidth, extractAbiVersion, extractHeapBase, isWasmModuleBytes } from "./constants";
import { ThreadExitCoordinator } from "./thread-exit-coordinator";
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
  waitForExecRetirement as waitForExecRetirementFence,
  waitForWorkerQuiescence as waitForWorkerQuiescenceFence,
} from "./worker-quiescence";
import { RootfsSnapshotGate } from "./rootfs-snapshot-gate";
import { reapHostOwnedExitedProcess } from "./host-owned-process-reap";
import { uninitializedKernelPipeResult } from "./kernel-pipe-transport";
import type {
  CentralizedWorkerInitMessage,
  CentralizedThreadInitMessage,
  WorkerToHostMessage,
} from "./worker-protocol";
import { ThreadPageAllocator } from "./thread-allocator";
import { CH_TOTAL_SIZE, DEFAULT_MAX_PAGES, PAGES_PER_THREAD } from "./constants";
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
import type {
  HostDiagnostic,
  MainToKernelMessage,
  KernelToMainMessage,
} from "./browser-kernel-protocol";
import {
  initializeBrowserCorsProxyForWorker,
} from "./browser-kernel-protocol";
import { kernelRealmDestroyResult } from "./kernel-realm-destroy";

const PAGE_SIZE = 65536;
// State
let kernelWorker: CentralizedKernelWorker;
let workerAdapter: BrowserWorkerAdapter;
let memfs: MemoryFileSystem;
let io: VirtualPlatformIO;
let maxPages: number = DEFAULT_MAX_PAGES;
let defaultThreadSlots: number = DEFAULT_PROCESS_THREAD_SLOTS;
let processMemoryAllocator: ProcessMemoryAllocator;
const processMemoryRetirementPressureHook =
  createProcessMemoryRetirementPressureHook();
let defaultEnv: string[] = [];
const ENOEXEC = 8;

type LazyRegistrationMessage = Extract<
  MainToKernelMessage,
  { type: "register_lazy_files" | "register_lazy_archives" }
>;

let initReady = false;
let initFailure: string | null = null;
const pendingLazyRegistrationMessages: LazyRegistrationMessage[] = [];
let lazyRegistrationTail: Promise<void> = Promise.resolve();
const rootfsSnapshotGate = new RootfsSnapshotGate();
const processMemoryCreators = new ProcessMemoryCreatorGate();

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
  /** Host-only identity for one execution image. A PID persists across exec. */
  generation: number;
  memory: WebAssembly.Memory;
  memoryLease: ProcessMemoryLease;
  workerQuiescence: WorkerQuiescence;
  execRetirement: WorkerQuiescence;
  memoryRetirementSafe: boolean;
  /** True once this generation's Memory was cloned to browser main for fb0. */
  framebufferExposed: boolean;
  /** Exact browser-main alias teardown, shared by competing failure paths. */
  framebufferRelease?: Promise<boolean>;
  programBytes: ArrayBuffer;
  programModule?: WebAssembly.Module;
  worker: ReturnType<BrowserWorkerAdapter["createWorker"]>;
  argv: string[];
  channelOffset: number;
  ptrWidth: 4 | 8;
  layout: ProcessMemoryLayout;
  threadAllocator: ThreadPageAllocator;
  /** Non-_start continuation root inherited from a pthread fork until exec. */
  forkReplayContext?: ForkReplayContext;
}
const processes = new Map<number, ProcessInfo>();
const processTeardowns = new Map<ProcessInfo["worker"], Promise<void>>();
const vmInterruptTimers = new VmInterruptTimerManager<ProcessInfo>(
  (pid) => processes.get(pid),
);
// Includes standalone thread-worker teardown promises that may outlive the
// process map entry they came from.
const workerTeardowns = new Set<Promise<void>>();
let nextProcessGeneration = 1;
let nextFramebufferReleaseRequestId = 1;
const pendingFramebufferReleaseAcks = new Map<
  number,
  { resolve: (released: boolean) => void; timeout: ReturnType<typeof setTimeout> }
>();
const threadedProcessPids = new Set<number>();
const THREADED_WORKER_TERMINATION_SETTLE_MS = 250;
const NODE_PROCESS_WORKER_TERMINATION_SETTLE_MS = 2000;
const PROCESS_WORKER_QUIESCENCE_WAIT_MS = 100;
const EXEC_WORKER_RETIREMENT_WAIT_MS = 5000;
const FRAMEBUFFER_RELEASE_ACK_WAIT_MS = 2000;
// [JSC-TERMINATE-ATOMICS-WAIT-LEAK] On destroy we wake every Atomics.wait-blocked
// worker so it cooperatively exits (on JSC — Safari and Bun — Worker.terminate()
// can't free a blocked worker). These bound the wait for those workers to run
// their exit path and drain. See docs/jsc-terminate-atomics-wait-workaround.md.
const DESTROY_KILL_DRAIN_TIMEOUT_MS = 1500;
const DESTROY_KILL_DRAIN_POLL_MS = 15;

/**
 * Workers we deliberately terminated — exec, exit, top-level destroy. The
 * synthesized "exit" event from {@link BrowserWorkerHandle} fires on
 * `worker.terminate()` indistinguishably from an unexpected death; this
 * WeakSet lets the crash detector skip the deliberate cases. Mirrors the
 * `intentionallyTerminated` set on the Node host (PR #410).
 */
const intentionallyTerminated = new WeakSet<object>();

const MAX_SHEBANG_DEPTH = 4;

function parseShebang(bytes: ArrayBuffer): { interpreter: string; arg?: string } | null {
  const view = new Uint8Array(bytes);
  if (view.length < 2 || view[0] !== 0x23 || view[1] !== 0x21) return null;
  let end = 2;
  while (end < view.length && view[end] !== 0x0a && end < 4096) end++;
  const line = new TextDecoder().decode(view.subarray(2, end)).replace(/\r$/, "").trim();
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
  const bytes = await readExecFileFromFs(path);
  if (!bytes) return null;

  const shebang = parseShebang(bytes);
  if (!shebang) {
    if (!isWasmModuleBytes(bytes)) return { errno: ENOEXEC };
    let programModule: WebAssembly.Module;
    try {
      programModule = await WebAssembly.compile(bytes);
    } catch (error) {
      if (error instanceof WebAssembly.CompileError) return { errno: ENOEXEC };
      throw error;
    }
    const declaredAbi = extractAbiVersion(bytes);
    if (declaredAbi !== null && declaredAbi !== kernelWorker.getKernelAbiVersion()) {
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

// Per-PID thread module cache: lazily compiled on first clone(), shared across
// all threads of the same process. Keyed by PID of the process that spawned threads.
const threadModuleCache = new Map<number, WebAssembly.Module>();
interface ThreadWorkerInfo {
  worker: ReturnType<BrowserWorkerAdapter["createWorker"]>;
  channelOffset: number;
  tid: number;
  basePage: number;
  quiescent: boolean;
  workerQuiescence: WorkerQuiescence;
  execRetirement: WorkerQuiescence;
  termination?: Promise<void>;
}
const threadWorkers = new Map<number, ThreadWorkerInfo[]>();
const threadExits = new ThreadExitCoordinator();

async function waitForWorkerQuiescence(
  quiescence: WorkerQuiescence,
): Promise<boolean> {
  const quiescent = await waitForWorkerQuiescenceFence(
    quiescence,
    PROCESS_WORKER_QUIESCENCE_WAIT_MS,
  );
  // The timeout is not evidence that terminate completed. It only bounds
  // teardown latency; a missing explicit terminal message uses the forced
  // retirement path.
  return quiescent;
}

async function waitForExecRetirement(
  retirement: WorkerQuiescence,
  quiescence: WorkerQuiescence,
): Promise<boolean> {
  return waitForExecRetirementFence(
    retirement,
    quiescence,
    EXEC_WORKER_RETIREMENT_WAIT_MS,
  );
}

function handleVmInterruptTimer(msg: {
  pid: number;
  timedOutPtr: number;
  vmInterruptPtr: number;
  seconds: number;
}, pid: number, process: ProcessInfo): void {
  if (msg.pid !== pid) return;
  vmInterruptTimers.handleRequest(pid, process, msg);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function processWorkerTerminationSettleMs(argv: readonly string[] | undefined): number {
  const name = basename(argv?.[0] ?? "");
  // Chrome can still have SpiderMonkey Node's process Worker teardown in
  // flight after worker.terminate() resolves. Launching another Node-mode
  // process too quickly can make the second process trap in its wasm runtime.
  // This compatibility delay never proves Memory retirement safe; only the
  // exact worker-entry memory_quiescent fence does that.
  return name === "node" || name === "spidermonkey-node" || name === "spidermonkey-node.wasm"
    ? NODE_PROCESS_WORKER_TERMINATION_SETTLE_MS
    : 0;
}

function readServiceLogForProcess(argv: readonly string[] | undefined): string | null {
  const name = basename(argv?.[0] ?? "");
  const logPath = name === "nginx" ? "/var/log/nginx.log" : null;
  if (!logPath) return null;
  const bytes = readFileFromFs(logPath);
  if (!bytes || bytes.byteLength === 0) return `${logPath}: <empty>`;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trimEnd();
  return `${logPath}:\n${text || "<empty>"}`;
}

function formatProcessFailureContext(pid: number): string {
  const info = processes.get(pid);
  const serviceLog = readServiceLogForProcess(info?.argv);
  const syscalls = kernelWorker.dumpLastSyscalls(pid) || "<none>";
  return [
    `argv=${JSON.stringify(info?.argv ?? [])}`,
    serviceLog,
    `last syscalls:\n${syscalls}`,
  ].filter((line): line is string => line !== null).join("\n");
}

async function waitForProcessTeardowns(): Promise<void> {
  while (processTeardowns.size > 0 || workerTeardowns.size > 0) {
    await Promise.allSettled([
      ...processTeardowns.values(),
      ...workerTeardowns,
    ]);
  }
}

async function awaitFinalizedProcessTeardown(
  pid: number,
  exitStatus: number,
  expectedWorker: ProcessInfo["worker"],
  crashSignum?: number,
): Promise<void> {
  if (!processTeardowns.has(expectedWorker)) {
    handleExit(pid, exitStatus, crashSignum, expectedWorker);
  }
  await processTeardowns.get(expectedWorker);
}

async function terminateTrackedWorker(
  worker: ReturnType<BrowserWorkerAdapter["createWorker"]>,
  settleMs = 0,
): Promise<void> {
  intentionallyTerminated.add(worker as object);
  const teardown = (async () => {
    await worker.terminate().catch(() => {});
    if (settleMs > 0) await delay(settleMs);
  })();
  workerTeardowns.add(teardown);
  void teardown.finally(() => workerTeardowns.delete(teardown));
  await teardown;
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
          )
        : waitForWorkerQuiescence(thread.workerQuiescence)),
  );
  const allQuiescent = quiescence.every(Boolean);
  for (const thread of threads) {
    intentionallyTerminated.add(thread.worker as object);
  }
  for (const t of threads) {
    await (
      t.termination ??
      terminateTrackedWorker(t.worker, THREADED_WORKER_TERMINATION_SETTLE_MS)
    );
    threadExits.release(pid, t.channelOffset);
  }
  return allQuiescent;
}
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
      threadedProcessPids.delete(pid);
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
      return kernelWorker.settleRetiredChannelListeners(
        pid,
        generation.memory,
      );
    },
    retire,
  });
  if (result.status === "released" && "postCommitError" in result) {
    try {
      reportHostDiagnostic({
        pid,
        source: "process memory retirement",
        message:
          `[browser-kernel-worker] pid ${pid} retired its exact process ` +
          `memory before a cleanup callback failed: ${
            formatError(result.postCommitError)
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
  try {
    reportHostDiagnostic({
      pid,
      source,
      ...(status === undefined ? {} : { status }),
      message:
        `[browser-kernel-worker] retained pid ${pid}'s exact process memory: ` +
        formatError(result.error),
    });
  } catch {
    // WHY: the transaction remains in the retry ledger. A closed diagnostic
    // port must not replace the lifecycle error or discard retry authority.
  }
}

// Kernel wasm exports cache
let kernelInstance: WebAssembly.Instance | null = null;
let kernelMemory: WebAssembly.Memory | null = null;

// HTTP bridge port (transferred from main thread → service worker comms)
let bridgePort: MessagePort | null = null;
let bridgeTargetPort: number | null = null; // The specific HTTP port to route bridge requests to
let nextBridgeActivityId = 1;
const activeBridgeRequests = new Set<number>();

function post(msg: KernelToMainMessage, transfer?: Transferable[]) {
  (globalThis as any).postMessage(msg, transfer ?? []);
}

function allocateProcessGeneration(): number {
  const generation = nextProcessGeneration++;
  if (!Number.isSafeInteger(generation)) {
    throw new Error("browser process execution generation space exhausted");
  }
  return generation;
}

/**
 * Prove that BrowserKernel no longer owns this generation's structured-clone
 * Memory wrapper or framebuffer-registry typed views.
 *
 * WHY: Worker quiescence only fences the process and kernel-worker realms.
 * Browser main is an independent owner after fb_bind posts WebAssembly.Memory,
 * so its exact-generation acknowledgement is part of retirement too. A
 * timeout does not pretend success: callers route the lease through forced
 * retirement, which remains safe because process Memory is never reused. The
 * ownership boundary and RSS evidence are recorded in
 * docs/measurements/2026-07-28-process-memory-retirement-rss.md.
 */
function releaseMainFramebufferGeneration(
  pid: number,
  info: ProcessInfo,
): Promise<boolean> {
  if (!info.framebufferExposed) return Promise.resolve(true);
  if (info.framebufferRelease) return info.framebufferRelease;

  const requestId = nextFramebufferReleaseRequestId++;
  info.framebufferRelease = new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      if (!pendingFramebufferReleaseAcks.delete(requestId)) return;
      resolve(false);
    }, FRAMEBUFFER_RELEASE_ACK_WAIT_MS);
    pendingFramebufferReleaseAcks.set(requestId, { resolve, timeout });
    post({
      type: "fb_release_generation",
      requestId,
      pid,
      generation: info.generation,
    });
  }).then((released) => {
    if (released) {
      // WHY: main keeps a terminal tombstone until this ACK-ordered marker.
      // Quiescence and port ordering mean this or an older generation cannot
      // bind after the marker, so main can reject a racing bind without
      // retaining one tombstone per PID until BrowserKernel destruction.
      post({
        type: "fb_forget_generation",
        pid,
        generation: info.generation,
      });
    }
    return released;
  });
  return info.framebufferRelease;
}

function acknowledgeMainFramebufferRelease(requestId: number): void {
  const pending = pendingFramebufferReleaseAcks.get(requestId);
  if (!pending) return;
  pendingFramebufferReleaseAcks.delete(requestId);
  clearTimeout(pending.timeout);
  pending.resolve(true);
}

function reportHostDiagnostic(
  diagnostic: HostDiagnostic,
  level: "error" | "warn" = "error",
): void {
  if (level === "warn") console.warn(diagnostic.message);
  else console.error(diagnostic.message);
  post({ type: "host_diagnostic", ...diagnostic });
}

function reportBridgePendingRequests(): void {
  post({ type: "http_bridge_pending", count: activeBridgeRequests.size });
}

function beginBridgeRequest(): number {
  const activityId = nextBridgeActivityId++;
  activeBridgeRequests.add(activityId);
  reportBridgePendingRequests();
  return activityId;
}

function endBridgeRequest(activityId: number): void {
  if (!activeBridgeRequests.delete(activityId)) return;
  reportBridgePendingRequests();
}

function resetBridgePendingRequests(): void {
  if (activeBridgeRequests.size === 0) return;
  activeBridgeRequests.clear();
  reportBridgePendingRequests();
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ? `${err.message}\n${err.stack}` : err.message;
  }
  return String(err);
}

function isMissingPathError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === -2 || code === "ENOENT";
}

function respond(requestId: number, result: unknown) {
  post({ type: "response", requestId, result });
}

function respondTransferredBytes(requestId: number, result: Uint8Array) {
  post(
    { type: "response", requestId, result },
    [result.buffer as ArrayBuffer],
  );
}

function respondError(requestId: number, error: string) {
  post({ type: "response", requestId, result: null, error });
}

function respondIfRequested(
  msg: { requestId?: number },
  result: unknown,
): void {
  if (typeof msg.requestId === "number") {
    respond(msg.requestId, result);
  }
}

function respondErrorIfRequested(
  msg: { requestId?: number },
  error: string,
): void {
  if (typeof msg.requestId === "number") {
    respondError(msg.requestId, error);
  }
}

function reportWorkerProtocolError(message: string): void {
  reportHostDiagnostic({
    pid: 0,
    source: "worker protocol",
    message: `[kernel-worker] ${message}`,
  });
}

async function applyLazyRegistration(msg: LazyRegistrationMessage): Promise<void> {
  if (msg.type === "register_lazy_files") {
    memfs.importLazyEntries(msg.entries);
  } else {
    await memfs.importVerifiedLazyArchiveEntries(msg.entries);
  }
  respondIfRequested(msg, true);
}

function failPendingLazyRegistrations(error: string): void {
  const pending = pendingLazyRegistrationMessages.splice(0);
  for (const msg of pending) {
    respondErrorIfRequested(msg, error);
  }
}

function scheduleLazyRegistration(
  msg: LazyRegistrationMessage,
): Promise<void> {
  // WHY: worker message handlers may overlap after an await. Serialize trust
  // checks so two registrations cannot both authenticate against an obsolete
  // view and then publish in a different order.
  const scheduled = lazyRegistrationTail.then(async () => {
    const releaseMutation = rootfsSnapshotGate.beginMutation(
      "register lazy rootfs entries",
    );
    try {
      await applyLazyRegistration(msg);
    } finally {
      releaseMutation();
    }
  });
  lazyRegistrationTail = scheduled.catch(() => {});
  return scheduled;
}

function reportLazyRegistrationFailure(
  msg: LazyRegistrationMessage,
  err: unknown,
): void {
  const error = formatError(err);
  respondErrorIfRequested(msg, error);
  reportWorkerProtocolError(`${msg.type} failed: ${error}`);
}

async function flushPendingLazyRegistrations(): Promise<void> {
  // Keep init closed while draining. Messages delivered while a digest yields
  // join this queue and must be authenticated before the worker reports ready.
  while (pendingLazyRegistrationMessages.length !== 0) {
    const msg = pendingLazyRegistrationMessages.shift()!;
    try {
      await scheduleLazyRegistration(msg);
    } catch (err) {
      reportLazyRegistrationFailure(msg, err);
      throw err;
    }
  }
}

async function handleLazyRegistration(msg: LazyRegistrationMessage): Promise<void> {
  if (initFailure) {
    respondErrorIfRequested(msg, initFailure);
    reportWorkerProtocolError(
      `${msg.type} rejected because kernel worker init failed: ${initFailure}`,
    );
    return;
  }
  if (!initReady) {
    pendingLazyRegistrationMessages.push(msg);
    return;
  }
  try {
    await scheduleLazyRegistration(msg);
  } catch (err) {
    reportLazyRegistrationFailure(msg, err);
  }
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
      kernelWorker.reserveHostRegion(pid, PAGES_PER_THREAD * PAGE_SIZE) / PAGE_SIZE,
  });
}

interface ProcessMemoryAllocationContext {
  operation: "spawn" | "exec" | "posix_spawn";
  path?: string;
  argv?: readonly string[];
}

function processMemoryAllocationDiagnostics(
  pid: number,
  ptrWidth: 4 | 8,
  layout: ProcessMemoryLayout,
  heapBase: bigint | number | null,
  context?: ProcessMemoryAllocationContext,
) {
  let totalLiveBufferBytes = 0;
  const liveProcesses = Array.from(processes.entries())
    .sort(([a], [b]) => a - b)
    .map(([livePid, info]) => {
      const bufferBytes = info.memory.buffer.byteLength;
      totalLiveBufferBytes += bufferBytes;
      return {
        pid: livePid,
        argv: info.argv.slice(0, 8),
        ptrWidth: info.ptrWidth,
        currentPages: Math.ceil(bufferBytes / PAGE_SIZE),
        maximumPages: info.layout.maximumPages,
        bufferBytes,
      };
    });

  return {
    operation: context?.operation,
    pid,
    path: context?.path,
    argv: context?.argv,
    ptrWidth,
    heapBase: heapBase == null ? null : heapBase.toString(),
    requestedLayout: {
      initialPages: layout.initialPages,
      maximumPages: layout.maximumPages,
      controlBase: layout.controlBase,
      brkBase: layout.brkBase,
      mmapBase: layout.mmapBase,
      maxAddr: layout.maxAddr,
      threadSlotCount: layout.threadSlotCount,
      threadArenaEndPage: layout.threadArenaEndPage,
    },
    liveProcessCount: processes.size,
    pendingProcessTeardowns: processTeardowns.size,
    pendingWorkerTeardowns: workerTeardowns.size,
    totalLiveBufferBytes,
    liveProcesses,
  };
}

async function createFreshProcessMemory(
  pid: number,
  programBytes: ArrayBuffer,
  ptrWidth: 4 | 8,
  processMaxPages = maxPages,
  context?: ProcessMemoryAllocationContext,
): Promise<{
  memory: WebAssembly.Memory;
  memoryLease: ProcessMemoryLease;
  layout: ProcessMemoryLayout;
  threadAllocator: ThreadPageAllocator;
}> {
  const heapBase = extractHeapBase(programBytes);
  const layout = computeProcessMemoryLayout({
    maxPages: processMaxPages,
    defaultThreadSlots,
    ptrWidth,
    programBytes,
    heapBase,
  });
  let memoryLease: ProcessMemoryLease;
  try {
    memoryLease = await processMemoryAllocator.acquireWhenAvailable({
      ptrWidth,
      initialPages: layout.initialPages,
      maximumPages: layout.maximumPages,
    });
  } catch (e) {
    console.error(
      "[kernel-worker] process memory allocation failed",
      JSON.stringify(
        processMemoryAllocationDiagnostics(pid, ptrWidth, layout, heapBase, context),
      ),
    );
    throw e;
  }
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
    // No browser Worker or kernel registration exists yet, so rollback is an
    // exact single-owner release rather than forced retirement.
    memoryLease.release();
    throw error;
  }
}

// ── Init ──

async function handleInit(msg: Extract<MainToKernelMessage, { type: "init" }>) {
  initReady = false;
  initFailure = null;
  // WHY: structured cloning strips the host-side freeze. Revalidate into one
  // worker-owned immutable copy before either browser network path sees it.
  const {
    lazyFetcher: corsProxyLazyFetcher,
    tlsBackend,
  } = initializeBrowserCorsProxyForWorker(msg.config.corsProxy, {
    useLazyFetcher: msg.closedLazyAssets === undefined,
    createLazyFetcher: (config) => createBrowserLazyFetcher(config),
    createTlsBackend: (options) => new TlsNetworkBackend({
      dnsAliases: msg.config.dnsAliases,
      ...options,
    }),
    reportHostDiagnostic,
  });
  maxPages = msg.config.maxMemoryPages;
  defaultThreadSlots = msg.config.defaultThreadSlots ?? DEFAULT_PROCESS_THREAD_SLOTS;
  defaultEnv = msg.config.env;
  processMemoryAllocator = new ProcessMemoryAllocator({
    // The sampled byte budget is the concurrency authority. Keep the count
    // ceiling high enough that small address spaces do not inherit the
    // historically unenforced maxWorkers value as a new process-count limit.
    maxMemories: Math.max(
      1,
      Math.floor(msg.config.maxProcessMemoryBytes / PAGE_SIZE),
    ),
    maxTotalBytes: msg.config.maxProcessMemoryBytes,
    ...deriveProcessMemoryRetirementAdmissionThresholds(
      msg.config.maxWorkers,
      msg.config.maxProcessMemoryBytes,
    ),
    retirementPressureHook: processMemoryRetirementPressureHook,
  });

  // Create VFS — prefer pre-built image bytes (kernel-owned FS); fall back
  // to the legacy shared-SAB path so the existing demos keep working.
  //
  // vfsImage path (Task 4.4): apply DEFAULT_MOUNT_SPEC through the shared
  // browser-worker VFS-init boundary,
  // giving 8 mounts — / from the image, plus scratch memfs at /tmp, /var/tmp,
  // /var/log, /var/run, /home/user, /root, /srv. Layer /dev/shm and /dev on
  // top: those are browser-platform internals (POSIX semaphore SAB,
  // kernel devices) not part of the canonical spec.
  //
  // Legacy fsSab path keeps the prior 3-mount layout intact — its caller
  // controls the rootfs contents directly via kernel.fs and would lose
  // control if the spec dictated additional scratch mounts.
  const shmfs = MemoryFileSystem.fromExisting(msg.shmSab);
  const devfs = new DeviceFileSystem();
  // The kernel worker OWNS the VFS: rebuild it from the demo's image bytes and
  // apply DEFAULT_MOUNT_SPEC (/ from the image + scratch mounts for /tmp,
  // /var/*, /home/user, /root, /srv). /etc is part of the image, baked in by
  // the demo (see apps/browser-demos/lib/kernel-owned-boot.ts).
  const specMounts = await restoreBrowserKernelInitMounts(
    msg.vfsImage,
    msg.rootfsMountSpec,
  );
  const rootMount = specMounts.find((m) => m.mountPoint === "/");
  if (!rootMount) throw new Error("rootfs mount spec missing / mount");
  memfs = rootMount.backend as MemoryFileSystem;
  if (msg.lazyUrlBase) {
    memfs.rewriteLazyFileUrls((url) => resolveLazyUrl(msg.lazyUrlBase!, url));
    memfs.rewriteLazyArchiveUrls((url) => resolveLazyUrl(msg.lazyUrlBase!, url));
  }
  if (msg.closedLazyAssets !== undefined) {
    memfs.setLazyFetcher(createClosedLazyAssetFetcherFromOwnedAssets(msg.closedLazyAssets));
  } else if (corsProxyLazyFetcher !== undefined) {
    // WHY: guest networking and lazy VFS downloads are separate fetch paths.
    // Lazy VFS must read and verify release-asset bytes, which requires CORS.
    // CORP alone cannot make an opaque response body readable to JavaScript.
    memfs.setLazyFetcher(corsProxyLazyFetcher);
  }
  const mounts: MountConfig[] = [
    { mountPoint: "/dev/shm", backend: shmfs },
    { mountPoint: "/dev", backend: devfs },
    ...specMounts,
  ];
  memfs.subscribeLazyDownloads((event) => {
    post({ type: "lazy_download", event });
  });
  await prepareHomebrewFlatLazyBoot(memfs);
  io = new VirtualPlatformIO(mounts, new BrowserTimeProvider());

  // Create TLS-MITM network backend. Programs do real TLS handshakes via
  // their compiled-in OpenSSL; the backend terminates TLS locally, makes
  // real fetch() requests, and re-encrypts the responses.
  // The service worker handles CORS proxying transparently in both dev and
  // production, keeping the browser networking path identical across modes.
  await tlsBackend.init();
  io.network = tlsBackend;

  // Install the MITM CA certificate in the VFS so OpenSSL trusts it.
  const caCertPem = tlsBackend.getCACertPEM();
  try {
    // Demo images don't always include /etc — create the full chain.
    for (const dir of ["/etc", "/etc/ssl", "/etc/ssl/certs"]) {
      try { memfs.mkdir(dir, 0o755); } catch { /* exists */ }
    }
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
      defaultThreadSlots,
      enableSyscallLog: msg.config.enableSyscallLog,
      syscallLogPtrWidth: msg.config.syscallLogPtrWidth,
    },
    io,
    {
      onProcessMemoryTarget: (memory, target) => {
        processMemoryAllocator.observeTarget(memory, target);
      },
      onFork: ({ parentPid, childPid, parentMemory, continuation }) => {
        return processMemoryCreators.run("a fork process Worker", () => {
          // Tell the main thread a kernel-side fork happened so Inspector
          // panes can refresh their process table without polling.
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
          // Fire after handleExec updates the kernel Process.argv. If this is
          // sent before registerProcess(..., { argv }), Kandelo's Procs tab
          // refreshes against stale cmdline data and only corrects on remount.
          // Fatal post-commit handoffs return 0 too, but install no new worker.
          const installedWorker = processes.get(pid)?.worker;
          if (
            result === 0
            && installedWorker
            && installedWorker !== previousWorker
            && kernelWorker.isProcessExecutionActive(pid)
          ) {
            post({ type: "proc_event", kind: "exec", pid });
          }
          return result;
        }),
      onResolveSpawn: handlePosixSpawnResolve,
      onSpawn: (parentPid, childPid, program, envp) =>
        processMemoryCreators.run(
          "a posix_spawn process Worker",
          () => handlePosixSpawn(parentPid, childPid, program, envp),
        ),
      onClone: (attachment) => processMemoryCreators.run(
        "a pthread Worker",
        () => handleClone(attachment),
      ),
      onThreadExit: (pid, _tid, channelOffset) => handleThreadExit(pid, channelOffset),
      onExit: (pid, exitStatus) => handleExit(pid, exitStatus),
    },
  );

  // In a dedicated worker, use Atomics.waitAsync directly — no V8 microtask
  // chain freeze bug (that's main-thread-only).
  kernelWorker.usePolling = false;
  // Defer every relisten and already-PENDING dispatch through the
  // MessageChannel-backed setImmediate queue so syscall handling and worker
  // messages both keep progressing under multi-process bridge load.
  // Notification remains event-driven through Atomics.waitAsync.
  (kernelWorker as any).relistenBatchSize = 1;

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
        kw.startTcpListener(pid, _fd, port, addr);
      }
      post({ type: "listen_tcp", pid, fd: _fd, port });
      return 0;
    },
  };

  await kernelWorker.init(msg.kernelWasmBytes);
  kernelInstance = kw.kernelInstance;
  kernelMemory = kw.kernelMemory;

  // /dev/fb0 forwarding: the registry lives in this worker, but the canvas
  // lives on the main thread. WHY: today's zero-copy fbdev contract therefore
  // exposes raw process Memory and must pair every bind with the exact release
  // fence above; see docs/measurements/2026-07-28-process-memory-retirement-rss.md.
  kernelWorker.framebuffers.onChange((pid, ev) => {
    const processInfo = processes.get(pid);
    if (!processInfo) return;
    if (ev === "bind") {
      const b = kernelWorker.framebuffers.get(pid);
      const memory = kernelWorker.getProcessMemory(pid);
      if (!b || !memory) return;
      processInfo.framebufferExposed = true;
      post({
        type: "fb_bind",
        pid,
        generation: processInfo.generation,
        addr: b.addr,
        len: b.len,
        w: b.w,
        h: b.h,
        stride: b.stride,
        fmt: "BGRA32",
        memory,
      });
    } else {
      post({
        type: "fb_unbind",
        pid,
        generation: processInfo.generation,
      });
    }
  });
  // memory.grow invalidates the previously-shared SAB; forward the new
  // Memory so the main-thread renderer rebuilds its view.
  const origRebind = kernelWorker.framebuffers.rebindMemory.bind(
    kernelWorker.framebuffers,
  );
  kernelWorker.framebuffers.rebindMemory = (pid: number) => {
    origRebind(pid);
    if (!kernelWorker.framebuffers.get(pid)) return;
    const memory = kernelWorker.getProcessMemory(pid);
    const processInfo = processes.get(pid);
    if (memory && processInfo) {
      post({
        type: "fb_rebind_memory",
        pid,
        generation: processInfo.generation,
        memory,
      });
    }
  };
  // Write-based fb deltas (fbDOOM-style): forward each pixel chunk
  // to the main thread, which mirrors them into its own registry.
  // The bytes here are non-shared (kernel.ts copies from the kernel
  // memory before invoking fbWrite), so they transfer cleanly.
  kernelWorker.framebuffers.onWrite((pid, offset, bytes) => {
    const processInfo = processes.get(pid);
    if (!processInfo) return;
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    post(
      {
        type: "fb_write",
        pid,
        generation: processInfo.generation,
        offset,
        bytes: new Uint8Array(buf),
      },
      [buf],
    );
  });

  // Accept bridge port for HTTP request handling
  if (msg.bridgePort) {
    bridgePort = msg.bridgePort;
    resetBridgePendingRequests();
  }

  await flushPendingLazyRegistrations();
  // No await separates the final queue check from opening init, so a message
  // cannot slip past both the pending queue and the serialized live path.
  initReady = true;

  post({ type: "ready" });
}

// ── Spawn ──

async function handleSpawn(msg: Extract<MainToKernelMessage, { type: "spawn" }>) {
  let releaseMutation: (() => void) | undefined;
  let createdPid: number | undefined;
  let createdMemoryLease: ProcessMemoryLease | undefined;
  let createdMemoryRegistered = false;
  let workerCreationAttempted = false;
  let createdWorker: ProcessInfo["worker"] | undefined;
  let createdGeneration: ProcessInfo | undefined;
  try {
    releaseMutation = rootfsSnapshotGate.beginMutation("spawn a process");
    await waitForProcessTeardowns();

    let programBytes: ArrayBuffer;
    if (msg.programBytes) {
      programBytes = msg.programBytes;
    } else if (msg.programPath) {
      // Read from shared filesystem
      const bytes = await readExecFileFromFs(msg.programPath);
      if (!bytes) {
        respondError(msg.requestId, `ENOENT: ${msg.programPath}`);
        return;
      }
      programBytes = bytes;
    } else {
      respondError(msg.requestId, "No programBytes or programPath");
      return;
    }

    if (!isWasmModuleBytes(programBytes)) {
      respondError(msg.requestId, "ENOEXEC: program is not a WebAssembly module");
      return;
    }

    const pid = kernelWorker.createProcess(
      msg.pty ? TERMINAL_STDIO : CAPTURED_STDIO,
    );
    createdPid = pid;
    const path = msg.programPath ?? msg.argv[0];
    const pages = msg.maxPages ?? maxPages;
    const ptrWidth = detectPtrWidth(programBytes);
    const {
      memory,
      memoryLease,
      layout,
      threadAllocator,
    } = await createFreshProcessMemory(pid, programBytes, ptrWidth, pages, {
      operation: "spawn",
      path,
      argv: msg.argv,
    });
    createdMemoryLease = memoryLease;
    const channelOffset = layout.channelOffset;
    const launchEnv = msg.env ?? defaultEnv;

    kernelWorker.registerProcess(pid, memory, [channelOffset], {
      ptrWidth,
      argv: msg.argv,
      env: launchEnv,
      brkBase: layout.brkBase,
      mmapBase: layout.mmapBase,
      maxAddr: layout.maxAddr,
    });
    createdMemoryRegistered = true;

    kernelWorker.setCredentials(pid, { uid: msg.uid, gid: msg.gid });
    if (msg.cwd) {
      kernelWorker.setCwd(pid, msg.cwd);
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
    } else {
      if (msg.stdin) {
        const stdinData = msg.stdin instanceof Uint8Array ? msg.stdin : new Uint8Array(msg.stdin);
        kernelWorker.setStdinData(pid, stdinData);
      }
    }

    const initData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid,
      programBytes,
      memory,
      channelOffset,
      env: launchEnv,
      argv: msg.argv,
      cwd: msg.cwd,
      ptrWidth,
      kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
    };

    workerCreationAttempted = true;
    const worker = workerAdapter.createWorker(initData);
    createdWorker = worker;
    createdGeneration = {
      generation: allocateProcessGeneration(),
      memory,
      memoryLease,
      workerQuiescence: createWorkerQuiescence(),
      execRetirement: createWorkerQuiescence(),
      memoryRetirementSafe: true,
      framebufferExposed: false,
      programBytes,
      worker,
      argv: msg.argv,
      channelOffset,
      ptrWidth,
      layout,
      threadAllocator,
    };
    processes.set(pid, createdGeneration);

    installProcessWorkerListeners(worker, pid);
    createdMemoryLease = undefined;
    createdPid = undefined;

    respond(msg.requestId, pid);
  } catch (e) {
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
          retire: async (commit) => {
            const framebufferReleased = createdGeneration
              ? await releaseMainFramebufferGeneration(
                  createdPid!,
                  createdGeneration,
                )
              : true;
            // Browser Worker termination has no completion event. Once
            // creation was attempted, retire through the forced path.
            if (workerCreationAttempted || !framebufferReleased) {
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
          // Preserve the original spawn failure.
        }
      }
    }
    respondError(msg.requestId, String(e));
  } finally {
    releaseMutation?.();
  }
}

/**
 * Wire the four ways a process worker can die so the kernel's view of
 * the process matches reality: worker-level uncaught error, worker-main
 * `{type:"error"}` (instantiation/init failure), worker-main
 * `{type:"exit"}` (_start returned without SYS_exit_group, or an
 * "unreachable" trap that worker-main treated as a normal exit), and
 * the synthesized "exit" event from {@link BrowserWorkerHandle} when
 * `worker.onerror` fires or `terminate()` is called externally.
 *
 * Without this, a wasm trap inside a process would post `{type:"exit"}`
 * to the main thread, but the kernel would still see the process as
 * alive — any `waitpid()` in the parent (e.g. dinit waiting on a child,
 * php-fpm master waiting on a worker) would block forever, and the
 * whole demo appears hung.
 *
 * Mirrors the wiring on the Node side (`installCrashSafetyNet` +
 * per-handler "error"/"exit" message routing in
 * `host/src/node-kernel-worker-entry.ts`, PR #410).
 */
function installProcessWorkerListeners(
  worker: ReturnType<BrowserWorkerAdapter["createWorker"]>,
  pid: number,
): void {
  let exited = false;
  const finalize = (
    status: number,
    crashSignum?: number,
    failure?: Pick<HostDiagnostic, "source" | "message">,
  ) => {
    if (exited) return;
    if (intentionallyTerminated.has(worker as object)) return;
    if (processes.get(pid)?.worker !== worker) return; // already replaced (e.g. by exec)
    exited = true;
    try {
      if (failure !== undefined) {
        reportHostDiagnostic({
          pid,
          status,
          source: failure.source,
          message: `${failure.message}\n${formatProcessFailureContext(pid)}`,
        });
      }
    } finally {
      handleExit(pid, status, crashSignum, worker);
    }
  };

  // Status conventions match the Node host:
  //   128+signal — classified Wasm trap, or generic SIGSEGV when a worker
  //         dies without a trap reason. Matches Linux signal-death status.
  //   -1  — worker-main caught an unclassified instantiation/init error
  //         and posted {type:"error"}.
  //   m.status — worker-main posted {type:"exit"}, normal exit path.
  worker.on("error", (err: Error) => {
    if (intentionallyTerminated.has(worker as object)) return;
    const signum = classifiedSignalOrFallback(err);
    const status = signalExitStatus(signum);
    finalize(
      status,
      signum,
      {
        source: "worker.onerror",
        message: `[kernel-worker] worker error pid=${pid}: ${err.message}`,
      },
    );
  });
  worker.on("exit", (code: number) => {
    // BrowserWorkerHandle synthesizes an "exit" event when the underlying
    // Worker dies via onerror or external terminate(). worker-main itself
    // never triggers this — it posts {type:"exit"} via postMessage instead.
    // Skip the synthesized event when we're the ones terminating (exec,
    // explicit exit/destroy/terminate_process); otherwise we'd tear down
    // kernel state for a process that's still alive in a new wasm worker.
    if (intentionallyTerminated.has(worker as object)) return;
    // BrowserWorkerHandle synthesizes code=1 from onerror; we already
    // finalized via the "error" handler above, so this is a no-op there.
    // If "exit" fires without a prior "error" (worker died via some path
    // we don't yet model), still treat it as a crash.
    if (exited) return;
    const status = signalExitStatus(SIGSEGV);
    finalize(
      status,
      SIGSEGV,
      {
        source: "worker exit event",
        message:
          `[process-worker] pid=${pid} crashed ` +
          `(worker exit code=${code}, no exit message from wasm)`,
      },
    );
  });
  worker.on("message", (msg: unknown) => {
    const process = processes.get(pid);
    if (!process || process.worker !== worker) return;
    const m = msg as WorkerToHostMessage;
    if (m.type === "memory_quiescent" && m.tid === undefined) {
      // The browser entry emits this only after worker-main returns. Unlike
      // Browser Worker.terminate(), this is an exact-generation ownership
      // fence and can authorize dropping the allocator's strong reference.
      process.workerQuiescence.settle();
    }
    if (m.type === "exec_retired" && m.tid === undefined) {
      process.execRetirement.settle();
    }
    if (intentionallyTerminated.has(worker as object)) return;
    if (m.type === "error") {
      const signum = classifiedSignalOrFallback(m.message);
      const status = classifiedTrapExitStatus(m.message) ?? -1;
      finalize(
        status,
        signum,
        {
          source: "worker-main error message",
          message: `[process-worker] ${m.message ?? "unknown error"}`,
        },
      );
    } else if (m.type === "exit") {
      finalize(m.status ?? 0);
    } else if (m.type === "vm_interrupt_timer") {
      handleVmInterruptTimer(m, pid, process);
    }
  });
}

// ── Process lifecycle callbacks ──

async function handleFork(
  parentPid: number,
  childPid: number,
  parentMemory: WebAssembly.Memory,
  continuation: ForkContinuationContext,
): Promise<number[]> {
  const parentInfo = processes.get(parentPid);
  if (!parentInfo || parentInfo.memory !== parentMemory) {
    throw new Error(`Unknown parent generation for pid ${parentPid}`);
  }

  const ptrWidth = parentInfo.ptrWidth;
  const childLayout = parentInfo.layout;
  // WHY: teardown and compilation below yield. A sibling exec may then retire
  // the parent's exact generation, so the committed fork must own its clone
  // before the first await.
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
  try {
    await waitForProcessTeardowns();
    // Preserve fork's exact syscall-time snapshot before any await, then hold
    // only Worker launch until the retirement admission gate reopens.
    await processMemoryAllocator.waitForRetirementBacklogCapacity(
      childMemory.buffer.byteLength,
    );

    // Pre-compile module for TurboFan-optimized code (smaller stack frames).
    if (!parentInfo.programModule) {
      parentInfo.programModule = await WebAssembly.compile(parentInfo.programBytes);
    }
    if (!kernelWorker.shouldLaunchPendingChild(childPid)) {
      childMemoryLease.release();
      return [];
    }

    // Everything after acquire is one transaction. A copy, registration,
    // allocator, DeferredWorker, or listener failure must not strand the
    // backing outside explicit lease ownership.
    new Uint8Array(
      childMemory.buffer,
      childChannelOffset,
      CH_TOTAL_SIZE,
    ).fill(0);

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
    const childInitData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid: childPid,
      programBytes: parentInfo.programBytes,
      programModule: parentInfo.programModule,
      memory: childMemory,
      channelOffset: childChannelOffset,
      isForkChild: true,
      forkBufAddr: activeForkBufAddr,
      forkChildThreadFnPtr: forkReplayContext?.fnPtr,
      forkChildThreadArgPtr: forkReplayContext?.argPtr,
      ptrWidth,
      kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
    };

    childWorker = new DeferredWorkerHandle(
      () => workerAdapter.createWorker(childInitData),
    );
    const worker = childWorker;
    childGeneration = {
      generation: allocateProcessGeneration(),
      memory: childMemory,
      memoryLease: childMemoryLease,
      workerQuiescence: createWorkerQuiescence(),
      execRetirement: createWorkerQuiescence(),
      memoryRetirementSafe: true,
      framebufferExposed: false,
      programBytes: parentInfo.programBytes,
      programModule: parentInfo.programModule,
      worker,
      argv: parentInfo.argv,
      channelOffset: childChannelOffset,
      ptrWidth,
      layout: childLayout,
      threadAllocator: threadAllocatorForLayout(childLayout, ptrWidth, childPid),
      forkReplayContext,
    };
    processes.set(childPid, childGeneration);

    installProcessWorkerListeners(worker, childPid);
    const startDisposition = kernelWorker.startProcessWorkerWhenRunnable(
      childPid,
      childMemory,
      () => {
        workerStartAttempted = true;
        worker.start();
      },
      () => { void worker.terminate(); },
    );
    if (startDisposition === "stale") {
      throw new Error(`Fork child ${childPid} changed generation before Worker launch`);
    }
    if (startDisposition === "dead") {
      await worker.terminate();
      processes.get(childPid)?.workerQuiescence.settle();
      const signal = kernelWorker.finalizePendingChildTermination(childPid);
      lifecycleTeardownStarted = true;
      await awaitFinalizedProcessTeardown(
        childPid,
        signal > 0 ? signalExitStatus(signal) : 0,
        worker,
        signal > 0 ? signal : undefined,
      );
      return [];
    }
  } catch (error) {
    if (lifecycleTeardownStarted) throw error;
    if (childWorker) await terminateTrackedWorker(childWorker);
    const generation = childGeneration ?? {
      memory: childMemory,
      memoryLease: childMemoryLease,
    };
    const detachResult = await detachExactProcessGeneration({
      pid: childPid,
      generation,
      operation: registered ? "deactivate" : "none",
      retire: async (commit) => {
        const framebufferReleased = childGeneration
          ? await releaseMainFramebufferGeneration(childPid, childGeneration)
          : true;
        if (workerStartAttempted || !framebufferReleased) {
          childMemoryLease.releaseAfterForcedTermination();
        } else {
          childMemoryLease.release();
        }
        commit();
      },
    });
    if (detachResult.status !== "released") {
      reportRetainedProcessGeneration(
        childPid,
        "fork rollback",
        detachResult,
      );
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
  if (!kernelWorker.supportsExecMetadataReplacement()) return -38; // ENOSYS

  const resolved = await resolveExecutableForLaunch(path, argv);
  if (!resolved) return -2; // ENOENT
  if ("errno" in resolved) return -resolved.errno;
  const { programBytes: bytes, programModule, argv: launchArgv } = resolved;
  // Preallocate the replacement address space before the irreversible commit.
  const ptrWidth = detectPtrWidth(bytes);
  const metadataResult = kernelWorker.validateExecMetadata(
    launchArgv,
    envp,
    initiatingInfo.ptrWidth,
  );
  if (metadataResult < 0) return metadataResult;
  let prepared: Awaited<ReturnType<typeof createFreshProcessMemory>>;
  try {
    prepared = await createFreshProcessMemory(
      pid,
      bytes,
      ptrWidth,
      maxPages,
      {
      operation: "exec",
      path,
      argv: launchArgv,
      },
    );
  } catch (error) {
    if (error instanceof ProcessMemoryRetirementBacklogError) return -11;
    if (error instanceof ProcessMemoryCapacityError) return -12;
    throw error;
  }
  let preparedTransferred = false;
  let preparedLeaseConsumed = false;
  let replacementRegistered = false;
  let replacementStartAttempted = false;
  let oldMemoryRetirementSafe = false;
  let initiatingLeaseConsumed = false;

  // Resolution/compilation yielded to the event loop. Another exec may have
  // replaced the host execution generation for this persistent PID; a stale
  // continuation must not commit exec state against it.
  if (processes.get(pid) !== initiatingInfo
      || kernelWorker.isExecHandoffActive(pid)
      || !kernelWorker.isProcessExecutionActive(pid)) {
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
  let replacementWorker: ReturnType<BrowserWorkerAdapter["createWorker"]> | undefined;
  try {
    const setupResult = kernelWorker.kernelExecSetup(pid, callerTid);
    if (setupResult < 0) {
      prepared.memoryLease.release();
      return setupResult;
    }
    vmInterruptTimers.clear(pid, initiatingInfo);

    // Wake the exact old execution generation through the existing internal
    // SIGKILL path. worker-main recognizes the exec-retire marker, skips
    // SYS_EXIT for the persistent PID, returns, and lets worker-entry publish
    // the only browser-safe memory ownership fence.
    // Suppress ordinary crash/exit finalizers before the first retirement
    // wake. The persistent PID is already past exec's commit point, so an
    // error from the discarded generation must never kill the replacement.
    if (initiatingInfo.worker) {
      intentionallyTerminated.add(initiatingInfo.worker as object);
    }
    for (const thread of threadWorkers.get(pid) ?? []) {
      intentionallyTerminated.add(thread.worker as object);
    }
    const retiredOffsets =
      kernelWorker.wakeProcessWorkersForExecRetirement(
        pid,
        initiatingInfo.memory,
      );
    const mainRetirementStarted = retiredOffsets.has(
      initiatingInfo.channelOffset,
    );
    threadedProcessPids.delete(pid);
    if (!kernelWorker.prepareProcessForExec(pid, initiatingInfo.memory)) {
      throw new Error(`Exec pid ${pid} changed generation during commit`);
    }

    const finalizeResult = kernelWorker.finalizeAddressSpaceForExec(pid);
    if (finalizeResult < 0) {
      throw new Error("failed to detach the discarded address space");
    }

    const [mainQuiescent, threadsQuiescent] = await Promise.all([
      mainRetirementStarted
        ? waitForExecRetirement(
            initiatingInfo.execRetirement,
            initiatingInfo.workerQuiescence,
          )
        : Promise.resolve(false),
      terminateThreadWorkers(pid, true),
    ]);
    if (initiatingInfo.worker) {
      intentionallyTerminated.add(initiatingInfo.worker as object);
      await initiatingInfo.worker.terminate().catch(() => {});
    }
    if (mainQuiescent) {
      // Thread fences retire their own exact listeners during slot reclaim.
      // Settle the main channel independently so one unresponsive sibling
      // cannot retain an otherwise finished waitAsync closure.
      await kernelWorker.settleRetiredChannelListeners(
        pid,
        initiatingInfo.memory,
        initiatingInfo.channelOffset,
      );
    }
    const mainFramebufferReleased =
      await releaseMainFramebufferGeneration(pid, initiatingInfo);
    oldMemoryRetirementSafe =
      mainQuiescent
      && threadsQuiescent
      && initiatingInfo.memoryRetirementSafe
      && mainFramebufferReleased;
    const handoffExitSignal =
      kernelWorker.finalizeExecHandoffTermination(pid);
    if (handoffExitSignal > 0) {
      prepared.memoryLease.release();
      preparedLeaseConsumed = true;
      await awaitFinalizedProcessTeardown(
        pid,
        signalExitStatus(handoffExitSignal),
        initiatingInfo.worker,
        handoffExitSignal,
      );
      return 0;
    }

    // DIAGNOSTIC: track pid → exec path so the sysprof dump can name
    // each pid (otherwise the table is just opaque numbers).
    {
      const g = globalThis as { __pidMap?: Map<number, string> };
      if (!g.__pidMap) g.__pidMap = new Map();
      g.__pidMap.set(pid, path);
    }
    const {
      memory: newMemory,
      memoryLease: newMemoryLease,
      layout: newLayout,
      threadAllocator: newThreadAllocator,
    } = prepared;
    const newChannelOffset = newLayout.channelOffset;

    const execInitData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid,
      programBytes: bytes,
      programModule,
      memory: newMemory,
      channelOffset: newChannelOffset,
      argv: launchArgv,
      env: envp,
      ptrWidth,
      kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
    };

    replacementWorker = new DeferredWorkerHandle(
      () => workerAdapter.createWorker(execInitData),
    );
    kernelWorker.registerProcess(pid, newMemory, [newChannelOffset], {
      preserveProcessState: true,
      ptrWidth,
      metadataPtrWidth: initiatingInfo.ptrWidth,
      brkBase: newLayout.brkBase,
      mmapBase: newLayout.mmapBase,
      maxAddr: newLayout.maxAddr,
      // Refresh kernel-owned argv/environment for procfs and kernel APIs.
      argv: launchArgv,
      env: envp,
    });
    replacementRegistered = true;

    // Clear cached thread module — the new program binary is different
    threadModuleCache.delete(pid);

    processes.set(pid, {
      generation: allocateProcessGeneration(),
      memory: newMemory,
      memoryLease: newMemoryLease,
      workerQuiescence: createWorkerQuiescence(),
      execRetirement: createWorkerQuiescence(),
      memoryRetirementSafe: true,
      framebufferExposed: false,
      programBytes: bytes,
      programModule,
      worker: replacementWorker,
      argv: launchArgv,
      channelOffset: newChannelOffset,
      ptrWidth,
      layout: newLayout,
      threadAllocator: newThreadAllocator,
    });
    preparedTransferred = true;

    if (oldMemoryRetirementSafe) initiatingInfo.memoryLease.release();
    else initiatingInfo.memoryLease.releaseAfterForcedTermination();
    initiatingLeaseConsumed = true;

    // Wire post-exec error/exit handling. The handleFork listener (on the
    // pre-exec worker) is gone with the terminated worker; without re-arming
    // here, a wasm trap in the exec'd binary leaves waitpid blocked forever.
    installProcessWorkerListeners(replacementWorker, pid);
    const startDisposition = kernelWorker.startProcessWorkerWhenRunnable(
      pid,
      newMemory,
      () => {
        replacementStartAttempted = true;
        (replacementWorker as DeferredWorkerHandle).start();
      },
      () => { void replacementWorker?.terminate(); },
    );
    if (startDisposition === "stale") {
      throw new Error(`Exec pid ${pid} changed generation before Worker launch`);
    }
    if (startDisposition === "dead") {
      // startProcessWorkerWhenRunnable proved that the replacement Worker was
      // never started. Publish the equivalent ownership fence so the ordinary
      // exit teardown can retire listeners and release its lease safely.
      processes.get(pid)?.workerQuiescence.settle();
      kernelWorker.finishProcessExecHandoff(pid);
      const signal = kernelWorker.finalizeExecHandoffTermination(pid);
      await awaitFinalizedProcessTeardown(
        pid,
        signal > 0 ? signalExitStatus(signal) : 0,
        replacementWorker,
        signal > 0 ? signal : undefined,
      );
      return 0;
    }
    kernelWorker.finishProcessExecHandoff(pid);
    return 0;
  } catch (err) {
    if (initiatingInfo.worker) {
      intentionallyTerminated.add(initiatingInfo.worker as object);
    }
    threadedProcessPids.delete(pid);
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
        retire: (commit) => {
          if (replacementStartAttempted) {
            prepared.memoryLease.releaseAfterForcedTermination();
          } else {
            prepared.memoryLease.release();
          }
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
      if (oldMemoryRetirementSafe) {
        initiatingInfo.memoryLease.release();
      } else {
        initiatingInfo.memoryLease.releaseAfterForcedTermination();
      }
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
    try { kernelWorker.notifyHostProcessCrashed(pid, SIGSEGV); } catch { /* best-effort */ }
    handleExit(pid, signalExitStatus(SIGSEGV), SIGSEGV);
    return 0;
  }
}

/**
 * Handle SYS_SPAWN (non-forking posix_spawn) on the browser host.
 *
 * The kernel has already constructed the child Process descriptor under
 * `childPid` with attrs and file actions applied. This callback receives the
 * preflight's compiled program, allocates a fresh Memory for the child, and
 * attaches it to the Process the kernel already created, and spawns a Worker.
 *
 * Distinct from handleExec (which replaces the calling worker) and
 * handleFork (which clones the parent's Memory): this always creates a
 * fresh Memory and runs the new program from `_start`.
 *
 * Mirrors handlePosixSpawn in host/src/node-kernel-worker-entry.ts —
 * per CLAUDE.md the two hosts must move in lockstep.
 *
 * Returns 0 on success, negative errno on failure.
 */
/**
 * Pre-flight resolver — see node-kernel-worker-entry.ts:handlePosixSpawnResolve.
 * Browser-side equivalent: materialize the lazy file (async fetch via
 * the memfs lazy-loader, avoiding sync-XHR + SW deadlocks), reads its
 * contents from the VFS, follows shebangs, and compiles the final Wasm
 * module. Safe to call before the kernel applies spawn file actions.
 */
async function handlePosixSpawnResolve(
  path: string,
  argv: string[],
): Promise<SpawnProgramResolution | null> {
  return resolveExecutableForLaunch(path, argv);
}

/**
 * Launch a worker for a SYS_SPAWN child whose program has already been
 * resolved and compiled by `handlePosixSpawnResolve`. Mirrors the Node
 * entry's `handlePosixSpawn`.
 */
async function handlePosixSpawn(
  parentPid: number,
  childPid: number,
  program: ResolvedSpawnProgram,
  envp: string[],
): Promise<number> {
  await waitForProcessTeardowns();

  // Unrelated teardown waits yield to the event loop. Keep a successfully
  // created zombie, but never resurrect it with a new Worker.
  if (!kernelWorker.shouldLaunchPendingChild(childPid)) return 0;
  post({ type: "proc_event", kind: "spawn", pid: childPid, ppid: parentPid });

  const { programBytes, programModule, argv } = program;
  const ptrWidth = detectPtrWidth(programBytes);
  let fresh: Awaited<ReturnType<typeof createFreshProcessMemory>>;
  try {
    fresh = await createFreshProcessMemory(
      childPid,
      programBytes,
      ptrWidth,
      maxPages,
      {
        operation: "posix_spawn",
        path: argv[0],
        argv,
      },
    );
  } catch (error) {
    if (error instanceof ProcessMemoryRetirementBacklogError) {
      return -11; // EAGAIN
    }
    if (error instanceof ProcessMemoryCapacityError) return -12; // ENOMEM
    throw error;
  }
  const {
    memory: newMemory,
    memoryLease,
    layout: newLayout,
    threadAllocator,
  } = fresh;
  // Allocation admission yielded. Do not resurrect a child that exited or was
  // killed while the short retirement admission gate drained.
  if (!kernelWorker.shouldLaunchPendingChild(childPid)) {
    memoryLease.release();
    return 0;
  }
  const newChannelOffset = newLayout.channelOffset;
  let newWorker: DeferredWorkerHandle | undefined;
  let registered = false;
  let workerStartAttempted = false;
  let lifecycleTeardownStarted = false;
  let childGeneration: ProcessInfo | undefined;
  try {
    // Kernel already created the child via kernel_spawn_process. Treat every
    // subsequent host attachment as one rollback-capable transaction.
    kernelWorker.registerProcess(childPid, newMemory, [newChannelOffset], {
      ptrWidth,
      brkBase: newLayout.brkBase,
      mmapBase: newLayout.mmapBase,
      maxAddr: newLayout.maxAddr,
    });
    registered = true;

    const initData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid: childPid,
      programBytes,
      programModule,
      memory: newMemory,
      channelOffset: newChannelOffset,
      argv,
      env: envp,
      ptrWidth,
      kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
    };

    newWorker = new DeferredWorkerHandle(
      () => workerAdapter.createWorker(initData),
    );
    const worker = newWorker;
    childGeneration = {
      generation: allocateProcessGeneration(),
      memory: newMemory,
      memoryLease,
      workerQuiescence: createWorkerQuiescence(),
      execRetirement: createWorkerQuiescence(),
      memoryRetirementSafe: true,
      framebufferExposed: false,
      programBytes,
      programModule,
      worker,
      argv,
      channelOffset: newChannelOffset,
      ptrWidth,
      layout: newLayout,
      threadAllocator,
    };
    processes.set(childPid, childGeneration);

    installProcessWorkerListeners(worker, childPid);
    const startDisposition = kernelWorker.startProcessWorkerWhenRunnable(
      childPid,
      newMemory,
      () => {
        workerStartAttempted = true;
        worker.start();
      },
      () => { void worker.terminate(); },
    );
    if (startDisposition === "stale") {
      throw new Error(`Spawn child ${childPid} changed generation before Worker launch`);
    }
    if (startDisposition === "dead") {
      await worker.terminate();
      processes.get(childPid)?.workerQuiescence.settle();
      const signal = kernelWorker.finalizePendingChildTermination(childPid);
      lifecycleTeardownStarted = true;
      await awaitFinalizedProcessTeardown(
        childPid,
        signal > 0 ? signalExitStatus(signal) : 0,
        worker,
        signal > 0 ? signal : undefined,
      );
      return 0;
    }
  } catch (error) {
    if (lifecycleTeardownStarted) throw error;
    if (newWorker) await terminateTrackedWorker(newWorker);
    const generation = childGeneration ?? { memory: newMemory, memoryLease };
    const detachResult = await detachExactProcessGeneration({
      pid: childPid,
      generation,
      operation: registered ? "deactivate" : "none",
      retire: async (commit) => {
        const framebufferReleased = childGeneration
          ? await releaseMainFramebufferGeneration(childPid, childGeneration)
          : true;
        if (workerStartAttempted || !framebufferReleased) {
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

async function handleClone(
  attachment: ThreadChannelAttachment,
): Promise<void> {
  const { pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory } =
    attachment;
  const processInfo = processes.get(pid);
  if (!processInfo) throw new Error(`Unknown pid ${pid} for clone`);
  threadedProcessPids.add(pid);

  // Auto-compile thread module if not already cached.
  // The cache is per-PID so each process's module is compiled once and reused
  // for all its threads. Async compilation is fine since clone() blocks on the channel.
  // We keep this separate from processInfo.programModule (which is the unpatched
  // module used for fork children) to avoid conflating the two.
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
  if (!isCurrentProcessGeneration(
    processes,
    pid,
    processInfo,
    memory,
    kernelWorker.isExecHandoffActive(pid),
  ) || !kernelWorker.isProcessExecutionActive(pid)) {
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

  // Register fnPtr/argPtr so handleFork can route a fork() from this
  // thread back through its entry point. Mirrors handleClone in
  // host/src/node-kernel-worker-entry.ts.
  try {
    kernelWorker.attachThreadChannel(attachment, alloc.channelOffset);
  } catch (err) {
    processInfo.threadAllocator.free(alloc.basePage);
    throw err;
  }

  const threadInitData: CentralizedThreadInitMessage = {
    type: "centralized_thread_init",
    pid,
    tid,
    programBytes: processInfo.programBytes,
    programModule: threadModule,
    memory,
    processChannelOffset: processInfo.channelOffset,
    channelOffset: alloc.channelOffset,
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

  const threadWorker = new DeferredWorkerHandle(
    () => workerAdapter.createWorker(threadInitData),
  );
  if (!threadWorkers.has(pid)) threadWorkers.set(pid, []);
  const threadEntry: ThreadWorkerInfo = {
    worker: threadWorker,
    channelOffset: alloc.channelOffset,
    tid,
    basePage: alloc.slotStartPage,
    quiescent: false,
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
    if (threadEntry.quiescent) {
      // The browser entry returned from worker-main before publishing this
      // fence, so neither guest code nor its Worker can race slot reuse.
      await kernelWorker.settleRetiredChannelListeners(
        pid,
        memory,
        alloc.channelOffset,
      );
      processInfo.threadAllocator.free(alloc.basePage);
    } else {
      // Hard browser termination is not a quiescence barrier. Keep the slot
      // and ultimately prevents safe retirement of the process backing.
      processInfo.memoryRetirementSafe = false;
    }
    if (belongsToCurrentProcessImage()) {
      threadExits.release(pid, alloc.channelOffset);
    }
    removeThreadWorkerRegistryEntry(threadWorkers, pid, threadEntry);
  };
  const terminateThreadEntry = (): Promise<void> => {
    if (!threadEntry.termination) {
      threadEntry.termination = terminateTrackedWorker(
        threadWorker,
        THREADED_WORKER_TERMINATION_SETTLE_MS,
      ).then(reclaimThread);
    }
    return threadEntry.termination;
  };
  threadExits.register(pid, alloc.channelOffset, terminateThreadEntry);

  const isCurrentThreadGeneration = () =>
    !intentionallyTerminated.has(threadWorker as object)
    && belongsToCurrentProcessImage();
  const failThread = (reason: string, awaitQuiescence = false) => {
    if (!isCurrentThreadGeneration()) {
      void terminateThreadEntry();
      return;
    }
    const disposition = threadWorkerFailureDisposition(reason);
    reportHostDiagnostic({
      pid,
      status: disposition.kind === "guest-fatal-trap"
        ? disposition.exitStatus
        : undefined,
      source: "thread worker failure",
      message: `[kernel-worker] pid=${pid} tid=${tid}: ${reason}`,
    });
    kernelWorker.finalizeThreadExit(pid, tid, alloc.channelOffset);
    if (!awaitQuiescence) void terminateThreadEntry();
    if (disposition.kind === "guest-fatal-trap") {
      handleExit(pid, disposition.exitStatus, disposition.signum);
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
      // The browser wrapper publishes memory_quiescent after worker-main
      // returns. Do not turn this earlier semantic exit into a retirement fence.
    } else if (m.type === "memory_quiescent" && m.tid === tid) {
      threadEntry.quiescent = true;
      threadEntry.workerQuiescence.settle();
      void terminateThreadEntry();
    } else if ((m as { type?: string }).type === "error") {
      // worker-main posted {type:"error"} — instantiation failure, top-level
      // throw, etc. Without this the parent's pthread_join blocks forever.
      failThread(
        (m as { message?: string }).message ?? "thread error",
        true,
      );
    } else if (m.type === "vm_interrupt_timer") {
      if (!isCurrentThreadGeneration() || m.pid !== pid) return;
      handleVmInterruptTimer(m, pid, processInfo);
    }
  });
  threadWorker.on("error", (err: Error) => {
    failThread(`worker error: ${err.message ?? err}`);
  });

  let startDisposition: ReturnType<
    CentralizedKernelWorker["startProcessWorkerWhenRunnable"]
  >;
  try {
    startDisposition = kernelWorker.startProcessWorkerWhenRunnable(
      pid,
      memory,
      () => { threadWorker.start(); },
      () => { void threadWorker.terminate(); },
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
    throw new Error(`Process ${pid} changed generation before thread Worker launch`);
  }

}

function handleThreadExit(pid: number, channelOffset: number): boolean {
  // The kernel has completed the exit syscall, but the browser Worker may not
  // yet have resumed from Atomics.wait. The worker-entry memory_quiescent
  // message, not Worker.terminate(), authorizes slot reclamation.
  void pid;
  void channelOffset;
  return true;
}

function signalFromExitStatus(exitStatus: number): number | null {
  return exitStatus >= 128 ? (exitStatus - 128) & 0x7f : null;
}

function handleExit(
  pid: number,
  exitStatus: number,
  crashSignum?: number,
  expectedWorker = processes.get(pid)?.worker,
): void {
  void finishProcessExit(pid, exitStatus, crashSignum, expectedWorker);
}

async function finishProcessExit(
  pid: number,
  exitStatus: number,
  crashSignum: number = signalFromExitStatus(exitStatus) ?? SIGSEGV,
  expectedWorker = processes.get(pid)?.worker,
): Promise<void> {
  if (!expectedWorker) return;
  const info = processes.get(pid);
  if (!info || info.worker !== expectedWorker) return;
  if (processTeardowns.has(expectedWorker)) return;
  vmInterruptTimers.clear(pid, info);

  const threadedSettleMs = threadedProcessPids.has(pid)
    ? THREADED_WORKER_TERMINATION_SETTLE_MS
    : 0;
  const settleMs = Math.max(
    threadedSettleMs,
    processWorkerTerminationSettleMs(info?.argv),
  );
  threadedProcessPids.delete(pid);

  const teardown = (async () => {
    // Synthesize a signal-style reap *before* `deactivateProcess` in
    // case the worker died without sending SYS_EXIT_GROUP (uncaught
    // wasm trap -> onerror, worker-main `{type:"error"}` -> finalize(-1),
    // externally terminated Worker -> "exit" event). Without this, a
    // concurrent waitpid in the parent blocks until destroy because
    // the kernel never marked the child as a zombie. Idempotent via
    // `hostReaped`: when the kernel already processed a clean
    // SYS_EXIT_GROUP for this pid, this is a no-op. Mirrors
    // `finalizeProcessWorker` in host/src/node-kernel-worker-entry.ts.
    try { kernelWorker.notifyHostProcessCrashed(pid, crashSignum); } catch { /* best-effort */ }

    // Keep the pid registered until the process worker is gone. musl's
    // _Exit() loops on SYS_exit after SYS_exit_group returns; while worker
    // termination is in flight those duplicate exits still need channel
    // completions, otherwise the worker can park in Atomics.wait with no
    // registered listener left to wake it.
    const workerQuiescent = await waitForWorkerQuiescence(
      info.workerQuiescence,
    );
    const threadsQuiescent = await terminateThreadWorkers(pid);
    await terminateTrackedWorker(expectedWorker, settleMs);

    // Check if this is a "top-level" process or a fork child. For now,
    // always deactivate after worker termination; the main thread tracks
    // exit promises, and no further guest syscalls can arrive on this
    // channel once the worker is gone.
    const detachResult = await detachExactProcessGeneration({
      pid,
      generation: info,
      operation: "deactivate",
      retire: async (commit) => {
        const mainFramebufferReleased =
          await releaseMainFramebufferGeneration(pid, info);
        if (
          workerQuiescent
          && threadsQuiescent
          && info.memoryRetirementSafe
          && mainFramebufferReleased
        ) {
          info.memoryLease.release();
        } else {
          // Browser Worker.terminate() returns before the underlying Worker
          // has necessarily stopped. A missing terminal fence uses forced
          // retirement; the backing is never handed to another process.
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

    if (!detachResult.mayReapPid) return;
    try {
      reapHostOwnedExitedProcess(kernelInstance, pid);
    } catch (error) {
      reportHostDiagnostic({
        pid,
        status: exitStatus,
        source: "host-owned process reap",
        message:
          `[browser-kernel-worker] failed to reap completed host-owned pid ${pid}: ` +
          formatError(error),
      });
    }
  })();
  processTeardowns.set(expectedWorker, teardown);

  post({
    type: "exit",
    pid,
    generation: info.generation,
    status: exitStatus,
  });

  try {
    await teardown;
  } finally {
    processTeardowns.delete(expectedWorker);
  }
}

// ── Terminate ──

// Read a file out of the kernel-owned VFS and return its bytes (or null if it
// does not exist / is not readable). Used by demos that collect artifacts a
// process wrote (e.g. sqlite-test's result DB/logs) without sharing the live
// VFS SharedArrayBuffer with the main thread.
async function handleReadVfsFile(
  msg: Extract<MainToKernelMessage, { type: "read_vfs_file" }>,
) {
  if (!io) { respond(msg.requestId, null); return; }
  let releaseMutation: (() => void) | undefined;
  try {
    // A read can materialize a lazy file/tree and is therefore serialized
    // with snapshots even though an already-materialized read is non-mutating.
    releaseMutation = rootfsSnapshotGate.beginMutation(
      "read or materialize a rootfs file",
    );
    const { data, stat } = await readPreparedPlatformFile(io, msg.path);
    if ((stat.mode & 0o170000) !== 0o100000) {
      respond(msg.requestId, null);
      return;
    }
    // Copy into a plain (non-shared) ArrayBuffer so it structured-clones back.
    const result = data.slice();
    respond(
      msg.requestId,
      msg.includeMode ? { data: result, mode: stat.mode & 0o7777 } : result,
    );
  } catch (error) {
    if (isMissingPathError(error)) respond(msg.requestId, null);
    else respondError(msg.requestId, formatError(error));
  } finally {
    releaseMutation?.();
  }
}

// Mutate the mounted filesystem from inside its owning worker. This keeps the
// VFS SAB off the persistent browser main thread while allowing harnesses to
// stage transient files between process spawns.
function handleWriteVfsFile(msg: Extract<MainToKernelMessage, { type: "write_vfs_file" }>) {
  if (!io) { respondError(msg.requestId, "VFS is not initialized"); return; }
  let releaseMutation: (() => void) | undefined;
  let fd: number | null = null;
  try {
    releaseMutation = rootfsSnapshotGate.beginMutation("write a rootfs file");
    fd = io.open(msg.path, 0o1101 /* O_WRONLY|O_CREAT|O_TRUNC */, msg.mode & 0o7777);
    let offset = 0;
    while (offset < msg.data.byteLength) {
      const written = io.write(
        fd,
        msg.data.subarray(offset),
        null,
        msg.data.byteLength - offset,
      );
      if (written <= 0) {
        throw new Error(`Short write while staging ${msg.path}`);
      }
      offset += written;
    }
    io.close(fd);
    fd = null;
    // open(O_CREAT) preserves an existing file's mode. Apply the caller's
    // requested mode explicitly so replacement and creation behave alike.
    io.chmod(msg.path, msg.mode & 0o7777);
    respond(msg.requestId, true);
  } catch (err) {
    if (fd !== null) {
      try { io.close(fd); } catch { /* preserve the original failure */ }
    }
    respondError(msg.requestId, formatError(err));
  } finally {
    releaseMutation?.();
  }
}

function handleUnlinkVfsFile(msg: Extract<MainToKernelMessage, { type: "unlink_vfs_file" }>) {
  if (!io) { respondError(msg.requestId, "VFS is not initialized"); return; }
  let releaseMutation: (() => void) | undefined;
  try {
    releaseMutation = rootfsSnapshotGate.beginMutation("unlink a rootfs file");
    try {
      io.lstat(msg.path);
    } catch {
      respond(msg.requestId, false);
      return;
    }
    io.unlink(msg.path);
    respond(msg.requestId, true);
  } catch (err) {
    respondError(msg.requestId, formatError(err));
  } finally {
    releaseMutation?.();
  }
}

async function handleExportRootfsImage(
  msg: Extract<MainToKernelMessage, { type: "export_rootfs_image" }>,
) {
  if (!memfs) {
    respondError(msg.requestId, "VFS is not initialized");
    return;
  }
  if (!initReady) {
    respondError(msg.requestId, "rootfs export requires an initialized kernel");
    return;
  }
  try {
    const image = await rootfsSnapshotGate.runSnapshot(async () => {
      if (
        processes.size !== 0 ||
        processTeardowns.size !== 0 ||
        workerTeardowns.size !== 0
      ) {
        throw new Error(
          "rootfs export requires a quiescent kernel with no live or tearing-down processes",
        );
      }
      return memfs.saveImage();
    });
    respondTransferredBytes(msg.requestId, image);
  } catch (error) {
    respondError(msg.requestId, formatError(error));
  }
}

async function handleTerminateProcess(msg: Extract<MainToKernelMessage, { type: "terminate_process" }>) {
  const pid = msg.pid;
  const info = processes.get(pid);
  if (info) vmInterruptTimers.clear(pid, info);

  // Terminate thread workers
  const threads = threadWorkers.get(pid);
  if (threads) {
    for (const t of threads) {
      await (
        t.termination ??
        terminateTrackedWorker(t.worker, THREADED_WORKER_TERMINATION_SETTLE_MS)
      );
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
    const detachResult = await detachExactProcessGeneration({
      pid,
      generation: info,
      operation: "unregister",
      retire: async (commit) => {
        await releaseMainFramebufferGeneration(pid, info);
        // terminate_process has no terminal worker message, so its backing
        // uses forced retirement and is never reused.
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
        `failed to unregister unknown pid ${pid}: ${formatError(error)}`,
      );
      return;
    }
    threadModuleCache.delete(pid);
    threadedProcessPids.delete(pid);
    ptyByPid.delete(pid);
  }
  respond(msg.requestId, true);
}

// ── Pipe operations ──

function handlePipeRead(msg: Extract<MainToKernelMessage, { type: "pipe_read" }>) {
  if (!initReady) {
    respond(msg.requestId, uninitializedKernelPipeResult("read"));
    return;
  }
  respond(msg.requestId, kernelWorker.readHostPipe(msg.pid, msg.pipeIdx));
}

function handlePipeWrite(msg: Extract<MainToKernelMessage, { type: "pipe_write" }>) {
  if (!initReady) {
    respond(msg.requestId, uninitializedKernelPipeResult("write"));
    return;
  }
  respond(
    msg.requestId,
    kernelWorker.writeHostPipe(msg.pid, msg.pipeIdx, msg.data),
  );
}

function handlePipeCloseRead(msg: Extract<MainToKernelMessage, { type: "pipe_close_read" }>) {
  if (!initReady) return;
  kernelWorker.closeHostPipeRead(msg.pid, msg.pipeIdx);
}

function handlePipeCloseWrite(msg: Extract<MainToKernelMessage, { type: "pipe_close_write" }>) {
  if (!initReady) return;
  kernelWorker.closeHostPipeWrite(msg.pid, msg.pipeIdx);
}

function handlePipeIsWriteOpen(msg: Extract<MainToKernelMessage, { type: "pipe_is_write_open" }>) {
  if (!initReady) {
    respond(msg.requestId, uninitializedKernelPipeResult("is-write-open"));
    return;
  }
  respond(
    msg.requestId,
    kernelWorker.isHostPipeWriteOpen(msg.pid, msg.pipeIdx),
  );
}

function handleInjectConnection(msg: Extract<MainToKernelMessage, { type: "inject_connection" }>) {
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

function handleWakeBlockedReaders(msg: Extract<MainToKernelMessage, { type: "wake_blocked_readers" }>) {
  if (!initReady) return;
  kernelWorker.wakeHostPipeReaders(msg.pipeIdx);
}

function handleWakeBlockedWriters(msg: Extract<MainToKernelMessage, { type: "wake_blocked_writers" }>) {
  if (!initReady) return;
  kernelWorker.wakeHostPipeWriters(msg.pipeIdx);
}

function handleIsStdinConsumed(msg: Extract<MainToKernelMessage, { type: "is_stdin_consumed" }>) {
  if (!initReady) {
    respond(msg.requestId, false);
    return;
  }
  const kw = kernelWorker as any;
  respond(msg.requestId, kw.stdinFinite.has(msg.pid) && !kw.stdinBuffers.has(msg.pid));
}

function handlePickListenerTarget(msg: Extract<MainToKernelMessage, { type: "pick_listener_target" }>) {
  if (!initReady) {
    respond(msg.requestId, uninitializedKernelPipeResult("pick-listener"));
    return;
  }
  respond(msg.requestId, kernelWorker.pickListenerTarget(msg.port));
}

async function performDestroy() {
  // Phase 1 — wake every Atomics.wait-blocked worker so it cooperatively exits.
  // [JSC-TERMINATE-ATOMICS-WAIT-LEAK] — WORKAROUND, remove when the engine bug is
  // fixed; see docs/jsc-terminate-atomics-wait-workaround.md.
  // On JSC (Safari, and Bun), `Worker.terminate()` cannot kill (or free the
  // memory of) a worker parked in `Atomics.wait` on its syscall channel — the
  // state every idle/blocked process worker sits in — so terminating them
  // directly leaks their threads + committed working set and each image switch
  // OOMs Safari. killAllBlockedForTeardown completes each blocked syscall with
  // EINTR + a queued SIGKILL; the guest glue then runs kernel_exit, the worker
  // returns to its JS event loop (via {exit}), and it becomes reclaimable. A
  // no-op cost on V8 (Chrome), so it runs unconditionally.
  let woken = new Set<number>();
  try { woken = kernelWorker.killAllBlockedForTeardown(); } catch (e) {
    console.error(`[kernel-worker] killAllBlockedForTeardown failed: ${e}`);
  }

  // Phase 2 — drain. The woken workers run their exit path and post `{exit}`,
  // which fires handleExit → removes them from `processes` and terminates them
  // while idle (reclaimed). Wait only for the pids we woke — a process we did
  // not wake (e.g. one already exited via a sibling thread) never posts `{exit}`
  // and is force-terminated below instead of waited on. Bounded.
  const drainDeadline = Date.now() + DESTROY_KILL_DRAIN_TIMEOUT_MS;
  const stillDraining = () => {
    for (const pid of woken) if (processes.has(pid)) return true;
    return false;
  };
  while (stillDraining() && Date.now() < drainDeadline) {
    await delay(DESTROY_KILL_DRAIN_POLL_MS);
  }
  if (stillDraining()) {
    console.warn(`[kernel-worker] destroy drain timed out with woken process(es) still live; force-terminating`);
  }

  // Phase 3 — terminate any stragglers (non-blocked workers, or any that
  // didn't exit in time) + thread workers, then clear every per-pid map.
  // Mirrors performDestroy in node-kernel-worker-entry.ts — without the
  // threadWorkers / ptyByPid clears, those maps stay populated across kernel
  // rebuilds (e.g. iframe reload) and leak.
  const retireCurrentGenerations = async (): Promise<void> => {
    for (const [pid, info] of [...processes.entries()]) {
      if (info.worker) {
        await terminateThreadWorkers(pid);
        await terminateTrackedWorker(info.worker);
      }
      const detachResult = await detachExactProcessGeneration({
        pid,
        generation: info,
        operation: "unregister",
        retire: async (commit) => {
          await releaseMainFramebufferGeneration(pid, info);
          info.memoryLease.releaseAfterForcedTermination();
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
  for (const threads of threadWorkers.values()) {
    for (const t of threads) {
      await (
        t.termination ??
        terminateTrackedWorker(t.worker, THREADED_WORKER_TERMINATION_SETTLE_MS)
      );
    }
  }
  await waitForProcessTeardowns();
  // A process teardown can yield while exec installs a successor. Sweep the
  // exact current objects and retry only transactions whose phase threw.
  await retireCurrentGenerations();
  const retryResults = await processGenerationDetaches.retryPending();
  for (const result of retryResults) {
    if (result.status !== "released") {
      console.warn(
        "[browser-kernel-worker] destroy retained an exact process generation: " +
        formatError(result.error),
      );
    }
  }
  vmInterruptTimers.clearAll();
  // The enclosing creator gate is closed and drained, so this exact map/ledger
  // state cannot be invalidated by a later spawn/exec/fork/clone continuation.
  let gracefulDetachComplete =
    processGenerationDetaches.pendingCount === 0 && processes.size === 0;
  threadModuleCache.clear();
  threadWorkers.clear();
  threadedProcessPids.clear();
  ptyByPid.clear();
  initReady = false;
  initFailure = "kernel worker destroyed";
  failPendingLazyRegistrations(initFailure);
  if (gracefulDetachComplete) {
    try {
      processMemoryAllocator.clear();
    } catch (error) {
      gracefulDetachComplete = false;
      console.warn(
        "[browser-kernel-worker] process memory allocator retained an unsafe " +
        `lease during destroy: ${formatError(error)}`,
      );
    }
  }
  if (!gracefulDetachComplete) {
    console.warn(
      "[browser-kernel-worker] destroy retained exact process-generation " +
      "ownership; terminating this kernel Worker realm is the final release " +
      "fallback",
    );
  }
  return kernelRealmDestroyResult(gracefulDetachComplete);
}

async function handleDestroy(
  msg: Extract<MainToKernelMessage, { type: "destroy" }>,
) {
  // WHY: browser message and syscall callbacks overlap whenever an async
  // handler yields. The shared gate closes admission synchronously, drains
  // every creator already in flight, and runs this terminal sweep only once.
  // Browser main still terminates this whole worker realm on timeout.
  const result = await processMemoryCreators.closeAndRunAfterDrain(
    performDestroy,
  );
  respond(msg.requestId, result);
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

function handleMouseInject(msg: Extract<MainToKernelMessage, { type: "mouse_inject" }>) {
  kernelWorker.injectMouseEvent(msg.dx, msg.dy, msg.buttons);
}

/**
 * Drain up to `maxBytes` from the kernel's `/dev/dsp` ring and post the
 * bytes back to the main thread. The main thread's AudioContext
 * scheduler decodes them into an `AudioBuffer` using
 * (sampleRate, channels) reported by the same call so a runtime config
 * change (`SNDCTL_DSP_SPEED`) is picked up on the next drain.
 */
function handleAudioDrain(msg: Extract<MainToKernelMessage, { type: "audio_drain" }>) {
  const cap = Math.min(msg.maxBytes, 65536);
  const buf = new Uint8Array(cap);
  const n = kernelWorker.drainAudio(buf);
  const sampleRate = kernelWorker.audioSampleRate();
  const channels = kernelWorker.audioChannels();
  // Slice to the actual drained length and transfer the underlying
  // ArrayBuffer so we don't pay a copy fee for the worker → main hop.
  const out = n > 0 ? buf.slice(0, n) : new Uint8Array(0);
  post(
    {
      type: "response",
      requestId: msg.requestId,
      result: { bytes: out, sampleRate, channels },
    },
    [out.buffer],
  );
}

function handleRegisterPtyOutput(msg: Extract<MainToKernelMessage, { type: "register_pty_output" }>) {
  const ptyIdx = ptyByPid.get(msg.pid);
  if (ptyIdx === undefined) return;
  kernelWorker.onPtyOutput(ptyIdx, (data: Uint8Array) => {
    post({ type: "pty_output", pid: msg.pid, data });
  });
}

// ── HTTP request bridge (runs inside kernel worker) ──
//
// Two callers:
//   1. The service-worker MessagePort (bridgePort) — for browser pages whose
//      fetch events are intercepted by a service worker.
//   2. The main thread via the `http_request` message — for direct
//      programmatic access without going through a service worker.
//
// Both end up calling kernelWorker.sendHttpRequest() with the same shape.

async function handleHttpRequest(requestId: number, request: any) {
  if (!kernelInstance || !bridgePort) return;
  const portRef = bridgePort;
  const activityId = beginBridgeRequest();
  const url = request.url || "?";

  try {
    // Resolve the port to dispatch to. The SW bridge configures one
    // bridgeTargetPort per page; if not set, fall back to the first
    // registered listener (matches earlier behavior).
    let port = bridgeTargetPort;
    if (port == null) {
      const ports: number[] = Array.from(
        (kernelWorker as any).tcpListenerTargets?.keys() ?? [],
      );
      port = ports[0] ?? null;
    }
    if (port == null) {
      console.warn(`[bridge] no listener target for req#${requestId} ${url}`);
      portRef.postMessage({
        type: "http-error",
        requestId,
        error: "No listener target available",
      });
      return;
    }

    console.debug(`[bridge] req#${requestId} ${request.method} ${url} -> port=${port}`);
    const response = await kernelWorker.sendHttpRequest(
      port,
      {
        method: request.method,
        url,
        headers: request.headers ?? {},
        body: request.body ?? null,
      },
      { debugLabel: `req#${requestId}` },
    );
    portRef.postMessage({
      type: "http-response",
      requestId,
      status: response.status,
      headers: response.headers,
      body: response.body,
    });
  } catch (e) {
    console.warn(`[bridge] req#${requestId} ${url} failed:`, e);
    portRef.postMessage({
      type: "http-error",
      requestId,
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    endBridgeRequest(activityId);
  }
}

/**
 * Direct main-thread → in-kernel HTTP request. Mirrors the SW bridge path
 * but doesn't require a transferred MessagePort. Replies via the
 * `response` message (resolves to an HttpResponse, or rejects with an
 * error string).
 */
async function handleHttpRequestMessage(msg: {
  requestId: number;
  port: number;
  request: any;
  timeoutMs?: number;
  maxResponseBytes?: number;
}) {
  if (!kernelInstance) {
    respondError(msg.requestId, "Kernel not initialized");
    return;
  }
  try {
    const response = await kernelWorker.sendHttpRequest(
      msg.port,
      msg.request,
      {
        timeoutMs: msg.timeoutMs,
        maxResponseBytes: msg.maxResponseBytes,
      },
    );
    respond(msg.requestId, response);
  } catch (e) {
    respondError(msg.requestId, e instanceof Error ? e.message : String(e));
  }
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

async function readExecFileFromFs(path: string): Promise<ArrayBuffer | null> {
  try {
    const { data } = await readPreparedPlatformFile(io, path);
    return data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
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
    case "init":
      void handleInit(msg).catch((err) => {
        const error = formatError(err);
        initReady = false;
        initFailure = error;
        failPendingLazyRegistrations(error);
        console.error("[kernel-worker] init failed:", err);
        post({ type: "init_error", error });
      });
      break;
    case "spawn":
      void processMemoryCreators
        .run("a host-spawned process Worker", () => handleSpawn(msg))
        .catch((error) => respondError(msg.requestId, formatError(error)));
      break;
    case "terminate_process": void handleTerminateProcess(msg); break;
    case "read_vfs_file": void handleReadVfsFile(msg); break;
    case "write_vfs_file": handleWriteVfsFile(msg); break;
    case "unlink_vfs_file": handleUnlinkVfsFile(msg); break;
    case "export_rootfs_image": void handleExportRootfsImage(msg); break;
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
    case "http_request": handleHttpRequestMessage(msg); break;
    case "destroy": void handleDestroy(msg); break;
    case "register_lazy_files": void handleLazyRegistration(msg); break;
    case "register_lazy_archives": void handleLazyRegistration(msg); break;
    case "get_fork_count": {
      // Round-trip access to the kernel's per-process fork counter for
      // tests asserting SYS_SPAWN didn't fall back to fork. Mirrors the
      // Node-side `get_fork_count` request in node-kernel-worker-entry.ts.
      try {
        const count = kernelWorker.getForkCount(msg.pid);
        respond(msg.requestId, count);
      } catch (err) {
        respondError(msg.requestId, (err as Error)?.message ?? String(err));
      }
      break;
    }
    case "get_kernel_memory_pages": {
      try {
        respond(msg.requestId, kernelWorker.getKernelMemoryPages());
      } catch (err) {
        respondError(msg.requestId, (err as Error)?.message ?? String(err));
      }
      break;
    }
    case "mouse_inject": handleMouseInject(msg); break;
    case "audio_drain": handleAudioDrain(msg); break;
    case "enum_procs": {
      // Snapshot the kernel's process table for the Inspector → Procs tab.
      // Mirrors the Node-side handler in node-kernel-worker-entry.ts —
      // dual-host parity is load-bearing here.
      try {
        respond(msg.requestId, kernelWorker.enumProcs());
      } catch (err) {
        respondError(msg.requestId, (err as Error)?.message ?? String(err));
      }
      break;
    }
    case "read_proc_maps": {
      try {
        respond(msg.requestId, kernelWorker.readProcMaps(msg.pid));
      } catch (err) {
        respondError(msg.requestId, (err as Error)?.message ?? String(err));
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
        respond(msg.requestId, kernelWorker.drainSyscallTrace());
      } catch (err) {
        respondError(msg.requestId, (err as Error)?.message ?? String(err));
      }
      break;
    }
    case "kms_attach_canvas":
      kernelWorker.attachKmsCanvas(msg.crtcId, msg.canvas, msg.stats, msg.opts);
      break;
    case "kms_attach_stats":
      kernelWorker.attachKmsStats(msg.crtcId, msg.stats);
      break;
    case "fb_release_generation_ack":
      acknowledgeMainFramebufferRelease(msg.requestId);
      break;
    default: {
      // Every typed MainToKernelMessage must have a case above. Browser
      // tooling also sends a few deliberately out-of-band control messages,
      // which remain handled below after the compile-time exhaustiveness
      // check.
      const exhaustive: never = msg;
      void exhaustive;
      // Handle non-protocol messages (e.g., bridge port transfer)
      const raw = e.data as any;
      if (raw?.type === "sysprof_start") {
        (globalThis as { __sysprof?: boolean }).__sysprof = true;
        (globalThis as { __sysprofTable?: Map<string, unknown> }).__sysprofTable = new Map();
        (globalThis as { __sysprofStartedAt?: number }).__sysprofStartedAt = performance.now();
        post({ type: "stdout", pid: 0, data: new TextEncoder().encode("[sysprof] started\n") });
      } else if (raw?.type === "pid_map_dump") {
        const m = (globalThis as { __pidMap?: Map<number, string> }).__pidMap;
        const out = ["[pid-map] (pid → exec'd path)\n"];
        if (m) for (const [pid, p] of [...m.entries()].sort((a, b) => a[0] - b[0])) out.push(`  pid=${pid} ${p}\n`);
        post({ type: "stdout", pid: 0, data: new TextEncoder().encode(out.join("")) });
      } else if (raw?.type === "sysprof_dump") {
        const table = (globalThis as { __sysprofTable?: Map<string, { count: number; totalMs: number; maxMs: number }> }).__sysprofTable;
        const gapTable = (globalThis as { __sysprofGap?: Map<number, { count: number; gapTotalMs: number; gapMaxMs: number }> }).__sysprofGap;
        const startedAt = (globalThis as { __sysprofStartedAt?: number }).__sysprofStartedAt ?? 0;
        const elapsed = performance.now() - startedAt;
        const rows = table ? [...table.entries()].map(([k, v]) => ({ key: k, ...v })) : [];
        rows.sort((a, b) => b.totalMs - a.totalMs);
        let out = `[sysprof] ${elapsed.toFixed(0)}ms total, top syscalls by kernel-side time:\n`;
        for (const r of rows.slice(0, 20)) {
          const [pid, nr] = r.key.split(":");
          out += `  pid=${pid} nr=${nr} count=${r.count} total=${r.totalMs.toFixed(0)}ms max=${r.maxMs.toFixed(1)}ms avg=${(r.totalMs / r.count).toFixed(2)}ms\n`;
        }
        // Wall-clock gaps tell us which pid's *user wasm code* is the
        // actual bottleneck — kernel handling itself has been ~negligible.
        if (gapTable) {
          const gapRows = [...gapTable.entries()].map(([pid, v]) => ({ pid, ...v }));
          gapRows.sort((a, b) => b.gapTotalMs - a.gapTotalMs);
          out += `[sysprof] gap-between-syscalls per pid (= time spent in user wasm):\n`;
          for (const r of gapRows.slice(0, 15)) {
            out += `  pid=${r.pid} gaps=${r.count} total=${r.gapTotalMs.toFixed(0)}ms max=${r.gapMaxMs.toFixed(1)}ms avg=${(r.gapTotalMs / r.count).toFixed(2)}ms\n`;
          }
        }
        post({ type: "stdout", pid: 0, data: new TextEncoder().encode(out) });
        (globalThis as { __sysprof?: boolean }).__sysprof = false;
      } else if (raw?.type === "set_bridge_port" && raw.bridgePort) {
        bridgePort = raw.bridgePort;
        resetBridgePendingRequests();
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
        reportHostDiagnostic({
          pid: 0,
          source: "worker protocol",
          message: `[kernel-worker] unknown main-thread message type: ${String(raw?.type)}`,
        }, "warn");
      }
    }
  }
};
