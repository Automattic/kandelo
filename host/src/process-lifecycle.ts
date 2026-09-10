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

import type {
  CentralizedKernelWorker,
  ResolvedSpawnProgram,
  SpawnProgramResolution,
} from "./kernel-worker";
import { retryKernelEntryResult } from "./kernel-entry-retry";
import { readPreparedPlatformFile } from "./vfs";
import type { PlatformIO } from "./types";
import {
  describeWasmArtifactPolicyFailures,
  extractAbiVersion,
  isWasmModuleBytes,
} from "./constants";
import { FILE_MODES } from "./generated/abi";
import type { ForkExternrefImportWake } from "./fork-externref-import-mailbox";
import type { ForkHostImportOwnerWorker } from "./fork-host-import-runtime";
import type {
  ForkModuleProofMessage,
  HostDiagnostic,
  HostDiagnosticMessage,
} from "./host-diagnostic";
import type { ProcessMemoryLayout, ProcessMemoryLease } from "./process-memory";
import { ThreadPageAllocator } from "./thread-allocator";
import { ThreadExitCoordinator } from "./thread-exit-coordinator";
import {
  waitForExecRetirement as waitForExecRetirementFence,
  waitForWorkerQuiescence as waitForWorkerQuiescenceFence,
  type WorkerQuiescence,
} from "./worker-quiescence";
import type {
  VforkExactCompletionReason,
  VforkLifetimeCoordinator,
} from "./vfork-lifetime";
import type { VmInterruptTimerManager } from "./vm-interrupt-timer";
import type {
  ExactProcessGenerationDetachLedger,
  ExactProcessGenerationDetachResult,
} from "./process-generation-detach";
import { PAGES_PER_THREAD, WASM_PAGE_SIZE } from "./constants";
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
export interface ProcessLifecycleInfo extends ProcessGenerationOwnership {
  channelOffset: number;
  vforkWorkspace?: VforkWorkspaceOwnership;
  worker: LifecycleWorker;
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
  | { type: "response"; requestId: number; result: unknown; error?: string };

/**
 * Everything this module needs from its host. Every genuine platform
 * boundary appears here, so the list of real differences is readable in one
 * place instead of being inferred from two 4,000-line files.
 */
export interface ProcessLifecycleHost<Info extends ProcessLifecycleInfo> {
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

  readonly vforkLifetimes: VforkLifetimeCoordinator<Info>;
  readonly vmInterruptTimers: VmInterruptTimerManager<Info>;

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
  readonly processes: Map<number, Info>;

  /** In-flight process teardowns, keyed by the worker being torn down. */
  readonly processTeardowns: Map<Info["worker"], Promise<void>>;

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
export function createProcessLifecycle<Info extends ProcessLifecycleInfo>(
  host: ProcessLifecycleHost<Info>,
) {
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
    ThreadWorkerRecord<Info["worker"]>[]
  >();

  const threadExits = new ThreadExitCoordinator();

  /**
   * Terminate a worker we own, recording the teardown so observers can wait.
   *
   * `settleMs` buys time for a host whose `terminate()` proves nothing to let
   * the worker actually stop; it is 0 where termination is itself a fence.
   */
  async function terminateTrackedWorker(
    worker: Info["worker"],
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

  return {
    bindForkHostImports,
    completeVforkGenerationTeardown,
    detachExactProcessGeneration,
    dispatchForkHostImport,
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
    threadAllocatorForLayout,
    traceVforkMechanism,
  };
}

export type ProcessLifecycle<Info extends ProcessLifecycleInfo> =
  ReturnType<typeof createProcessLifecycle<Info>>;

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
