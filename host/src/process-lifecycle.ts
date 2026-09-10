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
  type CentralizedKernelWorker,
  type ResolvedSpawnProgram,
  type SpawnProgramResolution,
} from "./kernel-worker";
import type { CentralizedWorkerInitMessage } from "./worker-protocol";
import { createWorkerQuiescence } from "./worker-quiescence";
import { retryKernelEntryResult } from "./kernel-entry-retry";
import { readPreparedPlatformFile } from "./vfs";
import type { PlatformIO } from "./types";
import {
  describeWasmArtifactPolicyFailures,
  detectPtrWidth,
  extractAbiVersion,
  isWasmModuleBytes,
} from "./constants";
import { FILE_MODES } from "./generated/abi";
import type { ForkExternrefImportWake } from "./fork-externref-import-mailbox";
import type { ForkHostImportOwnerWorker } from "./fork-host-import-runtime";
import type { ForkExternrefProcessOwner } from "./fork-externref-process-owner";
import type { ForkExternrefGeneration } from "./fork-reference-broker";
import type {
  ForkModuleProofMessage,
  HostDiagnostic,
  HostDiagnosticMessage,
} from "./host-diagnostic";
import type { ProcessMemoryLayout, ProcessMemoryLease } from "./process-memory";
import type { ProcessMemoryAllocator } from "./process-memory";
import { ThreadPageAllocator } from "./thread-allocator";
import { ThreadExitCoordinator } from "./thread-exit-coordinator";
import {
  waitForExecRetirement as waitForExecRetirementFence,
  waitForWorkerQuiescence as waitForWorkerQuiescenceFence,
  type WorkerQuiescence,
} from "./worker-quiescence";
import {
  VforkAddressSpaceBusyError,
  type VforkExactCompletionReason,
  type VforkLifetimeCoordinator,
  type VforkLifetimeDisposition,
} from "./vfork-lifetime";
import { SIGSEGV, signalExitStatus } from "./trap-signals";
import type { VmInterruptTimerManager } from "./vm-interrupt-timer";
import type {
  ExactProcessGenerationDetachLedger,
  ExactProcessGenerationDetachResult,
} from "./process-generation-detach";
import { CH_TOTAL_SIZE, PAGES_PER_THREAD, WASM_PAGE_SIZE } from "./constants";
import { extractHeapBase } from "./constants";
import {
  computeProcessMemoryLayout,
  ProcessMemoryCapacityError,
  ProcessMemoryRetirementBacklogError,
} from "./process-memory";
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
  readonly allocator: ThreadPageAllocator;
  readonly slotStartPage: number;
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
  W extends LifecycleWorker = LifecycleWorker,
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
  threadAllocator: ThreadPageAllocator;
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
  | { type: "response"; requestId: number; result: unknown; error?: string };

/**
 * Everything this module needs from its host. Every genuine platform
 * boundary appears here, so the list of real differences is readable in one
 * place instead of being inferred from two 4,000-line files.
 */
export interface ProcessLifecycleHost<W extends LifecycleWorker> {
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

  readonly vforkLifetimes: VforkLifetimeCoordinator<ProcessLifecycleInfo<W>>;
  readonly vmInterruptTimers: VmInterruptTimerManager<ProcessLifecycleInfo<W>>;

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

  /** Owner registry for the fork host-import protocol, keyed by worker. */
  readonly forkHostImportsByWorker: WeakMap<object, ForkHostImportOwnerWorker>;

  /** Retry ledger for exact process-generation detach transactions. */
  readonly processGenerationDetaches:
    ExactProcessGenerationDetachLedger<ProcessGenerationOwnership>;

  /** PTY index by PID. */
  readonly ptyByPid: Map<number, number>;

  /** Live processes by PID. */
  readonly processes: Map<number, ProcessLifecycleInfo<W>>;

  /** In-flight process teardowns, keyed by the worker being torn down. */
  readonly processTeardowns: Map<W, Promise<void>>;

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

  /** Exact broker authority for each PID's current Wasm image. */
  readonly externrefProcessOwner: ForkExternrefProcessOwner;

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
   * Allocate the next execution-generation number for this realm.
   *
   * Monotonic and never reused, so a message naming a generation can always
   * be rejected as stale rather than misapplied to a successor image.
   */
  allocateProcessGeneration(): number;

  /** Owner registry issuing this realm's fork host-import workers. */
  readonly forkHostImportOwnerRuntime: {
    createWorker(options: {
      pid: number;
      generationId: number;
      authorizeSender: () => void;
    }): ForkHostImportOwnerWorker;
  };

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
  ): W & { start(): boolean };

  /**
   * Init-message fields naming this host's co-resident side modules.
   *
   * A genuine artifact difference: Node reads the modules off disk, the
   * browser receives them as compiled `WebAssembly.Module`s from main.
   */
  sideModuleInitFields(ptrWidth: 4 | 8): Partial<CentralizedWorkerInitMessage>;

  /**
   * Attach this host's message/error listeners to a new process worker.
   *
   * `errorLabel` names the launch in a worker-error diagnostic, so a failure
   * during a `posix_spawn` is distinguishable from an ordinary one.
   */
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
 * Bind the shared lifecycle logic to one host.
 *
 * Returns plain functions rather than a class so each entry can destructure
 * exactly what it uses and the call sites read the same as before.
 */
export function createProcessLifecycle<W extends LifecycleWorker>(
  host: ProcessLifecycleHost<W>,
) {
  type Info = ProcessLifecycleInfo<W>;
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
    host.vmInterruptTimers.handleRequest(pid, process, msg);
  }

  /** Return a borrowed vfork control slot to its owning allocator, once. */
  function releaseVforkWorkspace(info: Info): void {
    const workspace = info.vforkWorkspace;
    if (!workspace || workspace.released) return;
    workspace.released = true;
    workspace.allocator.free(workspace.slotStartPage);
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
    const phase = host.vforkLifetimes.phaseForChild(info);
    if (phase === undefined) return;
    if (!exact) {
      host.vforkLifetimes.requireAddressSpaceContainment(
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
      host.vforkLifetimes.completeWithoutBorrow(
        info,
        reason === "exit" ? "exit" : "signal",
      );
    } else {
      host.vforkLifetimes.completeAfterExactTeardown(info, reason);
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
        host.kernel().reserveHostRegion(
          pid,
          PAGES_PER_THREAD * WASM_PAGE_SIZE,
        ) / WASM_PAGE_SIZE,
    });
  }

  function bindForkHostImports(
    worker: object,
    owner: ForkHostImportOwnerWorker,
  ): void {
    host.forkHostImportsByWorker.set(worker, owner);
  }

  function dispatchForkHostImport(
    worker: object,
    message: { wake: ForkExternrefImportWake },
  ): void {
    const owner = host.forkHostImportsByWorker.get(worker);
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
    const result = await host.processGenerationDetaches.detach({
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
    const ptyIdx = host.ptyByPid.get(pid);
    if (ptyIdx === undefined) return;
    host.kernel().ptyMasterWrite(ptyIdx, data);
  }

  function handlePtyResize(pid: number, rows: number, cols: number): void {
    const ptyIdx = host.ptyByPid.get(pid);
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
    host.forkHostImportsByWorker.get(worker as object)?.close();
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
      for (const info of host.processes.values()) {
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

  /** What a process-memory allocation was for, reported when it fails. */
  interface ProcessMemoryAllocationContext {
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
    const liveProcesses = Array.from(host.processes.entries())
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
        threadArenaEndPage: layout.threadArenaEndPage,
      },
      liveProcessCount: host.processes.size,
      pendingProcessTeardowns: host.processTeardowns.size,
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
    threadAllocator: ThreadPageAllocator;
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
        threadAllocator: threadAllocatorForLayout(layout, ptrWidth, pid),
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
    const info = host.processes.get(pid);
    if (!info || info.worker !== expectedWorker) return;
    host.vmInterruptTimers.clear(pid, info);

    if (host.processTeardowns.has(expectedWorker)) {
      // A second notification for the same teardown still has to reach main:
      // the browser used to drop it silently while Node re-reported it, so the
      // same double exit was observable on one host and invisible on the
      // other. `reportProcessExit` is once-only per PID, so re-reporting is
      // idempotent and the Node shape is the safe one to adopt.
      host.reportProcessExit(pid, info, exitStatus);
      return;
    }

    const settleMs = host.processExitSettleMs(pid, info);
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

      host.externrefProcessOwner.releaseGeneration(info.externrefGeneration);
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
    host.processTeardowns.set(expectedWorker, teardown);

    // The process is already a kernel-side zombie here. Report the exit before
    // worker teardown so a slow termination cannot make a host's spawn() look
    // like the guest process never exited. The teardown promise stays tracked
    // so destroy() still waits for cleanup.
    host.reportProcessExit(pid, info, exitStatus);

    try {
      await teardown;
    } finally {
      host.processTeardowns.delete(expectedWorker);
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
    if (host.processes.get(disposition.childPid) === childGeneration) {
      await finishProcessExit(
        disposition.childPid,
        status,
        SIGSEGV,
        childGeneration.worker,
        "trap",
      );
    }
    if (host.processes.get(parentPid) === disposition.parentGeneration) {
      await finishProcessExit(
        parentPid,
        status,
        SIGSEGV,
        disposition.parentGeneration.worker,
        "trap",
      );
    }

    if (
      host.processes.get(disposition.childPid) === childGeneration
      || host.processes.get(parentPid) === disposition.parentGeneration
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
    if (!host.processTeardowns.has(expectedWorker)) {
      void finishProcessExit(pid, exitStatus, crashSignum, expectedWorker, reason);
    }
    await host.processTeardowns.get(expectedWorker);
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
          host.processes.size !== 0 ||
          host.processTeardowns.size !== 0 ||
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
        threadAllocator,
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
      });
      createdMemoryRegistered = true;

      kernelWorker.setCredentials(pid, { uid: msg.uid, gid: msg.gid });
      const secureExec = kernelWorker.processSecureExec(pid);
      if (msg.cwd) kernelWorker.setCwd(pid, msg.cwd);
      if (msg.maxAddr != null) kernelWorker.setMaxAddr(pid, msg.maxAddr);

      if (msg.pty) {
        const ptyIdx = kernelWorker.setupPty(pid);
        host.ptyByPid.set(pid, ptyIdx);
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

      const externrefGeneration = host.externrefProcessOwner.startGeneration(pid);
      createdExternrefGeneration = externrefGeneration;
      let worker: W;
      const forkHostImports = host.forkHostImportOwnerRuntime.createWorker({
        pid,
        generationId: externrefGeneration.id,
        authorizeSender: () => {
          const current = host.processes.get(pid);
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
        generation: host.allocateProcessGeneration(),
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
        threadAllocator,
        externrefGeneration,
      };
      host.processes.set(pid, createdGeneration);

      host.installProcessWorkerListeners(worker, pid);
      createdMemoryLease = undefined;
      createdPid = undefined;
      createdExternrefGeneration = undefined;
      createdForkHostImports = undefined;

      respond(msg.requestId, pid);
    } catch (e) {
      createdForkHostImports?.close();
      if (createdExternrefGeneration) {
        host.externrefProcessOwner.releaseGeneration(createdExternrefGeneration);
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
    const { memory, memoryLease, layout, threadAllocator } = fresh;
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
      });
      registered = true;

      externrefGeneration = host.externrefProcessOwner.startGeneration(childPid);
      const processExternrefGeneration = externrefGeneration;
      const processForkHostImports = host.forkHostImportOwnerRuntime
        .createWorker({
          pid: childPid,
          generationId: processExternrefGeneration.id,
          authorizeSender: () => {
            const current = host.processes.get(childPid);
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

      newWorker = host.createDeferredProcessWorker(initData);
      const worker = newWorker;
      bindForkHostImports(worker, processForkHostImports);
      childGeneration = {
        generation: host.allocateProcessGeneration(),
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
        threadAllocator,
        externrefGeneration: processExternrefGeneration,
      };
      host.processes.set(childPid, childGeneration);

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
        host.processes.get(childPid)?.workerQuiescence.settle();
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
        host.externrefProcessOwner.releaseGeneration(externrefGeneration);
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

  return {
    bindForkHostImports,
    completeVforkGenerationTeardown,
    handleSpawn,
    handlePosixSpawn,
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
    threadAllocatorForLayout,
    traceVforkMechanism,
  };
}

export type ProcessLifecycle<W extends LifecycleWorker> =
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
