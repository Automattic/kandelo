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

import type { CentralizedKernelWorker } from "./kernel-worker";
import type { ForkExternrefImportWake } from "./fork-externref-import-mailbox";
import type { ForkHostImportOwnerWorker } from "./fork-host-import-runtime";
import type {
  ForkModuleProofMessage,
  HostDiagnostic,
  HostDiagnosticMessage,
} from "./host-diagnostic";
import type { ProcessMemoryLayout, ProcessMemoryLease } from "./process-memory";
import { ThreadPageAllocator } from "./thread-allocator";
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
  /** Send a message to the main thread. */
  post(message: ProcessLifecycleOutboundMessage): void;

  /**
   * Whether an awaited worker termination proves the worker has stopped.
   *
   * `true` on Node, where `await worker.terminate()` joins the thread.
   * `false` in the browser, where `Worker.terminate()` reports nothing and a
   * guest parked in `Atomics.wait` cannot be observed to have stopped. When
   * this is `false`, a slot or a memory backing released after termination
   * must be force-retired rather than exactly released.
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

  return {
    bindForkHostImports,
    completeVforkGenerationTeardown,
    detachExactProcessGeneration,
    dispatchForkHostImport,
    handlePtyResize,
    handlePtyWrite,
    handleVmInterruptTimer,
    postForkModuleProof,
    releaseVforkWorkspace,
    reportHostDiagnostic,
    reportRetainedProcessGeneration,
    respond,
    respondError,
    threadAllocatorForLayout,
    traceVforkMechanism,
  };
}

export type ProcessLifecycle<Info extends ProcessLifecycleInfo> =
  ReturnType<typeof createProcessLifecycle<Info>>;
