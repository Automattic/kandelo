/**
 * The fork half of a process Worker and of a pthread Worker, written once.
 *
 * # Why this file exists
 *
 * `centralizedWorkerMain` (a process) and `centralizedThreadWorkerMain` (a
 * pthread) each carried their own copy of the same fork sequence: instantiate
 * the co-resident fork module, admit activation 0, build the activation /
 * table / identity records, serve the guest's `kernel.kernel_fork` import, and
 * run the guest entry in a loop that seals a capture, issues SYS_FORK and
 * replays. Two copies of one sequence drift, and these had: the pthread copy
 * never filled the merged static-root catalog before a capture (so a
 * statically initialised reference captured from a pthread was rebuilt as a
 * second object in the child), never said why a fork aborted, and took the
 * process archive lock through a hand-written duplicate of the loader's own
 * reader lock. Lane F's super plan, step 3
 * (docs/superpowers/plans/2026-09-24-lane-f-super-plan.md), merges them here.
 *
 * # Why it is "support" for worker-main.ts and not a fork file of its own
 *
 * The maintainer ruled (2026-09-25) that the merged path is SUBSERVIENT to
 * `worker-main.ts` and is counted in the same closure measure,
 * `workerMainForkTypeScript` (host/test/surface-budget.test.ts). Moving a line
 * here therefore never reads as a reduction; only deleting one does. It is a
 * separate file only so the two mains can share it without a class inside a
 * 6,000-line module.
 *
 * # What stays in the mains
 *
 * Only what legitimately differs between a process and a pthread: where the
 * fork module's region comes from (a copied fork child reuses the one it
 * inherited), whether the launch root is published (a borrowed vfork child
 * must not write its parked parent's control word), the child install (a
 * pthread Worker is never a fork child), which guest entry pair to run, and
 * how the Worker reports its exit.
 */
import type { WorkerToHostMessage } from "./worker-protocol";
import {
  CHANNEL_STATUS_IDLE,
  CHANNEL_STATUS_PENDING,
  CH_ARG_SIZE,
  CH_ARGS,
  CH_ERRNO,
  CH_REQUEST_FLAGS,
  CH_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
  HOST_INTERCEPTED_SYSCALLS,
  PROCESS_FORK_MODE_FORK,
  PROCESS_FORK_MODE_VFORK,
  type ProcessForkMode,
} from "./generated/abi";
import { ContinuationAllocationError } from "./fork-continuation";
import {
  buildForkGuestImports,
  FORK_GUEST_ACTIVATION_GLOBAL_IMPORT,
  FORK_GUEST_TABLE_GENERATION_ADDR_IMPORT,
  forkUnwindTagFrom,
  isForkUnwindException,
} from "./fork-guest-imports";
import { forkPhase, type ForkPhase } from "./fork-phase";
import {
  type ForkModuleInstance,
  instantiateForkModule,
} from "./fork-module-instance";
import {
  type ForkBorrowedReplayWorkspace,
  type ForkModuleStat,
  ForkModuleContinuationBackend,
} from "./fork-module-backend";
import { computeForkModuleTemplateId } from "./fork-guest-sections";
import { ForkImportIdentity } from "./fork-import-identity";
import { ForkActivations, forkActivationCatalogSink } from "./fork-activations";
import { ForkTables } from "./fork-tables";
// Types only: a value import from worker-main.ts would make the two modules a
// load-order cycle.
import type {
  DlopenSupport,
  ForkActivationTableReplication,
  MessagePort,
  ProcessTableReplicationOwner,
} from "./worker-main";

const ENOSYS = 38;
const EAGAIN = 11;
const EINVAL = 22;

/** @internal Exported so cross-engine exit-trap recognition is tested. */
export function isWasmUnreachableTrap(error: unknown): boolean {
  // WHY: WebKit describes the same Wasm `unreachable` trap as
  // "Unreachable code should not be executed" while V8 uses lowercase
  // "unreachable". The RuntimeError guard keeps an ordinary JavaScript Error
  // containing that word from masquerading as a committed guest exit.
  return error instanceof WebAssembly.RuntimeError
    && /\bunreachable\b/i.test(error.message);
}

/** The mode a guest's `kernel_fork(mode)` asked for, or null for garbage. */
export function processForkMode(value: number): ProcessForkMode | null {
  if (value === PROCESS_FORK_MODE_FORK) return PROCESS_FORK_MODE_FORK;
  if (value === PROCESS_FORK_MODE_VFORK) return PROCESS_FORK_MODE_VFORK;
  return null;
}

/**
 * Issue one blocking syscall on this Worker's channel and return
 * `result` or `-errno`.
 *
 * Signal delivery is deferred for the call: the fork paths issue these while a
 * continuation is half built, where a handler cannot run.
 */
export function channelSyscall(
  memory: WebAssembly.Memory,
  channelOffset: number,
  syscall: number,
  args: readonly bigint[],
): number {
  const view = new DataView(memory.buffer);
  view.setInt32(channelOffset + CH_SYSCALL, syscall, true);
  for (let i = 0; i < 6; i++) {
    view.setBigInt64(channelOffset + CH_ARGS + i * CH_ARG_SIZE, args[i] ?? 0n, true);
  }
  view.setUint32(
    channelOffset + CH_REQUEST_FLAGS,
    CH_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY,
    true,
  );
  const i32 = new Int32Array(memory.buffer);
  const status = (channelOffset + CH_STATUS) / 4;
  Atomics.store(i32, status, CHANNEL_STATUS_PENDING);
  Atomics.notify(i32, status, 1);
  while (Atomics.wait(i32, status, CHANNEL_STATUS_PENDING) === "ok") {
    /* */
  }
  // Fresh views: the kernel may have grown the memory during the call.
  const after = new DataView(memory.buffer);
  const result = Number(after.getBigInt64(channelOffset + CH_RETURN, true));
  const err = after.getUint32(channelOffset + CH_ERRNO, true);
  after.setUint32(channelOffset + CH_REQUEST_FLAGS, 0, true);
  Atomics.store(new Int32Array(memory.buffer), status, CHANNEL_STATUS_IDLE);
  return err ? -err : result;
}

/**
 * SYS_FORK or SYS_VFORK for `mode`; -errno or the child pid. A vfork also
 * tells the kernel how much private workspace the borrowed child's replay
 * needs, from the module's seal row.
 */
export function sendForkSyscall(
  memory: WebAssembly.Memory,
  channelOffset: number,
  mode: ProcessForkMode,
  sealed: ForkBorrowedReplayWorkspace,
): number {
  const vfork = mode === PROCESS_FORK_MODE_VFORK;
  return channelSyscall(
    memory,
    channelOffset,
    vfork ? HOST_INTERCEPTED_SYSCALLS.SYS_VFORK : HOST_INTERCEPTED_SYSCALLS.SYS_FORK,
    vfork ? [BigInt(sealed.prefixBytes), BigInt(sealed.scratchBytes)] : [],
  );
}

/** Everything that differs between a process Worker and a pthread Worker. */
export interface ForkWorkerOptions {
  readonly port: MessagePort;
  readonly memory: WebAssembly.Memory;
  readonly ptrWidth: 4 | 8;
  /** This Worker's own syscall channel. */
  readonly channelOffset: number;
  readonly pid: number;
  /** `pid=N` or `pid=N tid=T`, prefixed to every failure. */
  readonly label: string;
  readonly forkModuleModule: WebAssembly.Module | undefined;
  /** The guest program, and the bytes its template id is hashed from. */
  readonly guestModule: WebAssembly.Module;
  readonly guestBytes: ArrayBuffer | ArrayBufferView;
  /** The PROCESS control block the fork module reads: a pthread shares it. */
  readonly archiveControlAddr: number;
  /** The process's shared table-generation fence. */
  readonly generationAddress: number;
  /** A fork child replays; it never captures before its install. */
  readonly forkChild: boolean;
  /** A vfork child running in its parked parent's memory. */
  readonly borrowedChild: boolean;
  /** Place the fork module's region (see the process main for the COW case). */
  readonly reserve: (size: number) => number;
  /** Record where a child finds activation 0's continuation. */
  readonly publishLaunchRoot: (address: number) => void;
}

/** How a guest entry ended. */
export type ForkWorkerOutcome =
  | { readonly returned: unknown }
  | { readonly exited: number };

/**
 * The fork module's reasons for an abort, keyed by its `ABORT_CAUSE_*`
 * numbers (`crates/fork-module/src/lib.rs`).
 */
const FORK_ABORT_REASONS: Readonly<Record<number, string>> = {
  1: "a continuation frame could not be reserved mid-unwind (the parent's "
    + "committed frames were replayed; no child was created)",
  2: "the capture could not seal (the parent's frames are intact "
    + "and were replayed; no child was created)",
  3: "the kernel refused to create the child process",
};

/**
 * One Worker's fork machinery: its co-resident fork module and everything
 * the host keeps beside it.
 */
export class ForkWorker {
  private readonly backend: ForkModuleContinuationBackend;
  private readonly moduleExports: Record<string, unknown>;
  readonly instance: ForkModuleInstance;
  readonly unwindTag: WebAssembly.Tag;
  readonly activations: ForkActivations;
  readonly tables: ForkTables;
  readonly identity: ForkImportIdentity;
  /** The generation fence as the guest imports it. */
  readonly tableReplication: ForkActivationTableReplication;
  /** Set once this Worker's dynamic loader exists; see `bindArchive`. */
  private archive: {
    readonly dlopen: DlopenSupport;
    readonly replication: ProcessTableReplicationOwner;
  } | null = null;
  private readerHeld = false;
  private mainRegistered = false;
  private forkMode: ProcessForkMode;
  /** What the guest's `fork()` returns once its replay finishes. */
  private forkResult = 0;

  constructor(private readonly options: ForkWorkerOptions, forkMode: ProcessForkMode) {
    const { label, memory } = options;
    // The co-resident module is the unconditional capturer and reconstructor:
    // there is no JavaScript fork engine behind it, so a missing one fails
    // loud instead of silently dropping to a path that no longer exists.
    if (!options.forkModuleModule) {
      throw new Error(`${label}: fork-instrumented worker requires the co-resident fork module`);
    }
    this.forkMode = forkMode;
    this.instance = instantiateForkModule({
      module: options.forkModuleModule,
      memory,
      reserve: options.reserve,
      label: `${label}: fork-module`,
      // This Worker's dynamic loader answers the module's request to
      // instantiate a library a peer published.
      hostImports: {
        __wpk_fork_host_materialize_dlopen_archive: (generation) =>
          this.archive?.replication.materialize(generation) ?? ENOSYS,
      },
    });
    this.backend = new ForkModuleContinuationBackend({
      instance: this.instance,
      memory,
      ptrWidth: options.ptrWidth,
      forkChild: options.forkChild,
      borrowedChild: options.borrowedChild,
      // The module maps its own arena and journal image through this
      // Worker's channel, and reads the process archive control block.
      channelBase: options.channelOffset,
      archiveControlAddr: options.archiveControlAddr,
      label: `${label}: fork-module`,
    });
    this.moduleExports = this.instance.exports;
    // The per-worker format first (it resets every activation record), then
    // activation 0's admission: every fork section of the program goes to the
    // module before instantiation, including the pointer-width check.
    this.backend.setup();
    this.backend.admitActivation(
      0,
      options.guestModule,
      computeForkModuleTemplateId(options.guestBytes),
    );
    // The module DEFINES the unwind tag; a host that minted its own would
    // disagree with the module the moment the module threw one.
    this.unwindTag = forkUnwindTagFrom(this.instance.exports, `${label} unwind`);
    this.activations = new ForkActivations(
      this.backend,
      `${label}: fork activations`,
      forkActivationCatalogSink({ functionCatalog: this.instance.functionCatalog }),
    );
    // The host's one table fact: which identity group a mutated table is. The
    // module elects the writer and owns the dirty journal.
    this.tables = new ForkTables(
      {
        markTablePages: (groupMark, firstPage, pageCount) =>
          (
            this.instance.exports.__wpk_fork_module_state_table_dirty_mark as (
              owner: number,
              first: bigint,
              count: bigint,
            ) => void
          )(groupMark, firstPage, pageCount),
      },
      `${label}: fork tables`,
    );
    this.identity = new ForkImportIdentity(
      this.backend,
      `${label}: imported activation state`,
      this.tables,
    );
    this.tableReplication = {
      generationAddress: new WebAssembly.Global(
        { value: "i64", mutable: false },
        BigInt(options.generationAddress),
      ),
    };
  }

  /** The module backend. */
  module(): ForkModuleContinuationBackend {
    return this.backend;
  }

  /** The module's phase. */
  phase(): ForkPhase {
    return forkPhase(this.moduleExports, this.options.pid);
  }

  /** What a side activation needs to route its frames to this module. */
  frameFlip(): {
    readonly moduleExports: Record<string, unknown>;
    readonly backend: ForkModuleContinuationBackend;
  } {
    return { moduleExports: this.instance.exports, backend: this.module() };
  }

  /**
   * The guest's fork imports: everything the module serves, plus the two
   * objects a JavaScript host supplies. An unbound name fails here, by name.
   */
  guestImports(): Record<string, WebAssembly.ImportValue> {
    return buildForkGuestImports({
      moduleExports: this.instance.exports as Record<string, unknown>,
      extras: {
        [FORK_GUEST_ACTIVATION_GLOBAL_IMPORT]: new WebAssembly.Global(
          { value: "i32", mutable: false },
          0,
        ),
        [FORK_GUEST_TABLE_GENERATION_ADDR_IMPORT]:
          this.tableReplication.generationAddress,
      },
      guestModule: this.options.guestModule,
      label: `${this.options.label}: fork imports`,
    }) as Record<string, WebAssembly.ImportValue>;
  }

  /**
   * Attach this Worker's dynamic loader and table replica.
   *
   * Late because of a construction cycle: the loader's imports need this
   * object's unwind tag and activation records, and a fork needs the loader's
   * archive lock.
   */
  bindArchive(dlopen: DlopenSupport, replication: ProcessTableReplicationOwner): void {
    this.archive = { dlopen, replication };
  }

  /** Remember activation 0; a `fork()` before this answers ENOSYS. */
  registerMain(instance: WebAssembly.Instance): void {
    this.activations.register({ activationId: 0, instance });
    this.mainRegistered = true;
  }

  /**
   * Take a reader token on the process archive at a generation this Worker
   * has already materialized.
   *
   * Reconciliation may instantiate a missing side module and run its start
   * function, so it needs the writer; the reader is taken after it, and a
   * publication that won the handoff race sends the loop round again. The
   * token is held from capture until the parent's replay finishes, so no
   * library can join the archive between the snapshot and the child.
   */
  private acquireArchiveReader(): void {
    const archive = this.archive;
    if (!archive) {
      throw new Error(`${this.options.label}: fork archive owner is not initialized`);
    }
    for (;;) {
      archive.replication.reconcileNow();
      archive.dlopen.acquireArchiveReader();
      this.readerHeld = true;
      if (archive.replication.isCurrentUnderLock()) return;
      this.releaseArchiveReader();
    }
  }

  private releaseArchiveReader(): void {
    if (!this.readerHeld) return;
    this.readerHeld = false;
    this.archive?.dlopen.releaseArchiveReader();
  }

  /** Abort a transaction the module still holds, keeping the first error. */
  private abortIfOpen(): void {
    if (this.phase() === "idle") return;
    try {
      this.module().abort();
    } catch {
      // Preserve the caller's failure; abort made the transaction unreachable
      // before attempting any cleanup.
    }
  }

  /**
   * The guest's `kernel.kernel_fork(mode)` import.
   *
   * Called twice per fork: once on the way down, where it opens a capture
   * and the guest unwinds, and once more when the replayed frames reach the
   * same call site, where it finishes the transaction and returns what
   * `fork()` returns.
   */
  kernelFork(rawMode: number): number {
    const { label } = this.options;
    if (!this.mainRegistered) return -ENOSYS;
    const mode = processForkMode(rawMode);
    if (mode === null) return -EINVAL;
    const phase = this.phase();
    if (phase === "parent-replay" || phase === "child-replay" || phase === "abort-replay") {
      if (mode !== this.forkMode) {
        throw new Error(
          `${label}: fork ${phase} mode ${mode} does not match captured mode ${this.forkMode}`,
        );
      }
      // ONE finish for every replay, and for an abort the errno and cause are
      // the ones the MODULE recorded when it began the abort, whoever began
      // it -- so no abort path can forget to say why. The parent survives and
      // `fork()` returns `-errno`, but a guest that does not check the return
      // fails somewhere else entirely, and the reason would be gone.
      let finished: { readonly errno: number; readonly cause: number };
      try {
        finished = this.module().parentFinish(phase === "abort-replay");
      } finally {
        this.releaseArchiveReader();
      }
      if (phase === "abort-replay") {
        const { errno, cause } = finished;
        const { pid } = this.options;
        const reason = FORK_ABORT_REASONS[cause] ?? `unknown abort cause ${cause}`;
        this.post({ type: "fork_aborted", pid, errno, reason });
        return -errno;
      }
      // A child's finish has already reported SYS_FORK_REPLAY_READY from
      // inside the module. A borrowed (vfork) child keeps its fork-module
      // region until its image ends: the KERNEL reclaims it then, before the
      // parent may resume (`reclaim_vfork_borrow` in crates/runtime-core).
      return this.forkResult;
    }
    if (phase !== "idle") {
      throw new Error(`${label}: fork import reached while process continuation is ${phase}`);
    }
    // A borrowed vfork child may not fork again before exec or _exit.
    if (this.options.borrowedChild) return -EAGAIN;
    this.forkMode = mode;
    try {
      this.acquireArchiveReader();
    } catch (error) {
      this.releaseArchiveReader();
      throw error;
    }
    try {
      // The module fills its merged static-root catalog itself, from each
      // activation's own, before it opens the capture.
      this.options.publishLaunchRoot(0);
      this.options.publishLaunchRoot(this.module().parentBeginCapture(this.options.channelOffset));
    } catch (error) {
      this.abortIfOpen();
      this.releaseArchiveReader();
      if (error instanceof ContinuationAllocationError) return -error.errno;
      throw error;
    }
    return 0; // ignored: the guest is unwinding
  }

  /** A live counter from the module. */
  private stat(name: ForkModuleStat): number {
    return Number(this.module().stat(name));
  }

  private post(message: WorkerToHostMessage): void {
    this.options.port.postMessage(message);
  }

  /**
   * Proof that the MODULE drove this parent's unwind: its committed-frame
   * count. Posted from the run loop as well as the tail, because on a
   * main-thread host a fork parent's tail can be torn down before it runs.
   */
  private postParentFrames(): void {
    if (this.options.forkChild) return;
    this.post({
      type: "fork_module_frames",
      pid: this.options.pid,
      frames: Number(this.backend.stat("framesCommitted")),
    });
  }

  /**
   * Seal the capture the guest just unwound into, create the child, and
   * start the parent's replay.
   *
   * A seal that fails after the frames sealed comes back null with the
   * MODULE already abort-replaying the parent; `fork()` returns `-errno` at
   * the abort finish, which reports it.
   */
  private forkFromCapture(): void {
    const sealed = this.module().sealCaptureAndSerialize();
    if (sealed !== null) {
      const { memory, channelOffset } = this.options;
      const childPid = sendForkSyscall(memory, channelOffset, this.forkMode, sealed);
      this.forkResult = childPid;
      this.module().parentReplay(childPid < 0 ? -childPid : 0);
      if (childPid < 0) return;
    }
    this.postParentFrames();
  }


  /**
   * Run a guest entry until it returns or exits, serving every fork it issues.
   *
   * `lexical` runs when no continuation is pending; `replay` re-enters the
   * guest to rewind a captured one. The fork-unwind exception is the module's
   * own tag, thrown by the guest's instrumented frames once they have
   * committed; an `unreachable` trap after `kernel_exit` recorded a status is
   * a committed exit, not a crash.
   */
  run(
    lexical: () => unknown,
    replay: () => unknown,
    exitStatus: () => number | null,
  ): ForkWorkerOutcome {
    const { label } = this.options;
    try {
      for (;;) {
        let unwound = false;
        let returned: unknown;
        try {
          returned = (this.phase() === "idle" ? lexical : replay)();
        } catch (error) {
          if (isForkUnwindException(error, this.unwindTag)) {
            unwound = true;
          } else {
            const status = exitStatus();
            if (isWasmUnreachableTrap(error) && status !== null) return { exited: status };
            throw error;
          }
        }
        const phase = this.phase();
        if (unwound && phase !== "capture") {
          throw new Error(
            `${label}: private fork-unwind exception escaped while process continuation is ${phase}`,
          );
        }
        if (phase === "capture") {
          this.forkFromCapture();
          continue;
        }
        if (phase !== "idle") {
          throw new Error(`${label}: guest entry returned while continuation is ${phase}`);
        }
        return { returned };
      }
    } catch (error) {
      this.releaseArchiveReader();
      const status = exitStatus();
      if (isWasmUnreachableTrap(error) && status !== null) return { exited: status };
      this.abortIfOpen();
      throw error;
    }
  }

  /**
   * Report proof of use and release what the Worker still holds.
   *
   * `teardown` also aborts the module's transaction and releases every
   * activation. A pthread Worker must NOT: after its `kernel_exit` its channel
   * is gone, and a module release that unmaps through it would park the
   * Worker forever. Nor does a borrowed (vfork) child, for the same reason
   * and because nothing it mapped outlives its image: the kernel reclaims
   * every mapping it made on its parent's image when that image ends.
   */
  finish(teardown: boolean): void {
    this.postParentFrames();
    if (this.options.forkChild) this.postChildProof();
    if (teardown && !this.options.borrowedChild) {
      this.module().abort();
      this.activations.clear();
    }
    this.releaseArchiveReader();
  }

  /**
   * A fork child's proof that the module rebuilt its references and rewound
   * its frames. Silent when every counter is zero, so a reference-free child
   * does not add a diagnostic that could race a consumer waiting for the
   * parent's frame count.
   */
  private postChildProof(): void {
    const pid = this.options.pid;
    const references = this.stat("referencesReconstructed");
    const exnrefs = this.stat("exnrefsReconstructed");
    const gcNodes = this.stat("gcNodesReconstructed");
    const driveSteps = this.stat("driveStepsExecuted");
    const staticRoots = this.stat("staticRootsPublished");
    if (references + exnrefs + gcNodes + driveSteps + staticRoots > 0) {
      this.post({
        type: "fork_module_references",
        pid,
        references,
        exnrefs,
        gcNodes,
        driveSteps,
        staticRoots,
      });
    }
    // A child never commits a frame, so its replayed count is the proof it
    // rewound through the module (a fork-from-thread child carries no
    // references and says nothing above).
    const frames = this.stat("framesReplayed");
    if (frames > 0) this.post({ type: "fork_module_child_frames", pid, frames });
  }
}
