// Phase 6 D5 step 4b/5: the host-side driver that makes a QUALIFYING simple
// fork run its continuation through the co-resident `fork-module` (wasm→wasm
// over the shared memory) instead of the per-frame JavaScript closures in
// `ForkProcessContinuationCoordinator`. This backend owns every `fm_*` call and
// the placement of the serialized replay-event image so the coordinator's
// module-backed branches stay small and structurally parallel to the JS path.
//
// Scope (single-activation, single-thread, no dlopen/references/vfork): the
// coordinator activates these branches only when `enableModuleBacking` was
// called with an instance of this class, which `worker-main` does solely for a
// qualifying fork behind `WASM_POSIX_FORK_MODULE`. Flag-off / non-qualifying
// forks never construct this and are byte-identical to today.

import { WASM_PAGE_SIZE } from "./constants";
import type { LinkedFrameFormatDescriptor } from "./fork-continuation";
import type { ForkModuleExports } from "./fork-module-instance";

/** The fork-module's static resume-catalog cap (mirrors `RESUME_CATALOG_CAP`). */
export const FORK_MODULE_RESUME_CATALOG_CAP = 16_384;

/**
 * Default host frame-arena size for a module-backed fork (Option A). The module
 * cannot grow it, so it is sized to comfortably hold a simple fork's saved
 * frames (thousands of small linked nodes) without ever exhausting; 4 MiB is a
 * page multiple (64 wasm pages).
 */
export const FORK_MODULE_FRAME_ARENA_BYTES = 4 * 1024 * 1024;

/**
 * Bytes carved off the TOP of the frame arena to hold the serialized replay
 * journal (KFRE image) that seeds the forked child. The frames grow from the
 * base upward within the remaining region, so they never reach it. The image
 * region is inside the frame arena precisely so the child inherits it verbatim
 * through the fork memory copy, at the same guest addresses, without needing an
 * ABI-reserved control word or an arena record kind. 512 KiB holds a very large
 * journal (tens of thousands of frame events); a simple fork's is tiny.
 */
const FORK_MODULE_IMAGE_REGION_BYTES = 512 * 1024;

/** Fixed self-describing header at the start of the image region. */
const IMAGE_HEADER_BYTES = 16;
const IMAGE_MAGIC = 0x4d524653; // "SFRM" little-endian
const IMAGE_VERSION = 1;

export interface ForkModuleBackendOptions {
  /** The co-resident module instance's guest-facing + lifecycle exports. */
  readonly exports: ForkModuleExports;
  /** The single shared guest linear memory (the frame data plane). */
  readonly memory: WebAssembly.Memory;
  /** Guest pointer width: 4 for wasm32, 8 for wasm64. */
  readonly ptrWidth: 4 | 8;
  /** The guest's real linked-frame format (from `readLinkedFrameFormat`). */
  readonly format: LinkedFrameFormatDescriptor;
  /**
   * The FULL resume catalog's function ordinals (from `readForkResumeCatalog`),
   * seeded into the module so its resume-slot numbering matches the JS
   * `__wpk_fork_resume_table` by construction. Must be `<= CAP`.
   */
  readonly catalogOrdinals: readonly number[];
  /** Reserve a page-aligned guest region (production: channel `continuationMmap`). */
  readonly reserveRegion: (size: number) => number;
  /** Release a region reserved by `reserveRegion` (production: `continuationMunmap`). */
  readonly releaseRegion: (addr: number, size: number) => void;
  /**
   * Bytes for the module's per-fork frame arena (Option A: the HOST owns it).
   * The module cannot grow it, so it is sized GENEROUSLY: a qualifying simple
   * fork must never exhaust it (the module's reserve returns ENOMEM without the
   * JS abort-replay handshake). Must be a non-zero page multiple.
   */
  readonly frameArenaBytes: number;
  readonly label: string;
}

/**
 * Drives one process worker's fork continuation through the co-resident module.
 *
 * A parent worker calls `beginUnwind` → `finishUnwindAndSerialize` →
 * `beginParentReplay` → `finishReplay`. A fresh child worker (its own instance
 * at a different `__memory_base`, empty journal) calls only `beginChildReplay`
 * → `finishReplay`, seeding entirely from the copied guest memory.
 */
export class ForkModuleContinuationBackend {
  private readonly exports: ForkModuleExports;
  private readonly memory: WebAssembly.Memory;
  private readonly ptrWidth: 4 | 8;
  private readonly format: LinkedFrameFormatDescriptor;
  private readonly catalogOrdinals: readonly number[];
  private readonly reserveRegion: (size: number) => number;
  private readonly releaseRegion: (addr: number, size: number) => void;
  private readonly frameArenaBytes: number;
  private readonly label: string;

  /** The parent-owned frame arena (0 in a replay-only child). */
  private frameArenaAddr = 0;
  private moduleBuffer = 0;
  private didSetup = false;

  constructor(options: ForkModuleBackendOptions) {
    this.exports = options.exports;
    this.memory = options.memory;
    this.ptrWidth = options.ptrWidth;
    this.format = options.format;
    this.catalogOrdinals = options.catalogOrdinals;
    this.reserveRegion = options.reserveRegion;
    this.releaseRegion = options.releaseRegion;
    this.frameArenaBytes = options.frameArenaBytes;
    this.label = options.label;
    if (
      this.frameArenaBytes <= 0
      || this.frameArenaBytes % WASM_PAGE_SIZE !== 0
      || this.frameArenaBytes <= FORK_MODULE_IMAGE_REGION_BYTES
    ) {
      throw new RangeError(
        `${this.label}: fork-module frame arena must be a page multiple larger `
          + `than the ${FORK_MODULE_IMAGE_REGION_BYTES}-byte image region`,
      );
    }
    if (this.catalogOrdinals.length > FORK_MODULE_RESUME_CATALOG_CAP) {
      throw new RangeError(
        `${this.label}: resume catalog of ${this.catalogOrdinals.length} exceeds `
          + `the module cap ${FORK_MODULE_RESUME_CATALOG_CAP}`,
      );
    }
  }

  /**
   * Seed the linked-frame format and the FULL resume catalog once per worker,
   * before any fork. Both are host-known (the guest module's custom sections),
   * so this runs at process init on every worker that may drive a module fork.
   */
  setup(): void {
    if (this.didSetup) {
      throw new Error(`${this.label}: fork-module backend is already set up`);
    }
    this.exports.fm_set_format(this.ptrWidth, this.format.fixedPrefixSize);
    this.requireOk("fm_set_format");
    const count = this.catalogOrdinals.length;
    if (count > 0) {
      const byteLen = count * 4;
      const regionBytes = alignUpPage(byteLen);
      const scratch = this.reserveRegion(regionBytes);
      try {
        const view = new DataView(this.memory.buffer);
        for (let i = 0; i < count; i++) {
          view.setUint32(scratch + i * 4, this.catalogOrdinals[i]! >>> 0, true);
        }
        this.exports.fm_set_resume_catalog(this.wptr(scratch), this.wptr(count));
        this.requireOk("fm_set_resume_catalog");
      } finally {
        this.releaseRegion(scratch, regionBytes);
      }
    }
    this.didSetup = true;
  }

  /** Number of frames the module has committed since worker start (proof-of-use). */
  framesCommitted(): bigint {
    return BigInt(this.exports.fm_frames_committed() as number | bigint);
  }

  /**
   * Parent: reserve the host frame arena and begin the module unwind. Returns
   * the module-buffer anchor (the continuation root) the coordinator writes into
   * the module-state prefix and passes to the guest's `wpk_fork_unwind_begin`.
   */
  beginUnwind(): number {
    this.requireSetup("begin unwind");
    if (this.frameArenaAddr !== 0) {
      throw new Error(`${this.label}: fork-module unwind already active`);
    }
    const base = this.reserveRegion(this.frameArenaBytes);
    if (!Number.isSafeInteger(base) || base <= 0 || base % WASM_PAGE_SIZE !== 0) {
      throw new Error(`${this.label}: fork-module frame arena base is invalid`);
    }
    this.frameArenaAddr = base;
    // Hand the module only the lower frame region; the top image region is
    // reserved for the serialized journal the child reads.
    const moduleBuffer = this.toNum(
      this.exports.fm_begin_unwind(
        0,
        this.wptr(base),
        this.wptr(this.frameRegionBytes()),
      ),
    );
    this.requireOk("fm_begin_unwind");
    if (!Number.isSafeInteger(moduleBuffer) || moduleBuffer <= 0) {
      throw new Error(`${this.label}: fm_begin_unwind returned invalid anchor`);
    }
    this.moduleBuffer = moduleBuffer;
    return moduleBuffer;
  }

  /**
   * Parent: close the unwind and serialize the sealed journal as a KFRE image
   * into the TOP (image) region of the frame arena, prefixed by a self-describing
   * header. The forked child inherits this region verbatim through the fork
   * memory copy — at the same guest addresses — and decodes it (`beginChildReplay`)
   * without any arena record or ABI-reserved control word.
   */
  finishUnwindAndSerialize(): void {
    this.exports.fm_finish_unwind();
    this.requireOk("fm_finish_unwind");
    if (this.frameArenaAddr === 0) {
      throw new Error(`${this.label}: no frame arena to serialize into`);
    }
    const imageRegionBase = this.frameArenaAddr + this.frameRegionBytes();
    const imageDataPtr = imageRegionBase + IMAGE_HEADER_BYTES;
    const imageCap = FORK_MODULE_IMAGE_REGION_BYTES - IMAGE_HEADER_BYTES;
    const len = this.toNum(
      this.exports.fm_serialize_journal(
        this.wptr(imageDataPtr),
        this.wptr(imageCap),
      ),
    );
    this.requireOk("fm_serialize_journal");
    if (!Number.isSafeInteger(len) || len <= 0 || len > imageCap) {
      throw new Error(
        `${this.label}: fm_serialize_journal produced ${len} bytes`,
      );
    }
    const view = new DataView(this.memory.buffer);
    view.setUint32(imageRegionBase, IMAGE_MAGIC, true);
    view.setUint32(imageRegionBase + 4, IMAGE_VERSION, true);
    view.setUint32(imageRegionBase + 8, len, true);
    view.setUint32(imageRegionBase + 12, 0, true);
  }

  /** Parent: begin the rewind (attach the driver + register resume slots). */
  beginParentReplay(): void {
    this.exports.fm_begin_replay();
    this.requireOk("fm_begin_replay");
  }

  /**
   * Child: seed replay from the copied guest memory. `root` is the inherited
   * continuation anchor (the parent's module buffer at the same guest offset).
   * The frame arena base is `root - chunkHeaderSize`; the KFRE image sits in that
   * arena's top image region, self-describing, inherited verbatim by the copy.
   */
  beginChildReplay(root: number): void {
    this.requireSetup("begin child replay");
    const arenaBase = root - this.format.chunkHeaderSize;
    if (!Number.isSafeInteger(arenaBase) || arenaBase <= 0
      || arenaBase % WASM_PAGE_SIZE !== 0) {
      throw new Error(
        `${this.label}: inherited continuation root ${root} yields an invalid arena base`,
      );
    }
    const imageRegionBase = arenaBase + this.frameRegionBytes();
    const view = new DataView(this.memory.buffer);
    if (imageRegionBase + FORK_MODULE_IMAGE_REGION_BYTES > this.memory.buffer.byteLength) {
      throw new Error(`${this.label}: inherited image region escapes guest memory`);
    }
    const magic = view.getUint32(imageRegionBase, true);
    const version = view.getUint32(imageRegionBase + 4, true);
    const len = view.getUint32(imageRegionBase + 8, true);
    if (magic !== IMAGE_MAGIC || version !== IMAGE_VERSION) {
      throw new Error(
        `${this.label}: inherited journal image header is invalid `
          + `(magic=0x${magic.toString(16)} version=${version})`,
      );
    }
    if (len <= 0 || len > FORK_MODULE_IMAGE_REGION_BYTES - IMAGE_HEADER_BYTES) {
      throw new Error(`${this.label}: inherited journal image length ${len} is invalid`);
    }
    const imageDataPtr = imageRegionBase + IMAGE_HEADER_BYTES;
    this.moduleBuffer = root;
    this.exports.fm_begin_child_replay(
      this.wptr(root),
      this.wptr(imageDataPtr),
      this.wptr(len),
    );
    this.requireOk("fm_begin_child_replay");
  }

  /** Bytes of the frame arena the module writes frames into (below the image). */
  private frameRegionBytes(): number {
    return this.frameArenaBytes - FORK_MODULE_IMAGE_REGION_BYTES;
  }

  /** Finish the rewind and release the parent-owned frame arena (if any). */
  finishReplay(): void {
    this.exports.fm_finish_replay();
    this.requireOk("fm_finish_replay");
    this.releaseFrameArena();
    this.moduleBuffer = 0;
  }

  /** Release any parent-held frame arena without asserting module success. */
  abort(): void {
    this.releaseFrameArena();
    this.moduleBuffer = 0;
  }

  private releaseFrameArena(): void {
    const addr = this.frameArenaAddr;
    if (addr === 0) return;
    this.frameArenaAddr = 0;
    this.releaseRegion(addr, this.frameArenaBytes);
  }

  private requireSetup(operation: string): void {
    if (!this.didSetup) {
      throw new Error(
        `${this.label}: cannot ${operation}; fork-module backend is not set up`,
      );
    }
  }

  private requireOk(call: string): void {
    const errno = Number(this.exports.fm_last_errno() as number | bigint);
    if (errno !== 0) {
      throw new Error(`${this.label}: ${call} failed with errno=${errno}`);
    }
  }

  private wptr(value: number): number | bigint {
    return this.ptrWidth === 8 ? BigInt(value) : value;
  }

  private toNum(value: number | bigint): number {
    return typeof value === "bigint" ? Number(value) : value;
  }
}

function alignUpPage(value: number): number {
  return Math.ceil(value / WASM_PAGE_SIZE) * WASM_PAGE_SIZE;
}
