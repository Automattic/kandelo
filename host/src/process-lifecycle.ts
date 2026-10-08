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

import type { ForkExternrefImportWake } from "./fork-externref-import-mailbox";
import type { ForkHostImportOwnerWorker } from "./fork-host-import-runtime";
import type { HostDiagnostic, HostDiagnosticMessage } from "./host-diagnostic";
import type { ProcessMemoryLayout, ProcessMemoryLease } from "./process-memory";
import { ThreadPageAllocator } from "./thread-allocator";
import type {
  VforkExactCompletionReason,
  VforkLifetimeCoordinator,
} from "./vfork-lifetime";
import type { VmInterruptTimerManager } from "./vm-interrupt-timer";
import { PAGES_PER_THREAD, WASM_PAGE_SIZE } from "./constants";
import type { CentralizedKernelWorker } from "./kernel-worker";
import { retryKernelEntryResult } from "./kernel-entry-retry";
import type { LazyFetch } from "./vfs/lazy-download-event";
import { resolveLazyUrl } from "./vfs/lazy-url";
import {
  buildRootfsLazyWiring,
  waitForDeferredFetch,
  type DeferredProgress,
} from "./vfs/rootfs-lazy-archives";

/** Bytes one pthread slot (TLS, stack and channel pages) occupies. */
const THREAD_SLOT_BYTES = PAGES_PER_THREAD * WASM_PAGE_SIZE;

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

  /** Reserve a host-owned region for one thread slot, returning its page. */
  reserveThreadSlotStartPage(pid: number, bytes: number): number;

  /** Owner registry for the fork host-import protocol, keyed by worker. */
  readonly forkHostImportsByWorker: WeakMap<object, ForkHostImportOwnerWorker>;
}

// ── Host-independent helpers ────────────────────────────────────────────────

/**
 * The signal encoded in a shell-style wait status, or null for a plain exit.
 */
export function signalFromExitStatus(exitStatus: number): number | null {
  return exitStatus >= 128 ? (exitStatus - 128) & 0x7f : null;
}

/**
 * Whether an error means "that path is not there", as opposed to a real
 * failure that should abort exec resolution.
 */
export function isMissingPathError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === -2 || code === "ENOENT") return true;
  // The kernel owns `/`, so the host mount table holds only the host-backed
  // mounts beneath it. A path none of them covers reaches `VirtualPlatformIO`
  // with no mount ("ENOENT: no mount for path: ..."), which is a missing path,
  // not a hard failure.
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" &&
    message.startsWith("ENOENT: no mount for path");
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
        host.reserveThreadSlotStartPage(pid, THREAD_SLOT_BYTES) / WASM_PAGE_SIZE,
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

  return {
    bindForkHostImports,
    completeVforkGenerationTeardown,
    dispatchForkHostImport,
    handleVmInterruptTimer,
    releaseVforkWorkspace,
    reportHostDiagnostic,
    respond,
    respondError,
    threadAllocatorForLayout,
    traceVforkMechanism,
  };
}

export type ProcessLifecycle<Info extends ProcessLifecycleInfo> =
  ReturnType<typeof createProcessLifecycle<Info>>;


// ── Kernel-owned root filesystem ────────────────────────────────────────────
//
// The kernel owns `/` and the scratch mounts. What a worker entry still does
// for them is the same on both hosts: hand the kernel the boot image and a
// byte pipe for what the image does not carry, and read or write `/` files on
// the main thread's behalf through the kernel. These helpers are that common
// part; where the two entries differ is only in where the image bytes and the
// lazy transport come from, and those are the parameters.

/**
 * Hand the boot image's `/` tree to the in-kernel rootfs.
 *
 * Installs the deferred-resource provider the kernel uses for files the image
 * names but does not carry (URL-backed lazy files and lazy archives), and the
 * image byte window the kernel reads image-backed file content through. The
 * kernel parses the image itself; the host supplies bytes, not a tree.
 *
 * `lazyUrlMap` maps an address the image records to the URL this deployment
 * serves it at, and `lazyUrlBase` resolves any other relative address against
 * the deployment, as the TypeScript filesystem's URL rewriting did before the
 * kernel owned `/`. The image is not rewritten: the address is resolved at
 * fetch time, so a closed-asset fetcher keyed by resolved URLs still finds its
 * bytes.
 */
export function configureRootfsOverlayFromImage(
  kernel: CentralizedKernelWorker,
  options: {
    /** Read the image at a CONTAINER offset; `0` at or past the end. */
    imageRead: (at: number, dest: Uint8Array) => number;
    imageBytes: Uint8Array;
    /** Report lazy transfer progress. The fetch is the host's, so its progress is too. */
    onLazyProgress?: DeferredProgress;
    foreignPrefixes: string[];
    nosuid: boolean;
    lazyFetcher?: LazyFetch;
    lazyUrlBase?: string;
    /** Where the deployment serves an address the image records; consulted
     *  before `lazyUrlBase`. See `lazyUrlMap` in `browser-kernel-protocol.ts`. */
    lazyUrlMap?: Readonly<Record<string, string>>;
  },
): void {
  const installedLazyFetcher = options.lazyFetcher;
  const lazyUrlBase = options.lazyUrlBase;
  const lazyUrlMap = options.lazyUrlMap;
  const resolveAddress = (url: string): string => {
    if (
      lazyUrlMap !== undefined
      && Object.prototype.hasOwnProperty.call(lazyUrlMap, url)
    ) {
      return lazyUrlMap[url]!;
    }
    return lazyUrlBase ? resolveLazyUrl(lazyUrlBase, url) : url;
  };
  const fetchUrlBytes: (url: string) => Promise<Uint8Array> =
    installedLazyFetcher
      ? async (url) => {
        const resolved = resolveAddress(url);
        const response = await installedLazyFetcher(resolved);
        if (!response.ok) {
          throw new Error(`lazy fetch of ${resolved} failed: HTTP ${response.status}`);
        }
        return new Uint8Array(await response.arrayBuffer());
      }
      : async () => {
        // With no transport installed a lazy read genuinely cannot succeed;
        // the kernel reports EIO to the guest rather than hanging.
        throw new Error("no lazy transport configured");
      };
  const { deferredProvider, whenFetchSettles } = buildRootfsLazyWiring(
    fetchUrlBytes,
    options.onLazyProgress,
  );
  kernel.configureRootfsOverlay(
    deferredProvider,
    options.foreignPrefixes,
    options.nosuid,
    options.imageBytes,
    options.imageRead,
    whenFetchSettles,
  );
}

const ROOTFS_EAGAIN_ERRNO = 11;
const ROOTFS_ENOENT_ERRNO = 2;
const ROOTFS_ENOTDIR_ERRNO = 20;
const ROOTFS_EISDIR_ERRNO = 21;
const ROOTFS_ETIMEDOUT_ERRNO = 110;
/**
 * A lazy file under `/` whose bytes have not arrived reads as EAGAIN; the
 * fetch runs on this worker's event loop, so a retry waits for it to settle
 * (`waitForDeferredFetch`) rather than spinning on microtasks. Only an EAGAIN
 * with no fetch in flight — which this pipe does not produce — falls back to
 * this plain timer between retries. Matches `readPreparedExecTarget` in
 * `host/src/exec-target.ts`.
 */
const ROOTFS_RETRY_DELAY_MS = 10;
/**
 * Defensive backstop only: a fetch normally resolves to bytes or a terminal
 * errno well before this. It exists so a stuck fetch fails with a truthful
 * timeout instead of hanging a spawn forever.
 */
const ROOTFS_RETRY_MAX_WAIT_MS = 30_000;

/** A `/` read that waited past {@link ROOTFS_RETRY_MAX_WAIT_MS} for lazy bytes. */
export class RootfsReadTimeoutError extends Error {
  readonly errno = ROOTFS_ETIMEDOUT_ERRNO;
  constructor(path: string, waitedMs: number) {
    super(
      `rootfs read of ${path} timed out after ${waitedMs}ms waiting for a ` +
        "lazy file fetch to complete",
    );
    this.name = "RootfsReadTimeoutError";
  }
}

function rootfsErrno(error: unknown): number | undefined {
  const errno = (error as { errno?: unknown }).errno;
  return typeof errno === "number" ? errno : undefined;
}

/**
 * Read a `/` file through the kernel, for a host-side caller that needs the
 * bytes (the spawn preflight resolving what a launch would run).
 *
 * ENOENT/ENOTDIR/EISDIR mean "not a readable regular file here" and return
 * null so the caller can fall through to its other sources. A lazy file whose
 * bytes are still arriving is retried until they land; any other errno is a
 * real failure and is thrown.
 *
 * `rootfsReadFile` is an immediate kernel entry. A caller running inside a
 * protocol transaction (the SYS_SPAWN preflight) can find the entry gate busy;
 * `retryKernelEntryResult` retries that on a later host turn, which is safe
 * because the gate rejects the read before touching kernel state.
 */
export async function readRootfsFileWithRetry(
  kernel: CentralizedKernelWorker,
  path: string,
): Promise<Uint8Array | null> {
  const start = Date.now();
  for (;;) {
    try {
      return await retryKernelEntryResult(() => kernel.rootfsReadFile(path));
    } catch (error) {
      const errno = rootfsErrno(error);
      if (
        errno === ROOTFS_ENOENT_ERRNO ||
        errno === ROOTFS_ENOTDIR_ERRNO ||
        errno === ROOTFS_EISDIR_ERRNO
      ) {
        return null;
      }
      if (errno !== ROOTFS_EAGAIN_ERRNO) throw error;
      const waited = Date.now() - start;
      if (waited >= ROOTFS_RETRY_MAX_WAIT_MS) {
        throw new RootfsReadTimeoutError(path, waited);
      }
      // WHY not a fixed timer: the bytes usually land well inside one timer
      // period, and every first read of a lazy file (the spawn preflight of a
      // lazy program) paid the rest of that period on top of the fetch.
      const inFlight = kernel.deferredFetchSettled();
      await waitForDeferredFetch(
        inFlight,
        inFlight === null
          ? ROOTFS_RETRY_DELAY_MS
          : ROOTFS_RETRY_MAX_WAIT_MS - waited,
      );
    }
  }
}

/**
 * Whether a kernel rootfs read failure means "no readable regular file at
 * that path" rather than a real error, for the main thread's `read_vfs_file`.
 */
export function isRootfsMissingFileError(error: unknown): boolean {
  const errno = rootfsErrno(error);
  return errno === ROOTFS_ENOENT_ERRNO ||
    errno === ROOTFS_ENOTDIR_ERRNO ||
    errno === ROOTFS_EISDIR_ERRNO;
}
