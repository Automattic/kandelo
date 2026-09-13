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
