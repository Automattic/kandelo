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
 * Size a vfork BORROWED child's private workspace, refusing a missing module.
 *
 * The backend handle is nullable everywhere in the worker, and the two call
 * sites are on a path that cannot be reached without it: a vfork only gets here
 * having sealed a capture, and only the module can seal one. A bare `!` would
 * be right and would also mean that if the impossible ever happened the failure
 * would name a JavaScript property rather than the thing that was missing.
 */
export function borrowedReplayWorkspaceOf(
  backend: ForkModuleContinuationBackend | null,
  pid: number,
): ForkBorrowedReplayWorkspace {
  if (backend === null) {
    throw new Error(
      `pid=${pid}: a vfork sealed its capture with no fork-module backend`,
    );
  }
  return backend.borrowedReplayWorkspace();
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
export const FORK_ACTIVATION_DRIVE_SLOTS = 13;

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

  private call(name: string, ...args: number[]): number {
    const fn = this.exports[name] as ((...a: number[]) => number) | undefined;
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
