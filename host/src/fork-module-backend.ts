/**
 * The host's calls into the co-resident fork module, for both JS hosts.
 *
 * This replaces a 1239-line wrapper that predated most of what the module can
 * now do. Two things shrank it.
 *
 * The module folded eleven `fm_*` counter exports into one `fm_stats(field)`;
 * the host wrapper kept eight one-line accessors over it, so reading a counter
 * cost a method here AND a field constant. One `stat()` replaces them, and the
 * field numbering lives next to the module's own array.
 *
 * And half of the old wrapper served callers that are no longer here: the
 * capture/replay orchestration the module took over. Methods are added back when
 * a caller needs one, not in anticipation.
 *
 * Every call reports through `fm_last_errno`, so every wrapper checks it. A
 * module entry that failed silently would surface as a wrong fork much later.
 */

import type { ForkActivationRow } from "./fork-activations";
import type { ForkModuleInstance } from "./fork-module-instance";
import { ContinuationAllocationError } from "./fork-continuation";
import {
  encodeForkAdmission,
  FORK_ADMISSION_BORROWED_CHILD,
  FORK_ADMISSION_FORK_CHILD,
} from "./fork-guest-sections";

/**
 * Field indices into the module's `fm_stats` array, in its order.
 *
 * DUPLICATED from the `stats` array in `crates/fork-module/src/lib.rs`. Reading
 * the wrong index returns a plausible number from the wrong counter, which is a
 * wrong diagnostic rather than an error -- so `host/test/fork-module-backend.test.ts`
 * pins these against that array.
 */
export const FORK_MODULE_STATS = [
  "framesCommitted",
  "framesReplayed",
  "referencesReconstructed",
  // Retired: it counted host externrefs a fork reconstructed, and a fork
  // carries none since externref stage E2. Kept so later indices hold.
  "retiredExternrefsResolved",
  "exnrefsReconstructed",
  "gcNodesReconstructed",
  "staticRootsPublished",
  "driveStepsExecuted",
  "referenceFeedReads",
  "referenceGraphsDecoded",
  "externrefHandlesScanned",
] as const;

/**
 * The backend, or a loud failure naming what was missing.
 *
 * The handle is nullable everywhere in the worker, and every fork path that
 * reaches these calls has one by construction — a fork only gets here having
 * instantiated the module. A bare `!` would be right and would also mean that
 * if the impossible ever happened, the failure would name a JavaScript property
 * rather than the thing that was absent.
 *
 * One guard rather than one per call site: this replaced a
 * `borrowedReplayWorkspaceOf` that did the same job for exactly one method,
 * which stopped being the right shape as soon as a second caller needed it.
 */
export function requireForkModuleBackend(
  backend: ForkModuleContinuationBackend | null,
  pid: number,
): ForkModuleContinuationBackend {
  if (backend === null) {
    throw new Error(`pid=${pid}: this fork path needs a fork-module backend`);
  }
  return backend;
}

/** Sizes a vfork BORROWED child's host-reserved private workspace. */
export interface ForkBorrowedReplayWorkspace {
  readonly prefixBytes: number;
  readonly scratchBytes: number;
}

export type ForkModuleStat = (typeof FORK_MODULE_STATS)[number];

/** `ENOMEM`: the module could not get memory, which a fork survives. */
const FORK_MODULE_ENOMEM = 12;

/**
 * One activation's guest exports, bound into the module's drive table so the
 * module can `call_indirect` them.
 *
 * Each entry is `[slot offset, guest export name]`. The offsets are
 * DUPLICATED from `crates/fork-codec/src/drive_plan.rs`, and binding the wrong
 * one makes the module call the wrong guest function with the right-looking
 * arguments -- a silent wrong answer, so `host/test/fork-module-backend.test.ts`
 * pins them against that file.
 *
 * This replaces `forkGcCodecProviderFromInstance`, which bound the same exports
 * into a JavaScript object the host then called. The module calls them now, so
 * the host only has to put them somewhere the module can reach.
 */
export interface ForkActivationDriveBinding {
  /** Slot offset within the activation's slice, from `fork-codec`'s drive plan. */
  readonly slot: number;
  /** The guest export bound there. */
  readonly name: string;
  /**
   * Whether a fork-instrumented guest must export it.
   *
   * The unwind/rewind/abort quartet is emitted by the instrumentation runtime
   * for every fork-capable guest, so a missing one is a broken artifact and has
   * to fail loudly -- the module WILL drive that slot, and an unbound slot is a
   * `call_indirect` on null.
   *
   * The module-state restore pair is required for the same reason, and the
   * binding it replaces said so explicitly: restore and finish reconstruct an
   * activation's global and table state, which exists even for an activation
   * carrying no references at all, so every activation the attach plan
   * enumerates must have them bound.
   *
   * The rest are conditional on what the guest actually contains: no typed-GC
   * codec means no allocate/fill, and no exception codec means no materialize.
   * The module emits no step for what a guest does not have, so an unbound
   * optional slot is never driven.
   */
  readonly required: boolean;
}

export const FORK_ACTIVATION_DRIVE_BINDINGS: readonly ForkActivationDriveBinding[] = [
  { slot: 0, name: "__wpk_fork_ref_gc_allocate", required: false },
  { slot: 1, name: "__wpk_fork_ref_gc_fill", required: false },
  { slot: 2, name: "__wpk_fork_exception_materialize", required: false },
  { slot: 3, name: "wpk_fork_module_state_restore", required: true },
  { slot: 4, name: "wpk_fork_module_state_finish_restore", required: true },
  { slot: 5, name: "wpk_fork_rewind_begin", required: true },
  { slot: 6, name: "wpk_fork_abort_begin", required: true },
  { slot: 7, name: "wpk_fork_unwind_end", required: true },
  { slot: 8, name: "wpk_fork_rewind_end", required: true },
  { slot: 9, name: "wpk_fork_abort_end", required: true },
  { slot: 10, name: "wpk_fork_unwind_begin", required: true },
  { slot: 11, name: "__wpk_fork_ref_gc_encode_slot", required: false },
  { slot: 12, name: "__wpk_fork_ref_gc_probe", required: false },
  { slot: 13, name: "wpk_fork_module_state_save", required: true },
  // The peer-table checkpoint's save walk. Not required: a guest built
  // without dylink support has no table state to publish.
  { slot: 14, name: "wpk_fork_module_table_state_save", required: false },
  // The activation's own tagged thrower, so the MODULE can ask whichever
  // activation owns an exception recipe to raise it. Not required: a guest with
  // no exception codec has no tags to raise and exports no thrower.
  { slot: 15, name: "__wpk_fork_ref_exn_throw_recipe", required: false },
  // The guest's own table shims: the module reads and writes a guest table
  // only by calling these, never by holding the table.
  { slot: 16, name: "wpk_fork_module_table_read", required: true },
  { slot: 17, name: "wpk_fork_module_table_length", required: true },
  { slot: 18, name: "wpk_fork_module_table_apply", required: true },
] as const;

/** Selectors for `fm_decoded_node_field`, in the module's `match` order. */
const DECODED_FIELD_KIND = 0;
const DECODED_FIELD_MODULE_ACTIVATION = 1;

export interface ForkModuleBackendOptions {
  readonly instance: ForkModuleInstance;
  readonly memory: WebAssembly.Memory;
  readonly ptrWidth: 4 | 8;
  /** This worker is a fork child, and (`borrowedChild`) a vfork borrowed one. */
  readonly forkChild?: boolean;
  readonly borrowedChild?: boolean;
  /**
   * The dlopen control address, or 0 when there is no archive. A borrowed
   * vfork child passes its OWNER's: it has no control block of its own.
   */
  readonly archiveControlAddr?: number;
  /**
   * This worker's syscall channel base. Publishing a table patch allocates its
   * record with SYS_MMAP through the same channel the guest uses, so the module
   * needs it -- and a borrowed fork child cannot derive it from the archive
   * control address, which belongs to its owner.
   */
  readonly channelBase?: number;
  readonly label?: string;
}

export class ForkModuleContinuationBackend {
  private readonly label: string;
  private didSetup = false;

  /** Read lazily: the constructor touches no export. */
  private get exports(): Record<string, (...args: never[]) => unknown> {
    return this.options.instance.exports as Record<
      string,
      (...args: never[]) => unknown
    >;
  }

  constructor(private readonly options: ForkModuleBackendOptions) {
    this.label = options.label ?? "fork-module backend";
  }

  /** The errno the last module call reported. */
  lastErrno(): number {
    return (this.exports.fm_last_errno as () => number)();
  }

  private call(name: string, ...args: (number | bigint)[]): number {
    const fn = this.exports[name] as
      | ((...a: (number | bigint)[]) => number)
      | undefined;
    if (fn === undefined) {
      throw new Error(`${this.label}: fork-module exports no ${name}`);
    }
    const result = fn(...args);
    const errno = this.lastErrno();
    if (errno !== 0) {
      // EBUSY (16) from a phase entry means the module was in a DIFFERENT phase
      // than the entry requires, and WHICH phase is the whole diagnosis --
      // "errno 16" alone leaves a reader six to guess between, which cost an
      // afternoon on the externref fork (census section 188). The module
      // answers it, so say it. Written as one expression deliberately: this
      // surface's ceiling equals its target, so a diagnostic pays for itself
      // in lines or it does not land.
      throw new Error(`${this.label}: ${name} failed with errno ${errno}${errno === 16 ? ` in module phase ${(this.exports.fm_phase as () => number)()}` : ""}`);
    }
    return result;
  }

  /**
   * The once-per-worker format seed, which also RESETS every per-activation
   * record -- so it must run before any `admitActivation`, and exactly once. A
   * second call would silently discard their admissions.
   *
   * The fixed-prefix argument is 0: the host no longer decodes the linked-frame
   * section, and activation 0's admission supplies the prefix instead. Stage 1d
   * takes the argument (and the pointer width) out of this call.
   */
  setup(): void {
    if (this.didSetup) {
      throw new Error(`${this.label}: already set up`);
    }
    this.call(
      "fm_set_format",
      this.options.ptrWidth,
      0,
      this.options.archiveControlAddr ?? 0,
      this.options.channelBase ?? 0,
    );
    this.didSetup = true;
  }

  /**
   * Admit one activation, before its instantiation: every `kandelo.wpk_fork.*`
   * section of `module`, located and copied verbatim, plus the facts only the
   * host has -- the activation id, this worker's fork-child flags and the
   * template id (the SHA-256 of the module's bytes). The module decodes and
   * validates every section here, so a malformed one is refused at admission
   * rather than at the capture that would finally read it.
   *
   * Re-admitting identical facts is a no-op in the module, which is what lets a
   * fork child admit every archived activation up front and its dlopen replay
   * admit each one again.
   */
  admitActivation(activationId: number, module: WebAssembly.Module, templateId: Uint8Array): void {
    const flags = (this.options.forkChild ? FORK_ADMISSION_FORK_CHILD : 0)
      | (this.options.borrowedChild ? FORK_ADMISSION_BORROWED_CHILD : 0);
    const desc = encodeForkAdmission(activationId, flags, templateId, module);
    // The module releases a buffer it mapped for this (`stage`) as it returns.
    this.call("fm_admit_activation", this.stage(desc), desc.length);
  }

  /**
   * Place an admitted, now instantiated, activation and read the module's row:
   * its drive base, its two merged-catalog bases and its published resume
   * assignment. Read out at once, because the module rewrites the row -- and
   * the assignment buffer it points at -- on the next bind.
   */
  bindActivation(activationId: number, funcCatalogLength: number, staticRootLength: number): ForkActivationRow {
    const at = this.call("fm_bind_activation", activationId, funcCatalogLength, staticRootLength);
    const [driveBase, funcCatalogBase, staticRootBase, ptr, count] =
      new Uint32Array(this.options.memory.buffer.slice(at, at + 20));
    return { driveBase: driveBase!, funcCatalogBase: funcCatalogBase!, staticRootBase: staticRootBase!, resume: { ptr: ptr!, count: count! } };
  }

  /**
   * One module counter, by name rather than by a method each.
   *
   * No local "is that a real field?" check: `fm_stats` answers -1 for a field it
   * does not have, and the module is the authority on which fields exist.
   * Checking first here would be a second opinion on the same question, which is
   * the duplication this lane has been removing everywhere else.
   */
  stat(name: ForkModuleStat): bigint {
    const field = FORK_MODULE_STATS.indexOf(name);
    const value = (this.exports.fm_stats as (f: number) => bigint)(field);
    if (value < 0n) {
      throw new Error(`${this.label}: fm_stats rejected field ${field} (${name})`);
    }
    return value;
  }

  /**
   * Child-private workspace a vfork BORROWED child needs, sized by the module.
   *
   * Ported out of the JS coordinator, which reached into each activation's
   * frame format for its fixed prefix and into the capture session for the
   * scratch high-water -- per-activation module state and the module's own
   * allocator, read through a JS mirror of both. The module walks its own
   * activations now; this is the read.
   *
   * Legal only once the capture has sealed. The module answers `EBUSY` off
   * phase rather than an undercount, because before the seal the activation set
   * is still growing and the scratch high-water has not peaked -- and an
   * undersized reservation means one activation's rewind writing into another's
   * prefix, which is silent.
   */
  borrowedReplayWorkspace(): ForkBorrowedReplayWorkspace {
    const read = (field: number): number => {
      const value = Number(
        (this.exports.fm_borrowed_replay_workspace as (f: number) => bigint)(
          field,
        ),
      );
      if (value < 0) {
        throw new Error(
          `${this.label}: fm_borrowed_replay_workspace rejected field ${field}`,
        );
      }
      return value;
    };
    return { prefixBytes: read(0), scratchBytes: read(1) };
  }

  /**
   * Publish which `(activation, owner)` coordinate WRITES a physical table's
   * sparse state, which the module then serves to the guest's
   * `__wpk_fork_module_state_table_state_owned` import.
   *
   * Imported aliases name one `WebAssembly.Table`, and only the canonical
   * coordinate writes its state; the others still contribute mutation marks.
   * Deciding which is canonical is host floor -- it compares Table OBJECT
   * IDENTITY, which wasm cannot observe -- and `ForkTableStateOwners` makes
   * that decision. This is only the wire it leaves on.
   */
  setActivationTableStateOwner(
    activationId: number,
    ownerId: number,
    owns: boolean,
  ): void {
    this.call(
      "fm_set_activation_table_state_owner",
      activationId,
      ownerId,
      owns ? 1 : 0,
    );
  }

  /**
   * Tell the module that one catalog entry is the object `groupId` names.
   *
   * Entries sharing a group are one `WebAssembly.Global` or `WebAssembly.Table`.
   * The host assigns the ids because only JavaScript can compare object
   * identity; which member PROVIDES the object is the module's election, since
   * that needs the KFIG/KFIT sections it is seeded with.
   */
  setIdentityGroup(
    space: number,
    activationId: number,
    ownerId: number,
    groupId: number,
  ): void {
    this.call("fm_set_identity_group", space, activationId, ownerId, groupId);
  }

  /**
   * Tell the module what one imported global or table turned out to be.
   *
   * `BASE_IMPORT` is not a kind a host may publish: it asserts that no
   * activation provides the object, which is the election's conclusion.
   */
  setImportProvenance(
    space: number,
    consumerActivation: number,
    importOrdinal: number,
    kind: number,
    groupId: number,
    rawBits: bigint,
  ): void {
    this.call(
      "fm_set_import_provenance",
      space,
      consumerActivation,
      importOrdinal,
      kind,
      groupId,
      rawBits,
    );
  }

  /**
   * Open this fork's reference-capture builder (`fm_capture_begin`).
   *
   * The first module call of a capture fork, issued before the guest unwinds:
   * it is the fork's single bump-heap reset point, and it seeds the capture
   * graph (recipe 0 is the canonical null). It reports no errno, so there is
   * nothing to check.
   */
  captureBegin(): void {
    (this.exports.fm_capture_begin as () => void)();
  }

  /**
   * Open this fork's capture: register the activations, publish each one's arena
   * root, and drive every guest `wpk_fork_unwind_begin` — one module call. The
   * activations are the ones this worker registered, which the module knows as
   * the ones it BOUND (`bindActivation`), so nothing about them is passed in.
   *
   * `0` for the arena root asks the module to allocate its own and declare the
   * activation set into it. A caller that brings its own root keeps the older
   * contract, which is what `crates/host-native` still does.
   *
   * Returns activation 0's module-buffer anchor, which the host publishes as the
   * process launch root. A side activation's anchor never reaches the host: the
   * module records every activation's root in the continuation manifest it
   * writes into the arena at seal.
   */
  parentBeginCapture(channelBase: number, arenaRoot: number): number {
    // AN ALLOCATION FAILURE HERE IS A FORK THAT ABORTS, NOT A WORKER THAT
    // DIES. Opening a capture channel-mmaps the arena's first chunk, and under
    // memory exhaustion that fails with ENOMEM -- which is the case
    // `p_11_fork_continuation_enomem` exists to prove survivable: `fork()`
    // returns `-ENOMEM`, no child is created, and the parent runs on.
    //
    // It was not survivable, because this threw a plain Error. The fork
    // handler's catch distinguishes `ContinuationAllocationError` from every
    // other failure precisely so an allocation failure can become an errno,
    // and anything else can still be fatal; `sealCaptureAndSerialize` has
    // thrown the typed error for the same reason since it was written. Nothing
    // has unwound yet at this point, so there are no frames to replay and no
    // capture to seal -- the errno is the whole of the abort.
    const root = (this.exports.fm_parent_begin_capture as (...a: number[]) => number)(
      channelBase,
      arenaRoot,
    );
    const errno = this.lastErrno();
    if (errno === FORK_MODULE_ENOMEM) {
      throw new ContinuationAllocationError(
        errno,
        0,
        `${this.label}: fm_parent_begin_capture could not allocate (errno ${errno})`,
      );
    }
    if (errno !== 0) {
      throw new Error(
        `${this.label}: fm_parent_begin_capture failed with errno ${errno}`,
      );
    }
    return root;
  }

  /**
   * Install this fork's child: SEED every activation's replay driver from the
   * inherited journal image, then seed the reference replay from the inherited
   * arena, admit its exnref tags, and build the whole reconstruction plan.
   *
   * Both module calls, in this order, because they are one arrival at the
   * child-replay phase and the install plan's restore/finish tail is built per
   * activation -- so the activations must exist before the plan is built.
   * WITHOUT THE SEED THE CHILD HAS NO MODULE STATE AT ALL: every
   * `__wpk_fork_module_state_record_find` the guest's restore makes answers 0,
   * which the guest reads as a page header at address 0 and traps on. The
   * seed's only caller was the fork coordinator; census 183.
   *
   * The side activations are the ones this child registered -- the ones the
   * module bound -- so it knows them without being told: each one's fixed
   * prefix is its admission's, and
   * its continuation root is a per-fork address the parent recorded in the
   * arena's `ActivationContinuations` manifest, which the module reads back
   * itself.
   *
   * ONE call for both child shapes. A COW child and a vfork BORROWED child
   * share an identical install plan -- the only borrowed-specific work is the
   * host-side child-private replay-prefix reservation, which is raw memory
   * placement carrying no reference values and never entered the module.
   *
   * Returns the plan's guest address; drive it with `driveRestoredPlan`. The
   * step count comes from the module rather than the caller, so the two cannot
   * disagree about how much of the plan to run.
   */
  installChild(
    moduleStateRoot: number,
    act0Root: number,
    pid: number,
    /**
     * A vfork BORROWED child's admitted replay workspace: where the kernel put
     * it and how big it is. That is the whole of what a host knows about it and
     * the module cannot derive. The module carves each activation's private
     * prefix out of it, using the same walk it already reports the total for
     * through `fm_borrowed_replay_workspace` -- so the host does not run that
     * arithmetic a second time to hand the answers back.
     */
    borrowed?: { readonly prefixBase: number; readonly prefixBytes: number },
  ): number {
    if (borrowed) {
      this.call(
        "fm_set_borrowed_workspace",
        borrowed.prefixBase,
        borrowed.prefixBytes,
      );
    }
    this.call(
      borrowed ? "fm_child_seed_borrowed" : "fm_child_seed",
      moduleStateRoot,
      act0Root,
    );
    return this.call("fm_attach_child", moduleStateRoot, pid);
  }

  /**
   * Execute a reconstruction plan the module built.
   *
   * The injected shim `call_indirect`s each step through the drive table, so
   * every slot the plan references must be bound first -- see
   * `bindActivationDrive`. An unbound slot is a call on null, not a skipped
   * step.
   */
  driveRestoredPlan(planPtr: number): void {
    const count = Number((this.exports.fm_gc_plan_count as () => number)());
    if (count < 0) {
      throw new Error(`${this.label}: fm_gc_plan_count reported ${count}`);
    }
    if (count === 0) return;
    (this.exports.fm_drive_execute as (p: number, n: number) => void)(
      planPtr,
      count,
    );
  }


  /**
   * Seal a PARTIAL capture for abort, without the guest unwind-end drive or the
   * journal serialization a normal seal does.
   *
   * The mid-unwind failure path: a frame reserve came back 0, so the capture
   * cannot complete, but a failed reserve leaves no pending frame — the
   * committed chain is whole and seal-able. Sealing it moves the module to
   * sealed-parent so the abort replay can run over the frames that did commit,
   * and the parent survives with `fork()` returning -errno.
   *
   * Distinct from `sealCaptureAndSerialize` precisely because it must NOT drive
   * the guest's `wpk_fork_unwind_end`: the guest is still mid-unwind, and
   * driving it there corrupts the unwind state machine.
   */
  parentAbortSeal(): void {
    this.call("fm_parent_abort_seal");
  }

  /**
   * Begin the parent's replay, or its abort replay when `abort` is set.
   *
   * Drives each activation's `wpk_fork_rewind_begin` / `wpk_fork_abort_begin`
   * from the module rather than a host loop.
   */
  parentReplay(abort: boolean): void {
    this.call("fm_parent_replay", abort ? 1 : 0);
  }

  /**
   * End the parent's replay: drive each activation's `wpk_fork_rewind_end` (or
   * `wpk_fork_abort_end`), finish the journal, and release this fork's
   * channel-mapped chunks.
   */
  parentFinish(abort: boolean): void {
    this.call("fm_parent_finish", abort ? 1 : 0);
  }

  /**
   * Abandon whatever this fork had open and return the module to idle.
   *
   * Best effort by design — it is the teardown path for a capture that failed
   * part-way, so it must not itself fail and strand the module mid-phase.
   */
  abort(): void {
    this.call("fm_abort");
  }

  /**
   * Seal this fork's capture and serialize the child-inheritable journal image.
   *
   * A failure here is a TYPED `ContinuationAllocationError`, not a generic
   * throw: the coordinator distinguishes "the module could not allocate" from
   * every other failure, and a generic error at this point traps the worker
   * instead of aborting the fork truthfully.
   */
  sealCaptureAndSerialize(): { readonly ptr: number; readonly len: number } {
    const seal = this.exports.fm_parent_seal_capture as (base: number) => number;
    const ptr = Number(seal(this.options.channelBase ?? 0));
    const errno = this.lastErrno();
    if (errno !== 0) {
      throw new ContinuationAllocationError(
        errno,
        0,
        `${this.label}: fm_parent_seal_capture failed with errno=${errno}`,
      );
    }
    const len = Number((this.exports.fm_journal_image_len as () => number)());
    if (!Number.isSafeInteger(ptr) || ptr <= 0 || !Number.isSafeInteger(len) || len <= 0) {
      throw new Error(
        `${this.label}: seal returned an invalid journal image (ptr ${ptr}, len ${len})`,
      );
    }
    return { ptr, len };
  }

  /**
   * Bind one activation's typed-reference guest exports into the module's drive
   * table, so the module can drive allocation, filling, exception
   * materialization, probing and encoding without importing them.
   *
   * A reference-typed `Table.set` is a host floor: Rust cannot hold a funcref.
   * Everything else about the drive -- the order, the plan, the transit asserts
   * -- is the module's.
   */
  bindActivationDrive(
    activationId: number,
    base: number,
    guestExports: Record<string, unknown>,
  ): void {
    const table = this.options.instance.driveTable;
    // Grow by the FULL per-activation stride, not by the highest slot this
    // activation happens to bind. The module derives every slot from the
    // drive base (`fm_bind_activation`'s row), so a table grown to the last BOUND slot leaves the
    // tail of the slice off the end of the table -- and the next activation's
    // base is past it. Growing to the stride makes the slice exist whether or
    // not this guest fills all of it.
    // One slot per binding: the bindings cover the whole stride, which
    // `host/test/fork-module-backend.test.ts` pins against fork-codec's
    // `DRIVE_SLOTS_PER_ACTIVATION`, so the host keeps no hand-written copy of
    // the stride to drift from it.
    const needed = base + FORK_ACTIVATION_DRIVE_BINDINGS.length;
    if (table.length < needed) table.grow(needed - table.length);
    for (const { slot, name, required } of FORK_ACTIVATION_DRIVE_BINDINGS) {
      const fn = guestExports[name];
      if (typeof fn !== "function") {
        if (!required) continue;
        throw new Error(
          `${this.label}: activation ${activationId} exports no ${name}; the ` +
            `module drives that slot on every fork, so an unbound one is a ` +
            `call_indirect on null rather than a missing feature`,
        );
      }
      table.set(base + slot, fn);
    }
  }

  /**
   * Seed the replay driver from a sealed arena and build its install plan.
   *
   * Distinct from `attachChild`: this appends NO guest restore/finish steps,
   * because a peer-table install is single-phase -- there is no child being
   * reconstructed, only this worker's tables catching up to a peer's
   * publication.
   */
  restoreFromArena(moduleStateRoot: number, pid: number): number {
    return this.call("fm_restore_from_arena", moduleStateRoot, pid);
  }

  /** Make a child's decoded reference graph resident for the accessors below. */
  decodeReferenceGraph(moduleStateRoot: number): void {
    this.call("fm_decode_reference_graph", moduleStateRoot);
  }

  // WHAT USED TO BE HERE: `moduleStateArenaRoot`, which read
  // `fm_module_state_arena` operation 0 (an entry since deleted) so the host
  // could tell the exception broker which arena's graph answers "who owns this
  // recipe" -- the module's own root first, the inherited one as a fallback. The module makes that
  // choice itself now: it remembers the root of its most recent replay, which
  // is the same arena by construction. Its last caller went with the broker
  // (census 192), and a method the host keeps for nobody is host surface.

  // WHAT USED TO BE HERE: `publishResumeAssignment`, and before it
  // `resumeSlot`. Placement asks for a whole activation's `(ordinal, slot)`
  // decision at once, and since lane F stage 1b it arrives in the
  // `fm_bind_activation` row with the activation's other bases.

  /**
   * Release everything the module holds for an activation -- resume slots,
   * records, table ranges -- so its id can be reused. `unplaced` for one whose
   * thunks were never placed (a `dlopen` that failed part way). Returns how
   * many resume slots were freed.
   */
  releaseResumeSlots(activationId: number, unplaced = false): number {
    return this.call("fm_resume_slots", unplaced ? 2 : 1, activationId, 0);
  }

  // WHAT USED TO BE HERE: `decodedNodeCount` and `decodedNodeOrdinal`. Their
  // only caller was the child-install path's second merged static-root base
  // map, which walked every node to find the static roots and took each
  // activation's maximum ordinal. That layout is settled once at registration
  // now (census 201), so nothing counts nodes or reads an ordinal from the
  // host any more. `fm_decoded_node_field` is still reached, for kind and
  // module_activation, by `ForkChildReferences`.

  decodedNodeKind(index: number): number {
    return this.call("fm_decoded_node_field", index, DECODED_FIELD_KIND);
  }

  decodedNodeModuleActivation(index: number): number {
    return this.call(
      "fm_decoded_node_field",
      index,
      DECODED_FIELD_MODULE_ACTIVATION,
    );
  }

  /**
   * Build one child activation's import plan and return its entry count.
   *
   * The activation's KFIG/KFIT sections must already be seeded. An activation
   * that declared neither plans 0 imports, which is the ordinary single-module
   * case rather than an error.
   */
  /**
   * Capture a PEER-TABLE checkpoint into a fresh module-owned arena.
   *
   * Returns the arena root the dlopen loader publishes. The arena outlives this
   * call -- peers read it -- so nothing here releases it.
   */
  capturePeerTables(channelBase: number): number {
    const root = this.call("fm_capture_peer_tables", channelBase);
    if (root === 0) {
      throw new Error(`${this.label}: peer-table capture produced no arena`);
    }
    return root;
  }

  childImportPlan(activation: number, moduleStateRoot: number): number {
    return this.call("fm_child_import_plan", activation, moduleStateRoot);
  }

  /**
   * One field of the resident plan's entry at `index`.
   *
   * Not routed through `call`, which narrows to `number`: field 5 is a 64-bit
   * PATTERN -- raw global bits, a recipe id or a saved scalar -- and narrowing
   * it would lose the low bits of an i64. For the same reason `-1` is a legal
   * result here, so failure is read from `fm_last_errno` rather than from the
   * value.
   */
  childImportPlanField(index: number, field: number): bigint {
    const read = this.exports.fm_child_import_plan_field as
      (i: number, f: number) => bigint;
    const value = read(index, field);
    const errno = this.lastErrno();
    if (errno !== 0) {
      throw new Error(
        `${this.label}: fm_child_import_plan_field(${index}, ${field}) ` +
          `failed with errno ${errno}`,
      );
    }
    return value;
  }

  /**
   * Stage one activation's admission descriptor and return its address:
   * the start of the module's staging slab, or -- for a descriptor larger
   * than the slab -- a buffer the module maps to its size. VALID UNTIL THE
   * NEXT STAGE, whoever makes it. An admission is the only thing a host
   * stages; the side-activation list the capture and child seeds used to
   * read went in lane F stage 1d, when the module began walking the
   * activations it had admitted.
   *
   * One lifetime, not two. The slab used to be a bump cursor with a per-fork
   * rewind mark, because the module kept the POINTER to every durable seed
   * (a catalog, a codec, a section) and read it back at every later fork --
   * so a seed had to stay put for the life of the worker, and only the two
   * per-fork stages could be reused. The module keeps a COPY of every seed
   * now: catalogs, codecs and sections go into its own arena records and the
   * template id into its own table, all during the entry that seeds them.
   * Nothing outlives its call, so nothing needs a cursor, and the slab
   * only has to hold one request at a time rather than the sum of every
   * activation's seeds. An admission larger than the slab goes to a buffer
   * the module maps to its size (`fm_admission_buffer`) and releases as
   * `fm_admit_activation` returns, accepted or refused, so nothing is ever
   * truncated.
   *
   * `host/test/fork-arena-release.test.ts` is where the copy is proven: it
   * admits codecs and sections over the same staging page, and the module
   * still answers from its own copies of their bytes.
   */
  private stage(bytes: Uint8Array): number {
    const limit = this.options.instance.stagingBytes;
    const at = bytes.length > limit ? this.call("fm_admission_buffer", bytes.length) >>> 0 : this.options.instance.stagingBase;
    new Uint8Array(this.options.memory.buffer).set(bytes, at);
    return at;
  }
}
