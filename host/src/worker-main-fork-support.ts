/**
 * The fork half of a process Worker and of a pthread Worker, written once.
 *
 * # What is left here, and why
 *
 * Since lane F step 3c the co-resident fork module runs every fork itself: it
 * serves the guest's `kernel.kernel_fork` import (`__wpk_fork_kernel_fork`),
 * takes the process archive reader, has the guest fill its static-root
 * catalog, seals, issues SYS_FORK / SYS_VFORK, replays, and reports the
 * outcome through the kernel; `fm_run` runs the guest entry in that loop.
 * What stays in TypeScript is the host floor: instantiating the module and
 * the guest, the reference-typed `Table.set` bindings, the child's import
 * plan and install, and the guard that reads an `unreachable` trap after a
 * recorded exit as that exit. The sections below describe how this file came
 * to be.
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
  PROCESS_FORK_MODE_FORK,
  PROCESS_FORK_MODE_VFORK,
  type ProcessForkMode,
} from "./generated/abi";
import {
  buildForkGuestImports,
  FORK_GUEST_ACTIVATION_GLOBAL_IMPORT,
  FORK_GUEST_TABLE_GENERATION_ADDR_IMPORT,
  forkUnwindTagFrom,
} from "./fork-guest-imports";
import {
  type ForkModuleInstance,
  instantiateForkModule,
} from "./fork-module-instance";
import {
  FORK_RUN_KINDS,
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
  ProcessTableReplicationOwner,
} from "./worker-main";

const ENOSYS = 38;

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

/** Everything that differs between a process Worker and a pthread Worker. */
export interface ForkWorkerOptions {
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
}

/** How a guest entry ended. */
export type ForkWorkerOutcome =
  | { readonly returned: unknown }
  | { readonly exited: number };

/**
 * One Worker's fork machinery: its co-resident fork module and everything
 * the host keeps beside it.
 */
export class ForkWorker {
  private readonly backend: ForkModuleContinuationBackend;
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

  constructor(private readonly options: ForkWorkerOptions) {
    const { label, memory } = options;
    // The co-resident module is the unconditional capturer and reconstructor:
    // there is no JavaScript fork engine behind it, so a missing one fails
    // loud instead of silently dropping to a path that no longer exists.
    if (!options.forkModuleModule) {
      throw new Error(`${label}: fork-instrumented worker requires the co-resident fork module`);
    }
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
   * object's unwind tag and activation records, and the module's archive
   * reader needs the loader to materialize what peers published. The loader
   * in turn asks the MODULE whether this Worker's fork holds the archive
   * reader before it takes the writer (it would wait on itself forever):
   * the module owns that token (lane F step 3c, ruling 4).
   */
  bindArchive(dlopen: DlopenSupport, replication: ProcessTableReplicationOwner): void {
    this.archive = { dlopen, replication };
    const held = this.instance.exports.__wpk_fork_archive_reader_held;
    if (!(held instanceof WebAssembly.Global)) {
      throw new Error(`${this.options.label}: the fork module exports no archive reader state`);
    }
    dlopen.setForkReaderProbe(() => held.value !== 0);
  }

  /**
   * The guest's `kernel.kernel_fork(mode)` import: the MODULE's own export,
   * bound straight in, so no host code runs between `fork()` and the module.
   */
  kernelForkImport(): (mode: number) => number {
    const kernelFork = this.instance.exports.__wpk_fork_kernel_fork;
    if (typeof kernelFork !== "function") {
      throw new Error(`${this.options.label}: the fork module does not serve kernel_fork`);
    }
    return kernelFork as (mode: number) => number;
  }

  /**
   * Register activation 0 (the module answers a `fork()` before this with
   * ENOSYS), which also binds its entry points for `fm_run`.
   */
  registerMain(instance: WebAssembly.Instance): void {
    this.activations.register({ activationId: 0, instance });
  }

  /**
   * Run a guest entry until it returns or exits, the module serving every
   * fork it makes (`fm_run`).
   *
   * A process runs `_start` (`kind` "process"); a pthread, or a fork child of
   * one, runs its start routine through `wpk_fork_thread_entry(fnPtr, arg)`
   * ("thread"). The module picks the replay entry itself while a fork is
   * open, so a fork child starts in its replay without being told.
   *
   * The one decision left to the host is the trap guard: an `unreachable`
   * trap after `kernel_exit` recorded a status is a committed exit, not a
   * crash. Anything else propagates -- a trap, an exec retirement -- and ends
   * this Worker.
   *
   * Before it does, a fork that still holds the process archive READER gives
   * it back (`fm_abort`): the reader is the one thing a fork holds that
   * outlives this Worker, and a peer thread's loader would wait on it
   * forever. Nothing else is released here. The rest of a fork is this
   * Worker's own and ends with it, and an abort with no fork open is not
   * harmless: it frees the last completed fork's arena, which a vfork child
   * may still be reading, and a borrowed child's heap in the middle of its
   * exec retirement, which the kernel's exact old-memory fence refuses.
   */
  run(
    kind: keyof typeof FORK_RUN_KINDS,
    fnPtr: number,
    arg: number,
    exitStatus: () => number | null,
  ): ForkWorkerOutcome {
    const fmRun = this.instance.exports.fm_run as (
      kind: number,
      fnPtr: number,
      arg: number | bigint,
    ) => bigint;
    try {
      const argument = this.options.ptrWidth === 8 ? BigInt(arg) : arg;
      return { returned: fmRun(FORK_RUN_KINDS[kind], fnPtr, argument) };
    } catch (error) {
      const status = exitStatus();
      if (isWasmUnreachableTrap(error) && status !== null) return { exited: status };
      const readerHeld = this.instance.exports.__wpk_fork_archive_reader_held;
      if (readerHeld instanceof WebAssembly.Global && readerHeld.value !== 0) {
        try {
          this.module().abort();
        } catch {
          // Keep the guest's failure; the abort is cleanup.
        }
      }
      throw error;
    }
  }

  /**
   * Abort the module's transaction and release every activation, at a
   * process Worker's exit.
   *
   * A pthread Worker must NOT call this: after its `kernel_exit` its channel
   * is gone, and a module release that unmaps through it would park the
   * Worker forever. Nor does a borrowed (vfork) child, for the same reason
   * and because nothing it mapped outlives its image: the kernel reclaims
   * every mapping it made on its parent's image when that image ends. (A
   * fork's archive reader is the module's and ends with the fork, and its
   * reports go through the kernel, so neither needs a finish here.)
   */
  finish(): void {
    if (!this.options.borrowedChild) {
      this.module().abort();
      this.activations.clear();
    }
  }
}
