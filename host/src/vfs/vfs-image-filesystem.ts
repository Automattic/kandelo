import type { HostFileOffset, StatResult } from "../types";

/**
 * What an image says about itself: the builder's own statements, carried by the
 * filesystem and read by nobody in between.
 *
 * Moved here from `memory-fs.ts` because it is a CONTRACT, not part of that
 * implementation — thirteen builder recipes import it, and every one of them
 * was counted as coupled to a filesystem it never touches. Same move and same
 * reason as V8 giving `SFSError` a home in `vfs-errors.ts`.
 */
export interface VfsImageMetadata {
  version: 1;
  /**
   * Exact kernel ABI this image expects when it carries ABI-bound artifacts
   * such as wasm-posix user programs. Omit for data-only images.
   */
  kernelAbi?: number;
  /** Free-form builder id, e.g. "mkrootfs 0.1.0" or a package script name. */
  createdBy?: string;
  /** Preserve forwards compatibility for future signed/provenance fields. */
  [key: string]: unknown;
}

/**
 * The filesystem a VFS image builder recipe is handed.
 *
 * Lives in `host/src/vfs/` rather than under `images/` because the host's own
 * helpers take it too, and a host module importing from `images/` would invert
 * the dependency — `images/` consumes the host, not the other way round. Same
 * home and same reason as `vfs-errors.ts`, which V8 gave `SFSError`.
 *
 * # Why this exists
 *
 * Builder recipes — which packages go in the LAMP image, how WordPress is
 * preinstalled — are product configuration and stay in TypeScript. What should
 * NOT stay is their dependence on a particular implementation of the SFFS
 * format. Eighteen of them took `MemoryFileSystem` purely as a parameter type
 * and never constructed one, so the coupling the budget counts was a type
 * import and nothing more.
 *
 * This is that type, stated as the operations recipes actually perform, so
 * `memory-fs.ts` can be deleted without every recipe being rewritten.
 *
 * # What it deliberately leaves out
 *
 * `saveImage`, `getLazyEntry`, `isPathDeferred`, `registerLazyArchiveFromEntries`
 * and `exportLazyArchiveEntries`. Five recipes use those, and they are not
 * included because including them would make this interface a second name for
 * `MemoryFileSystem` rather than a description of what a recipe needs — the
 * shape of every other measurement in this lane, where the lazy-archive and
 * save paths are the boundary. Those five stay on the concrete type until the
 * bridge grows an equivalent, and the plan records which they are.
 *
 * # What repointing here does NOT mean
 *
 * H-8: low coupling is not migratability. A recipe that takes this type still
 * receives a `MemoryFileSystem` today, because the callers that CONSTRUCT one
 * have not moved. The import count falling is what unblocks deleting the
 * implementation; it is not evidence that these recipes run against the Rust
 * writer.
 */
export interface VfsImageFilesystem {
  chmod(path: string, mode: number): void;
  chown(path: string, uid: number, gid: number): void;
  stat(path: string): StatResult;
  lstat(path: string): StatResult;
  open(path: string, flags: number, mode: number): number;
  close(handle: number): number;
  read(
    handle: number,
    buffer: Uint8Array,
    offset: HostFileOffset | null,
    length: number,
  ): number;
  write(
    handle: number,
    buffer: Uint8Array,
    offset: HostFileOffset | null,
    length: number,
  ): number;
  unlink(path: string): void;

  /**
   * Whether `path` is backed by a lazy archive or tree.
   *
   * Half of the question recipes actually ask, which is "are these bytes
   * here?" — the other half is [`getLazyEntry`]. They are separate here
   * because `MemoryFileSystem` answers them separately, and collapsing them
   * would silently drop a case: `isPathDeferred` alone misses a URL-backed
   * single lazy file, which is precisely the case lane S's defect is about.
   *
   * The assertions built on this are product requirements — "dinit must be
   * resident before service boot", "the login program must be eager" — and
   * asking them was the only reason those recipes needed a filesystem
   * IMPLEMENTATION rather than this interface.
   */
  isPathDeferred(path: string): boolean;

  /**
   * A registered per-file lazy entry for `path`, or `null`.
   *
   * **Deliberately `unknown`.** Every caller null-checks it and none reads a
   * field, so the interface grants exactly that. Typing it richly would drag
   * `MemoryFileSystem`'s `LazyFileEntry` in and make this a second name for
   * the class rather than a description of what a recipe needs.
   *
   * An implementation with ONE notion of deferred — the Rust bridge, where a
   * deferred file is a deferred file whether an archive or a URL stands behind
   * it — reports everything through `isPathDeferred` and returns `null` here.
   * That is not a stub: the union the recipes compute comes out identical.
   */
  getLazyEntry(path: string): unknown;

  mkdir(path: string, mode: number): void;
  symlink(target: string, path: string): void;
  readlink(path: string): string;

  /**
   * Directory iteration, POSIX-shaped: a handle, entries, a close.
   *
   * An entry is `{ name }` and nothing else, because that is all any recipe
   * reads — twelve call sites, every one of them `.name`, none of them `type`
   * or `ino`. `MemoryFileSystem.readdir` returns a richer `DirEntry` and
   * satisfies this structurally; declaring the richer shape would oblige every
   * implementation to produce fields no caller wants.
   */
  opendir(path: string): number;
  readdir(handle: number): { name: string } | null;
  closedir(handle: number): void;

  /**
   * The finished image's bytes, uncompressed.
   *
   * Compression and the file write are NOT here and should not be: zstd and
   * `writeFileSync` are host facilities, and the floor this lane reduces
   * toward is host facilities only. What moves off the host is producing the
   * image; what stays is putting it somewhere.
   *
   * `metadata` is `unknown` for the same reason `getLazyEntry`'s return is —
   * the builder states it, the filesystem carries it, and nothing in between
   * reads it.
   */
  /**
   * Register a file fetched standalone: no archive, and `url` is the whole of
   * what says where its bytes are.
   *
   * The positional shape is what recipes call and what `MemoryFileSystem` has
   * always had. An ARCHIVE member is a different operation and is deliberately
   * not here — only two recipes register one, and giving both operations one
   * name is what hid a missing capability in the bridge until it was measured.
   */
  registerLazyFile(path: string, url: string, size: number, mode?: number): number;

  /**
   * Free space and free inodes in the image, judged against a profile.
   *
   * **Optional, and so is {@link statfs} below, on purpose.** The two
   * implementations differ in what they can answer: the Rust bridge computes
   * this verdict in the kernel, and `MemoryFileSystem` can only report a
   * `statfs` for a caller to turn into one.
   *
   * Requiring the verdict would force the method into `memory-fs.ts`, whose
   * budget target is 0 and which the surface gate has already refused to let
   * grow. Requiring `statfs` instead would put the primitive back on the
   * bridge and leave the arithmetic and the judgement on this side. Carrying
   * both as optional lets the two coexist for exactly as long as both exist —
   * the `statfs` branch is deleted along with `memory-fs.ts`, and there is one
   * call site to delete.
   */
  checkHeadroom?(minimumFreeBytes: number, minimumFreeInodes: number): {
    met: boolean;
    freeBytes: number;
    requiredBytes: number;
    freeInodes: number;
    requiredInodes: number;
  };

  /** See {@link checkHeadroom}: the primitive, for the implementation that has no verdict. */
  statfs?(path: string): { bfree: number; frsize: number; ffree: number };

  /**
   * The growth ceiling the exported image will declare.
   *
   * Optional for the same reason as {@link checkHeadroom}: the producer can
   * answer it, and the implementation that cannot leaves its caller to parse
   * the finished bytes. That parse is the thing being removed, so the fallback
   * dies with `memory-fs.ts` rather than becoming the contract.
   */
  exportCapacityBytes?(): number;

  saveImage(options?: {
    materializeAll?: boolean;
    metadata?: unknown;
    normalizeTimestampsMs?: number;
  }): Promise<Uint8Array>;
}
