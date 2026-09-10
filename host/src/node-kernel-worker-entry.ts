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
import {
  retryKernelEntryResult,
  retryKernelEntryResultForGeneration,
} from "./kernel-entry-retry";
import type {
  ForkBorrowedReplayWorkspace,
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
  HostFileSystem,
  MemoryFileSystem,
} from "./vfs";
import { resolveForNodeKernelSession } from "./vfs/default-mounts-node";
import type { MountConfig } from "./vfs/types";
import type { MountSpec } from "./vfs/default-mounts";
import {
  createClosedLazyAssetFetcherFromOwnedAssets,
  createClosedLazyAssetSourceFetcher,
} from "./vfs/closed-lazy-assets";
import { resolveLazyUrl } from "./vfs/lazy-url";
import {
  collectRootfsBlobPaths,
  createRootfsBlobProvider,
} from "./vfs/rootfs-blob-store";
import { buildRootfsLazyWiring } from "./vfs/rootfs-lazy-archives";
import { TcpNetworkBackend } from "./networking/tcp-backend";
import { findRepoRoot, resolveBinary } from "./binary-resolver";
// The kernel worker reads an artifact before it compiles the kernel
// (`kernel.ts` needs the pointer width to build the import object), so the
// artifact reader has to be reachable from this realm's first read onward.
import { useNodeWasmArtifactModule } from "./wasm-artifact-module-node";

useNodeWasmArtifactModule();
import { NodeWorkerAdapter } from "./worker-adapter";
import { DeferredWorkerHandle } from "./deferred-worker-handle";
import type {
  PreparedExecLaunchPlan,
  PreparedExecLaunchRequest,
} from "./exec-target";
import { patchWasmForThread } from "./worker-main";
import {
  describeWasmArtifactPolicyFailures,
  detectPtrWidth,
  extractAbiVersion,
  isWasmModuleBytes,
} from "./constants";
import { CH_TOTAL_SIZE, DEFAULT_MAX_PAGES, PAGES_PER_THREAD, WASM_PAGE_SIZE } from "./constants";
import {
  PROCESS_FORK_MODE_VFORK,
  type ProcessForkMode,
} from "./generated/abi";
import {
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
} from "./worker-quiescence";
import { uninitializedKernelPipeResult } from "./kernel-pipe-transport";
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
  createProcessMemoryRetirementPressureHook,
  DEFAULT_PROCESS_THREAD_SLOTS,
  deriveProcessMemoryRetirementAdmissionThresholds,
  FORK_SAVE_BUFFER_SIZE,
  ProcessMemoryCapacityError,
  ProcessMemoryAllocator,
  ProcessMemoryRetirementBacklogError,
  type ProcessMemoryLayout,
  type ProcessMemoryLease,
} from "./process-memory";
import {
  VforkAddressSpaceBusyError,
  VforkLifetimeCoordinator,
  type VforkExactCompletionReason,
  type VforkLifetime,
} from "./vfork-lifetime";
import {
  ExactProcessGenerationDetachLedger,
  type ExactProcessGenerationDetachResult,
} from "./process-generation-detach";
import { ProcessMemoryCreatorGate } from "./process-memory-creator-gate";
import { sampleProcessMemoryStats } from "./fork-mechanism-trace";
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
import {
  bufferToArrayBuffer,
  createProcessLifecycle,
  type ForkReplayContext,
  type ProcessLifecycleInfo,
  type ThreadWorkerRecord,
  formatError,
  handleThreadExit,
  signalFromExitStatus,
  type ProcessGenerationOwnership,
  type VforkWorkspaceOwnership,
} from "./process-lifecycle";
import { NodePcmDriver } from "./audio/node-pcm-driver";

if (!parentPort) {
  throw new Error("node-kernel-worker-entry must run in a worker_thread");
}

const port = parentPort;

/**
 * Phase 6 D5: resolve and compile the width-matching co-resident `fork-module`
 * once per pointer width at this kernel host (the Node kernel worker builds
 * every `centralized_init` message) and ship it to each fork-instrumented
 * process worker. The co-resident module is the UNCONDITIONAL reconstructor +
 * capturer for every fork — there is no kill switch and no JS reference engine
 * behind it, so the module always ships.
 */
const forkModuleModuleByWidth = new Map<4 | 8, WebAssembly.Module>();
// Explicit per-boot fork-module bytes (see `InitMessage.forkModuleBytesByWidth`
// and `NodeKernelHostOptions.forkModuleBytesByWidth`). Seeded from the init
// message; consulted only on a compiled-module cache miss. The fork module is
// identical regardless of source, so caching by width stays sound whether a
// width was first compiled from injected bytes or from the resolver.
let injectedForkModuleBytesByWidth: Partial<Record<4 | 8, ArrayBuffer>> = {};
/**
 * The co-resident WASI module, compiled once per kernel host. WASI Preview 1
 * is a wasm32 ABI, so there is one module rather than one per pointer width.
 *
 * Resolved lazily: a host that never runs a WASI guest never needs the
 * artifact, and a host that does gets a loud resolver error naming the build
 * script rather than a silent loss of WASI support.
 */
let wasiModuleModule32Node: WebAssembly.Module | null = null;
function wasiModuleModule(): WebAssembly.Module {
  if (!wasiModuleModule32Node) {
    wasiModuleModule32Node = new WebAssembly.Module(
      readFileSync(resolveBinary("wasi_module32.wasm")),
    );
  }
  return wasiModuleModule32Node;
}

/**
 * The standalone dynamic-linking planner (`crates/dylink-module`).
 *
 * Shipped to EVERY process worker, not only fork-instrumented ones. `dlopen`
 * is a generic POSIX interface: an uninstrumented process may call it, and the
 * only in-tree runtime-`dlopen` consumer today happens to be instrumented, so
 * gating this on instrumentation would leave a gap no artifact here would
 * catch.
 *
 * Unlike the two modules above it is NOT co-resident and NOT position-
 * independent: it imports nothing at all and owns its own linear memory, so it
 * is never placed inside the guest's address space. It is also not
 * pointer-width-specific — the planner narrows its arithmetic at its own
 * boundary and carries the process's pointer width in its configuration
 * record — so one wasm32 module serves wasm32 and wasm64 guests alike.
 */
let dylinkModuleModuleCache: WebAssembly.Module | null = null;
// Explicit per-boot planner bytes (see `InitMessage.dylinkModuleBytes`).
// Seeded from the init message; consulted before the resolver, because a
// build-time boot runs under the source-only resolution policy with no
// source-only binary root and the resolver cannot answer at all there.
let injectedDylinkModuleBytes: ArrayBuffer | undefined;
function dylinkModuleModule(): WebAssembly.Module | undefined {
  if (dylinkModuleModuleCache) return dylinkModuleModuleCache;
  if (injectedDylinkModuleBytes !== undefined) {
    dylinkModuleModuleCache = new WebAssembly.Module(
      new Uint8Array(injectedDylinkModuleBytes),
    );
    return dylinkModuleModuleCache;
  }
  try {
    dylinkModuleModuleCache = new WebAssembly.Module(
      readFileSync(resolveBinary("dylink_module32.wasm")),
    );
  } catch {
    // A tree that has not built the module yet must still boot: nothing
    // consumes it until the loader is cut over. When it IS consumed, its
    // absence has to be a loud `dlopen` failure at the call site rather than a
    // silent substitution here.
    return undefined;
  }
  return dylinkModuleModuleCache;
}

/**
 * The pre-compiled modules a process worker may need.
 *
 * The fork module and the WASI module are PIC side modules placed into the
 * guest's address space by the process worker. The dynamic-linking planner is
 * not — it imports nothing and owns its memory — but it is supplied the same
 * way and consumed at the same point, so it travels here too. A fourth module
 * is one field here rather than a new spread at every worker-launch site.
 */
function sideModuleInitFields(ptrWidth: 4 | 8): {
  forkModuleModule: WebAssembly.Module;
  wasiModuleModule?: WebAssembly.Module;
  dylinkModuleModule?: WebAssembly.Module;
} {
  let mod = forkModuleModuleByWidth.get(ptrWidth);
  if (!mod) {
    const injected = injectedForkModuleBytesByWidth[ptrWidth];
    if (injected !== undefined) {
      mod = new WebAssembly.Module(new Uint8Array(injected));
    } else {
      const name = `fork_module${ptrWidth === 8 ? 64 : 32}.wasm`;
      mod = new WebAssembly.Module(readFileSync(resolveBinary(name)));
    }
    forkModuleModuleByWidth.set(ptrWidth, mod);
  }
  // The planner is width-independent, so it is attached on BOTH the wasm64
  // early return below and the wasm32 path. A wasm64 process can `dlopen` too.
  const dylinkModule = dylinkModuleModule();
  const dylinkField = dylinkModule ? { dylinkModuleModule: dylinkModule } : {};
  // WASI Preview 1 is wasm32-only. A wasm64 worker gets no module, and a
  // wasm64 WASI guest fails loud in the worker rather than here.
  if (ptrWidth !== 4) {
    return { forkModuleModule: mod, ...dylinkField };
  }
  // Resolving the artifact must not fail a worker launch for the overwhelming
  // majority of programs, which are not WASI guests. The worker reports the
  // missing capability when it actually has a WASI module to host.
  let wasiModule: WebAssembly.Module | undefined;
  try {
    wasiModule = wasiModuleModule();
  } catch {
    wasiModule = undefined;
  }
  return {
    forkModuleModule: mod,
    ...(wasiModule ? { wasiModuleModule: wasiModule } : {}),
    ...dylinkField,
  };
}

// --- State ---

let kernelWorker: CentralizedKernelWorker;
let pcmDriver: NodePcmDriver | null = null;
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
    throw new Error(
      `invalid KANDELO_RECLAIM_PRESSURE_BYTES: ${configured}`,
    );
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
  createProcessMemoryRetirementPressureHook(
    reclamationMeasurementPressure,
  );
let execPrograms: Record<string, string> = {};
let execProgramBytes: Record<string, ArrayBuffer> = {};
let vfsExecIO: PlatformIO | null = null;
let rootfsMemfs: MemoryFileSystem | null = null;
/** The exact fetcher installed on `rootfsMemfs` via `setLazyFetcher`
 *  (closed-asset bundle, closed-asset-source, or the dev fallback below).
 *  Captured here — rather than only as a local in `buildVirtualPlatformIO`
 *  — so the rootfs overlay wiring in `handleInit` can reuse the SAME
 *  transport for `host_fetch_archive` (Phase 5 3b-wiring.3). */
let rootfsLazyFetcher: Parameters<MemoryFileSystem["setLazyFetcher"]>[0] | undefined;
/** Canonical mount points of the sibling filesystems still mounted under `/`
 *  after the host `/` mount is dropped (e.g. `/dev/shm`, `/run/kandelo-run`
 *  session-seed trees, extra host mounts). Captured in `buildVirtualPlatformIO`
 *  and handed to the in-kernel rootfs overlay in `handleInit` so it does not
 *  greedily claim these sibling paths. */
let rootfsForeignPrefixes: string[] = [];
/** Whether the overlay's `/` mount was configured `nosuid`. Captured in
 *  `buildVirtualPlatformIO` from the resolved root mount and handed to the
 *  in-kernel rootfs overlay in `handleInit` so an overlay-served setuid/setgid
 *  exec target elevates (or, on a nosuid mount, does not) like the host `/`
 *  mount. Defaults set-ID honoring. */
let rootfsNosuid = false;
let initReady = false;
let injectedExecWorkerConstructionFailure = false;
/** Per-boot scratch directory; cleaned up on `destroy`. Only set when the
 *  worker constructs a `VirtualPlatformIO` from the default mount spec. */
let sessionDir: string | null = null;
// [JSC-TERMINATE-ATOMICS-WAIT-LEAK] destroy-time drain bounds; see handleDestroy.
const DESTROY_KILL_DRAIN_TIMEOUT_MS = 1500;
const DESTROY_KILL_DRAIN_POLL_MS = 15;
const PCM_DESTROY_DRAIN_TIMEOUT_MS = 2000;

// Process tracking
/**
 * This host's execution-image record.
 *
 * The whole declaration is shared now: the two entries' copies were
 * field-for-field the same apart from the worker handle, so the shared module
 * is generic in that alone. `ForkReplayContext` came with it.
 */
type ProcessInfo = ProcessLifecycleInfo<
  ReturnType<NodeWorkerAdapter["createWorker"]>
>;
let nextProcessGeneration = 1;

/**
 * Allocate the next execution-generation number for this realm.
 *
 * Monotonic and never reused, so a message naming a generation can always be
 * rejected as stale rather than misapplied to a successor image.
 */
function allocateProcessGeneration(): number {
  const generation = nextProcessGeneration++;
  if (!Number.isSafeInteger(generation)) {
    throw new Error("process execution generation space exhausted");
  }
  return generation;
}

const processes = new Map<number, ProcessInfo>();
const vforkLifetimes = new VforkLifetimeCoordinator<ProcessInfo>();
const externrefProcessOwner = new ForkExternrefProcessOwner();
const forkHostImportOwnerRuntime =
  new ForkHostImportOwnerRuntime(externrefProcessOwner);
const forkHostImportsByWorker =
  new WeakMap<object, ForkHostImportOwnerWorker>();
const processTeardowns = new Map<ProcessInfo["worker"], Promise<void>>();
const vmInterruptTimers = new VmInterruptTimerManager<ProcessInfo>(
  (pid) => processes.get(pid),
);
const processMemoryCreators = new ProcessMemoryCreatorGate();
const vforkMechanismTraceEnabled = Boolean(process.env.KERNEL_SYSCALL_LOG);

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
    finalizeUnexpectedWorkerError(pid, worker, errorLabel, error));
  worker.on("message", (raw: unknown) => {
    const process = processes.get(pid);
    if (!process || process.worker !== worker) return;
    const message = raw as WorkerToHostMessage;
    if (
      message.type === "memory_quiescent"
      && message.pid === pid
      && message.tid === undefined
    ) {
      if (vforkLifetimes.phaseForChild(process) !== undefined) {
        traceVforkMechanism("memory_quiescent", `child=${pid}`);
      }
      process.workerQuiescence.settle();
      return;
    }
    if (
      message.type === "exec_retired"
      && message.pid === pid
      && message.tid === undefined
    ) {
      process.execRetirement.settle();
      return;
    }
    if (message.type === "error" && message.pid === pid) {
      finalizeProcessWorkerError(pid, worker, message.message);
    } else if (message.type === "exit" && message.pid === pid) {
      void finalizeProcessWorker(pid, worker, message.status ?? 0);
    } else if (
      message.type === "vm_interrupt_timer"
      && message.pid === pid
    ) {
      handleVmInterruptTimer(message, pid, process);
    } else if (message.type === "fork_host_import") {
      dispatchForkHostImport(worker, message);
    } else if (message.type === "fork_module_frames" && message.pid === pid) {
      // Forward the co-resident fork-module's proof-of-use (Phase 6 D5): a
      // nonzero frame count confirms the qualifying fork ran its continuation
      // through the module. Proof-of-use is informational success telemetry, not
      // a host problem, so it rides the dedicated `fork_module_proof` channel and
      // never pollutes `onHostDiagnostic`.
      postForkModuleProof({
        pid,
        source: "fork-module",
        message: `fork_module_frames=${message.frames}`,
      });
    } else if (
      message.type === "fork_module_child_frames" &&
      message.pid === pid
    ) {
      // Forward the co-resident fork-module's REPLAY-side proof-of-use (Phase 6
      // D7b): a nonzero count confirms a fork CHILD (e.g. a fork-from-thread
      // child) drove its rewind through the module — the child never commits, so
      // `fork_module_frames` cannot show this.
      postForkModuleProof({
        pid,
        source: "fork-module",
        message: `fork_module_child_frames=${message.frames}`,
      });
    } else if (
      message.type === "fork_module_references" &&
      message.pid === pid
    ) {
      // Forward the co-resident fork-module's PER-KIND REFERENCE proof-of-use
      // (Phase 6 D6.5): a nonzero count for a kind confirms the child's carried
      // references of that kind were reconstructed through the module. All kinds
      // ride one string so a reader can extract any of funcref/externref/exnref/
      // typed-GC.
      postForkModuleProof({
        pid,
        source: "fork-module",
        message:
          `fork_module_references=${message.references} ` +
          `externrefs_resolved=${message.externrefs} ` +
          `exnrefs_reconstructed=${message.exnrefs} ` +
          `gc_nodes_reconstructed=${message.gcNodes} ` +
          `drive_steps_executed=${message.driveSteps} ` +
          `static_roots_published=${message.staticRoots}`,
      });
    } else if (
      message.type === "fork_module_region" &&
      message.pid === pid
    ) {
      // Record where this worker placed its co-resident fork-module region so a
      // COPIED fork child reuses the same base instead of double-mapping the
      // region it already inherits (see `forkModuleInheritedBase` plumbing in
      // `handleOrdinaryFork`).
      process.forkModuleRegion = { base: message.base, bytes: message.bytes };
    }
  });
  installCrashSafetyNet(worker, pid);
}

// Per-PID thread module cache: lazily compiled on first clone()




function reportProcessExit(pid: number, status: number): void {
  if (reportedExits.has(pid)) return;
  reportedExits.add(pid);
  post({ type: "exit", pid, status });
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

/**
 * The shared lifecycle implementation both host entries call.
 *
 * `terminationProvesQuiescence` is `true` here because Node's
 * `await worker.terminate()` genuinely joins the thread: a worker parked in
 * `Atomics.wait` on a SharedArrayBuffer does not resume once it resolves.
 * The browser entry declares `false` for the same field.
 */
const lifecycle = createProcessLifecycle<ProcessInfo["worker"]>({
  post: (message, transfer) => post(message, transfer),
  terminationProvesQuiescence: true,
  isVforkMechanismTraceEnabled: () => vforkMechanismTraceEnabled,
  vforkLifetimes,
  vmInterruptTimers,
  kernel: () => kernelWorker,
  diagnosticPrefix: "[node-kernel-worker]",
  forkHostImportsByWorker,
  processGenerationDetaches,
  ptyByPid,
  execMountIO: () => vfsExecIO,
  processes,
  processTeardowns,
  isInitReady: () => initReady,
  rootfsBaseImage: () => rootfsMemfs,
  externrefProcessOwner,
  // Node's worker-'exit' handler and vfork containment path synthesize the
  // crash reap themselves before entering the shared teardown.
  defaultExitCrashSignum: () => undefined,
  threadWorkerSettleMs: 0,
  reportProcessExit: (pid, _info, status) => reportProcessExit(pid, status),
  allocateProcessGeneration,
  forkHostImportOwnerRuntime,
  createProcessWorker: (init) => workerAdapter.createWorker(init),
  createThreadWorker: (init) =>
    new DeferredWorkerHandle(() => workerAdapter.createWorker(init)),
  createDeferredProcessWorker: (init) =>
    new DeferredWorkerHandle(() => workerAdapter.createWorker(init)),
  sideModuleInitFields,
  installProcessWorkerListeners,
  // Node reaches the network directly, so a launch runs with exactly the
  // environment it asked for.
  decorateLaunchEnv: (env) => [...env],
  defaultLaunchEnv: () => [],
  // `await worker.terminate()` is the ownership fence, so every predecessor
  // teardown has already completed by the time a successor is admitted.
  awaitProcessConstructionBarrier: () => Promise.resolve(),
  // Node registers the PTY output callback at spawn; the browser's main
  // thread asks for it separately with `register_pty_output`.
  onProcessPtyReady: (pid, ptyIdx) => {
    kernelWorker.onPtyOutput(ptyIdx, (data: Uint8Array) => {
      post({ type: "pty_output", pid, data });
    });
  },
  // `await worker.terminate()` joins the thread on Node, so nothing has
  // to settle afterwards, and no host-side alias of the Memory exists.
  processExitSettleMs: () => 0,
  releaseGenerationAliases: () => true,
  processMemoryAllocator: () => processMemoryAllocator,
  defaultMaxPages: () => maxPages,
  defaultThreadSlots: () => defaultThreadSlots,
  stopKernelRealm: () => {
    cleanupSessionDir();
    queueMicrotask(() => process.exit(1));
  },
  // Node alone has locally injected program buffers and a main-thread
  // `resolve_exec` fallback beyond the filesystem.
  resolveExecFile: (path) => resolveExec(path),
});
const {
  bindForkHostImports,
  completeVforkGenerationTeardown,
  handleSpawn,
  handlePosixSpawn,
  handleOrdinaryFork,
  handleVfork,
  handleFork,
  handleClone,
  handleExit,
  threadModuleCache,
  classifyWasmTrap,
  classifiedSignalOrFallback,
  classifiedTrapExitStatus,
  awaitFinalizedProcessTeardown,
  createFreshProcessMemory,
  detachExactProcessGeneration,
  dispatchForkHostImport,
  containVforkAddressSpace,
  finishProcessExit,
  finishVforkDisposition,
  handleExportRootfsImage,
  handleInjectConnection,
  handlePipeRead,
  handlePipeWrite,
  handleReadVfsFile,
  handleWriteVfsFile,
  reportedExits,
  rootfsSnapshotGate,
  handlePosixSpawnResolve,
  handlePtyResize,
  intentionallyTerminated,
  terminateThreadWorkers,
  terminateTrackedWorker,
  threadExits,
  threadWorkers,
  waitForExecRetirement,
  waitForWorkerQuiescence,
  workerTeardowns,
  readExecFromVfs,
  reportWorkerProtocolError,
  resolveExecutableForLaunch,
  respondTransferredBytes,
  handlePtyWrite,
  handleVmInterruptTimer,
  postForkModuleProof,
  releaseVforkWorkspace,
  reportHostDiagnostic,
  reportRetainedProcessGeneration,
  respond,
  respondError,
  terminatePoisonedKernelWorker,
  traceVforkMechanism,
} = lifecycle;

// Exec resolution: request ID → resolver
let execResolveId = 0;
const pendingExecResolves = new Map<number, (bytes: ArrayBuffer | null) => void>();

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
  try { kernelWorker.notifyHostProcessCrashed(pid, crashSignum); } catch { /* best-effort */ }

  // WHY: ordinary exits and crashes must share one teardown funnel. Keeping a
  // second cleanup sequence here previously let their Worker/channel ordering
  // drift and made it possible to reap Rust state before all Workers stopped.
  await finishProcessExit(pid, exitStatus, undefined, worker, "trap");
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
  const message = err instanceof Error ? (err.message ?? String(err)) : String(err);
  const { exitStatus, signum } = unexpectedWorkerCrashDisposition(err);
  reportHostDiagnostic({
    pid,
    status: exitStatus,
    source: label,
    message: `[kernel-worker] pid=${pid}: ${label}: ${message}`,
  });
  void finalizeProcessWorker(pid, worker, exitStatus, signum);
}

function post(msg: KernelToMainMessage, transfer?: ArrayBuffer[]) {
  port.postMessage(msg, transfer ?? []);
}






function resolveExecLocal(path: string): ArrayBuffer | null {
  const owned = Object.prototype.hasOwnProperty.call(execProgramBytes, path)
    ? execProgramBytes[path]
    : undefined;
  if (owned !== undefined) {
    // WHY: process-worker launch transfers its program buffer. Preserve the
    // worker-lifetime snapshot by lending a fresh copy to every execution.
    return owned.slice(0);
  }
  const mapped = Object.prototype.hasOwnProperty.call(execPrograms, path)
    ? execPrograms[path]
    : undefined;
  if (mapped && existsSync(mapped)) {
    const bytes = readFileSync(mapped);
    return bufferToArrayBuffer(bytes);
  }
  return null;
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
    exclusiveNativeWriters?: boolean;
    uid?: number;
    gid?: number;
  }>,
  sessionSeedTrees?: InitMessage["sessionSeedTrees"],
  rootfsLazyUrlBase?: InitMessage["rootfsLazyUrlBase"],
  rootfsLazyAssets?: InitMessage["rootfsLazyAssets"],
  rootfsLazyAssetSources?: InitMessage["rootfsLazyAssetSources"],
): Promise<VirtualPlatformIO> {
  const bootSessionDir = mkdtempSync(join(tmpdir(), "wasm-posix-session-"));
  sessionDir = bootSessionDir;
  let specMounts: MountConfig[];
  try {
    specMounts = await resolveForNodeKernelSession(
      rootfsMountSpec ?? DEFAULT_MOUNT_SPEC,
      new Uint8Array(rootfsImage),
      bootSessionDir,
      sessionSeedTrees,
      (extraMounts ?? []).map((mount) => mount.mountPoint),
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
      exclusiveNativeWriters: m.exclusiveNativeWriters,
      uid: m.uid,
      gid: m.gid,
    }),
    readonly: m.readonly,
  }));
  const mounts = [
    { mountPoint: "/dev/shm", backend: shmfs, nosuid: true },
    ...specMounts,
    ...extras,
  ];
  const rootMount = mounts.find((m) => m.mountPoint === "/");
  rootfsNosuid = rootMount?.nosuid === true;
  rootfsMemfs = rootMount?.backend instanceof MemoryFileSystem
    ? rootMount.backend
    : null;
  if (rootfsMemfs) {
    if (rootfsLazyUrlBase !== undefined) {
      rootfsMemfs.rewriteLazyFileUrls((url) => resolveLazyUrl(rootfsLazyUrlBase, url));
      rootfsMemfs.rewriteLazyArchiveUrls((url) => resolveLazyUrl(rootfsLazyUrlBase, url));
    }
    rootfsMemfs.subscribeLazyDownloads((event) => {
      post({ type: "lazy_download", event });
    });
    const lazyFetcher = rootfsLazyAssets !== undefined
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
    rootfsLazyFetcher = lazyFetcher;
  }
  // Phase 5 cutover: the in-kernel rootfs overlay is the unconditional sole
  // `/` authority, so the host `/` mount is always dropped from the
  // guest-facing VirtualPlatformIO. Guest syscalls route non-tmpfs `/` paths
  // through the overlay (`rootfs::claims_path`), and host-initiated exec-byte
  // reads go through the overlay (`readExecFromOverlay`), so nothing depends
  // on `/` being mounted here. Leaving it mounted would double-fetch lazy
  // archives (this host mount plus the overlay's own lazy wiring both
  // fetching). `rootMount` was already captured into `rootfsMemfs` above, so
  // the backing MemoryFileSystem stays alive as the `blob_read` byte store and
  // lazy-group source even though it is no longer mounted.
  const guestMounts = mounts.filter((m) => m.mountPoint !== "/");
  // The mounts that survive dropping `/` are exactly the sibling filesystems the
  // overlay must not claim. Hand their prefixes to the overlay so `/dev/shm`,
  // `/run/kandelo-run` session-seed trees, and extra host mounts keep resolving
  // through their own backend rather than being shadowed by the sole `/`
  // authority. (tmpfs scratch mounts are excluded by the kernel independently.)
  rootfsForeignPrefixes = guestMounts.map((m) => m.mountPoint);
  return new VirtualPlatformIO(guestMounts, new NodeTimeProvider());
}

function cleanupSessionDir(): void {
  if (sessionDir) {
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // WHY: a graceful/fatal worker path must attempt cleanup, but native
      // handles can transiently retain files and abrupt process termination
      // cannot run this hook. Never treat this best-effort cleanup as the
      // ownership proof; private inode creation before ready is that proof.
    }
  }
  sessionDir = null;
  vfsExecIO = null;
  rootfsMemfs = null;
  rootfsLazyFetcher = undefined;
}

async function handleInit(msg: InitMessage) {
  initReady = false;
  injectedExecWorkerConstructionFailure = false;
  maxPages = msg.config.maxPages ?? DEFAULT_MAX_PAGES;
  defaultThreadSlots = msg.config.defaultThreadSlots ?? DEFAULT_PROCESS_THREAD_SLOTS;
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
  execProgramBytes = msg.execProgramBytes ?? {};
  workerAdapter = new NodeWorkerAdapter();
  if (!msg.rootfsImage && (msg.sessionSeedTrees?.length ?? 0) > 0) {
    throw new Error("sessionSeedTrees requires rootfsImage");
  }

  const io: PlatformIO = msg.rootfsImage
    ? await buildVirtualPlatformIO(
      msg.rootfsImage,
      msg.rootfsMountSpec,
      msg.extraMounts,
      msg.sessionSeedTrees,
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
      onFork: ({
        parentPid,
        childPid,
        mode,
        parentMemory,
        continuation,
        borrowedReplay,
      }) => {
        const launch = (releaseCreatorAdmission?: () => void) => {
          // Notify the main thread of every kernel-side process event so
          // Inspector-style UIs (Kandelo) can refresh their process table
          // event-driven. Mirrors the browser-side worker entry.
          post({
            type: "proc_event",
            kind: "spawn",
            pid: childPid,
            ppid: parentPid,
          });
          return handleFork(
            parentPid,
            childPid,
            mode,
            parentMemory,
            continuation,
            borrowedReplay,
            releaseCreatorAdmission,
          );
        };
        return mode === PROCESS_FORK_MODE_VFORK
          ? processMemoryCreators.runUntilCommitted(
              "a vfork process Worker",
              (commit) => launch(commit),
            )
          : processMemoryCreators.run(
              "a fork process Worker",
              () => launch(),
            );
      },
      onExec: async (request) => {
        const creatorAdmission = processMemoryCreators.acquire(
          "an exec process Worker",
        );
        try {
          const { pid } = request;
          const execGeneration = processes.get(pid);
          const previousWorker = execGeneration?.worker;
          const result = await handleExec(request);
          if (
            typeof result === "number"
            && result < 0
            && execGeneration
            && processes.get(pid) === execGeneration
            && vforkLifetimes.isActiveBorrower(execGeneration)
          ) {
            // A failed exec returns to the borrowing child. POSIX does not let
            // that release the parent; only a later successful exec or _exit
            // ends the shared-address-space lifetime.
            vforkLifetimes.noteFailedExec(execGeneration, -result);
          }
          if (typeof result === "number") {
            creatorAdmission.release();
            return result;
          }

          let planState: "ready" | "settled" = "ready";
          return {
            onCommitFailure: (commitResult?: number) => {
              if (planState !== "ready") return;
              planState = "settled";
              try {
                result.onCommitFailure(commitResult);
              } finally {
                creatorAdmission.release();
              }
            },
            startAfterCommit: async () => {
              if (planState !== "ready") {
                throw new Error("exec replacement plan already settled");
              }
              planState = "settled";
              try {
                const startResult = await result.startAfterCommit();
                // Notify after handleExec refreshes kernel-side Process.argv so
                // process-table consumers don't refetch stale command names. A
                // post-commit signal death also returns 0 because the old syscall
                // can no longer return; only emit exec when a replacement exists.
                const installedWorker = processes.get(pid)?.worker;
                if (
                  startResult === 0
                  && installedWorker
                  && installedWorker !== previousWorker
                ) {
                  const executionState =
                    await retryKernelEntryResultForGeneration(
                      () =>
                        processes.get(pid)?.worker === installedWorker
                        && !kernelWorker.isExecHandoffActive(pid),
                      () => kernelWorker.isProcessExecutionActive(pid),
                    );
                  if (
                    executionState.status === "current"
                    && executionState.value
                  ) {
                    post({ type: "proc_event", kind: "exec", pid });
                  }
                }
                return startResult;
              } finally {
                creatorAdmission.release();
              }
            },
          } satisfies PreparedExecLaunchPlan;
        } catch (error) {
          creatorAdmission.release();
          throw error;
        }
      },
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
      onExit: handleExit,
    },
  );

  kernelWorker.setProcessOutputCallbacks({
    onStdout: (pid, data) => {
      post({
        type: "stdout",
        pid,
        data: new Uint8Array(data),
      });
    },
    onStderr: (pid, data) => {
      post({
        type: "stderr",
        pid,
        data: new Uint8Array(data),
      });
    },
  });

  // Phase 5 cutover: the in-kernel rootfs overlay is the unconditional sole
  // `/` authority. Hand the `/` image tree to the overlay and install the byte
  // provider before init applies them. The `/` MemoryFileSystem is reachable
  // only here in the entry.
  if (rootfsMemfs) {
    // Phase 5 Increment 3b-wiring.3: also bridge System A's lazy-archive
    // export (`rootfsMemfs.exportLazyArchiveEntries()`) into the overlay's
    // `KIND_LAZY_FILE` linkage + `host_fetch_archive` provider.
    // `buildRootfsLazyWiring` needs a `(url) => Promise<Uint8Array>` fetcher,
    // but the fetcher captured from `setLazyFetcher` in
    // `buildVirtualPlatformIO` (`rootfsLazyFetcher`, a `LazyFetch`) returns a
    // `Response` — adapt it here rather than change `setLazyFetcher`'s
    // contract. If no fetcher was installed (no rootfs image / no lazy
    // groups), fail loudly instead of guessing a transport: with zero lazy
    // groups `lazyInput` is empty and the provider is never called; with
    // lazy groups but no transport, a lazy read genuinely cannot succeed and
    // the provider should report that truthfully (EIO) rather than hang.
    const installedLazyFetcher = rootfsLazyFetcher;
    const lazyArchiveFetcher: (url: string) => Promise<Uint8Array> =
      installedLazyFetcher
        ? async (url) =>
          new Uint8Array(await (await installedLazyFetcher(url)).arrayBuffer())
        : async () => {
          throw new Error("no lazy transport configured");
        };
    // Only the archive provider is needed now: the kernel learns which files
    // are lazy from the image's own `KLZY` section, not from a host-built
    // linkage. `buildRootfsLazyWiring` still produces both; `lazyInput` is the
    // manifest half and now has only the test oracle as a consumer.
    const { archiveProvider } = buildRootfsLazyWiring(
      rootfsMemfs.exportLazyArchiveEntries(),
      lazyArchiveFetcher,
    );
    kernelWorker.configureRootfsOverlay(
      createRootfsBlobProvider(
        rootfsMemfs,
        collectRootfsBlobPaths(rootfsMemfs, (p) => p),
      ),
      archiveProvider,
      rootfsForeignPrefixes,
      rootfsNosuid,
      new Uint8Array(msg.rootfsImage!),
    );
  }

  injectedForkModuleBytesByWidth = msg.forkModuleBytesByWidth ?? {};
  injectedDylinkModuleBytes = msg.dylinkModuleBytes;

  await kernelWorker.init(msg.kernelWasmBytes);

  const pcmTransport = kernelWorker.claimPcmTransport(false);
  pcmDriver = new NodePcmDriver({
    clockUpdate: (frames) => kernelWorker.pcmClockUpdate(frames),
    // Node does not run the browser's shared-wake observer. Force one kernel
    // reconciliation/retry pass so blocked write, poll, drain, and close calls
    // observe EIO immediately when the null/physical sink fails.
    onFatal: () => {
      kernelWorker.pcmClockUpdate(0);
    },
  });
  await pcmDriver.prepare(pcmTransport);

  initReady = true;
  post({ type: "ready" });
}

// --- Spawn ---

// --- Process lifecycle callbacks ---

async function handleExec(
  request: PreparedExecLaunchRequest,
): Promise<number | PreparedExecLaunchPlan> {
  const {
    pid,
    targetBytes: programBytes,
    targetModule: programModule,
    argv: launchArgv,
    envp,
  } = request;
  const initiatingInfo = processes.get(pid);
  if (!initiatingInfo) return -3; // ESRCH
  const vforkBorrower = vforkLifetimes.isActiveBorrower(initiatingInfo);
  const newPtrWidth = detectPtrWidth(programBytes);
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
      programBytes,
      newPtrWidth,
    );
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
  const isInitiatingExecGeneration = () =>
    processes.get(pid) === initiatingInfo
    && !kernelWorker.isExecHandoffActive(pid);
  const executionState = await retryKernelEntryResultForGeneration(
    isInitiatingExecGeneration,
    () => kernelWorker.isProcessExecutionActive(pid),
  );
  if (executionState.status === "stale" || !executionState.value) {
    prepared.memoryLease.release();
    return -3; // ESRCH
  }
  const addressSpaceState = await retryKernelEntryResultForGeneration(
    isInitiatingExecGeneration,
    () => kernelWorker.prepareAddressSpaceForExec(pid),
  );
  if (addressSpaceState.status === "stale") {
    prepared.memoryLease.release();
    return -3; // ESRCH
  }
  const addressSpaceResult = addressSpaceState.value;
  if (addressSpaceResult < 0) {
    prepared.memoryLease.release();
    return addressSpaceResult;
  }
  let replacementWorker: ReturnType<NodeWorkerAdapter["createWorker"]> | undefined;
  let replacementExternrefGeneration: ForkExternrefGeneration | undefined;
  let replacementForkHostImports: ForkHostImportOwnerWorker | undefined;
  let launchPlanState: "ready" | "discarded" | "started" = "ready";
  const onCommitFailure = (commitResult?: number): void => {
    if (launchPlanState !== "ready") return;
    launchPlanState = "discarded";
    try {
      prepared.memoryLease.release();
      preparedLeaseConsumed = true;
    } catch {
      // Preserve the kernel's authoritative commit result.
    }
    if (
      commitResult !== undefined
      && commitResult < 0
      && vforkBorrower
      && vforkLifetimes.phaseForChild(initiatingInfo) !== undefined
    ) {
      vforkLifetimes.noteFailedExec(initiatingInfo, -commitResult);
    }
  };
  const startAfterCommit = async (): Promise<number> => {
    if (launchPlanState !== "ready") {
      throw new Error(`Exec launch plan for pid ${pid} was already consumed`);
    }
    launchPlanState = "started";
    try {
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
      // Commit wakes the old mailboxes while it already owns the kernel entry.
      // No Worker message can dispatch until this synchronous continuation
      // marks every old Worker intentional and consumes the host-owned result.
      const transition = kernelWorker.takeCommittedExecTransition(
        pid,
        initiatingInfo.memory,
      );
      const secureExec = transition.secureExec;
      const mainRetirementStarted = transition.retiredChannelOffsets.has(
        initiatingInfo.channelOffset,
      );
      if (!kernelWorker.prepareProcessForExec(pid, initiatingInfo.memory)) {
        throw new Error(`Exec pid ${pid} changed generation during commit`);
      }
      replacementExternrefGeneration = externrefProcessOwner.replaceGeneration(
        initiatingInfo.externrefGeneration,
      );

      if (transition.addressSpaceResult < 0) {
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
      const handoffExitSignal = await retryKernelEntryResult(
        () => kernelWorker.finalizeExecHandoffTermination(pid),
      );
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
          undefined,
          "signal",
        );
        return 0;
      }

      const {
        memory: newMemory,
        memoryLease: newMemoryLease,
        layout: newLayout,
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
        secureExec,
        externrefGenerationId: replacementExternrefGeneration.id,
        forkHostImports: replacementForkHostImports.init,
        argv: launchArgv,
        env: envp,
        ptrWidth: newPtrWidth,
        kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
        kernelAbiContractDigest: kernelWorker.getKernelAbiContractDigest() ?? undefined,
        ...sideModuleInitFields(newPtrWidth),
      };

      replacementWorker = new DeferredWorkerHandle(() => {
        if (
          (
            process.env.KANDELO_TEST_EXEC_WORKER_CONSTRUCTION_FAILURE === "once"
            || envp.includes(
              "KANDELO_TEST_EXEC_WORKER_CONSTRUCTION_FAILURE=once",
            )
          )
          && !injectedExecWorkerConstructionFailure
        ) {
          injectedExecWorkerConstructionFailure = true;
          throw new Error("injected exec Worker construction failure");
        }
        return workerAdapter.createWorker(initData);
      });
      kernelWorker.registerProcess(pid, newMemory, [newChannelOffset], {
        preserveProcessState: true,
        ptrWidth: newPtrWidth,
        metadataPtrWidth: initiatingInfo.ptrWidth,
        brkBase: newLayout.brkBase,
        mmapBase: newLayout.mmapBase,
        maxAddr: newLayout.maxAddr,
        threadSlotQuota: newLayout.threadSlotCount,
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
        generation: allocateProcessGeneration(),
        memory: newMemory,
        memoryLease: newMemoryLease,
        workerQuiescence: createWorkerQuiescence(),
        execRetirement: createWorkerQuiescence(),
        memoryRetirementSafe: true,
        aliasExposed: false,
        argv: launchArgv,
        programBytes,
        programModule,
        worker: replacementWorker,
        channelOffset: newChannelOffset,
        ptrWidth: newPtrWidth,
        secureExec,
        layout: newLayout,
        externrefGeneration: replacementExternrefGeneration,
      });
      preparedTransferred = true;

      // WHY: only terminal messages from every old Worker prove that no realm
      // can still touch this address space. A timeout uses forced retirement,
      // which drops the kernel alias but never recycles the backing.
      if (oldMemoryRetirementSafe) initiatingInfo.memoryLease.release();
      else initiatingInfo.memoryLease.releaseAfterForcedTermination();
      initiatingLeaseConsumed = true;

      installProcessWorkerListeners(
        replacementWorker,
        pid,
        "exec worker error",
      );
      const startDisposition = await retryKernelEntryResult(() =>
        kernelWorker.startProcessWorkerWhenRunnable(
          pid,
          newMemory,
          () => {
            if (!(replacementWorker as DeferredWorkerHandle).start()) {
              throw new Error(`Exec replacement Worker for pid ${pid} was cancelled`);
            }
            if (
              vforkBorrower
              && vforkLifetimes.phaseForChild(initiatingInfo) !== undefined
            ) {
              completeVforkGenerationTeardown(
                initiatingInfo,
                oldMemoryRetirementSafe && initiatingLeaseConsumed,
                "exec",
                new Error(
                  `vfork child ${pid} exec retired without an exact old-memory fence`,
                ),
              );
            }
          },
          () => {
            replacementForkHostImports?.close();
            void replacementWorker?.terminate();
          },
          (error) => {
            if (
              vforkBorrower
              && vforkLifetimes.phaseForChild(initiatingInfo) !== undefined
            ) {
              completeVforkGenerationTeardown(
                initiatingInfo,
                oldMemoryRetirementSafe && initiatingLeaseConsumed,
                "trap",
                error,
              );
            }
            const message = error instanceof Error ? error.message : String(error);
            reportHostDiagnostic({
              pid,
              status: signalExitStatus(SIGSEGV),
              source: "exec post-commit transition",
              message: `[exec] post-commit transition failed: ${message}`,
            });
            void finalizeProcessWorker(
              pid,
              replacementWorker as DeferredWorkerHandle,
              signalExitStatus(SIGSEGV),
              SIGSEGV,
            );
            return true;
          },
        ),
      );
      if (startDisposition === "stale") {
        throw new Error(`Exec pid ${pid} changed generation before Worker launch`);
      }
      if (startDisposition === "dead") {
        replacementForkHostImports.close();
        await terminateTrackedWorker(replacementWorker);
        kernelWorker.finishProcessExecHandoff(pid);
        const signal = await retryKernelEntryResult(
          () => kernelWorker.finalizeExecHandoffTermination(pid),
        );
        if (vforkBorrower) {
          completeVforkGenerationTeardown(
            initiatingInfo,
            oldMemoryRetirementSafe,
            "exec",
            new Error(
              `vfork child ${pid} exec retired without an exact old-memory fence`,
            ),
          );
        }
        await awaitFinalizedProcessTeardown(
          pid,
          signal > 0 ? signalExitStatus(signal) : 0,
          replacementWorker,
          undefined,
          signal > 0 ? "signal" : "exit",
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
          // Exact release is correct here because `terminateTrackedWorker()`
          // above has already awaited `Worker.terminate()`, which on Node is a
          // genuine ownership fence: a thread parked in `Atomics.wait` does
          // not resume once it resolves. It is NOT correct because the
          // replacement "was never started" — `preparedTransferred` is set
          // after `DeferredWorkerHandle.start()`, so a start may well have
          // happened. The browser entry must keep force-retiring on this path:
          // its `Worker.terminate()` returns no completion signal and proves
          // nothing.
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
      if (
        vforkBorrower
        && preparedTransferred
        && vforkLifetimes.phaseForChild(initiatingInfo) !== undefined
      ) {
        completeVforkGenerationTeardown(
          initiatingInfo,
          oldMemoryRetirementSafe && initiatingLeaseConsumed,
          "trap",
          err,
        );
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
      handleExit(pid, signalExitStatus(SIGSEGV));
      return 0;
    }
  };
  return { onCommitFailure, startAfterCommit };
}

/**
 * Pre-flight resolver for SYS_SPAWN. Side-effect-free: looks up program
 * bytes for `path` through the spawn-only execPrograms/main-thread fallback,
 * follows shebangs, and compiles the final Wasm module. Exec never enters
 * this resolver: its bytes come only from the retained kernel target. Returns
 * null on ENOENT and `{ errno }` when the located target cannot be launched.
 *
 * `handleSpawn` in `host/src/kernel-worker.ts` calls this BEFORE
 * `kernel_spawn_process` so that file_actions (which the kernel runs
 * inside `spawn_child`) never execute on a doomed PATH iteration —
 * see the POSIX "exactly once" rule.
 */

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
    console.warn(`[node-kernel-worker] destroy drain timed out with woken process(es) still live; force-terminating`);
  }

  const retireCurrentGenerations = async (): Promise<void> => {
    for (const [pid, info] of [...processes.entries()]) {
      vmInterruptTimers.clear(pid, info);
      const [workerQuiescent, threadsQuiescent] = await Promise.all([
        waitForWorkerQuiescence(info.workerQuiescence),
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
        (result.error instanceof Error ? result.error.message : String(result.error)),
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
  if (!(await kernelWorker.waitForPcmDrain(PCM_DESTROY_DRAIN_TIMEOUT_MS))) {
    post({
      type: "host_diagnostic",
      pid: 0,
      source: "Node PCM output",
      message:
        "Audio clock did not consume the queued close tail before machine teardown; the remaining tail was discarded.",
    });
  }
  await pcmDriver?.close();
  pcmDriver = null;
  kernelWorker.shutdownPcmTransport();
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
  const result = await processMemoryCreators.closeAndRunAfterDrain(
    performDestroy,
  );
  respond(msg.requestId, result);
}

// --- PTY ---

// --- Generic host-owned kernel pipes ---




// --- External HTTP request bridge ---

async function handleHttpRequest(msg: HttpRequestMessage) {
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
    respondError(msg.requestId, String(e));
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
      if (initReady) kernelWorker.closePipeRead(msg.pid, msg.pipeIdx);
      break;
    case "pipe_close_write":
      if (initReady) kernelWorker.closePipeWrite(msg.pid, msg.pipeIdx);
      break;
    case "pipe_is_write_open":
      respond(
        msg.requestId,
        initReady
          ? kernelWorker.isPipeWriteOpen(msg.pid, msg.pipeIdx)
          : uninitializedKernelPipeResult("is-write-open"),
      );
      break;
    case "wake_blocked_readers":
      if (initReady) kernelWorker.wakeBlockedReaders(msg.pipeIdx);
      break;
    case "wake_blocked_writers":
      if (initReady) kernelWorker.wakeBlockedWriters(msg.pipeIdx);
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
    case "write_vfs_file":
      handleWriteVfsFile(msg);
      break;
    case "signal_process": {
      try {
        respond(msg.requestId, kernelWorker.signalProcess(msg.pid, msg.signum));
      } catch (err) {
        respondError(msg.requestId, (err as Error)?.message ?? String(err));
      }
      break;
    }
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
        post({ type: "response", requestId: msg.requestId, result: kernelWorker.enumProcs() });
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
        post({ type: "response", requestId: msg.requestId, result: kernelWorker.readProcMaps(msg.pid) });
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
        post({ type: "response", requestId: msg.requestId, result: kernelWorker.drainSyscallTrace() });
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
