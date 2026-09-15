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
  "externrefsResolved",
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

/**
 * The module's resume-catalog capacity, in ordinals.
 *
 * DUPLICATED from `RESUME_CATALOG_CAP` in `crates/fork-module/src/lib.rs`, whose
 * comment names THIS file as its counterpart -- the module sizes a static
 * `[u32; CAP]` arena from it, so a host that staged more would be writing past
 * the end of it. Pinned against that constant by
 * `host/test/fork-module-backend.test.ts`.
 */
export const FORK_MODULE_RESUME_CATALOG_CAP = 65_536;

/**
 * Drive-table slots reserved per activation.
 *
 * DUPLICATED from `DRIVE_SLOTS_PER_ACTIVATION` in `fork-codec`; the module
 * derives every slot from `fm_drive_table_base`, so a host that grew the table
 * by a smaller stride would leave later activations overlapping earlier ones.
 */
export const FORK_ACTIVATION_DRIVE_SLOTS = 14;

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
] as const;

/** Selectors for `fm_decoded_node_field`, in the module's `match` order. */
const DECODED_FIELD_KIND = 0;
const DECODED_FIELD_MODULE_ACTIVATION = 1;
const DECODED_FIELD_ORDINAL = 2;

export interface ForkModuleBackendOptions {
  readonly instance: ForkModuleInstance;
  readonly memory: WebAssembly.Memory;
  readonly ptrWidth: 4 | 8;
  readonly format: LinkedFrameFormatDescriptor;
  /** The guest's resume-target function ordinals, in slot order. */
  readonly catalogOrdinals: readonly number[];
  /** The worker's dlopen control address, or 0 when it has no archive. */
  readonly archiveControlAddr?: number;
  /** The physical table whose patches this worker applies. */
  readonly tableOwner?: number;
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

  /**
   * Read lazily, so the capacity check below genuinely runs BEFORE any export is
   * touched -- which is what lets a caller prove the boundary with a stand-in
   * instance, and is what `fork-module-backend-coarse-failures` asserts.
   */
  private get exports(): Record<string, (...args: never[]) => unknown> {
    return this.options.instance.exports as Record<
      string,
      (...args: never[]) => unknown
    >;
  }

  constructor(private readonly options: ForkModuleBackendOptions) {
    this.label = options.label ?? "fork-module backend";
    // Checked HERE, not in `setup()`: it needs no module call, and a catalog
    // over the cap is a fact about the guest that is knowable the moment this is
    // constructed. The module sizes a static `[u32; CAP]` arena from the same
    // number, so staging more would write past its end.
    if (options.catalogOrdinals.length > FORK_MODULE_RESUME_CATALOG_CAP) {
      throw new Error(
        `${this.label}: a resume catalog of ${options.catalogOrdinals.length} ` +
          `ordinals exceeds the module cap ${FORK_MODULE_RESUME_CATALOG_CAP}`,
      );
    }
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
      throw new Error(`${this.label}: ${name} failed with errno ${errno}`);
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
      this.options.tableOwner ?? 0,
      this.options.channelBase ?? 0,
    );
    // The catalog is seeded AFTER the format, which resets it. Seeding first
    // would be silently discarded -- the bug the module's own reset comment
    // records having been hit on real forks.
    const ordinals = this.options.catalogOrdinals;
    const bytes = new Uint8Array(ordinals.length * 4);
    const view = new DataView(bytes.buffer);
    ordinals.forEach((ordinal, i) => view.setUint32(i * 4, ordinal >>> 0, true));
    const at = this.stage(bytes, "resume catalog");
    this.call("fm_set_resume_catalog", at, ordinals.length);
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

  setActivationCatalogBase(activationId: number, base: number): void {
    this.call("fm_set_activation_catalog_base", activationId, base);
  }

  setActivationStaticRootBase(activationId: number, base: number): void {
    this.call("fm_set_activation_static_root_base", activationId, base);
  }

  /**
   * One activation's own resume-target ordinals.
   *
   * Distinct from the process catalog `setup()` seeds: a side module loaded by
   * `dlopen` brings its own resume targets, and its slot numbering has to match
   * the funcref table the module indexes for it.
   */
  setActivationResumeCatalog(
    activationId: number,
    ordinals: readonly number[],
  ): void {
    if (ordinals.length > FORK_MODULE_RESUME_CATALOG_CAP) {
      throw new Error(
        `${this.label}: activation ${activationId}'s catalog of ` +
          `${ordinals.length} ordinals exceeds the module cap ` +
          `${FORK_MODULE_RESUME_CATALOG_CAP}`,
      );
    }
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
   * The bytes are staged into the module's own slab rather than anywhere the
   * guest might reuse: the module keeps the POINTER, not a copy, so the region
   * has to stay valid and untouched for the life of the worker.
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
   * Open this fork's capture: register the activations, publish each one's arena
   * root, and drive every guest `wpk_fork_unwind_begin` — one module call.
   *
   * `0` for the arena root asks the module to allocate its own and declare the
   * activation set into it. A caller that brings its own root keeps the older
   * contract, which is what `crates/host-native` still does.
   *
   * Returns activation 0's module-buffer anchor, which the host publishes as the
   * process launch root. A side activation's anchor is read back separately;
   * this entry returns only the first because its result is a single value.
   */
  parentBeginCapture(
    channelBase: number,
    arenaRoot: number,
    sides: readonly ForkSideActivation[],
  ): number {
    // Staged here rather than by the caller: the module reads the list as
    // `(id, fixedPrefix)` u32 pairs out of guest memory, and where they are
    // written is this wrapper's business, not worker-main's.
    let at = 0;
    if (sides.length > 0) {
      const bytes = new Uint8Array(sides.length * 8);
      const view = new DataView(bytes.buffer);
      sides.forEach((side, index) => {
        view.setUint32(index * 8, side.id >>> 0, true);
        view.setUint32(index * 8 + 4, side.fixedPrefix >>> 0, true);
      });
      at = this.stage(bytes, `${sides.length} side activation(s)`);
    }
    return this.call(
      "fm_parent_begin_capture",
      channelBase,
      arenaRoot,
      at,
      sides.length,
    );
  }

  /**
   * Install this fork's child: seed the reference replay from the inherited
   * arena, admit its exnref tags, and build the whole reconstruction plan.
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
  attachChild(moduleStateRoot: number, pid: number): number {
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
    const needed = base + FORK_ACTIVATION_DRIVE_SLOTS;
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
   * Every externref broker handle this capture interned, in intern order.
   *
   * The kernel worker needs this set to lease the parent's externrefs to the
   * child's generation. It used to DERIVE the set, by reading the parked
   * parent's KFMS arena and running the full segmented-transaction parser over
   * it. The module already had the handles -- they are passed to it on every
   * `fm_capture_intern` -- so deriving them again was ~4,956 lines of host
   * decoder duplicating work, on the one thread every process's syscalls
   * serialize through.
   *
   * Throws on overflow rather than returning a short list. A truncated lease
   * set is silent corruption: the child would hold references the parent
   * believes it passed on, and nothing would report the difference.
   */
  capturedExternrefHandles(): number[] {
    const count = Number(
      (this.exports.fm_captured_externref_count as () => number)(),
    );
    if (count < 0) {
      throw new Error(
        `${this.label}: this capture interned more externref handles than the ` +
          `module records, so the inherited set cannot be trusted`,
      );
    }
    const read = this.exports.fm_captured_externref as (i: number) => bigint | number;
    const handles: number[] = [];
    for (let index = 0; index < count; index++) {
      const handle = Number(read(index));
      if (handle < 0) {
        throw new Error(
          `${this.label}: externref handle ${index} of ${count} is missing`,
        );
      }
      handles.push(handle);
    }
    return handles;
  }

  /**
   * Stage the captured handle list into guest memory and return its address.
   *
   * Uses the same staging slab every other pre-fork buffer goes through, so a
   * COPIED child reusing this region does not grow its memory relative to the
   * parent's -- the reason `setup()`'s comment gives for staging rather than
   * mmapping per call.
   */
  stageExternrefHandover(handles: readonly number[]): number {
    const bytes = new Uint8Array(handles.length * 4);
    const view = new DataView(bytes.buffer);
    handles.forEach((handle, index) => view.setUint32(index * 4, handle >>> 0, true));
    return this.stage(bytes, "externref handover");
  }

  /** Make a child's decoded reference graph resident for the accessors below. */
  decodeReferenceGraph(moduleStateRoot: number): void {
    this.call("fm_decode_reference_graph", moduleStateRoot);
  }

  /**
   * The root of the KFMS arena THIS module built, or 0 when it built none.
   *
   * `fm_module_state_arena` operation 0 (ROOT). Zero is the ordinary answer on
   * a fork child before its own first capture: the arena it reads was mapped by
   * its parent and adopted by nobody, so the module has no root of its own and
   * the caller must use the inherited one.
   */
  moduleStateArenaRoot(): number {
    const read = this.exports.fm_module_state_arena as
      (op: number, arg: number) => bigint;
    const root = Number(read(0, 0));
    if (root < 0) throw new Error(`${this.label}: arena refused ROOT`);
    return root;
  }

  decodedNodeCount(): number {
    return this.call("fm_decoded_node_count");
  }

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

  decodedNodeOrdinal(index: number): number {
    return this.call("fm_decoded_node_field", index, DECODED_FIELD_ORDINAL);
  }

  /**
   * Copy `bytes` into the module's staging slab and return their address.
   *
   * A bump cursor, never reset: everything staged here is seeded once per worker
   * and must outlive the call. Overflow is an error rather than a wrap, because
   * wrapping would silently overwrite an earlier activation's section with a
   * later one's and leave the module pointing at the wrong bytes.
   */
  private stage(bytes: Uint8Array, what: string): number {
    const base = this.options.instance.stagingBase;
    const limit = base + this.options.instance.stagingBytes;
    const at = base + this.staged;
    if (at + bytes.length > limit) {
      throw new Error(
        `${this.label}: staging slab exhausted placing ${what} ` +
          `(${bytes.length} bytes; ${limit - at} left)`,
      );
    }
    new Uint8Array(this.options.memory.buffer).set(bytes, at);
    // 8-byte aligned so a later section's scalars are naturally aligned.
    this.staged += (bytes.length + 7) & ~7;
    return at;
  }

  private staged = 0;
}
