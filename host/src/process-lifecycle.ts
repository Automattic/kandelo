/**
 * Shared process-lifecycle logic for the Node and browser kernel worker
 * entries.
 *
 * `host/src/browser-kernel-worker-entry.ts` and
 * `host/src/node-kernel-worker-entry.ts` implement the same fork / vfork /
 * clone / exec / spawn / exit / thread lifecycle twice. 105 commits since
 * 2026-06-01 touched an entry file and 73 of them (70%) had to touch both —
 * and the two copies have drifted regardless, in ways ranging from harmless
 * to a VM interrupt timer left armed across a lease release.
 *
 * This module is the single implementation those two entries call. It exists
 * to make the drift structurally impossible, not merely discouraged.
 *
 * ## What belongs here
 *
 * Logic that is the same on every host. The genuine per-host residue is
 * small — constructing a Worker, constructing a `WebAssembly.Memory` and
 * posting a message are already abstracted behind `worker-adapter.ts` and
 * `process-memory.ts` — so "this differs between the hosts" is usually a
 * statement about how the code was written, not about the platform.
 *
 * ## Host differences are declared, not implied
 *
 * Where a real platform boundary exists it is named in
 * `ProcessLifecycleHost`, so a reader can see the whole list. The important
 * one is `terminationProvesQuiescence`:
 *
 * On Node, `await worker.terminate()` is a genuine ownership fence. This is
 * measured, not assumed: a worker parked in `Atomics.wait` on a
 * `SharedArrayBuffer` does not resume once it resolves, while the same
 * `Atomics.notify` wakes a live parked thread. In the browser,
 * `Worker.terminate()` returns `void`, offers no completion signal, and
 * `worker-adapter-browser.ts` has to fabricate the `exit` event itself.
 *
 * That single asymmetry is the real source of three of the four
 * "bug-shaped" divergences the K4 grounding catalogued — thread-slot
 * reclaim, exec-replacement lease release, and the browser-only
 * `memoryRetirementSafe` flag. Declaring it once means the safety model is
 * universal, with Node simply being the host where the predicate always
 * holds, rather than a browser-specific quirk the Node entry appears to be
 * missing.
 */

import {
  CAPTURED_STDIO,
  TERMINAL_STDIO,
  type CentralizedKernelCallbacks,
  type CentralizedKernelWorker,
  isCurrentProcessGeneration,
  type ForkBorrowedReplayWorkspace,
  type ForkContinuationContext,
  type ResolvedSpawnProgram,
  type SpawnProgramResolution,
  type ThreadChannelAttachment,
} from "./kernel-worker";
import type {
  CentralizedThreadInitMessage,
  CentralizedWorkerInitMessage,
  WorkerToHostMessage,
} from "./worker-protocol";
import { createWorkerQuiescence } from "./worker-quiescence";
import {
  retryKernelEntryResult,
  retryKernelEntryResultForGeneration,
} from "./kernel-entry-retry";
import { readPreparedPlatformFile } from "./vfs";
import type { PlatformIO } from "./types";
import {
  describeWasmArtifactPolicyFailures,
  detectPtrWidth,
  extractAbiVersion,
  isWasmModuleBytes,
} from "./constants";
import {
  FILE_MODES,
  PROCESS_FORK_MODE_VFORK,
  type ProcessForkMode,
} from "./generated/abi";
import type { ForkExternrefImportWake } from "./fork-externref-import-mailbox";
import {
  ForkHostImportOwnerRuntime,
  type ForkHostImportOwnerWorker,
} from "./fork-host-import-runtime";
import { ForkExternrefProcessOwner } from "./fork-externref-process-owner";
import type { ForkExternrefGeneration } from "./fork-reference-broker";
import type {
  ForkModuleProofMessage,
  HostDiagnostic,
  HostDiagnosticMessage,
} from "./host-diagnostic";
import type { ProcessMemoryLayout, ProcessMemoryLease } from "./process-memory";
import {
  materializeThreadSlot,
  THREAD_SLOT_BYTES,
  type ThreadAllocation,
} from "./thread-allocator";
import type { WorkerHandle } from "./worker-adapter";
import { ThreadExitCoordinator } from "./thread-exit-coordinator";
import {
  waitForExecRetirement as waitForExecRetirementFence,
  waitForWorkerQuiescence as waitForWorkerQuiescenceFence,
  type WorkerQuiescence,
} from "./worker-quiescence";
import {
  VforkAddressSpaceBusyError,
  type VforkExactCompletionReason,
  type VforkLifetime,
  VforkLifetimeCoordinator,
  type VforkLifetimeDisposition,
} from "./vfork-lifetime";
import {
  classifiedSignalOrFallback as classifySignalOrFallback,
  classifiedTrapExitStatus as classifyTrapExitStatus,
  SIGSEGV,
  signalExitStatus,
} from "./trap-signals";
import { VmInterruptTimerManager } from "./vm-interrupt-timer";
import {
  ExactProcessGenerationDetachLedger,
  type ExactProcessGenerationDetachResult,
} from "./process-generation-detach";
import { ProcessMemoryCreatorGate } from "./process-memory-creator-gate";
import type {
  PreparedExecLaunchPlan,
  PreparedExecLaunchRequest,
} from "./exec-target";
import {
  collectRootfsBlobPaths,
  createRootfsBlobProvider,
} from "./vfs/rootfs-blob-store";
import { buildRootfsLazyWiring } from "./vfs/rootfs-lazy-archives";
import { CH_TOTAL_SIZE, PAGES_PER_THREAD, WASM_PAGE_SIZE } from "./constants";
import { extractHeapBase } from "./constants";
import {
  acquireForkMemoryClone,
  computeProcessMemoryLayout,
  deriveProcessMemoryRetirementAdmissionThresholds,
  ProcessMemoryAllocator,
  createProcessMemoryRetirementPressureHook,
  FORK_SAVE_BUFFER_SIZE,
  ProcessMemoryCapacityError,
  ProcessMemoryRetirementBacklogError,
} from "./process-memory";
import {
  ForkReplayGateCoordinator,
  observeForkReplayWorker,
} from "./fork-replay-gate";
import { sampleProcessMemoryStats } from "./fork-mechanism-trace";
import { patchWasmForThread } from "./worker-main";
import {
  removeThreadWorkerRegistryEntry,
  threadWorkerFailureDisposition,
} from "./thread-worker-disposition";
import { RootfsSnapshotGate } from "./rootfs-snapshot-gate";
import { uninitializedKernelPipeResult } from "./kernel-pipe-transport";
import { exportRootfsImageFromOverlay } from "./vfs/rootfs-overlay-export";
import type { MemoryFileSystem } from "./vfs";

/** The backing a single execution image owns. A PID persists across exec. */
export interface ProcessGenerationOwnership {
  memory: WebAssembly.Memory;
  memoryLease: ProcessMemoryLease;
}

/** A parent's control slot, borrowed until exact vfork exec/exit teardown. */
export interface VforkWorkspaceOwnership {
  /**
   * The process whose address space the slot was reserved from. A vfork child
   * borrows its parent's memory, so the release goes back to the parent's pid,
   * not the child's.
   */
  readonly ownerPid: number;
  readonly slotAddr: number;
  released: boolean;
}

/**
 * The part of each entry's `ProcessInfo` this module actually reads.
 *
 * Deliberately structural and minimal: each host's richer record satisfies
 * it, and this module cannot reach fields it has no business touching.
 */
/**
 * A request to launch the first process of a machine.
 *
 * The union of what the two hosts' `SpawnMessage` types could express. Each
 * host's message satisfies it structurally, so neither protocol had to change
 * — but the launch path now honours every field on every host, which closed
 * three drifts: `maxPages` (browser-only), `maxAddr` (Node-only) and `cwd`
 * reaching the worker (browser-only).
 */
export interface ProcessSpawnRequest {
  requestId: number;
  argv: string[];
  env?: readonly string[];
  cwd?: string;
  programBytes?: ArrayBuffer;
  programPath?: string;
  /** A module pre-compiled from `programBytes`, where the host has one. */
  programModule?: WebAssembly.Module;
  uid?: number;
  gid?: number;
  pty?: boolean;
  ptyCols?: number;
  ptyRows?: number;
  stdin?: Uint8Array | ArrayBuffer;
  /** Per-process page ceiling; the kernel default when absent. */
  maxPages?: number;
  /** Heap growth limit protecting the thread channel pages. */
  maxAddr?: number;
}

/**
 * The compiled co-resident side modules a new worker is handed at init.
 *
 * A genuine artifact difference: Node compiles them from files on disk, the
 * browser receives them already compiled from its main thread. Both process
 * and thread workers take the same block, which is why it is typed on its own
 * rather than as a slice of either init message.
 */
export interface SideModuleInitFields {
  /**
   * Optional because the browser ships only the wasm32 side modules: a wasm64
   * guest gets none, and a fork-instrumented wasm64 worker fails loud rather
   * than silently forking without the module.
   */
  forkModuleModule?: WebAssembly.Module;
  wasiModuleModule?: WebAssembly.Module;
  dylinkModuleModule?: WebAssembly.Module;
}

/** Non-`_start` continuation root inherited from a pthread fork until exec. */
export interface ForkReplayContext {
  fnPtr: number;
  argPtr: number;
  forkBufAddr: number;
}

/**
 * One execution image's host-side record.
 *
 * Generic in the worker handle alone, because that is the only part of it
 * that was ever host-specific: the two entries' `ProcessInfo` declarations
 * were otherwise field-for-field the same once the browser's four extra
 * fields were recognised as host-independent concepts. Making the whole
 * module generic in the *worker* rather than in the *record* is what lets
 * shared code build a generation, instead of asking each host to.
 */
export interface ProcessLifecycleInfo<
  W extends LifecycleWorker = LifecycleWorkerHandle,
> extends ProcessGenerationOwnership {
  channelOffset: number;
  vforkWorkspace?: VforkWorkspaceOwnership;
  worker: W;
  forkReplayContext?: ForkReplayContext;
  /**
   * The co-resident fork-module region this process worker placed in its
   * shared linear memory (reported by the worker at init). A COPIED fork child
   * reuses this exact base so it does not double-map the module region it
   * already inherits via its memory clone. Inherited into a child's generation
   * so a grandchild fork propagates the same base.
   */
  forkModuleRegion?: { base: number; bytes: number };
  ptrWidth: 4 | 8;
  layout: ProcessMemoryLayout;
  workerQuiescence: WorkerQuiescence;
  execRetirement: WorkerQuiescence;
  externrefGeneration: ForkExternrefGeneration;
  secureExec: boolean;
  programBytes: ArrayBuffer;
  programModule?: WebAssembly.Module;
  /** The image's argument vector. */
  argv: readonly string[];

  /**
   * Host-independent identity for one execution image. A PID persists across
   * exec; a generation does not.
   *
   * The browser needs it to address a main-thread framebuffer alias cloned
   * from this exact Memory, and Node has no such alias — but the *concept* is
   * not browser-specific, and giving both hosts a monotonic counter is what
   * lets every process-constructing path be written once. What differs is only
   * whether the exit message carries it, and that is `reportProcessExit`.
   */
  generation: number;

  /**
   * Whether this generation's backing may still be released exactly rather
   * than force-retired.
   *
   * Cleared when a host-side owner was lost without an ownership fence — a
   * browser thread Worker terminated while parked, say. Always true where
   * `terminationProvesQuiescence` holds, which is why Node is the host the
   * predicate never falsifies rather than the host missing a safety model.
   */
  memoryRetirementSafe: boolean;

  /** True once this generation's Memory was cloned to a host-side alias. */
  aliasExposed: boolean;

  /** Exact host-side alias teardown, shared by competing failure paths. */
  aliasRelease?: Promise<boolean>;
}

/**
 * The part of a host's worker handle this module uses.
 *
 * Both `worker-adapter.ts` handles satisfy it; what a terminated worker
 * *proves* is the host difference, and that is declared separately as
 * `terminationProvesQuiescence`.
 */
export interface LifecycleWorker {
  terminate(): Promise<unknown>;
}

/**
 * The worker handle this module drives.
 *
 * Narrower than `WorkerHandle` was not sustainable once fork construction
 * moved here: `observeForkReplayWorker` needs the message surface to watch a
 * child reach its copied activation. Both hosts' adapters already return
 * exactly `WorkerHandle`, so this constrains nothing they do not already
 * satisfy — it only stops the module pretending it touches less than it does.
 */
export type LifecycleWorkerHandle = WorkerHandle;

/**
 * One thread worker of a multi-threaded process.
 *
 * `quiescent` records that the worker published a `memory_quiescent` fence.
 * It is optional because a host whose `terminate()` is itself an ownership
 * fence has no need to observe the message — see `terminationProvesQuiescence`
 * — not because the concept is host-specific.
 */
export interface ThreadWorkerRecord<W extends LifecycleWorker> {
  worker: W;
  channelOffset: number;
  tid: number;
  basePage: number;
  quiescent?: boolean;
  workerQuiescence: WorkerQuiescence;
  execRetirement: WorkerQuiescence;
  termination?: Promise<void>;
}

/** The narrow slice of a host's outbound message union this module posts. */
export type ProcessLifecycleOutboundMessage =
  | HostDiagnosticMessage
  | ForkModuleProofMessage
  | { type: "kernel_fatal"; error: string }
  | { type: "proc_event"; kind: "spawn"; pid: number; ppid: number }
  | { type: "proc_event"; kind: "exec"; pid: number }
  | { type: "response"; requestId: number; result: unknown; error?: string };

/**
 * Everything this module needs from its host. Every genuine platform
 * boundary appears here, so the list of real differences is readable in one
 * place instead of being inferred from two 4,000-line files.
 */
export interface ProcessLifecycleHost<W extends LifecycleWorkerHandle> {
  /**
   * Send a message to the main thread, optionally transferring buffers.
   *
   * Both hosts support a transfer list; the Node entry previously reached
   * past `post` to `port.postMessage` for the one message that needs one.
   */
  post(
    message: ProcessLifecycleOutboundMessage,
    transfer?: ArrayBuffer[],
  ): void;

  /**
   * Whether an awaited worker termination proves the worker has stopped.
   *
   * `true` on Node, where `await worker.terminate()` joins the thread.
   * `false` in the browser, where `Worker.terminate()` reports nothing and a
   * guest parked in `Atomics.wait` cannot be observed to have stopped. When
   * this is `false`, a slot or a memory backing released after termination
   * must be force-retired rather than exactly released.
   *
   * NOT YET CONSUMED. Both hosts declare it correctly, but the code that
   * should branch on it — thread-slot reclaim in `handleClone`, the exec
   * rollback's lease release, and the browser's `memoryRetirementSafe`
   * bookkeeping — still lives in the two entries and has not been moved here.
   * It is declared now because it is the adjudicated form of that behaviour
   * and the next tranche derives all three from it; until then it documents
   * the boundary rather than enforcing it.
   */
  readonly terminationProvesQuiescence: boolean;

  /** Whether `traceVforkMechanism` should emit. Read per call, not cached. */
  isVforkMechanismTraceEnabled(): boolean;

  /**
   * The kernel this entry drives.
   *
   * A function rather than a field because both entries assign their
   * `kernelWorker` during `handleInit`, after this record is built. It is the
   * same class on every host, so it is not a host difference — it is here only
   * so the shared code can reach it.
   */
  kernel(): CentralizedKernelWorker;

  /** Prefix for this host's diagnostic messages, e.g. `[node-kernel-worker]`. */
  readonly diagnosticPrefix: string;

  /**
   * Whether `handleInit` has completed.
   *
   * Before it has, the kernel exists but owns nothing, so requests that would
   * reach it must be refused with a defined result rather than a thrown
   * protocol error.
   */
  isInitReady(): boolean;

  /**
   * The frozen base rootfs image this kernel booted from, if it booted from
   * one. Null means the kernel has no overlay to write into or export.
   */
  rootfsBaseImage(): MemoryFileSystem | null | undefined;

  /** This kernel's process memory allocator. */
  processMemoryAllocator(): ProcessMemoryAllocator;

  /** Default per-process page ceiling when a spawn does not name one. */
  defaultMaxPages(): number;

  /** Default number of thread slots to reserve in a new address space. */
  defaultThreadSlots(): number;

  /**
   * Report a process exit to the main thread, exactly once per PID.
   *
   * Host-owned only because the two hosts' `exit` message carries different
   * fields: the browser names the execution generation that ended, Node names
   * the PID alone.
   */
  reportProcessExit(
    pid: number,
    info: ProcessLifecycleInfo<W>,
    status: number,
  ): void;

  /**
   * The signal to synthesize a crash reap with when a caller of
   * `finishProcessExit` does not name one.
   *
   * The browser always synthesizes — `signalFromExitStatus(status) ?? SIGSEGV`
   * — relying on the kernel's `hostReaped` guard to make it a no-op after a
   * clean SYS_EXIT_GROUP. Node returns undefined because its worker-'exit'
   * handler and vfork containment path call `notifyHostProcessCrashed`
   * themselves before entering the shared teardown. Same kernel call, two call
   * graphs; declaring the default keeps both exact.
   */
  defaultExitCrashSignum(exitStatus: number): number | undefined;

  /**
   * Settle delay applied when terminating a process's thread workers.
   *
   * Separate from `processExitSettleMs` because a process worker running a
   * wasm JS engine needs a much longer compatibility delay than a pthread
   * worker does, and charging the longer one to every thread would slow every
   * threaded teardown for no gain.
   */
  readonly threadWorkerSettleMs: number;

  /**
   * How long a terminated process worker needs to settle before its address
   * space may be reused, over and above the ownership fence.
   *
   * The thread-worker component is NOT this hook's business: a process that
   * cloned is recorded by `handleClone` and charged `threadWorkerSettleMs`
   * by the shared exit path, because the thread registry is already empty by
   * the time an exit chooses a settle.
   *
   * Zero where `terminate()` is itself a fence. A nonzero value is a
   * compatibility delay and never proves retirement safe on its own — only
   * the worker's `memory_quiescent` fence does that. Called once per exit, so
   * a host may also retire per-PID exit bookkeeping here.
   */
  processExitSettleMs(pid: number, info: ProcessLifecycleInfo<W>): number;

  /**
   * Release any host-side alias of this generation's `WebAssembly.Memory`,
   * resolving true once the host proves it no longer owns one.
   *
   * The browser has one: main-thread framebuffer registry views cloned from
   * the Memory at `fb_bind`. Worker quiescence fences the process and
   * kernel-worker realms only, so main's exact-generation acknowledgement is
   * part of retirement too; a timeout resolves false rather than pretending.
   * Node has no such owner and answers true.
   *
   * This replaced the narrower `exitRetirementFences`, which folded the alias
   * release together with `memoryRetirementSafe`. That flag now lives on the
   * shared `ProcessLifecycleInfo`, so the exit predicate — and the identical
   * one in every process-construction rollback — is written once here.
   */
  releaseGenerationAliases(
    pid: number,
    info: ProcessLifecycleInfo<W>,
  ): boolean | Promise<boolean>;

  /**
   * Construct a process worker for a fully built init message.
   *
   * The irreducible host floor: `new Worker(url)` in the browser and
   * `new NodeWorker(path)` on Node, already narrowed to one call by
   * `worker-adapter.ts`.
   */
  createProcessWorker(init: CentralizedWorkerInitMessage): W;

  /**
   * Construct a process worker whose backing Worker is built only when
   * `start()` is called, so a job-control-stopped child can be published
   * without being able to execute a single guest instruction.
   *
   * `DeferredWorkerHandle` is host-independent; the hook exists because the
   * factory it wraps is the per-host `createWorker`.
   */
  createDeferredProcessWorker(
    init: CentralizedWorkerInitMessage,
    purpose: "spawn" | "fork" | "vfork" | "exec",
  ): W & { start(): boolean };

  /**
   * Init-message fields naming this host's co-resident side modules.
   *
   * A genuine artifact difference: Node reads the modules off disk, the
   * browser receives them as compiled `WebAssembly.Module`s from main.
   */
  sideModuleInitFields(ptrWidth: 4 | 8): SideModuleInitFields;

  /**
   * Attach this host's message/error listeners to a new process worker.
   *
   * `errorLabel` names the launch in a worker-error diagnostic, so a failure
   * during a `posix_spawn` is distinguishable from an ordinary one.
   */
  /**
   * Construct a pthread worker for an existing process image.
   *
   * Deferred like a process worker, so the thread's Worker is constructed
   * only once the kernel says the thread is runnable.
   */
  createThreadWorker(
    init: CentralizedThreadInitMessage,
  ): W & { start(): boolean };

  installProcessWorkerListeners(
    worker: W,
    pid: number,
    errorLabel?: string,
  ): void;

  /**
   * The environment a launch actually runs with, given the requested one.
   *
   * The browser injects its TLS-MITM CA path so guest TLS can verify through
   * the host's proxied egress; Node reaches the network directly and returns
   * the request unchanged. A host decoration, not a POSIX one.
   */
  decorateLaunchEnv(env: readonly string[]): string[];

  /** The environment a spawn request that names none inherits. */
  defaultLaunchEnv(): readonly string[];

  /**
   * Barrier a new process generation must clear before claiming an address
   * space, beyond the allocator's own admission.
   *
   * See `waitForProcessTeardowns` on the browser entry: without an ownership
   * fence, a still-terminating predecessor's backing is not yet reclaimable,
   * so admitting a successor first can exhaust the reservation. Where
   * `terminationProvesQuiescence` holds the teardown has already completed by
   * the time it is awaited, so the barrier is vacuous rather than absent.
   */
  awaitProcessConstructionBarrier(): Promise<void>;

  /**
   * Called once a spawn has set up a PTY for the new process.
   *
   * Node registers the output callback here; the browser waits for main to
   * ask with `register_pty_output`, because its main thread owns when the
   * terminal starts consuming. A protocol difference, not a POSIX one.
   */
  onProcessPtyReady?(pid: number, ptyIdx: number): void;

  /**
   * Stop this kernel realm after a fatal kernel-instance failure.
   *
   * The last irreducible step of `terminatePoisonedKernelWorker`: the kernel
   * can no longer coordinate anything, so the host closes its own worker
   * realm. A dedicated worker closes itself in the browser and exits the
   * thread on Node, after releasing whatever host resources it owns.
   */
  stopKernelRealm(): void;

  /**
   * The guest mount table, when one exists.
   *
   * The in-kernel overlay owns `/` unconditionally, but sibling foreign mounts
   * still serve their own exec bytes, so exec resolution falls through to this
   * when the overlay disowns a path. A function rather than a field because
   * both entries build it during `handleInit`.
   */
  execMountIO(): PlatformIO | null | undefined;

  /**
   * Record which image a PID exec'd, for a host that can report it.
   *
   * The browser answers a `pid_map_dump` message from main with a pid → path
   * table, so its profiling output names programs instead of bare numbers.
   * Node has no such message and leaves this undefined. A reporting facility,
   * not a step in the exec transition — nothing downstream reads it back.
   */
  noteExecImagePath?(pid: number, path: string): void;

  /**
   * Extra exec-byte sources this host has beyond the filesystem, if any.
   *
   * Node injects program buffers into the worker and can ask the main thread
   * to resolve a path; the browser has neither, so it leaves this undefined
   * and exec resolution reads the filesystem alone. This is the *whole* host
   * difference in exec resolution — see `resolveExecutableForLaunch`.
   */
  resolveExecFile?(path: string): Promise<ArrayBuffer | null>;
}

// ── Host-independent helpers ────────────────────────────────────────────────

/**
 * The signal encoded in a shell-style wait status, or null for a plain exit.
 */
export function signalFromExitStatus(exitStatus: number): number | null {
  return exitStatus >= 128 ? (exitStatus - 128) & 0x7f : null;
}

/** Back-off between attempts to read an exec target through the overlay. */
export function execOverlayRetryDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether an error means "that path is not there", as opposed to a real
 * failure that should abort exec resolution.
 */
export function isMissingPathError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === -2 || code === "ENOENT") return true;
  // With the overlay owning `/`, the host `/` mount is dropped, so a `/`-owned
  // path the overlay disowns hits `VirtualPlatformIO` with no covering mount
  // ("ENOENT: no mount for path: ..."). That is a missing-path condition, not a
  // hard failure — treat it as ENOENT so exec resolution falls through cleanly.
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" &&
    message.startsWith("ENOENT: no mount for path");
}

/**
 * Render an error for a diagnostic message, keeping the stack when there is
 * one.
 *
 * The Node entry previously used only `err.message` here, so a lifecycle
 * failure reported on Node lost its stack while the same failure on the
 * browser kept it. Diagnostics should not be less truthful on one host.
 */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ? `${err.message}\n${err.stack}` : err.message;
  }
  return String(err);
}

/** Resolve after `ms` milliseconds of real time (a macrotask, not a tick). */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long to wait for a process worker's `memory_quiescent` fence.
 *
 * Short: the timeout is not evidence that termination completed, it only
 * bounds teardown latency. A worker that does not report in time is retired
 * through the forced path instead of the exact one.
 */
export const PROCESS_WORKER_QUIESCENCE_WAIT_MS = 100;

/**
 * How long to wait for an exec'd generation to publish its retirement.
 *
 * Long: unlike plain quiescence this is a handoff the replacement image is
 * waiting on, so giving up early would hand out a backing that is still live.
 */
export const EXEC_WORKER_RETIREMENT_WAIT_MS = 5_000;

/**
 * Acknowledge a kernel-completed thread exit.
 *
 * The kernel has finished the exit syscall, but the process worker may not
 * have resumed from `Atomics.wait` yet. Slot reclamation is authorized by the
 * worker's `memory_quiescent` message, never by `Worker.terminate()`, so
 * there is nothing to do here beyond reporting success.
 */
export function handleThreadExit(pid: number, channelOffset: number): boolean {
  void pid;
  void channelOffset;
  return true;
}

// ── Host-parameterised lifecycle ────────────────────────────────────────────

/**
 * What a process-memory allocation was for, reported when it fails.
 *
 * Module scope and exported, not local to `createProcessLifecycle`, because
 * that function's return type mentions it. A type reachable from an exported
 * signature is part of the public surface whether or not anyone imports it by
 * name, and a declaration file cannot describe it otherwise -- `tsup`'s `.d.ts`
 * pass failed the whole `host/dist` build with TS4060 "return type of exported
 * function has or is using private name" while it lived inside the closure.
 */
export interface ProcessMemoryAllocationContext {
  operation:
    | "spawn"
    | "posix_spawn"
    | "exec"
    | "fork"
    | "vfork"
    | "clone";
  path?: string;
  argv?: readonly string[];
}

/**
 * Bind the shared lifecycle logic to one host.
 *
 * Returns plain functions rather than a class so each entry can destructure
 * exactly what it uses and the call sites read the same as before.
 */
export function createProcessLifecycle<W extends LifecycleWorkerHandle>(
  host: ProcessLifecycleHost<W>,
) {
  type Info = ProcessLifecycleInfo<W>;

  // ── Realm state ────────────────────────────────────────────────────
  //
  // Every declaration below was written identically in both worker entries and
  // handed straight back through `ProcessLifecycleHost`. None of it was ever a
  // host difference: a `Map` of live processes is the same `Map` on Node and
  // in the browser. Constructing it here removes ten fields from the host
  // record — which is the point, because that record is the contract this
  // campaign is trying to shrink, not merely a place to move line counts to.

  /** Live processes by PID. */
  const processes = new Map<number, Info>();

  /** In-flight process teardowns, keyed by the worker being torn down. */
  const processTeardowns = new Map<W, Promise<void>>();

  /** PTY index by PID. */
  const ptyByPid = new Map<number, number>();

  /** Exact broker authority for each PID's current Wasm image. */
  const externrefProcessOwner = new ForkExternrefProcessOwner();

  /** Owner registry issuing this realm's fork host-import workers. */
  const forkHostImportOwnerRuntime =
    new ForkHostImportOwnerRuntime(externrefProcessOwner);

  /** Owner registry for the fork host-import protocol, keyed by worker. */
  const forkHostImportsByWorker =
    new WeakMap<object, ForkHostImportOwnerWorker>();

  const vforkLifetimes = new VforkLifetimeCoordinator<Info>();

  const vmInterruptTimers = new VmInterruptTimerManager<Info>((pid) =>
    processes.get(pid),
  );

  /**
   * Admission gate for process-memory creators, so a destroy can close
   * admission synchronously and still drain whoever entered first.
   */
  const processMemoryCreators = new ProcessMemoryCreatorGate();

  /**
   * Retry ledger for exact process-generation detach transactions.
   *
   * The two entries' callbacks differed by one line: the browser dropped the
   * PID from `threadedProcessPids` and Node did not. Node's omission was
   * documented as inert — its `threadWorkerSettleMs` is zero, so a stale entry
   * changes no decision — but it still grew a `Set` for the life of the realm.
   * Sharing the ledger takes the browser's half, which is the complete one.
   */
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

  /**
   * Next execution-generation number for this realm.
   *
   * Monotonic and never reused, so a message naming a generation can always
   * be rejected as stale rather than misapplied to a successor image.
   */
  let nextProcessGeneration = 1;

  function allocateProcessGeneration(): number {
    const generation = nextProcessGeneration++;
    if (!Number.isSafeInteger(generation)) {
      throw new Error("process execution generation space exhausted");
    }
    return generation;
  }

  function traceVforkMechanism(event: string, fields: string): void {
    if (!host.isVforkMechanismTraceEnabled()) return;
    console.log(`[vfork-mechanism] event=${event} ${fields}`);
  }

  function reportHostDiagnostic(
    diagnostic: HostDiagnostic,
    level: "error" | "warn" = "error",
  ): void {
    if (level === "warn") console.warn(diagnostic.message);
    else console.error(diagnostic.message);
    host.post({ type: "host_diagnostic", ...diagnostic });
  }

  /**
   * Report fork-module use on its own channel, so a clean fork never has to
   * be distinguished from a diagnostic by parsing a message string.
   */
  function postForkModuleProof(diagnostic: HostDiagnostic): void {
    host.post({ type: "fork_module_proof", ...diagnostic });
  }

  function respond(requestId: number, result: unknown): void {
    host.post({ type: "response", requestId, result });
  }

  function respondError(requestId: number, error: string): void {
    host.post({ type: "response", requestId, result: null, error });
  }

  function handleVmInterruptTimer(
    msg: {
      pid: number;
      timedOutPtr: number;
      vmInterruptPtr: number;
      seconds: number;
    },
    pid: number,
    process: Info,
  ): void {
    if (msg.pid !== pid) return;
    vmInterruptTimers.handleRequest(pid, process, msg);
  }

  /** Return a borrowed vfork control slot to its owning allocator, once. */
  function releaseVforkWorkspace(info: Info): void {
    const workspace = info.vforkWorkspace;
    if (!workspace || workspace.released) return;
    workspace.released = true;
    releaseThreadSlot(workspace.ownerPid, workspace.slotAddr);
  }

  /**
   * Close out a vfork child's generation.
   *
   * `exact` says whether the caller holds a real quiescence fence for the
   * child. Without one the address space must stay contained rather than be
   * handed back, because the borrowed backing is the *parent's*.
   */
  function completeVforkGenerationTeardown(
    info: Info,
    exact: boolean,
    reason: VforkExactCompletionReason,
    cause?: unknown,
  ): void {
    const phase = vforkLifetimes.phaseForChild(info);
    if (phase === undefined) return;
    if (!exact) {
      vforkLifetimes.requireAddressSpaceContainment(
        info,
        cause ?? new Error("vfork child teardown lacked an exact quiescence fence"),
      );
      return;
    }
    traceVforkMechanism(
      "exact_teardown",
      `child_channel=${info.channelOffset} reason=${reason}`,
    );
    releaseVforkWorkspace(info);
    if (phase === "starting") {
      vforkLifetimes.completeWithoutBorrow(
        info,
        reason === "exit" ? "exit" : "signal",
      );
    } else {
      vforkLifetimes.completeAfterExactTeardown(info, reason);
    }
  }

  /**
   * Return a control slot to the kernel's address-space allocator.
   *
   * Called only once the slot is provably out of use. The kernel deliberately
   * does not free it at thread exit, because a worker terminated without a
   * quiescence fence can still write into its slot and only this host knows
   * when that has settled.
   */
  function releaseThreadSlot(pid: number, slotAddr: number): void {
    host.kernel().releaseHostRegion(pid, slotAddr, THREAD_SLOT_BYTES);
  }

  /**
   * Reserve a host-owned control slot outside the guest pthread quota.
   *
   * WHY: a single-threaded executable can truthfully declare zero pthread
   * slots and still call vfork. Its borrowing child needs an independent
   * syscall channel, replay prefix, and scratch page, but that platform state
   * must neither require nor consume capacity promised to pthread_create --
   * so it comes from `kernel_reserve_host_region` rather than through `clone`.
   */
  function placeHostControlSlot(
    pid: number,
    memory: WebAssembly.Memory,
    ptrWidth: 4 | 8,
  ): ThreadAllocation {
    const slotAddr = host.kernel().reserveHostRegion(pid, THREAD_SLOT_BYTES);
    return materializeThreadSlot(memory, slotAddr, ptrWidth);
  }

  function bindForkHostImports(
    worker: object,
    owner: ForkHostImportOwnerWorker,
  ): void {
    forkHostImportsByWorker.set(worker, owner);
  }

  function dispatchForkHostImport(
    worker: object,
    message: { wake: ForkExternrefImportWake },
  ): void {
    const owner = forkHostImportsByWorker.get(worker);
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

  /**
   * Run one exact process-generation detach transaction through the ledger.
   *
   * `operation` selects what the kernel is told: deactivate the pid (it
   * becomes a zombie), unregister it entirely, or nothing at all when the
   * caller only needs the retirement half.
   */
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
          return host.kernel().deactivateProcess(pid, generation.memory);
        }
        return host.kernel().unregisterProcess(pid, generation.memory);
      },
      settle: () => {
        if (operation === "none") return;
        return host.kernel().settleRetiredChannelListeners(
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
            `${host.diagnosticPrefix} pid ${pid} retired its exact process ` +
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
          `${host.diagnosticPrefix} retained pid ${pid}'s exact process ` +
          `memory: ${formatError(result.error)}`,
      });
    } catch {
      // WHY: the transaction remains in the retry ledger. A closed diagnostic
      // port must not replace the lifecycle error or discard retry authority.
    }
  }

  function handlePtyWrite(pid: number, data: Uint8Array): void {
    const ptyIdx = ptyByPid.get(pid);
    if (ptyIdx === undefined) return;
    host.kernel().ptyMasterWrite(ptyIdx, data);
  }

  function handlePtyResize(pid: number, rows: number, cols: number): void {
    const ptyIdx = ptyByPid.get(pid);
    if (ptyIdx === undefined) return;
    host.kernel().ptySetWinsize(ptyIdx, rows, cols);
  }

  /**
   * Workers we deliberately terminated — exec, exit, top-level destroy.
   *
   * A browser worker's synthesized "exit" event fires on `terminate()`
   * indistinguishably from an unexpected death, so the crash detector consults
   * this set to skip the deliberate cases.
   */
  const intentionallyTerminated = new WeakSet<object>();

  /**
   * Termination promises still in flight, including standalone thread-worker
   * teardowns that outlive the process-map entry they came from.
   *
   * Anything that needs the realm to be quiescent — the rootfs export, above
   * all — has to see these. Only the browser entry tracked them; on Node the
   * teardown is usually awaited by its caller, but "usually" is not a
   * guarantee an observer can rely on, so both hosts track them now.
   */
  const workerTeardowns = new Set<Promise<void>>();

  /** Thread workers per PID, for cleanup. */
  const threadWorkers = new Map<
    number,
    ThreadWorkerRecord<W>[]
  >();

  const threadExits = new ThreadExitCoordinator();

  /**
   * Terminate a worker we own, recording the teardown so observers can wait.
   *
   * `settleMs` buys time for a host whose `terminate()` proves nothing to let
   * the worker actually stop; it is 0 where termination is itself a fence.
   */
  async function terminateTrackedWorker(
    worker: W,
    settleMs = 0,
  ): Promise<void> {
    intentionallyTerminated.add(worker as object);
    forkHostImportsByWorker.get(worker as object)?.close();
    const teardown = (async () => {
      await worker.terminate().catch(() => {});
      if (settleMs > 0) await delay(settleMs);
    })();
    workerTeardowns.add(teardown);
    void teardown.finally(() => workerTeardowns.delete(teardown));
    await teardown;
  }

  function waitForWorkerQuiescence(
    quiescence: WorkerQuiescence,
  ): Promise<boolean> {
    return waitForWorkerQuiescenceFence(
      quiescence,
      PROCESS_WORKER_QUIESCENCE_WAIT_MS,
    );
  }

  function waitForExecRetirement(
    retirement: WorkerQuiescence,
    quiescence: WorkerQuiescence,
  ): Promise<boolean> {
    return waitForExecRetirementFence(
      retirement,
      quiescence,
      EXEC_WORKER_RETIREMENT_WAIT_MS,
    );
  }

  /**
   * Tear down every thread worker of `pid`.
   *
   * Returns whether every thread published a real quiescence fence. A false
   * result is not a failure — it says the caller must force-retire the address
   * space rather than release it exactly.
   */
  async function terminateThreadWorkers(
    pid: number,
    requireExecRetirement = false,
    settleMs = 0,
  ): Promise<boolean> {
    const threads = threadWorkers.get(pid);
    if (!threads) return true;
    threadWorkers.delete(pid);
    const quiescence = await Promise.all(
      threads.map((thread) =>
        requireExecRetirement
          ? waitForExecRetirement(thread.execRetirement, thread.workerQuiescence)
          : waitForWorkerQuiescence(thread.workerQuiescence)),
    );
    const allQuiescent = quiescence.every(Boolean);
    for (const thread of threads) {
      intentionallyTerminated.add(thread.worker as object);
    }
    for (const t of threads) {
      await (t.termination ?? terminateTrackedWorker(t.worker, settleMs));
      threadExits.release(pid, t.channelOffset);
    }
    return allQuiescent;
  }

  /**
   * PIDs whose exit has already been reported to main.
   *
   * The once-only guarantee used to be structural: `finishProcessExit()`
   * returns early when a teardown is already registered, which is lossless
   * only because the entry's `processTeardowns.set()` and its `post()` are
   * adjacent with no `await` between them. Inserting a single `await` there
   * would silently drop a process exit. State the guarantee instead of relying
   * on statement order.
   *
   * Keying on PID is sound because the kernel never reuses a task ID within a
   * kernel instance (`crates/runtime-core/src/process_table.rs:1377-1380`).
   */
  const reportedExits = new Set<number>();

  /** Serialises rootfs mutations against a rootfs image export. */
  const rootfsSnapshotGate = new RootfsSnapshotGate();

  /**
   * Set once the kernel instance has been declared fatally poisoned, so the
   * teardown below runs exactly once however many callers observe the fault.
   */
  let kernelFatalReported = false;

  /**
   * Tear this kernel realm down after a fatal kernel-instance failure.
   *
   * A trapped kernel export can strand Rust's global transfer reservation in
   * Executing state, so nothing may call back into that generation. Terminate
   * the process workers and the process-owned pthread workers directly, then
   * hand the last step to the host.
   */
  function terminatePoisonedKernelWorker(error: Error): void {
    if (kernelFatalReported) return;
    kernelFatalReported = true;
    const detail = formatError(error);
    const prefix = host.diagnosticPrefix;
    try {
      try {
        reportHostDiagnostic({
          pid: 0,
          source: "kernel fatal",
          message: `${prefix} fatal kernel instance failure: ${detail}`,
        });
      } catch (reportError) {
        console.error(
          `${prefix} could not report fatal diagnostic:`,
          reportError,
        );
      }
      try {
        host.post({ type: "kernel_fatal", error: detail });
      } catch (postError) {
        console.error(`${prefix} could not post fatal state:`, postError);
      }
    } finally {
      // A rejected terminate() must not become an unhandled rejection in the
      // middle of fatal teardown: the browser entry dropped the catch the Node
      // entry had, so a refused termination surfaced as a second, unrelated
      // failure on top of the one being reported.
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
      host.stopKernelRealm();
    }
  }

  /**
   * Everything worth knowing about why a process-memory allocation failed.
   *
   * An allocation failure is a resource-exhaustion boundary, and the useful
   * question is always "exhausted by what" — so report the requested layout
   * alongside every live image and every teardown still in flight. This was a
   * browser-only diagnostic; a Node allocation failure threw with no context
   * at all.
   */
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
          argv: info.argv?.slice(0, 8),
          ptrWidth: info.ptrWidth,
          currentPages: Math.ceil(bufferBytes / WASM_PAGE_SIZE),
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
      },
      liveProcessCount: processes.size,
      pendingProcessTeardowns: processTeardowns.size,
      pendingWorkerTeardowns: workerTeardowns.size,
      totalLiveBufferBytes,
      liveProcesses,
    };
  }

  /**
   * Build a brand-new address space for one execution image.
   *
   * `processMaxPages` honours a caller-supplied per-process page ceiling; the
   * Node entry ignored the spawn option entirely and always used the kernel
   * default, which is a POSIX-visible difference in what a spawn request can
   * ask for.
   */
  async function createFreshProcessMemory(
    pid: number,
    programBytes: ArrayBuffer,
    ptrWidth: 4 | 8,
    processMaxPages = host.defaultMaxPages(),
    context?: ProcessMemoryAllocationContext,
  ): Promise<{
    memory: WebAssembly.Memory;
    memoryLease: ProcessMemoryLease;
    layout: ProcessMemoryLayout;
  }> {
    const heapBase = extractHeapBase(programBytes);
    const layout = computeProcessMemoryLayout({
      maxPages: processMaxPages,
      defaultThreadSlots: host.defaultThreadSlots(),
      ptrWidth,
      programBytes,
      heapBase,
    });
    let memoryLease: ProcessMemoryLease;
    try {
      memoryLease = await host.processMemoryAllocator().acquireWhenAvailable({
        ptrWidth,
        initialPages: layout.initialPages,
        maximumPages: layout.maximumPages,
      });
    } catch (e) {
      console.error(
        `${host.diagnosticPrefix} process memory allocation failed`,
        JSON.stringify(
          processMemoryAllocationDiagnostics(
            pid,
            ptrWidth,
            layout,
            heapBase,
            context,
          ),
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
      };
    } catch (error) {
      // No Worker or kernel registration can exist yet, so the lease still has
      // one owner and may be returned transactionally rather than force-retired.
      memoryLease.release();
      throw error;
    }
  }

  /**
   * Complete one process's exit: fence its workers, retire its address space,
   * deactivate the PID, and report the exit to main exactly once.
   *
   * `crashSignum` synthesizes a signal-style reap before `deactivateProcess`,
   * for the case where a worker died without sending SYS_EXIT_GROUP (an
   * uncaught wasm trap, or a Worker terminated from outside). Without it a
   * concurrent `waitpid` in the parent blocks until destroy, because the
   * kernel never marked the child a zombie. It is idempotent — the kernel's
   * `hostReaped` guard makes it a no-op when a clean SYS_EXIT_GROUP was
   * already processed.
   *
   * BOUNDARY, deliberately preserved rather than unified: the synthesis is a
   * *callee* responsibility in the browser, which passes a `crashSignum` on
   * every exit, and a *caller* responsibility on Node, whose worker-'exit'
   * handler (`finalizeProcessWorker`) and vfork containment path call
   * `notifyHostProcessCrashed` themselves and pass none. Both reach the same
   * kernel call; only the call graph differs. Collapsing that is a change to
   * Node's worker-'exit' path, which cannot be proven from the Node suites
   * alone, so it stays a declared difference here rather than an unvalidated
   * behaviour change.
   */
  async function finishProcessExit(
    pid: number,
    exitStatus: number,
    crashSignum: number | undefined,
    expectedWorker: W | undefined,
    vforkReason: VforkExactCompletionReason =
      signalFromExitStatus(exitStatus) === null ? "exit" : "signal",
  ): Promise<void> {
    if (!expectedWorker) return;
    const info = processes.get(pid);
    if (!info || info.worker !== expectedWorker) return;
    vmInterruptTimers.clear(pid, info);

    if (processTeardowns.has(expectedWorker)) {
      // A second notification for the same teardown still has to reach main:
      // the browser used to drop it silently while Node re-reported it, so the
      // same double exit was observable on one host and invisible on the
      // other. `reportProcessExit` is once-only per PID, so re-reporting is
      // idempotent and the Node shape is the safe one to adopt.
      host.reportProcessExit(pid, info, exitStatus);
      return;
    }

    // A process that ever cloned needs its host's thread-worker settle too,
    // and that fact is recorded at clone time because the thread registry is
    // already empty here. Whichever settle is longer wins; they overlap.
    const threadedSettleMs = threadedProcessPids.delete(pid)
      ? host.threadWorkerSettleMs
      : 0;
    const settleMs = Math.max(
      threadedSettleMs,
      host.processExitSettleMs(pid, info),
    );
    const reapSignum = crashSignum ?? host.defaultExitCrashSignum(exitStatus);

    const teardown = (async () => {
      if (reapSignum !== undefined) {
        try {
          host.kernel().notifyHostProcessCrashed(pid, reapSignum);
        } catch {
          // Best effort; continue to the exact-generation teardown funnel.
        }
      }

      // Keep the pid registered until the process worker is gone. musl's
      // _Exit() loops on SYS_exit after SYS_exit_group returns; while worker
      // termination is in flight those duplicate exits still need channel
      // completions, otherwise the worker can park in Atomics.wait with no
      // registered listener left to wake it.
      //
      // The two fences are independent, so they are awaited concurrently. The
      // browser awaited them in sequence, which delayed thread teardown by the
      // whole main-worker fence timeout for no stated reason.
      const [workerQuiescent, threadsQuiescent] = await Promise.all([
        waitForWorkerQuiescence(info.workerQuiescence),
        terminateThreadWorkers(pid, false, host.threadWorkerSettleMs),
      ]);
      await terminateTrackedWorker(expectedWorker, settleMs);

      // Deactivate the process (a zombie until reaped or destroy) after worker
      // termination, so no further guest syscalls can arrive on its channel.
      let exactMemoryTeardown = false;
      const detachResult = await detachExactProcessGeneration({
        pid,
        generation: info,
        operation: "deactivate",
        retire: async (commit) => {
          // The exit predicate, in full: every realm that could still be
          // holding this backing has proved it is not.
          const hostFences = info.memoryRetirementSafe
            && await host.releaseGenerationAliases(pid, info);
          exactMemoryTeardown = workerQuiescent && threadsQuiescent
            && hostFences;
          if (exactMemoryTeardown) {
            info.memoryLease.release();
          } else {
            // Without a terminal fence the backing is force-retired; it is
            // never handed to another process on a maybe.
            info.memoryLease.releaseAfterForcedTermination();
          }
          commit();
        },
      });
      if (detachResult.status !== "released") {
        completeVforkGenerationTeardown(
          info,
          false,
          vforkReason,
          detachResult.error,
        );
        reportRetainedProcessGeneration(
          pid,
          "process channel teardown",
          detachResult,
          exitStatus,
        );
        return;
      }

      externrefProcessOwner.releaseGeneration(info.externrefGeneration);
      completeVforkGenerationTeardown(
        info,
        exactMemoryTeardown,
        vforkReason,
        new Error(
          `vfork child ${pid} exited without exact ownership fences`,
        ),
      );

      // A superseded old image must not reap the persistent PID that now
      // belongs to its exec successor.
      if (!detachResult.mayReapPid) return;
      try {
        host.kernel().reapHostOwnedExitedProcess(pid);
      } catch (error) {
        reportHostDiagnostic({
          pid,
          status: exitStatus,
          source: "host-owned process reap",
          message:
            `${host.diagnosticPrefix} failed to reap completed host-owned ` +
            `pid ${pid}: ${formatError(error)}`,
        });
      }
    })();
    processTeardowns.set(expectedWorker, teardown);

    // The process is already a kernel-side zombie here. Report the exit before
    // worker teardown so a slow termination cannot make a host's spawn() look
    // like the guest process never exited. The teardown promise stays tracked
    // so destroy() still waits for cleanup.
    host.reportProcessExit(pid, info, exitStatus);

    try {
      await teardown;
    } finally {
      processTeardowns.delete(expectedWorker);
    }
  }

  /**
   * Contain a shared vfork address space whose child teardown was ambiguous.
   *
   * A vfork child borrows the parent's backing, so if the host cannot prove
   * which of the two still owns it, neither may keep running: both are exited
   * with SIGSEGV and the backing is force-retired. Failing to contain either
   * one leaves the kernel with two live images over one address space, which
   * is not a recoverable state — poison the kernel instance rather than
   * continue.
   */
  async function containVforkAddressSpace(
    disposition: Extract<
      VforkLifetimeDisposition<Info>,
      { kind: "contain-address-space" }
    >,
    childGeneration: Info,
    parentPid: number,
  ): Promise<number[]> {
    const status = signalExitStatus(SIGSEGV);
    reportHostDiagnostic({
      pid: parentPid,
      status,
      source: "vfork address-space containment",
      message:
        `[vfork] containing shared address space after ambiguous child `
        + `teardown for pid=${disposition.childPid}: ${
          formatError(disposition.cause)
        }`,
    });

    // SIGSEGV is passed explicitly rather than left to the host default: this
    // path knows both images are being killed, so the synthesized reap is
    // required on every host regardless of how that host's ordinary exits
    // reach it.
    if (processes.get(disposition.childPid) === childGeneration) {
      await finishProcessExit(
        disposition.childPid,
        status,
        SIGSEGV,
        childGeneration.worker,
        "trap",
      );
    }
    if (processes.get(parentPid) === disposition.parentGeneration) {
      await finishProcessExit(
        parentPid,
        status,
        SIGSEGV,
        disposition.parentGeneration.worker,
        "trap",
      );
    }

    if (
      processes.get(disposition.childPid) === childGeneration
      || processes.get(parentPid) === disposition.parentGeneration
    ) {
      const error = new Error(
        `could not contain ambiguous vfork address space for parent=${parentPid} `
        + `child=${disposition.childPid}`,
        { cause: disposition.cause },
      );
      terminatePoisonedKernelWorker(error);
      throw error;
    }

    // WHY: rejecting onFork here would ask the kernel to roll back childPid,
    // which may already name a successful exec replacement. Resolving is safe
    // only because the exact parked parent generation is now absent, so the
    // kernel completion guard cannot publish into its retired channel.
    return [];
  }

  /** Settle a completed vfork lifetime into what `onFork` should return. */
  async function finishVforkDisposition(
    disposition: VforkLifetimeDisposition<Info>,
    childGeneration: Info,
    parentPid: number,
  ): Promise<number[]> {
    if (disposition.kind === "return-error") {
      throw new VforkAddressSpaceBusyError(
        `vfork launch returned errno ${disposition.errno}`,
      );
    }
    if (disposition.kind === "contain-address-space") {
      return containVforkAddressSpace(disposition, childGeneration, parentPid);
    }
    // A sibling pthread can exec or exit the parent image while its calling
    // thread is parked. In that case the original channel no longer exists and
    // the kernel completion guard must observe no current parent generation.
    traceVforkMechanism(
      "parent_released",
      `parent=${parentPid} child=${disposition.childPid}`,
    );
    return [childGeneration.channelOffset];
  }

  /**
   * Wait for `pid`'s teardown, starting one if the exit has not been seen.
   */
  async function awaitFinalizedProcessTeardown(
    pid: number,
    exitStatus: number,
    expectedWorker: W,
    crashSignum?: number,
    reason: VforkExactCompletionReason =
      signalFromExitStatus(exitStatus) === null ? "exit" : "signal",
  ): Promise<void> {
    if (!processTeardowns.has(expectedWorker)) {
      void finishProcessExit(pid, exitStatus, crashSignum, expectedWorker, reason);
    }
    await processTeardowns.get(expectedWorker);
  }

  function respondTransferredBytes(requestId: number, result: Uint8Array): void {
    host.post(
      { type: "response", requestId, result },
      [result.buffer as ArrayBuffer],
    );
  }

  function reportWorkerProtocolError(message: string): void {
    reportHostDiagnostic({
      pid: 0,
      source: "worker protocol",
      message: `${host.diagnosticPrefix} ${message}`,
    });
  }

  /**
   * Read a file's bytes for exec THROUGH the in-kernel rootfs overlay.
   *
   * The overlay is the unconditional sole `/` authority, so it is the sole
   * source of exec bytes for `/`-tree paths (the host `/` mount no longer
   * exists). ENOENT/ENOTDIR/EISDIR mean "not a readable regular file here" ->
   * null, so callers fall through to the remaining resolution stages. Any
   * other errno is a truthful failure.
   *
   * `rootfsReadFile` is an immediate, result-bearing kernel entry. The
   * guest-initiated spawn resolver (`onResolveSpawn` ->
   * `resolveExecutableForLaunch` -> here) runs from inside the SYS_SPAWN
   * protocol transaction-start (kernel-worker.ts `#handleSpawn` ->
   * `deferProtocolTransactionStart`), whose synchronous prefix reaches this
   * read while `#runningProtocolTransactionStart` is still set. The entry gate
   * then rejects the read with `KernelReentrantEntryError` BEFORE touching any
   * kernel state (kernel-entry-gate.ts `runImmediateVoidIngress`), so retrying
   * it on a later host turn is safe and idempotent — the sanctioned handling
   * for spawn/exec/fork/clone continuations (see kernel-entry-retry.ts). Once
   * the transaction-start operation returns and the gate is idle, the read
   * completes. Host-initiated exec reaches this with an idle gate, so it
   * resolves on the first attempt.
   */
  async function readExecFromOverlay(path: string): Promise<ArrayBuffer | null> {
    const start = Date.now();
    for (;;) {
      try {
        return bufferToArrayBuffer(
          await retryKernelEntryResult(() => host.kernel().rootfsReadFile(path)),
        );
      } catch (error) {
        const errno = (error as { errno?: number }).errno;
        if (
          errno === EXEC_OVERLAY_ENOENT_ERRNO ||
          errno === EXEC_OVERLAY_ENOTDIR_ERRNO ||
          errno === EXEC_OVERLAY_EISDIR_ERRNO
        ) {
          return null;
        }
        if (errno !== EXEC_OVERLAY_EAGAIN_ERRNO) throw error;
        const waited = Date.now() - start;
        if (waited >= EXEC_OVERLAY_RETRY_MAX_WAIT_MS) {
          throw new ExecOverlayReadTimeoutError(path, waited);
        }
        await execOverlayRetryDelay(EXEC_OVERLAY_RETRY_DELAY_MS);
      }
    }
  }

  /**
   * Read exec bytes from the filesystem: the overlay first, then any sibling
   * foreign mount that still serves the path.
   *
   * The overlay correctly disowns foreign-mount paths (see
   * `rootfs::owns_path`'s foreign-mount registry), so a null overlay read must
   * fall through to the guest mount table rather than fail — otherwise a
   * program that only lives under a foreign mount would ENOENT.
   *
   * The directory check is not optional: `readPreparedPlatformFile` will hand
   * back bytes for a directory on some mounts, and a directory is never an
   * executable image. The browser entry lacked this check and the Node entry
   * had it; POSIX agrees with Node, so the check is now universal.
   */
  async function readExecFromVfs(path: string): Promise<ArrayBuffer | null> {
    const fromOverlay = await readExecFromOverlay(path);
    if (fromOverlay) return fromOverlay;
    const io = host.execMountIO();
    if (io) {
      try {
        // The base-image / foreign mount resolves symlinks and materializes
        // lazy programs.
        const { data, stat } = await readPreparedPlatformFile(io, path);
        if ((stat.mode & FILE_MODES.S_IFMT) === FILE_MODES.S_IFDIR) return null;
        return bufferToArrayBuffer(data);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        // Missing from the mount table; nothing else to fall through to.
      }
    }
    return null;
  }

  /** Every exec-byte source this host has, in resolution order. */
  function readExecFile(path: string): Promise<ArrayBuffer | null> {
    return host.resolveExecFile
      ? host.resolveExecFile(path)
      : readExecFromVfs(path);
  }

  /**
   * Resolve `path` to a launchable wasm image, following `#!` chains.
   *
   * Returns null when nothing is there, `{ errno }` when the bytes exist but
   * cannot be executed, and the compiled program otherwise.
   */
  async function resolveExecutableForLaunch(
    path: string,
    argv: string[],
    depth = 0,
  ): Promise<ResolvedSpawnProgram | { errno: number } | null> {
    if (depth > MAX_SHEBANG_DEPTH) return null;
    const bytes = await readExecFile(path);
    if (!bytes) return null;

    const shebang = parseShebang(bytes);
    if (!shebang) {
      if (!isWasmModuleBytes(bytes)) return { errno: ENOEXEC };
      const artifactFailures = describeWasmArtifactPolicyFailures(bytes, {
        expectedAbi: host.kernel().getKernelAbiVersion(),
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
        declaredAbi !== host.kernel().getKernelAbiVersion()
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

  /** The kernel's guest-initiated spawn resolver. */
  function handlePosixSpawnResolve(
    path: string,
    argv: string[],
  ): Promise<SpawnProgramResolution | null> {
    return resolveExecutableForLaunch(path, argv);
  }

  /**
   * Read a rootfs file for the main thread.
   *
   * The kernel overlay owns `/` unconditionally, so it is the authority for
   * these bytes (including guest copy-on-writes); the host `/` mount no longer
   * exists. ENOENT/ENOTDIR/EISDIR mean "missing or not a readable regular
   * file" -> null, matching the host-served path's contract.
   *
   * `includeMode` was a browser-only protocol option and transferring the
   * bytes was a Node-only optimisation; both are universal now. The bytes come
   * from a fresh host-owned buffer the kernel concatenated, never a view into
   * kernel memory, so the transfer is safe.
   */
  function handleReadVfsFile(msg: {
    requestId: number;
    path: string;
    includeMode?: boolean;
  }): void {
    try {
      const data = host.kernel().rootfsReadFile(msg.path);
      if (msg.includeMode) {
        const mode = host.kernel().rootfsStatMode(msg.path);
        respond(msg.requestId, { data, mode: mode & FILE_MODES.S_MODE_BITS });
      } else {
        respondTransferredBytes(msg.requestId, data);
      }
    } catch (error) {
      const errno = (error as { errno?: number }).errno;
      if (errno === 2 || errno === 20 || errno === 21) {
        respond(msg.requestId, null);
      } else {
        respondError(msg.requestId, formatError(error));
      }
    }
  }

  /**
   * Write a rootfs file on behalf of the main thread.
   *
   * Writes go into the overlay so the file is visible to live guests. A kernel
   * booted without a `/` image has no overlay to write into — reject clearly
   * rather than surfacing a lower-level "rootfs write failed".
   */
  function handleWriteVfsFile(msg: {
    requestId: number;
    path: string;
    data: Uint8Array;
    mode: number;
  }): void {
    if (!host.rootfsBaseImage()) {
      respondError(msg.requestId, "VFS is not initialized");
      return;
    }
    let releaseMutation: (() => void) | undefined;
    try {
      releaseMutation = rootfsSnapshotGate.beginMutation("write a rootfs file");
      host.kernel().rootfsWriteFile(
        msg.path,
        msg.data,
        msg.mode & FILE_MODES.S_MODE_BITS,
      );
      respond(msg.requestId, true);
    } catch (error) {
      respondError(msg.requestId, formatError(error));
    } finally {
      releaseMutation?.();
    }
  }

  /**
   * Serialise the live filesystem back into a rootfs image.
   *
   * The export must see a quiescent realm: a live process, a process teardown
   * or a worker teardown still in flight can all mutate the tree underneath
   * the snapshot. Only the browser entry counted worker teardowns; both hosts
   * track them now, so the predicate is the same on both.
   */
  async function handleExportRootfsImage(msg: {
    requestId: number;
  }): Promise<void> {
    const baseImage = host.rootfsBaseImage();
    if (!baseImage) {
      respondError(msg.requestId, "rootfs export requires a VFS-backed kernel");
      return;
    }
    if (!host.isInitReady()) {
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
        // The kernel overlay owns `/`; the base image is only the frozen tree
        // the kernel booted from. Rebuild a faithful image by reconciling that
        // base with the overlay's authoritative tree (copy-on-writes, runtime
        // creates and deletes, metadata) rather than serializing the stale
        // base directly.
        const { image: overlayImage } = await exportRootfsImageFromOverlay({
          baseImage: await baseImage.saveImage(),
          overlayTree: host.kernel().rootfsExportTree(),
          readCowBytes: (path) => host.kernel().rootfsReadFile(path),
        });
        return overlayImage;
      });
      respondTransferredBytes(msg.requestId, image);
    } catch (error) {
      respondError(msg.requestId, formatError(error));
    }
  }

  // The three pipe/socket entries below combine what the two hosts each had
  // half of. Node refused pre-init requests with a defined
  // `uninitializedKernelPipeResult`, which is the POSIX-shaped answer — the
  // caller learns the pipe is not there, not that the worker protocol broke —
  // but had no guard against a kernel throw. The browser had the throw guard
  // and no pre-init guard, so the same pre-init request produced a protocol
  // error on one host and a result on the other. Both guards are correct and
  // both now apply everywhere.

  function handlePipeRead(msg: {
    requestId: number;
    pid: number;
    pipeIdx: number;
  }): void {
    if (!host.isInitReady()) {
      respond(msg.requestId, uninitializedKernelPipeResult("read"));
      return;
    }
    try {
      respond(
        msg.requestId,
        host.kernel().readPipeAvailable(msg.pid, msg.pipeIdx),
      );
    } catch (error) {
      respondError(msg.requestId, formatError(error));
    }
  }

  function handlePipeWrite(msg: {
    requestId: number;
    pid: number;
    pipeIdx: number;
    data: Uint8Array;
  }): void {
    if (!host.isInitReady()) {
      respond(msg.requestId, uninitializedKernelPipeResult("write"));
      return;
    }
    try {
      const written = host.kernel().writePipeData(msg.pid, msg.pipeIdx, msg.data);
      // Wake readers and pollers only after the gated write has completed.
      host.kernel().notifyPipeReadable(msg.pipeIdx);
      respond(msg.requestId, written);
    } catch (error) {
      respondError(msg.requestId, formatError(error));
    }
  }

  function handleInjectConnection(msg: {
    requestId: number;
    pid: number;
    fd: number;
    peerAddr: readonly [number, number, number, number];
    peerPort: number;
  }): void {
    if (!host.isInitReady()) {
      respond(msg.requestId, uninitializedKernelPipeResult("inject"));
      return;
    }
    try {
      respond(
        msg.requestId,
        host.kernel().injectConnection(
          msg.pid,
          msg.fd,
          msg.peerAddr,
          msg.peerPort,
        ),
      );
    } catch (error) {
      respondError(msg.requestId, formatError(error));
    }
  }

  /**
   * Create the first process of a launch: a fresh PID, a fresh address space
   * and a fresh worker, with a rollback that leaves no half-built generation.
   *
   * Both entries carried this whole transaction. The differences were four
   * host decorations — a generation number, a TLS-CA environment injection, a
   * PTY-output registration and a side-module init block — plus three
   * behaviours only one host had, each of which is now the one both get:
   *
   * - **Exactly one program source.** Node refused a request naming both
   *   `programBytes` and `programPath`; the browser silently preferred the
   *   bytes and dropped the path, so a caller that got the pair wrong was told
   *   its spawn succeeded. The refusal is the correct half.
   * - **`maxPages` is honoured.** The Node entry ignored the per-request page
   *   ceiling and always used the kernel default, which is a POSIX-visible
   *   difference in what a spawn request may ask for.
   * - **`cwd` reaches the worker.** The browser passed it in the init message
   *   and Node did not, so a Node guest reading its own working directory
   *   before its first `chdir` saw the kernel default rather than the
   *   directory the launch named.
   */
  async function handleSpawn(msg: ProcessSpawnRequest): Promise<void> {
    let releaseMutation: (() => void) | undefined;
    let createdPid: number | undefined;
    let createdMemoryLease: ProcessMemoryLease | undefined;
    let createdMemoryRegistered = false;
    let workerCreationAttempted = false;
    let createdWorker: W | undefined;
    let createdGeneration: Info | undefined;
    let createdExternrefGeneration: ForkExternrefGeneration | undefined;
    let createdForkHostImports: ForkHostImportOwnerWorker | undefined;
    const kernelWorker = host.kernel();
    try {
      releaseMutation = rootfsSnapshotGate.beginMutation("spawn a process");
      await host.awaitProcessConstructionBarrier();

      const hasProgramBytes = msg.programBytes !== undefined;
      const hasProgramPath = msg.programPath !== undefined;
      if (hasProgramBytes === hasProgramPath) {
        respondError(
          msg.requestId,
          "spawn requires exactly one of programBytes or programPath",
        );
        return;
      }
      const programBytes = msg.programBytes
        ?? await readExecFromVfs(msg.programPath!);
      // A pre-compiled module belongs to the bytes it was compiled from, so a
      // path-sourced spawn must not adopt one.
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
      const {
        memory,
        memoryLease,
        layout,
      } = await createFreshProcessMemory(
        pid,
        programBytes,
        ptrWidth,
        msg.maxPages ?? host.defaultMaxPages(),
        {
          operation: "spawn",
          path: msg.programPath ?? msg.argv[0],
          argv: msg.argv,
        },
      );
      createdMemoryLease = memoryLease;
      const channelOffset = layout.channelOffset;
      const launchEnv = host.decorateLaunchEnv(
        msg.env ?? host.defaultLaunchEnv(),
      );

      kernelWorker.registerProcess(pid, memory, [channelOffset], {
        ptrWidth,
        argv: msg.argv,
        env: launchEnv,
        brkBase: layout.brkBase,
        mmapBase: layout.mmapBase,
        maxAddr: layout.maxAddr,
        threadSlotQuota: layout.threadSlotCount,
      });
      createdMemoryRegistered = true;

      kernelWorker.setCredentials(pid, { uid: msg.uid, gid: msg.gid });
      const secureExec = kernelWorker.processSecureExec(pid);
      if (msg.cwd) kernelWorker.setCwd(pid, msg.cwd);
      if (msg.maxAddr != null) kernelWorker.setMaxAddr(pid, msg.maxAddr);

      if (msg.pty) {
        const ptyIdx = kernelWorker.setupPty(pid);
        ptyByPid.set(pid, ptyIdx);
        // Apply the initial winsize before the wasm program starts. Without
        // this the program's first TIOCGWINSZ returns the kernel default
        // (80x24) and TUI renderers cache the wrong width before the
        // post-spawn pty_resize lands, corrupting the first redraw.
        if (msg.ptyCols != null && msg.ptyRows != null) {
          kernelWorker.ptySetWinsize(ptyIdx, msg.ptyRows, msg.ptyCols);
        }
        host.onProcessPtyReady?.(pid, ptyIdx);
      } else if (msg.stdin) {
        kernelWorker.setStdinData(
          pid,
          msg.stdin instanceof Uint8Array ? msg.stdin : new Uint8Array(msg.stdin),
        );
      }

      const externrefGeneration = externrefProcessOwner.startGeneration(pid);
      createdExternrefGeneration = externrefGeneration;
      let worker: W;
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
        secureExec,
        externrefGenerationId: externrefGeneration.id,
        forkHostImports: forkHostImports.init,
        env: launchEnv,
        argv: msg.argv,
        cwd: msg.cwd,
        ptrWidth,
        kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
        kernelAbiContractDigest:
          kernelWorker.getKernelAbiContractDigest() ?? undefined,
        ...host.sideModuleInitFields(ptrWidth),
      };

      // A constructor may expose Memory to a partially created worker before
      // it throws, so any failure from this point uses forced retirement.
      workerCreationAttempted = true;
      worker = host.createProcessWorker(initData);
      createdWorker = worker;
      bindForkHostImports(worker, forkHostImports);
      createdGeneration = {
        generation: allocateProcessGeneration(),
        memory,
        memoryLease,
        workerQuiescence: createWorkerQuiescence(),
        execRetirement: createWorkerQuiescence(),
        memoryRetirementSafe: true,
        aliasExposed: false,
        programBytes,
        programModule,
        worker,
        argv: msg.argv,
        channelOffset,
        ptrWidth,
        secureExec,
        layout,
        externrefGeneration,
      };
      processes.set(pid, createdGeneration);

      host.installProcessWorkerListeners(worker, pid);
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
          const rollbackPid = createdPid;
          const detachResult = await detachExactProcessGeneration({
            pid: rollbackPid,
            generation,
            operation: createdMemoryRegistered ? "unregister" : "none",
            retire: async (commit) => {
              const aliasesReleased = createdGeneration
                ? await host.releaseGenerationAliases(
                    rollbackPid,
                    createdGeneration,
                  )
                : true;
              // Where termination is not itself an ownership fence, an
              // attempted worker construction may already hold the Memory.
              if (workerCreationAttempted || !aliasesReleased) {
                lease.releaseAfterForcedTermination();
              } else {
                lease.release();
              }
              commit();
            },
          });
          if (detachResult.status !== "released") {
            reportRetainedProcessGeneration(
              rollbackPid,
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

  /**
   * Launch a worker for a `SYS_SPAWN` child whose program is the exact target
   * the kernel already committed.
   *
   * The earlier resolver was only side-effect-free candidate preflight; a
   * changed child CWD, fd table or credential view selects and recompiles the
   * final bytes before this callback. This phase allocates Memory, registers,
   * and launches — nothing else.
   *
   * One drift closed, toward the browser: when the kernel reports the child
   * already **dead**, the finalized signal is now passed to the teardown on
   * both hosts. Node passed none, so `finishProcessExit` synthesized no reap
   * at all on that path and a concurrent `waitpid` in the parent had nothing
   * to observe until destroy. The kernel's `hostReaped` guard makes the call
   * idempotent where it had already marked the child a zombie, so the correct
   * half costs nothing where it was not needed.
   */
  async function handlePosixSpawn(
    parentPid: number,
    childPid: number,
    program: ResolvedSpawnProgram,
    envp: string[],
  ): Promise<number> {
    const kernelWorker = host.kernel();
    const secureExec = kernelWorker.takeCommittedExecSecureExec(childPid);
    // The shared launcher invokes this callback only after Rust committed the
    // exact pending child. Do not re-enter the kernel while that postcommit
    // transaction is still draining; the first legal liveness fence follows
    // the asynchronous memory allocation below, and owns any exit observed
    // across the construction barrier as well.
    host.post({
      type: "proc_event",
      kind: "spawn",
      pid: childPid,
      ppid: parentPid,
    });
    await host.awaitProcessConstructionBarrier();

    const { programBytes, programModule, argv } = program;
    const ptrWidth = detectPtrWidth(programBytes);
    let fresh: Awaited<ReturnType<typeof createFreshProcessMemory>>;
    try {
      fresh = await createFreshProcessMemory(
        childPid,
        programBytes,
        ptrWidth,
        host.defaultMaxPages(),
        { operation: "posix_spawn", path: argv[0], argv },
      );
    } catch (error) {
      if (error instanceof ProcessMemoryRetirementBacklogError) {
        return -11; // EAGAIN
      }
      if (error instanceof ProcessMemoryCapacityError) return -12; // ENOMEM
      throw error;
    }
    const { memory, memoryLease, layout } = fresh;
    // Allocation admission yielded. Never attach a worker to a child that
    // became a zombie while the short retirement admission gate drained.
    if (!await retryKernelEntryResult(
      () => kernelWorker.shouldLaunchPendingChild(childPid),
    )) {
      memoryLease.release();
      return 0;
    }
    const channelOffset = layout.channelOffset;
    let newWorker: (W & { start(): boolean }) | undefined;
    let registered = false;
    let workerStartAttempted = false;
    let lifecycleTeardownStarted = false;
    let childGeneration: Info | undefined;
    let externrefGeneration: ForkExternrefGeneration | undefined;
    let forkHostImports: ForkHostImportOwnerWorker | undefined;
    try {
      // The kernel already created the child Process via kernel_spawn_process.
      // Treat every subsequent host attachment as one rollback-capable
      // transaction.
      kernelWorker.registerProcess(childPid, memory, [channelOffset], {
        ptrWidth,
        brkBase: layout.brkBase,
        mmapBase: layout.mmapBase,
        maxAddr: layout.maxAddr,
        threadSlotQuota: layout.threadSlotCount,
      });
      registered = true;

      externrefGeneration = externrefProcessOwner.startGeneration(childPid);
      const processExternrefGeneration = externrefGeneration;
      const processForkHostImports = forkHostImportOwnerRuntime
        .createWorker({
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
        secureExec,
        externrefGenerationId: processExternrefGeneration.id,
        forkHostImports: processForkHostImports.init,
        argv,
        env: envp,
        ptrWidth,
        kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
        kernelAbiContractDigest:
          kernelWorker.getKernelAbiContractDigest() ?? undefined,
        ...host.sideModuleInitFields(ptrWidth),
      };

      newWorker = host.createDeferredProcessWorker(initData, "spawn");
      const worker = newWorker;
      bindForkHostImports(worker, processForkHostImports);
      childGeneration = {
        generation: allocateProcessGeneration(),
        memory,
        memoryLease,
        workerQuiescence: createWorkerQuiescence(),
        execRetirement: createWorkerQuiescence(),
        memoryRetirementSafe: true,
        aliasExposed: false,
        argv,
        programBytes,
        programModule,
        worker,
        channelOffset,
        ptrWidth,
        secureExec,
        layout,
        externrefGeneration: processExternrefGeneration,
      };
      processes.set(childPid, childGeneration);

      host.installProcessWorkerListeners(
        worker,
        childPid,
        "spawn worker error",
      );
      const startDisposition = await retryKernelEntryResult(() =>
        kernelWorker.startProcessWorkerWhenRunnable(
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
        ),
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
        const signal = await retryKernelEntryResult(
          () => kernelWorker.finalizePendingChildTermination(childPid),
        );
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
      forkHostImports?.close();
      if (externrefGeneration) {
        externrefProcessOwner.releaseGeneration(externrefGeneration);
      }
      const generation = childGeneration ?? { memory, memoryLease };
      const detachResult = await detachExactProcessGeneration({
        pid: childPid,
        generation,
        operation: registered ? "deactivate" : "none",
        retire: async (commit) => {
          const aliasReleased = childGeneration
            ? await host.releaseGenerationAliases(childPid, childGeneration)
            : true;
          if (workerStartAttempted || !aliasReleased) {
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

  /**
   * Construct a COPIED or SHARED fork child: clone the parent's address
   * space, register the child, launch a worker into the copied activation,
   * and commit the replay gate that wakes it.
   *
   * The two entries' copies of this were already ~75% identical; the residue
   * was formatting, a local alias for `parentInfo.programBytes`, and the same
   * two corrections `handlePosixSpawn` needed — the construction barrier and
   * the exact finalized signal on the dead-child teardown.
   */
  async function handleOrdinaryFork(
    parentPid: number,
    childPid: number,
    mode: ProcessForkMode,
    parentMemory: WebAssembly.Memory,
    continuation: ForkContinuationContext,
  ): Promise<number[]> {
    const kernelWorker = host.kernel();
    const parentInfo = processes.get(parentPid);
    if (!parentInfo || parentInfo.memory !== parentMemory) {
      throw new Error(`Unknown parent generation for pid ${parentPid}`);
    }

    const ptrWidth = parentInfo.ptrWidth;
    const childLayout = parentInfo.layout;
    // WHY: teardown and compilation below yield. A sibling exec may then
    // retire the parent's exact generation, so the committed fork must pass
    // retired-memory admission and own its clone before the first await.
    const memoryStatsBeforeClone = sampleProcessMemoryStats(
      host.isVforkMechanismTraceEnabled(),
      host.processMemoryAllocator(),
    );
    const childMemoryLease = acquireForkMemoryClone(
      host.processMemoryAllocator(),
      parentMemory,
      ptrWidth,
      childLayout.maximumPages,
    );
    const childMemory = childMemoryLease.memory;
    const memoryStatsAfterClone = sampleProcessMemoryStats(
      host.isVforkMechanismTraceEnabled(),
      host.processMemoryAllocator(),
    );
    if (memoryStatsBeforeClone && memoryStatsAfterClone) {
      traceVforkMechanism(
        "fork_prepared",
        `mode=${mode} parent=${parentPid} child=${childPid} memory_identity=${
          childMemory === parentMemory ? "same" : "distinct"
        } live_memory_delta=${
          memoryStatsAfterClone.liveMemories
          - memoryStatsBeforeClone.liveMemories
        }`,
      );
    }
    const childChannelOffset = childLayout.channelOffset;
    let childWorker: (W & { start(): boolean }) | undefined;
    let registered = false;
    let workerStartAttempted = false;
    let lifecycleTeardownStarted = false;
    let childGeneration: Info | undefined;
    let childExternrefGeneration: ForkExternrefGeneration | undefined;
    let childForkHostImports: ForkHostImportOwnerWorker | undefined;
    const forkReplay = new ForkReplayGateCoordinator(
      `fork child pid=${childPid}`,
    );
    try {
      await host.awaitProcessConstructionBarrier();
      // Pre-compile the module so the child's code is optimized on entry.
      if (!parentInfo.programModule) {
        parentInfo.programModule = await WebAssembly.compile(
          parentInfo.programBytes,
        );
      }
      if (!await retryKernelEntryResult(
        () => kernelWorker.shouldLaunchPendingChild(childPid),
      )) {
        childMemoryLease.release();
        return [];
      }

      new Uint8Array(
        childMemory.buffer,
        childChannelOffset,
        CH_TOTAL_SIZE,
      ).fill(0);
      // Everything after acquire is one transaction. A copy, registration,
      // allocator, deferred-worker or listener failure must not strand the
      // backing outside explicit lease ownership.
      //
      // Retry on reentrant contention: under a php-fpm-style fork burst with
      // the in-kernel tmpfs serving scratch, sibling syscall-channel ingress
      // fills the deferred FIFO and the drain is starved by continuously
      // pending fork transaction-starts, so a single synchronous registration
      // loses the microtask race and the launch is rolled back. Yielding to a
      // later host turn — as the sibling `shouldLaunchPendingChild` call above
      // already does — lets the bounded burst drain so the registration lands.
      await retryKernelEntryResult(() =>
        kernelWorker.registerProcess(
          childPid,
          childMemory,
          [childChannelOffset],
          {
            ptrWidth,
            maxAddr: childLayout.maxAddr,
            mmapBase: childLayout.mmapBase,
            threadSlotQuota: childLayout.threadSlotCount,
          },
        ),
      );
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
      const externrefGrant = externrefProcessOwner
        .forkGenerationFromContinuation(
          parentInfo.externrefGeneration,
          childPid,
          parentMemory,
          ptrWidth,
          forkBufAddr,
        );
      childExternrefGeneration = externrefGrant.generation;
      let launchedWorker: W & { start(): boolean };
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
        programBytes: parentInfo.programBytes,
        programModule: parentInfo.programModule,
        memory: childMemory,
        channelOffset: childChannelOffset,
        secureExec: kernelWorker.processSecureExec(childPid),
        externrefGenerationId: externrefGrant.generation.id,
        forkHostImports: forkHostImports.init,
        isForkChild: true,
        forkMode: mode,
        forkBufAddr,
        // A COPIED fork child inherits the parent's co-resident fork-module
        // region via its memory clone; hand it the parent's exact base so it
        // reuses that region instead of double-mapping a fresh one (which
        // would inflate the child's observable `memory.size`). Absent only if
        // the parent worker has not yet reported its region (it reports at
        // init, before it can fork), in which case the child reserves its own.
        forkModuleInheritedBase: parentInfo.forkModuleRegion?.base,
        forkModuleInheritedBytes: parentInfo.forkModuleRegion?.bytes,
        forkReplayGate: forkReplay.gate,
        forkChildThreadFnPtr: forkReplayContext?.fnPtr,
        forkChildThreadArgPtr: forkReplayContext?.argPtr,
        ptrWidth,
        kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
        kernelAbiContractDigest:
          kernelWorker.getKernelAbiContractDigest() ?? undefined,
        ...host.sideModuleInitFields(ptrWidth),
      };

      childWorker = host.createDeferredProcessWorker(childInitData, "fork");
      const worker = childWorker;
      launchedWorker = worker;
      bindForkHostImports(worker, forkHostImports);
      childGeneration = {
        generation: allocateProcessGeneration(),
        memory: childMemory,
        memoryLease: childMemoryLease,
        workerQuiescence: createWorkerQuiescence(),
        execRetirement: createWorkerQuiescence(),
        memoryRetirementSafe: true,
        aliasExposed: false,
        argv: parentInfo.argv,
        programBytes: parentInfo.programBytes,
        programModule: parentInfo.programModule,
        worker,
        channelOffset: childChannelOffset,
        ptrWidth,
        secureExec: childInitData.secureExec,
        layout: childLayout,
        forkReplayContext,
        externrefGeneration: externrefGrant.generation,
        // The child reuses the parent's fork-module region; seed its
        // generation so a grandchild fork propagates the same base even
        // before the child worker re-reports it at init.
        forkModuleRegion: parentInfo.forkModuleRegion,
      };
      processes.set(childPid, childGeneration);

      observeForkReplayWorker(
        forkReplay,
        launchedWorker,
        childPid,
        () => processes.get(childPid)?.worker === launchedWorker,
      );
      host.installProcessWorkerListeners(worker, childPid);
      const startDisposition = await retryKernelEntryResult(() =>
        kernelWorker.startProcessWorkerWhenRunnable(
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
        ),
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
        const signal = await retryKernelEntryResult(
          () => kernelWorker.finalizePendingChildTermination(childPid),
        );
        lifecycleTeardownStarted = true;
        await awaitFinalizedProcessTeardown(
          childPid,
          signal > 0 ? signalExitStatus(signal) : 0,
          worker,
          signal > 0 ? signal : undefined,
        );
        return [];
      }
      await forkReplay.waitUntilReady();
      if (processes.get(childPid)?.worker !== launchedWorker) {
        throw new Error(
          `Fork child ${childPid} changed generation before replay commit`,
        );
      }
      if (!await retryKernelEntryResult(
        () => kernelWorker.shouldLaunchPendingChild(childPid),
      )) {
        throw new Error(`Fork child ${childPid} exited before replay commit`);
      }
      // WHY: only this commit wakes the child inside the inherited fork
      // import. Keep the child blocked there until the fresh worker generation
      // has proved reconstruction completed, so the parent cannot observe a
      // child whose continuation has not reached the copied activation.
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
        retire: async (commit) => {
          const aliasReleased = childGeneration
            ? await host.releaseGenerationAliases(childPid, childGeneration)
            : true;
          if (workerStartAttempted || !aliasReleased) {
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

  /**
   * Per-PID cache of the thread-patched module.
   *
   * Kept separate from `ProcessLifecycleInfo.programModule`, which is the
   * unpatched module a fork child inherits: conflating them would hand a
   * fork child a module patched for a thread entry point.
   */
  const threadModuleCache = new Map<number, WebAssembly.Module>();

  /**
   * PIDs that have ever cloned a thread.
   *
   * A host whose `terminate()` is not an ownership fence charges a longer
   * settle to a threaded process's teardown, and the thread registry is
   * already empty by the time that settle is chosen — so the fact is recorded
   * when the first clone happens rather than re-derived at exit.
   *
   * The shared exit path clears a PID's entry. Entries also have to be
   * dropped wherever a generation is replaced or the machine is torn down;
   * the browser does that at its exec and destroy sites. Node keeps none,
   * and a stale entry there is provably inert because its
   * `threadWorkerSettleMs` is zero.
   */
  const threadedProcessPids = new Set<number>();

  /**
   * Complete `pid`'s exit through the one teardown funnel.
   *
   * The browser's signature was a strict superset of Node's, so the shared
   * one is the browser's: Node's two-argument calls mean exactly what they
   * meant. Every parameter after the status exists so a caller that knows
   * more than the default can say so — the exact signal that killed the
   * process, the precise worker generation, or a vfork completion reason
   * that a status code cannot express, such as a trap.
   */
  function handleExit(
    pid: number,
    exitStatus: number,
    crashSignum?: number,
    expectedWorker = processes.get(pid)?.worker,
    vforkReason: VforkExactCompletionReason =
      signalFromExitStatus(exitStatus) === null ? "exit" : "signal",
  ): void {
    void finishProcessExit(
      pid,
      exitStatus,
      crashSignum,
      expectedWorker,
      vforkReason,
    );
  }

  /**
   * Attach a pthread worker to an existing process image.
   *
   * Two host asymmetries collapse here into the already-declared
   * `terminationProvesQuiescence`, which until now documented the boundary
   * without enforcing it:
   *
   * - **Thread-slot reclaim.** A slot may be freed exactly only once the
   *   thread has stopped. Where `terminate()` joins the thread that is proved
   *   by termination itself; where it does not, the worker's
   *   `memory_quiescent` fence proves it, and without either the slot stays
   *   out of circulation and the process backing loses exact retirement.
   *   Both hosts now derive that from the flag rather than one of them
   *   hard-coding the safe answer.
   * - **The guest-fatal-trap reap**, which Node performed as a bare
   *   `notifyHostProcessCrashed` beside `finishProcessExit` and the browser
   *   performed by naming the signal to it. One funnel now, on both.
   */
  async function handleClone(
    attachment: ThreadChannelAttachment,
  ): Promise<void> {
    const {
      pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, slotAddr, memory,
    } = attachment;
    const kernelWorker = host.kernel();
    const processInfo = processes.get(pid);
    if (!processInfo) throw new Error(`Unknown pid ${pid} for clone`);
    // A process that has ever cloned needs the longer teardown settle its
    // host declares for thread workers; record that here rather than
    // re-deriving it from an already-emptied registry at exit.
    threadedProcessPids.add(pid);

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
    const belongsToCompiledProcessImage = () =>
      isCurrentProcessGeneration(
        processes,
        pid,
        processInfo,
        memory,
        kernelWorker.isExecHandoffActive(pid),
      );
    const executionState = await retryKernelEntryResultForGeneration(
      belongsToCompiledProcessImage,
      () => kernelWorker.isProcessExecutionActive(pid),
    );
    if (executionState.status === "stale" || !executionState.value) {
      throw new Error(`Process ${pid} changed generation during clone`);
    }
    if (cacheCompiledModule) threadModuleCache.set(pid, threadModule);

    // The kernel already chose where this thread's control slot goes, inside
    // the `clone` that produced this attachment, and reserved the range in the
    // process address space. What is left is the part only a host can do:
    // grow the Memory until the range is addressable, and zero it.
    let alloc: ThreadAllocation;
    try {
      alloc = materializeThreadSlot(memory, slotAddr, processInfo.ptrWidth);
    } catch (e) {
      // The thread never started, so the range the kernel set aside for it is
      // free again. Without this the reservation would sit in the address
      // space for the life of the process, for a thread that does not exist.
      releaseThreadSlot(pid, slotAddr);
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
      const attachmentState = await retryKernelEntryResultForGeneration(
        belongsToCompiledProcessImage,
        () => kernelWorker.attachThreadChannel(attachment, alloc.channelOffset),
      );
      if (attachmentState.status === "stale") {
        throw new Error(`Process ${pid} changed generation during clone attachment`);
      }
    } catch (err) {
      releaseThreadSlot(pid, slotAddr);
      throw err;
    }

    let threadWorker: W & { start(): boolean };
    let threadEntry: ThreadWorkerRecord<Info["worker"]>;
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
      secureExec: processInfo.secureExec,
      externrefGenerationId: processInfo.externrefGeneration.id,
      forkHostImports: forkHostImports.init,
      // Phase 6 D7b: ship the same co-resident fork-module decision the process
      // worker receives, so a fork issued FROM this pthread unwinds through the
      // module (the parent side of a fork-from-thread).
      ...host.sideModuleInitFields(processInfo.ptrWidth),
      fnPtr,
      argPtr,
      stackPtr,
      tlsPtr,
      ctidPtr,
      tlsOffset: alloc.tlsOffset,
      tlsAllocAddr: alloc.tlsAllocAddr,
      ptrWidth: processInfo.ptrWidth,
      kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
      kernelAbiContractDigest: kernelWorker.getKernelAbiContractDigest() ?? undefined,
    };

    threadWorker = host.createThreadWorker(threadInitData);
    bindForkHostImports(threadWorker, forkHostImports);
    if (!threadWorkers.has(pid)) threadWorkers.set(pid, []);
    threadEntry = {
      worker: threadWorker,
      channelOffset: alloc.channelOffset,
      tid,
      basePage: alloc.slotStartPage,
      workerQuiescence: createWorkerQuiescence(),
      execRetirement: createWorkerQuiescence(),
      // Only meaningful where termination is not itself an ownership fence:
      // there a slot may be reclaimed exactly only after the worker published
      // this fence. See `terminationProvesQuiescence`.
      quiescent: false,
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
      if (host.terminationProvesQuiescence || threadEntry.quiescent) {
        // Either `terminate()` joined the thread, or the worker published its
        // `memory_quiescent` fence after returning from worker-main. Waking
        // the retired host waitAsync listener can then race neither the guest
        // nor a newly reused thread slot.
        await kernelWorker.settleRetiredChannelListeners(
          pid,
          memory,
          alloc.channelOffset,
        );
        // Only the generation that owns this address space may hand the range
        // back. A pid survives exec, but its `MemoryManager` does not: a
        // release aimed at a replacement image could free a range that image
        // has already reserved at the same address. A process that has exited
        // has no address space left to return anything to.
        if (belongsToCurrentProcessImage()) {
          releaseThreadSlot(pid, slotAddr);
        }
      } else {
        // A hard termination is not a quiescence barrier. Keep the slot out of
        // circulation, and refuse exact retirement of the process backing.
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
          host.threadWorkerSettleMs,
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
      const disposition = threadWorkerFailureDisposition(classifyWasmTrap, reason);
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
        // Naming the signal is what the Node side's own
        // `notifyHostProcessCrashed` did; `handleExit` performs it inside the
        // one teardown funnel instead of beside it.
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
        // memory_quiescent follows after worker-main returns; terminating here
        // would discard the exact ownership fence.
      } else if (m.type === "memory_quiescent" && m.tid === tid) {
        threadEntry.quiescent = true;
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
      } else if (m.type === "fork_module_frames" && m.pid === pid) {
        // Phase 6 D7b: forward the pthread PARENT worker's fork-module proof-of-use
        // (the parent side of a fork-from-thread). The process-worker handler above
        // forwards the same message for the main worker; the pthread worker has its
        // own handler, so mirror it here or the parent-frame proof is dropped.
        postForkModuleProof({
          pid,
          source: "fork-module",
          message: `fork_module_frames=${m.frames}`,
        });
      }
    });
    threadWorker.on("error", (err: Error) => {
      failThread(`worker error: ${err.message ?? err}`);
    });

    let startDisposition: ReturnType<
      CentralizedKernelWorker["startProcessWorkerWhenRunnable"]
    >;
    try {
      startDisposition = await retryKernelEntryResult(() =>
        kernelWorker.startProcessWorkerWhenRunnable(
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
        ),
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

  /**
   * Ask the kernel what a trap message means.
   *
   * The message can only be captured in a host realm, but the table that
   * reads it lives in `wasm_posix_shared::trap_signal` so both hosts and
   * `crates/host-native` agree. Returns 0 before the kernel worker exists,
   * which callers treat as "unclassified".
   */
  const classifyWasmTrap = (text: string): number => {
    const kernel = host.kernel() as CentralizedKernelWorker | undefined;
    return kernel ? kernel.classifyWasmTrapSignal(text) : 0;
  };

  const classifiedSignalOrFallback = (
    reason: unknown,
    fallback: number = SIGSEGV,
  ): number => classifySignalOrFallback(classifyWasmTrap, reason, fallback);

  const classifiedTrapExitStatus = (reason: unknown): number | null =>
    classifyTrapExitStatus(classifyWasmTrap, reason);

  /**
   * Route a committed fork to the construction its mode names.
   *
   * Byte-identical in the two entries before this, and it stays a pure
   * dispatcher: the preconditions it enforces come from the kernel's launch
   * contract, not from host policy.
   */
  async function handleFork(
    parentPid: number,
    childPid: number,
    mode: ProcessForkMode,
    parentMemory: WebAssembly.Memory,
    continuation: ForkContinuationContext,
    borrowedReplay?: ForkBorrowedReplayWorkspace,
    releaseCreatorAdmission?: () => void,
  ): Promise<number[]> {
    traceVforkMechanism(
      "dispatch",
      `mode=${mode} parent=${parentPid} child=${childPid}`,
    );
    if (mode === PROCESS_FORK_MODE_VFORK) {
      if (!borrowedReplay) {
        throw new VforkAddressSpaceBusyError(
          "vfork launch is missing its admitted replay workspace",
        );
      }
      return handleVfork(
        parentPid,
        childPid,
        parentMemory,
        continuation,
        borrowedReplay,
        releaseCreatorAdmission,
      );
    }
    if (releaseCreatorAdmission) {
      throw new Error("ordinary fork cannot release vfork creator admission");
    }
    if (borrowedReplay) {
      throw new Error("ordinary fork cannot borrow replay workspace");
    }
    return handleOrdinaryFork(
      parentPid,
      childPid,
      mode,
      parentMemory,
      continuation,
    );
  }

  /**
   * Construct a vfork child: it borrows the parent's address space and the
   * parent stays suspended until the child execs or exits.
   *
   * Shared verbatim apart from three things. Two are the launch family's
   * standing corrections — the exact finalized signal on a dead-child
   * teardown, in both places this path reaches one. The third is a rewrite of
   * Node's `finalizeProcessWorker` call into the `finishProcessExit` it
   * reduces to on this path, so the borrowing-phase trap is one call on both
   * hosts rather than a Node wrapper around it.
   *
   * The browser's vfork worker-constructor fault injection survives as the
   * `purpose` argument to `createDeferredProcessWorker`: it is a test seam for
   * the rollback below, and it must stay scoped to vfork rather than firing
   * for every deferred worker.
   */
  async function handleVfork(
    parentPid: number,
    childPid: number,
    parentMemory: WebAssembly.Memory,
    continuation: ForkContinuationContext,
    borrowedReplay: ForkBorrowedReplayWorkspace,
    releaseCreatorAdmission: (() => void) | undefined,
  ): Promise<number[]> {
    const kernelWorker = host.kernel();
    const parentInfo = processes.get(parentPid);
    if (!parentInfo || parentInfo.memory !== parentMemory) {
      throw new Error(`Unknown parent generation for pid ${parentPid}`);
    }
    if (vforkLifetimes.hasActiveAddressSpace(parentMemory)) {
      throw new VforkAddressSpaceBusyError();
    }
    if (
      borrowedReplay.prefixBytes <= 0
      || borrowedReplay.prefixBytes > FORK_SAVE_BUFFER_SIZE
      || borrowedReplay.scratchBytes < 0
      || borrowedReplay.scratchBytes > WASM_PAGE_SIZE
    ) {
      throw new VforkAddressSpaceBusyError(
        "vfork replay workspace exceeds one host control slot",
      );
    }

    if (!parentInfo.programModule) {
      // Stay synchronous until the alias lease, child generation, and lifetime
      // are all installed. A sibling pthread may otherwise replace the parent
      // generation in the first yielded turn.
      parentInfo.programModule = new WebAssembly.Module(parentInfo.programBytes);
    }

    const memoryStatsBefore = sampleProcessMemoryStats(
      host.isVforkMechanismTraceEnabled(),
      host.processMemoryAllocator(),
    );
    const childMemoryLease = parentInfo.memoryLease.retainAlias();
    const memoryStatsAfterAlias = sampleProcessMemoryStats(
      host.isVforkMechanismTraceEnabled(),
      host.processMemoryAllocator(),
    );
    let childMemoryLeaseConsumed = false;
    let workspaceAllocation: ThreadAllocation;
    try {
      workspaceAllocation = placeHostControlSlot(
        parentPid,
        parentMemory,
        parentInfo.ptrWidth,
      );
    } catch (error) {
      childMemoryLease.release();
      throw new VforkAddressSpaceBusyError(
        `vfork control workspace is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const workspaceOwnership: VforkWorkspaceOwnership = {
      ownerPid: parentPid,
      slotAddr: workspaceAllocation.slotStartPage * WASM_PAGE_SIZE,
      released: false,
    };
    const childChannelOffset = workspaceAllocation.channelOffset;
    const childLayout = parentInfo.layout;
    const ptrWidth = parentInfo.ptrWidth;
    let childWorker: (W & { start(): boolean }) | undefined;
    let childGeneration: Info | undefined;
    let childExternrefGeneration: ForkExternrefGeneration | undefined;
    let childForkHostImports: ForkHostImportOwnerWorker | undefined;
    let registered = false;
    let lifetimeStarted = false;
    let lifetime: VforkLifetime<Info> | undefined;
    const forkReplay = new ForkReplayGateCoordinator(
      `vfork child pid=${childPid}`,
    );

    try {
      const workspaceAddress =
        workspaceAllocation.slotStartPage * WASM_PAGE_SIZE;
      kernelWorker.reserveHostRegionAt(
        childPid,
        workspaceAddress,
        PAGES_PER_THREAD * WASM_PAGE_SIZE,
      );
      // Fork-child registration is a void ingress: it must observe an empty
      // deferred FIFO. Under a php-fpm-style fork burst with the in-kernel tmpfs
      // serving scratch, sibling syscall-channel ingress piles into that FIFO
      // and the drain is starved by continuously-pending fork transaction-starts,
      // so a single synchronous attempt loses the microtask race and the launch
      // is rolled back. Retry on a later host turn — matching exec, vfork start,
      // and signal launch continuations — so the bounded burst drains and the
      // registration lands instead of failing the guest's fork.
      await retryKernelEntryResult(() =>
        kernelWorker.registerProcess(childPid, parentMemory, [childChannelOffset], {
          ptrWidth,
          maxAddr: childLayout.maxAddr,
          mmapBase: childLayout.mmapBase,
          threadSlotQuota: childLayout.threadSlotCount,
          borrowedAddressSpace: true,
        }),
      );
      registered = true;
      kernelWorker.inheritProcessSharedMappings(parentPid, childPid);

      const forkBufAddr = continuation.forkBufAddr;
      const forkReplayContext: ForkReplayContext | undefined =
        continuation.kind === "thread"
          ? {
              fnPtr: continuation.fnPtr,
              argPtr: continuation.argPtr,
              forkBufAddr,
            }
          : parentInfo.forkReplayContext
            ? { ...parentInfo.forkReplayContext, forkBufAddr }
            : undefined;
      const externrefGrant =
        externrefProcessOwner.forkGenerationFromContinuation(
          parentInfo.externrefGeneration,
          childPid,
          parentMemory,
          ptrWidth,
          forkBufAddr,
        );
      childExternrefGeneration = externrefGrant.generation;
      let launchedWorker: W & { start(): boolean };
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
              `stale fork host-import sender for vfork child pid=${childPid}`,
            );
          }
        },
      });
      childForkHostImports = forkHostImports;
      const childInitData: CentralizedWorkerInitMessage = {
        type: "centralized_init",
        pid: childPid,
        programBytes: parentInfo.programBytes,
        programModule: parentInfo.programModule,
        memory: parentMemory,
        channelOffset: childChannelOffset,
        secureExec: kernelWorker.processSecureExec(childPid),
        externrefGenerationId: externrefGrant.generation.id,
        forkHostImports: forkHostImports.init,
        isForkChild: true,
        forkMode: PROCESS_FORK_MODE_VFORK,
        forkMemoryOwnership: "borrowed",
        forkBufAddr,
        forkOwnerControlAddr:
          parentInfo.channelOffset - FORK_SAVE_BUFFER_SIZE,
        forkPrivatePrefixAddr:
          childChannelOffset - FORK_SAVE_BUFFER_SIZE,
        forkPrivatePrefixBytes: borrowedReplay.prefixBytes,
        forkScratchAddr: workspaceAllocation.tlsOffset,
        forkScratchBytes: borrowedReplay.scratchBytes,
        forkReplayGate: forkReplay.gate,
        forkChildThreadFnPtr: forkReplayContext?.fnPtr,
        forkChildThreadArgPtr: forkReplayContext?.argPtr,
        ptrWidth,
        kernelAbiVersion: kernelWorker.getKernelAbiVersion(),
        kernelAbiContractDigest: kernelWorker.getKernelAbiContractDigest() ?? undefined,
        // Phase 6 item 4: the borrowed (vfork) child now drives its continuation
        // replay through the co-resident fork-module, so it needs the flag + the
        // compiled module just like a COW child (`worker-main` relaxed the
        // `!borrowedForkChild` gate). Without this the child would silently fall
        // back to the JS engine and fail against the module-backed parent's
        // Option-B journal image (which has no JS replay-event manifest).
        ...host.sideModuleInitFields(ptrWidth),
      };

      childWorker = host.createDeferredProcessWorker(childInitData, "vfork");
      launchedWorker = childWorker;
      bindForkHostImports(childWorker, forkHostImports);
      childGeneration = {
        generation: allocateProcessGeneration(),
        memory: parentMemory,
        memoryLease: childMemoryLease,
        workerQuiescence: createWorkerQuiescence(),
        execRetirement: createWorkerQuiescence(),
        memoryRetirementSafe: true,
        aliasExposed: false,
        argv: parentInfo.argv,
        programBytes: parentInfo.programBytes,
        programModule: parentInfo.programModule,
        worker: childWorker,
        channelOffset: childChannelOffset,
        ptrWidth,
        secureExec: childInitData.secureExec,
        layout: childLayout,
        forkReplayContext,
        externrefGeneration: externrefGrant.generation,
        vforkWorkspace: workspaceOwnership,
      };
      if (memoryStatsBefore && memoryStatsAfterAlias) {
        traceVforkMechanism(
          "vfork_prepared",
          `mode=1 parent=${parentPid} child=${childPid} memory_identity=${
            childGeneration.memory === parentMemory ? "same" : "distinct"
          } live_memory_delta=${
            memoryStatsAfterAlias.liveMemories - memoryStatsBefore.liveMemories
          } alias_delta=${
            memoryStatsAfterAlias.liveAliases - memoryStatsBefore.liveAliases
          } parent_channel=${parentInfo.channelOffset} child_channel=${childChannelOffset} `
            + `owner_control=${childInitData.forkOwnerControlAddr} `
            + `child_prefix=${childInitData.forkPrivatePrefixAddr} `
            + `scratch=${childInitData.forkScratchAddr} `
            + `externref_parent=${parentInfo.externrefGeneration.id} `
            + `externref_child=${childGeneration.externrefGeneration.id}`,
        );
      }
      lifetime = vforkLifetimes.begin(
        parentPid,
        childPid,
        parentInfo,
        childGeneration,
      );
      lifetimeStarted = true;
      processes.set(childPid, childGeneration);
      // The exact generation is now sweepable by terminal host destroy. Keep the
      // onFork promise pending to park only the calling guest thread.
      releaseCreatorAdmission?.();

      observeForkReplayWorker(
        forkReplay,
        launchedWorker,
        childPid,
        () => processes.get(childPid)?.worker === launchedWorker,
      );
      host.installProcessWorkerListeners(childWorker, childPid);
      let startFailure: unknown;
      const startDisposition = await retryKernelEntryResult(() =>
        kernelWorker.startProcessWorkerWhenRunnable(
          childPid,
          parentMemory,
          () => {
            vforkLifetimes.markChildMayAccessMemory(childGeneration!);
            traceVforkMechanism(
              "child_may_access_memory",
              `parent=${parentPid} child=${childPid}`,
            );
            try {
              launchedWorker.start();
            } catch (error) {
              // Worker construction can partially publish a realm before throwing.
              // Once marked borrowing, only whole-address-space containment may
              // release the parent's parked syscall.
              startFailure = error;
              forkReplay.cancel(error);
              vforkLifetimes.requireAddressSpaceContainment(
                childGeneration!,
                error,
              );
              traceVforkMechanism(
                "worker_start_failed",
                `parent=${parentPid} child=${childPid}`,
              );
            }
          },
          () => {
            forkReplay.cancel(
              new Error(`Vfork child ${childPid} launch was cancelled`),
            );
            forkHostImports.close();
            void launchedWorker.terminate();
          },
        ),
      );
      if (startDisposition === "stale") {
        throw new VforkAddressSpaceBusyError(
          `Vfork child ${childPid} changed generation before Worker launch`,
        );
      }
      if (startDisposition === "dead") {
        forkReplay.cancel(
          new Error(`Vfork child ${childPid} exited before Worker launch`),
        );
        forkHostImports.close();
        await terminateTrackedWorker(childWorker);
        childGeneration.workerQuiescence.settle();
        const signal = await retryKernelEntryResult(
          () => kernelWorker.finalizePendingChildTermination(childPid),
        );
        await awaitFinalizedProcessTeardown(
          childPid,
          signal > 0 ? signalExitStatus(signal) : 0,
          childWorker,
          signal > 0 ? signal : undefined,
          signal > 0 ? "signal" : "exit",
        );
        return finishVforkDisposition(
          await lifetime.completion,
          childGeneration,
          parentPid,
        );
      }

      try {
        await forkReplay.waitUntilReady();
      } catch (error) {
        const phase = vforkLifetimes.phaseForChild(childGeneration);
        if (phase === "starting") {
          childGeneration.workerQuiescence.settle();
          const signal = await retryKernelEntryResult(
            () => kernelWorker.finalizePendingChildTermination(childPid),
          );
          await awaitFinalizedProcessTeardown(
            childPid,
            signal > 0 ? signalExitStatus(signal) : 0,
            childWorker,
            signal > 0 ? signal : undefined,
            signal > 0 ? "signal" : "exit",
          );
        } else if (phase === "borrowing" && startFailure === undefined) {
          // The Node entry reached this through `finalizeProcessWorker`,
          // which reduces to exactly this call here: its extra guards are the
          // ones `finishProcessExit` already applies, and its
          // `notifyHostProcessCrashed` is what passing `SIGSEGV` performs.
          await finishProcessExit(
            childPid,
            signalExitStatus(SIGSEGV),
            SIGSEGV,
            childWorker,
            "trap",
          );
        }
        return finishVforkDisposition(
          await lifetime.completion,
          childGeneration,
          parentPid,
        );
      }
      if (processes.get(childPid) !== childGeneration) {
        throw new Error(
          `Vfork child ${childPid} changed generation before replay commit`,
        );
      }
      if (!await retryKernelEntryResult(
        () => kernelWorker.shouldLaunchPendingChild(childPid),
      )) {
        throw new Error(`Vfork child ${childPid} exited before replay commit`);
      }
      forkReplay.commit();
      return finishVforkDisposition(
        await lifetime.completion,
        childGeneration,
        parentPid,
      );
    } catch (error) {
      if (childGeneration && lifetimeStarted) {
        const phase = vforkLifetimes.phaseForChild(childGeneration);
        if (phase === "borrowing") {
          vforkLifetimes.requireAddressSpaceContainment(childGeneration, error);
          return finishVforkDisposition(
            await lifetime!.completion,
            childGeneration,
            parentPid,
          );
        }
      }

      forkReplay.cancel(error);
      childForkHostImports?.close();
      if (childWorker) await terminateTrackedWorker(childWorker);
      if (childExternrefGeneration) {
        externrefProcessOwner.releaseGeneration(childExternrefGeneration);
      }
      if (childGeneration && registered) {
        const detachResult = await detachExactProcessGeneration({
          pid: childPid,
          generation: childGeneration,
          operation: "deactivate",
          retire: (commit) => {
            childMemoryLease.release();
            childMemoryLeaseConsumed = true;
            commit();
          },
        });
        if (detachResult.status !== "released") {
          reportRetainedProcessGeneration(
            childPid,
            "vfork launch rollback",
            detachResult,
          );
        }
      }
      if (!childMemoryLeaseConsumed) childMemoryLease.release();
      if (!workspaceOwnership.released) {
        workspaceOwnership.released = true;
        releaseThreadSlot(workspaceOwnership.ownerPid, workspaceOwnership.slotAddr);
      }
      if (childGeneration && lifetimeStarted) {
        vforkLifetimes.abortBeforeChildStart(childGeneration, 11);
      }
      throw error;
    }
  }

  /**
   * Replace a process's execution image in place.
   *
   * The last member of the launch family to be shared, and the one that had
   * the most room left to drift: it builds a whole replacement generation, so
   * every hook the siblings needed — the deferred worker factory, the
   * alias-release fence, the thread-worker settle — was already paid for.
   *
   * Returns a launch *plan* rather than performing the launch, because exec's
   * commit point belongs to the kernel: `onCommitFailure` unwinds a refused
   * commit, `startAfterCommit` runs the irreversible half.
   */
  async function handleExec(
    request: PreparedExecLaunchRequest,
  ): Promise<number | PreparedExecLaunchPlan> {
    const {
      pid,
      targetBytes: programBytes,
      targetModule: programModule,
      argv: launchArgv,
      envp,
      diagnosticPath,
    } = request;
    const kernelWorker = host.kernel();
    const initiatingInfo = processes.get(pid);
    if (!initiatingInfo) return -3; // ESRCH
    const vforkBorrower = vforkLifetimes.isActiveBorrower(initiatingInfo);
    // Preallocate the replacement address space before the irreversible commit.
    const newPtrWidth = detectPtrWidth(programBytes);
    const metadataResult = kernelWorker.validateExecMetadata(
      launchArgv,
      envp,
      initiatingInfo.ptrWidth,
    );
    if (metadataResult < 0) return metadataResult;
    let prepared: Awaited<ReturnType<typeof createFreshProcessMemory>>;
    try {
      // The allocation context is the browser's: an exec that fails on
      // capacity should say which image it was trying to run. Node passed
      // none, so its failures named a PID and nothing else.
      prepared = await createFreshProcessMemory(
        pid,
        programBytes,
        newPtrWidth,
        undefined,
        {
          operation: "exec",
          path: diagnosticPath,
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
    let replacementWorker: (W & { start(): boolean }) | undefined;
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
        // memory_quiescent. Those messages are the only proof that the old
        // realm stopped using its Shared Memory; `Worker.terminate()` alone is
        // not such a fence on every engine, and in the browser it is not one
        // at all. Suppress ordinary crash/exit finalizers before the first
        // retirement wake: the persistent PID is already past exec's commit
        // point, so an error from the discarded generation must never kill the
        // replacement.
        if (initiatingInfo.worker) {
          intentionallyTerminated.add(initiatingInfo.worker as object);
        }
        for (const thread of threadWorkers.get(pid) ?? []) {
          intentionallyTerminated.add(thread.worker as object);
        }
        // Commit wakes the old mailboxes while it already owns the kernel
        // entry. No Worker message can dispatch until this synchronous
        // continuation marks every old Worker intentional and consumes the
        // host-owned result.
        const transition = kernelWorker.takeCommittedExecTransition(
          pid,
          initiatingInfo.memory,
        );
        const secureExec = transition.secureExec;
        const mainRetirementStarted = transition.retiredChannelOffsets.has(
          initiatingInfo.channelOffset,
        );
        // The replacement image has not cloned. Retiring the entry here keeps
        // the thread settle from being charged to a process that no longer has
        // threads; only the browser entry did this.
        threadedProcessPids.delete(pid);
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
          terminateThreadWorkers(pid, true, host.threadWorkerSettleMs),
        ]);
        if (initiatingInfo.worker) {
          await terminateTrackedWorker(initiatingInfo.worker);
        }
        if (mainQuiescent) {
          // Thread fences retire their own exact listeners during slot
          // reclaim. Settle the main listener separately so one unresponsive
          // sibling does not retain an otherwise quiescent generation.
          await kernelWorker.settleRetiredChannelListeners(
            pid,
            initiatingInfo.memory,
            initiatingInfo.channelOffset,
          );
        }
        // The full retirement predicate, which only the browser computed.
        // Worker quiescence fences the process and kernel-worker realms; a
        // host-side alias of the same Memory — the browser's main-thread
        // framebuffer views — is a third owner, and `memoryRetirementSafe`
        // records whether this generation ever exposed one. Node has no such
        // owner and answers true to both, so the predicate is the same
        // sentence on each host rather than a shorter one on Node.
        const aliasesReleased =
          await host.releaseGenerationAliases(pid, initiatingInfo);
        oldMemoryRetirementSafe =
          mainQuiescent
          && threadsQuiescent
          && initiatingInfo.memoryRetirementSafe
          && aliasesReleased;
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
            // Name the signal the kernel just reported rather than letting the
            // host default stand in for it. Node passed undefined here and
            // relied on a crash synthesis it does not perform on this path.
            handoffExitSignal,
            "signal",
          );
          return 0;
        }

        host.noteExecImagePath?.(pid, diagnosticPath);

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
              throw new Error(
                `stale fork host-import sender for exec pid=${pid}`,
              );
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
          kernelAbiContractDigest:
            kernelWorker.getKernelAbiContractDigest() ?? undefined,
          ...host.sideModuleInitFields(newPtrWidth),
        };

        // Each host's exec worker-construction fault seam lives behind the
        // factory's `purpose`, where the vfork seam already does, rather than
        // as two different `if` blocks inside this shared body.
        replacementWorker = host.createDeferredProcessWorker(initData, "exec");
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

        // WHY: only terminal messages from every old Worker prove that no
        // realm can still touch this address space. A timeout uses forced
        // retirement, which drops the kernel alias but never recycles the
        // backing.
        if (oldMemoryRetirementSafe) initiatingInfo.memoryLease.release();
        else initiatingInfo.memoryLease.releaseAfterForcedTermination();
        initiatingLeaseConsumed = true;

        // Re-arm error/exit handling. The listeners on the pre-exec worker
        // went with it; without this, a wasm trap in the exec'd binary would
        // leave a waiting parent blocked forever.
        host.installProcessWorkerListeners(
          replacementWorker,
          pid,
          "exec worker error",
        );
        const startDisposition = await retryKernelEntryResult(() =>
          kernelWorker.startProcessWorkerWhenRunnable(
            pid,
            newMemory,
            () => {
              replacementStartAttempted = true;
              if (!replacementWorker!.start()) {
                throw new Error(
                  `Exec replacement Worker for pid ${pid} was cancelled`,
                );
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
              const message =
                error instanceof Error ? error.message : String(error);
              reportHostDiagnostic({
                pid,
                status: signalExitStatus(SIGSEGV),
                source: "exec post-commit transition",
                message: `[exec] post-commit transition failed: ${message}`,
              });
              // One teardown funnel. Node routed this through a host-local
              // wrapper whose guards exist for worker-event races; the
              // replacement is the current generation by construction here, so
              // the guards were vacuous and the funnel is the same.
              handleExit(
                pid,
                signalExitStatus(SIGSEGV),
                SIGSEGV,
                replacementWorker,
                "trap",
              );
              return true;
            },
          ),
        );
        if (startDisposition === "stale") {
          throw new Error(
            `Exec pid ${pid} changed generation before Worker launch`,
          );
        }
        if (startDisposition === "dead") {
          replacementForkHostImports.close();
          // `startProcessWorkerWhenRunnable` proved the replacement Worker was
          // never started. Where termination is an ownership fence, taking it
          // is the proof; where it is not, publishing the equivalent fence
          // directly is, and terminating would prove nothing.
          if (host.terminationProvesQuiescence) {
            await terminateTrackedWorker(replacementWorker);
          } else {
            processes.get(pid)?.workerQuiescence.settle();
          }
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
            signal > 0 ? signal : undefined,
            signal > 0 ? "signal" : "exit",
          );
          return 0;
        }
        kernelWorker.finishProcessExecHandoff(pid);
        return 0;
      } catch (err) {
        replacementForkHostImports?.close();
        if (replacementExternrefGeneration) {
          externrefProcessOwner.releaseGeneration(
            replacementExternrefGeneration,
          );
          replacementExternrefGeneration = undefined;
        }
        // A kernel trap can leave the commit point uncertain. We cannot safely
        // return to the caller, so invalidate the old generation before
        // yielding and report a truthful signal death.
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
        if (
          replacementWorker
          && processes.get(pid)?.worker !== replacementWorker
        ) {
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
              // Exact release needs an ownership fence over a replacement that
              // may well have been started — `preparedTransferred` is set
              // after `start()`, so "it was never started" is not the reason
              // and never was. Where `terminate()` is a fence, the awaited
              // termination above is that proof. Where it is not, a start
              // attempt means the backing must be force-retired instead.
              if (
                replacementStartAttempted
                && !host.terminationProvesQuiescence
              ) {
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
        try {
          kernelWorker.notifyHostProcessCrashed(pid, SIGSEGV);
        } catch {
          // best-effort
        }
        handleExit(pid, signalExitStatus(SIGSEGV), SIGSEGV);
        return 0;
      }
    };
    return { onCommitFailure, startAfterCommit };
  }

  /**
   * The process-lifecycle half of a kernel's callback record.
   *
   * `handleInit` itself is NOT shared and should not be: the browser's
   * compiles side modules shipped from main, wires a service-worker bridge, a
   * CORS proxy and a TLS-MITM backend, and restores mounts from an image;
   * Node's reads files off disk and opens a session directory. That size ratio
   * is a real host difference and collapsing it would be the opposite mistake
   * to leaving a duplicate.
   *
   * What *was* duplicated is the middle: the record of callbacks the kernel
   * uses to reach process lifecycle. Every one of them routes to a function
   * that already lives here, and the two copies were the same text apart from
   * comment wording. A host adds its own callbacks by spreading this.
   */
  function processLifecycleKernelCallbacks(): CentralizedKernelCallbacks {
    return {
      onProcessMemoryTarget: (memory, target) => {
        host.processMemoryAllocator().observeTarget(memory, target);
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
          // Announce every kernel-side process event so an Inspector-style
          // process table refreshes on the event rather than by polling.
          host.post({
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
                // Announce after `handleExec` has refreshed kernel-side
                // Process.argv, or a process-table consumer refetches stale
                // command names and only corrects on a remount. A post-commit
                // signal death also returns 0 but installs no new worker, so
                // only an actually-replaced worker emits `exec`.
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
                        && !host.kernel().isExecHandoffActive(pid),
                      () => host.kernel().isProcessExecutionActive(pid),
                    );
                  if (
                    executionState.status === "current"
                    && executionState.value
                  ) {
                    host.post({ type: "proc_event", kind: "exec", pid });
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
      onThreadExit: (pid, _tid, channelOffset) =>
        handleThreadExit(pid, channelOffset),
      onExit: handleExit,
    };
  }

  /**
   * Build the process-memory allocator a kernel realm admits processes through.
   *
   * Both entries wrote this identically; the browser had reached for a
   * hand-written `PAGE_SIZE = 65536` where Node used the generated ABI
   * constant, which is the same number and the correct source for it.
   */
  function createInitProcessMemoryAllocator(config: {
    maxWorkers: number;
    maxProcessMemoryBytes: number;
    retirementPressureHook: ReturnType<
      typeof createProcessMemoryRetirementPressureHook
    >;
  }): ProcessMemoryAllocator {
    return new ProcessMemoryAllocator({
      // The sampled byte budget is the concurrency authority. Keep the count
      // ceiling high enough that small address spaces do not inherit the
      // historically unenforced `maxWorkers` value as a new process-count
      // limit.
      maxMemories: Math.max(
        1,
        Math.floor(config.maxProcessMemoryBytes / WASM_PAGE_SIZE),
      ),
      maxTotalBytes: config.maxProcessMemoryBytes,
      ...deriveProcessMemoryRetirementAdmissionThresholds(
        config.maxWorkers,
        config.maxProcessMemoryBytes,
      ),
      retirementPressureHook: config.retirementPressureHook,
    });
  }

  /**
   * Hand the boot image's `/` tree to the in-kernel rootfs overlay.
   *
   * The overlay is the unconditional sole `/` authority, so this installs both
   * the blob provider that serves its file bytes and the archive provider that
   * materializes its lazy members. Where the two entries differed was only in
   * where each argument came from — Node's image tree is built from a rootfs
   * image on disk, the browser's is restored from bytes shipped by main — and
   * those are the parameters.
   *
   * `buildRootfsLazyWiring` wants a `(url) => Promise<Uint8Array>` but the
   * fetcher installed on the image returns a `Response`, so it is adapted here
   * rather than changing `setLazyFetcher`'s contract. With no fetcher
   * installed, a lazy read genuinely cannot succeed, so the provider reports
   * that truthfully rather than hanging or guessing a transport. The kernel
   * learns which files are lazy from the image's own `KLZY` section, so only
   * the archive half of the wiring is needed here.
   */
  function configureRootfsOverlayFromImage(options: {
    baseImage: MemoryFileSystem;
    imageBytes: Uint8Array;
    foreignPrefixes: string[];
    nosuid: boolean;
    lazyFetcher?: Parameters<MemoryFileSystem["setLazyFetcher"]>[0];
  }): void {
    const installedLazyFetcher = options.lazyFetcher;
    const lazyArchiveFetcher: (url: string) => Promise<Uint8Array> =
      installedLazyFetcher
        ? async (url) =>
          new Uint8Array(await (await installedLazyFetcher(url)).arrayBuffer())
        : async () => {
          throw new Error("no lazy transport configured");
        };
    const { archiveProvider } = buildRootfsLazyWiring(
      options.baseImage.exportLazyArchiveEntries(),
      lazyArchiveFetcher,
    );
    host.kernel().configureRootfsOverlay(
      createRootfsBlobProvider(
        options.baseImage,
        collectRootfsBlobPaths(options.baseImage, (p) => p),
      ),
      archiveProvider,
      options.foreignPrefixes,
      options.nosuid,
      options.imageBytes,
    );
  }

  /**
   * What a process worker's message asks its host to do next.
   *
   * `consumed` and `stale` need nothing further. `error` and `exit` are the
   * two dispositions the hosts genuinely disagree about, so they are returned
   * rather than acted on — see `dispatchProcessWorkerMessage`.
   */
  type ProcessWorkerMessageDisposition =
    | { kind: "stale" }
    | { kind: "consumed" }
    | { kind: "error"; message: string | undefined }
    | { kind: "exit"; status: number };

  /**
   * Handle the host-independent half of a process worker's message.
   *
   * Both entries' listeners carried the same ~85-line dispatch: the ownership
   * fences (`memory_quiescent`, `exec_retired`), the VM interrupt timer, the
   * fork host-import protocol, the fork-module region record, and the four
   * fork-module proof-of-use channels. None of that is a host difference and
   * it is handled here.
   *
   * What is NOT shared is what a host does about a dead worker, and that is
   * deliberate. Node's `terminate()` is an ownership fence, so its listener
   * finalizes through host-local wrappers and installs a crash safety net on
   * the worker thread. The browser's proves nothing and delivers no `exit`
   * event at all, so `BrowserWorkerHandle` fabricates one and the listener
   * needs a latch to keep the fabricated event from double-finalizing a
   * worker that already reported. That is the terminate-fence boundary, and
   * collapsing it would mean asserting on Node a fence the browser does not
   * have. So `error` and `exit` come back as a disposition for the caller.
   */
  function dispatchProcessWorkerMessage(
    worker: W,
    pid: number,
    raw: unknown,
  ): ProcessWorkerMessageDisposition {
    const process = processes.get(pid);
    if (!process || process.worker !== worker) return { kind: "stale" };
    const message = raw as WorkerToHostMessage;
    if (
      message.type === "memory_quiescent"
      && message.pid === pid
      && message.tid === undefined
    ) {
      // Published only after worker-main returns. Unlike a browser
      // `Worker.terminate()`, this is an exact-generation ownership fence and
      // can authorize dropping the allocator's strong reference.
      if (vforkLifetimes.phaseForChild(process) !== undefined) {
        traceVforkMechanism("memory_quiescent", `child=${pid}`);
      }
      process.workerQuiescence.settle();
      return { kind: "consumed" };
    }
    if (
      message.type === "exec_retired"
      && message.pid === pid
      && message.tid === undefined
    ) {
      process.execRetirement.settle();
      return { kind: "consumed" };
    }
    if (message.type === "error" && message.pid === pid) {
      return { kind: "error", message: message.message };
    }
    if (message.type === "exit" && message.pid === pid) {
      return { kind: "exit", status: message.status ?? 0 };
    }
    if (message.type === "vm_interrupt_timer" && message.pid === pid) {
      handleVmInterruptTimer(message, pid, process);
    } else if (message.type === "fork_host_import") {
      dispatchForkHostImport(worker, message);
    } else if (message.type === "fork_module_frames" && message.pid === pid) {
      // Forward the co-resident fork-module's proof-of-use (Phase 6 D5): a
      // nonzero frame count confirms the qualifying fork ran its continuation
      // through the module. Proof-of-use is informational success telemetry,
      // not a host problem, so it rides the dedicated `fork_module_proof`
      // channel and never pollutes `onHostDiagnostic`.
      postForkModuleProof({
        pid,
        source: "fork-module",
        message: `fork_module_frames=${message.frames}`,
      });
    } else if (
      message.type === "fork_module_child_frames"
      && message.pid === pid
    ) {
      // Forward the REPLAY-side proof-of-use (Phase 6 D7b): a nonzero count
      // confirms a fork CHILD (e.g. a fork-from-thread child) drove its
      // rewind through the module — the child never commits, so
      // `fork_module_frames` cannot show this.
      postForkModuleProof({
        pid,
        source: "fork-module",
        message: `fork_module_child_frames=${message.frames}`,
      });
    } else if (
      message.type === "fork_module_references"
      && message.pid === pid
    ) {
      // Forward the PER-KIND REFERENCE proof-of-use (Phase 6 D6.5): a nonzero
      // count for a kind confirms the child's carried references of that kind
      // were reconstructed through the module. All kinds ride one string so a
      // reader can extract any of funcref/externref/exnref/typed-GC.
      postForkModuleProof({
        pid,
        source: "fork-module",
        message:
          `fork_module_references=${message.references} `
          + `externrefs_resolved=${message.externrefs} `
          + `exnrefs_reconstructed=${message.exnrefs} `
          + `gc_nodes_reconstructed=${message.gcNodes} `
          + `drive_steps_executed=${message.driveSteps} `
          + `static_roots_published=${message.staticRoots}`,
      });
    } else if (message.type === "fork_module_region" && message.pid === pid) {
      // Record where this worker placed its co-resident fork-module region so
      // a COPIED fork child reuses the same base instead of double-mapping the
      // region it already inherits (see `forkModuleInheritedBase` plumbing in
      // `handleOrdinaryFork`).
      process.forkModuleRegion = { base: message.base, bytes: message.bytes };
    }
    return { kind: "consumed" };
  }

  return {
    allocateProcessGeneration,
    bindForkHostImports,
    configureRootfsOverlayFromImage,
    createInitProcessMemoryAllocator,
    dispatchProcessWorkerMessage,
    externrefProcessOwner,
    forkHostImportOwnerRuntime,
    forkHostImportsByWorker,
    handleClone,
    handleExec,
    handleExit,
    processes,
    processGenerationDetaches,
    processLifecycleKernelCallbacks,
    processMemoryCreators,
    processTeardowns,
    ptyByPid,
    threadModuleCache,
    threadedProcessPids,
    vforkLifetimes,
    vmInterruptTimers,
    classifyWasmTrap,
    classifiedSignalOrFallback,
    classifiedTrapExitStatus,
    handleFork,
    completeVforkGenerationTeardown,
    handleVfork,
    handleSpawn,
    handlePosixSpawn,
    handleOrdinaryFork,
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
    handlePtyWrite,
    handleVmInterruptTimer,
    postForkModuleProof,
    handleReadVfsFile,
    handleWriteVfsFile,
    readExecFile,
    readExecFromOverlay,
    readExecFromVfs,
    releaseVforkWorkspace,
    reportHostDiagnostic,
    reportedExits,
    reportRetainedProcessGeneration,
    reportWorkerProtocolError,
    rootfsSnapshotGate,
    resolveExecutableForLaunch,
    respond,
    respondError,
    respondTransferredBytes,
    terminatePoisonedKernelWorker,
    traceVforkMechanism,
  };
}

export type ProcessLifecycle<W extends LifecycleWorkerHandle> =
  ReturnType<typeof createProcessLifecycle<W>>;

// ── Exec target resolution ──────────────────────────────────────────────────
//
// Reading a program's bytes, following `#!` chains and admitting the result as
// a wasm image is POSIX policy, not platform code. Both entries carried the
// whole family — the errno table, the retry loop, the shebang parser, the
// resolution recursion — and the only genuine difference is *where the bytes
// come from*: the browser has the VFS alone, while Node also has locally
// injected program buffers and a main-thread `resolve_exec` fallback. That
// difference is declared as `ProcessLifecycleHost.resolveExecFile`; everything
// else is shared.

/** Copy `bytes` into a standalone `ArrayBuffer` it exclusively owns. */
export function bufferToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

const ENOEXEC = 8;

// A `/`-tree path whose backing archive has not been fetched
// (rootfs-lazy-archives.ts) surfaces as EAGAIN from the kernel; the fetch runs
// on this same worker's event loop, so a `setTimeout`-backed (not microtask)
// delay is required between retries so it can complete. Mirrors
// host/src/exec-target.ts's `readPreparedExecTarget` EAGAIN retry (10ms
// cadence, 30s defensive cap -> truthful timeout).
const EXEC_OVERLAY_EAGAIN_ERRNO = 11;
const EXEC_OVERLAY_ENOENT_ERRNO = 2;
const EXEC_OVERLAY_ENOTDIR_ERRNO = 20;
const EXEC_OVERLAY_EISDIR_ERRNO = 21;
const EXEC_OVERLAY_ETIMEDOUT_ERRNO = 110;
const EXEC_OVERLAY_RETRY_DELAY_MS = 10;
// Defensive backstop only — normal operation always resolves via bytes or a
// terminal errno well before this. It exists so a hypothetical stuck fetch
// fails with a truthful timeout instead of hanging exec forever.
const EXEC_OVERLAY_RETRY_MAX_WAIT_MS = 30_000;

export class ExecOverlayReadTimeoutError extends Error {
  readonly errno = EXEC_OVERLAY_ETIMEDOUT_ERRNO;
  constructor(path: string, waitedMs: number) {
    super(
      `rootfs overlay exec read of ${path} timed out after ${waitedMs}ms ` +
        "waiting for a lazy archive fetch to complete",
    );
    this.name = "ExecOverlayReadTimeoutError";
  }
}

/** How deep a `#!` interpreter chain may nest before exec gives up. */
export const MAX_SHEBANG_DEPTH = 4;

/**
 * The interpreter line of a `#!` script, or null when `bytes` is not a script.
 *
 * POSIX leaves the optional single argument implementation-defined; this
 * follows Linux in taking everything after the first whitespace run as one
 * argument.
 */
export function parseShebang(
  bytes: ArrayBuffer,
): { interpreter: string; arg?: string } | null {
  const view = new Uint8Array(bytes);
  if (view.length < 2 || view[0] !== 0x23 || view[1] !== 0x21) return null;
  let end = 2;
  while (end < view.length && view[end] !== 0x0a && end < 4096) end++;
  const line = new TextDecoder().decode(view.subarray(2, end))
    .replace(/\r$/, "").trim();
  if (!line) return null;
  const match = line.match(/^(\S+)(?:\s+(.*))?$/);
  if (!match) return null;
  return { interpreter: match[1], arg: match[2] };
}
