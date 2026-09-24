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

import type { ForkSideActivation } from "./fork-activations";
import type { ForkModuleInstance } from "./fork-module-instance";
import type { ForkResumeAssignment } from "./fork-resume-table";
import {
  ContinuationAllocationError,
  type LinkedFrameFormatDescriptor,
} from "./fork-continuation";

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
  readonly format: LinkedFrameFormatDescriptor;
  /** The guest's resume-target function ordinals, in slot order. */
  readonly catalogOrdinals: readonly number[];
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
   * The once-per-worker seed, which also RESETS every per-activation catalog --
   * so it must run before any of the `setActivation*` calls below, and exactly
   * once. A second call would silently discard their seeds.
   */
  setup(): void {
    if (this.didSetup) {
      throw new Error(`${this.label}: already set up`);
    }
    this.call(
      "fm_set_format",
      this.options.ptrWidth,
      this.options.format.fixedPrefixSize,
      this.options.archiveControlAddr ?? 0,
      this.options.channelBase ?? 0,
    );
    // The catalog is seeded AFTER the format, which resets it. Seeding first
    // would be silently discarded -- the bug the module's own reset comment
    // records having been hit on real forks. Activation 0 seeds through the
    // same entry as every dlopen side module; the module keeps one store.
    this.setActivationResumeCatalog(0, this.options.catalogOrdinals);
    this.didSetup = true;
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
   * Seed one activation's 32-byte module template id.
   *
   * The module writes a `Module` record per activation into the capture arena,
   * and that record carries this id -- so without the seed a capture refuses
   * with `EINVAL` rather than writing a record with a zero id. The bytes are
   * a hash of the module the host holds, which is why they are seeded rather
   * than computed.
   */
  setActivationTemplateId(activationId: number, templateId: Uint8Array): void {
    if (templateId.byteLength !== 32) {
      throw new Error(
        `${this.label}: activation ${activationId} template id has ` +
          `${templateId.byteLength} bytes, expected 32`,
      );
    }
    const at = this.stage(templateId, "activation template id");
    this.call("fm_set_activation_template_id", activationId, at);
  }

  /** Where the module places (or placed) a catalog in its merged table. */
  placeActivationCatalog(activationId: number, length: number): number {
    return this.call("fm_place_activation_catalog", activationId, length);
  }

  placeActivationStaticRoots(activationId: number, length: number): number {
    return this.call("fm_place_activation_static_roots", activationId, length);
  }

  /**
   * One activation's own resume-target ordinals.
   *
   * Activation 0's is what `setup()` seeds; a side module loaded by `dlopen`
   * brings its own resume targets, and its slot numbering has to match the
   * funcref table the module indexes for it. No cap: the module stores the
   * catalog on its arena and answers the channel's own errno when it cannot.
   */
  setActivationResumeCatalog(
    activationId: number,
    ordinals: readonly number[],
  ): void {
    const bytes = new Uint8Array(ordinals.length * 4);
    const view = new DataView(bytes.buffer);
    ordinals.forEach((ordinal, i) => view.setUint32(i * 4, ordinal >>> 0, true));
    const at = this.stage(bytes, `activation ${activationId} resume catalog`);
    this.call(
      "fm_set_activation_resume_catalog",
      activationId,
      at,
      ordinals.length,
    );
  }

  setHostExceptionOwner(owner: number): void {
    this.call("fm_set_host_exception_owner", owner);
  }

  /**
   * Hand the module one activation's raw GC codec section.
   *
   * The module COPIES it into an arena record during the call, so the staged
   * bytes are dead once it returns; see `stage()`.
   */
  setActivationGcCodec(activationId: number, bytes: Uint8Array): void {
    const at = this.stage(bytes, `activation ${activationId} GC codec`);
    this.call("fm_set_activation_gc_codec", activationId, at, bytes.length);
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
   * Hand the module one activation's raw import declarations: the KFIG section
   * for `space` 0, the KFIT section for 1.
   *
   * Raw and undecoded, like the two codec sections above. The module refuses a
   * malformed one HERE rather than at the capture that finally reads it.
   */
  setActivationImports(space: number, activationId: number, bytes: Uint8Array): void {
    const at = this.stage(bytes, `activation ${activationId} imports ${space}`);
    this.call("fm_set_activation_imports", space, activationId, at, bytes.length);
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
   * Hand the module one activation's raw exception codec section.
   *
   * Raw, not decoded: the module derives the tag ordinals itself. The host used
   * to decode this section to produce a `u32` array, which made it a second
   * decoder of a module-owned format.
   */
  setActivationExceptionCodec(activationId: number, bytes: Uint8Array): void {
    const at = this.stage(bytes, `activation ${activationId} exception codec`);
    this.call(
      "fm_set_activation_exception_codec",
      activationId,
      at,
      bytes.length,
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
   * root, and drive every guest `wpk_fork_unwind_begin` — one module call.
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
  parentBeginCapture(
    channelBase: number,
    arenaRoot: number,
    sides: readonly ForkSideActivation[],
  ): number {
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
      this.stageSides(sides),
      sides.length,
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
   * Each side activation carries the ONE fact the host owns: its `fixedPrefix`,
   * a static property of the module this child loaded. Its continuation root is
   * a per-fork address the parent recorded in the arena's
   * `ActivationContinuations` manifest, and the module reads that back itself.
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
    sides: readonly ForkSideActivation[],
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
      this.stageSides(sides),
      sides.length,
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
    guestExports: Record<string, unknown>,
  ): void {
    const base = this.call("fm_drive_table_base", activationId);
    const table = this.options.instance.driveTable;
    // Grow by the FULL per-activation stride, not by the highest slot this
    // activation happens to bind. The module derives every slot from
    // `fm_drive_table_base`, so a table grown to the last BOUND slot leaves the
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

  // WHAT USED TO BE HERE: `resumeSlot(activation, ordinal)`, wrapping
  // `fm_resume_slots` op 0. It answered "which slot did this ONE coordinate
  // get", because the host placed each thunk itself. Placement asks for a
  // whole activation at once now, so it had no production caller, and the
  // module arm behind it is deleted in the same change -- a wrapper kept past
  // the entry it wraps is how a host surface outlives its reason.

  /**
   * Publish one activation's WHOLE `(ordinal, slot)` assignment, for the guest
   * shim to apply.
   *
   * This is the host's entire remaining part in placement. The module decides
   * every slot when the catalog is seeded and writes the decision into a
   * buffer in the memory the co-resident guest shares; the guest's own
   * `__wpk_fork_place_resume_thunks` then copies each thunk out of its catalog
   * table into the process resume table. Neither the pointer nor a single
   * thunk crosses into JavaScript.
   *
   * What it replaces is one `fm_resume_slots` op-0 call plus a
   * `table.get`/`table.set` pair PER FORK-INSTRUMENTED FUNCTION -- 19,025
   * crossings per php process start, the figure `docs/surface-budget.json`
   * records -- with one call.
   *
   * NOTHING IS DECODED HERE. This used to walk the buffer and copy out each
   * record's slot, because `ForkResumeTable` had to null exactly those entries
   * when `dlclose` released them. The module nulls them itself now, so the
   * pair of numbers passes straight through and the host never learns which
   * slots an activation got -- which is also why there is no stale-view
   * hazard left to warn about: there is one published buffer per worker and
   * the next publish overwrites it, and nothing on this side holds a view of
   * it past the call.
   */
  publishResumeAssignment(activationId: number): ForkResumeAssignment {
    // `call()` cannot carry this one: it is typed `number` and this export
    // returns `i64`, which reaches JavaScript as a `bigint`. The errno check
    // is therefore repeated here rather than shared. Written tight, and the
    // throw as one expression, for the reason `call()` gives about itself:
    // this surface's ceiling has no slack, so every line has to earn itself.
    const packed = (this.exports.fm_publish_resume_assignment as (a: number) => bigint)(activationId);
    if (packed === -1n) throw new Error(`${this.label}: fm_publish_resume_assignment failed for activation ${activationId} with errno ${this.lastErrno()}`);
    // COUNT HIGH, POINTER LOW, as the export's own doc comment gives it: a
    // pointer in the high half would make any buffer above 2 GiB decode as a
    // negative i64, which is this call's failure signal.
    return { ptr: Number(packed & 0xffff_ffffn), count: Number(packed >> 32n) };
  }

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
   * Stage a side-activation list as `(id, fixedPrefix)` u32 pairs.
   *
   * The SAME layout serves capture and child seed, because the host owns the
   * same one fact in both: `fixedPrefix`, a static property of the loaded
   * module. Everything else about a side activation -- above all its per-fork
   * continuation root -- the module recorded itself and reads back itself.
   * Where the pairs are written is this wrapper's business, not the caller's.
   */
  private stageSides(sides: readonly ForkSideActivation[]): number {
    if (sides.length === 0) return 0;
    const bytes = new Uint8Array(sides.length * 8);
    const view = new DataView(bytes.buffer);
    sides.forEach((side, index) => {
      view.setUint32(index * 8, side.id >>> 0, true);
      view.setUint32(index * 8 + 4, side.fixedPrefix >>> 0, true);
    });
    return this.stage(bytes, `${sides.length} side activation(s)`);
  }

  /**
   * Copy `bytes` to the start of the module's staging slab and return their
   * address. VALID UNTIL THE NEXT STAGE, whoever makes it.
   *
   * One lifetime, not two. The slab used to be a bump cursor with a per-fork
   * rewind mark, because the module kept the POINTER to every durable seed
   * (a catalog, a codec, a section) and read it back at every later fork --
   * so a seed had to stay put for the life of the worker, and only the two
   * per-fork stages could be reused. The module keeps a COPY of every seed
   * now: catalogs, codecs and sections go into its own arena records and the
   * template id into its own table, all during the entry that seeds them.
   * Nothing outlives its call, so nothing needs a cursor, and the slab
   * only has to hold the LARGEST single request rather than the sum of every
   * activation's seeds -- which is what `STAGING_SLAB_BYTES` is sized from.
   *
   * `host/test/fork-arena-release.test.ts` is where the copy is proven: it
   * seeds a GC codec and then an exception codec over the same staging page,
   * and the module still answers from the codec's own bytes.
   *
   * Overflow is an error rather than a truncation, because a truncated
   * section would be refused by the module's decoder at best and seed a wrong
   * one at worst; the message carries both sizes so the boundary is readable.
   */
  private stage(bytes: Uint8Array, what: string): number {
    const at = this.options.instance.stagingBase;
    const limit = this.options.instance.stagingBytes;
    if (bytes.length > limit) {
      throw new Error(
        `${this.label}: staging slab exhausted placing ${what} ` +
          `(${bytes.length} bytes against a ${limit}-byte slab)`,
      );
    }
    new Uint8Array(this.options.memory.buffer).set(bytes, at);
    return at;
  }
}
