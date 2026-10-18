import type { HostFileOffset } from "../types";

/**
 * What an image builder reads off a stat, and nothing else.
 *
 * The host's `StatResult` additionally carries `dev`, `atimeMs`, `mtimeMs`,
 * `ctimeMs`, `generation`, `linkCount` and `dataSequence`. The builders in
 * `images/` read the fields below and ONLY the fields below — `mode`, `size`,
 * `ino`, `uid` and `gid` — and never a timestamp or a device number.
 *
 * Declaring the wide type would have obliged every implementation to supply
 * seven values no caller looks at — and the way to supply a time the image does
 * not record is to invent one. This is the same judgement as `readdir`
 * returning `{ name }`: an interface states what is used, and a richer
 * implementation still satisfies it structurally.
 */
export interface VfsImageStat {
  /**
   * `number | bigint` because an inode number is a `u64`: the image module's
   * record is read as a number, but an implementation that needs exact
   * identity beyond 2^53 may widen it to `bigint`, and callers only compare it.
   */
  ino: number | bigint;
  mode: number;
  size: number;
  uid: number;
  gid: number;
}

/**
 * What an image says about itself: the builder's own statements, carried by the
 * filesystem and read by nobody in between.
 *
 * Declared here, beside the interface, because it is a CONTRACT and not part
 * of any implementation — builder recipes import it without touching a
 * filesystem. Same reason `SFSError` has its own home in `vfs-errors.ts`.
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
 * reason `vfs-errors.ts` lives here.
 *
 * # Why this exists
 *
 * Builder recipes — which packages go in the LAMP image, how WordPress is
 * preinstalled — are product configuration and stay in TypeScript. Producing
 * the KIFS image itself is the Rust image writer's job, reached through
 * `KandeloImageFs` (`images/vfs/lib/kandelo-image-fs.ts`). This interface
 * states the operations recipes actually perform, so a recipe depends on
 * that contract rather than on the writer's concrete class.
 */
export interface VfsImageFilesystem {
  chmod(path: string, mode: number): void;
  chown(path: string, uid: number, gid: number): void;
  stat(path: string): VfsImageStat;
  lstat(path: string): VfsImageStat;
  open(path: string, flags: number, mode: number): number;
  /**
   * `void` rather than `number`: no builder reads the result, and a method
   * returning a number still satisfies a `void` declaration, so this admits
   * both implementations while promising only what is used.
   */
  close(handle: number): void;
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
   * here?" — the other half is [`getLazyEntry`]. Recipes ask both, and asking
   * only one would silently drop a case: an archive-backed member and a
   * URL-backed single lazy file are different registrations.
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
   * field, so the interface grants exactly that. Typing it richly would oblige
   * every implementation to produce fields no caller reads.
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
   * or `ino`. A richer entry still satisfies this structurally; declaring the
   * richer shape would oblige every implementation to produce fields no caller
   * wants.
   */
  opendir(path: string): number;
  readdir(handle: number): { name: string } | null;
  closedir(handle: number): void;

  /**
   * The finished image's bytes, uncompressed.
   *
   * Compression and the file write are NOT here and should not be: zstd and
   * `writeFileSync` are host facilities. Producing the image is the image
   * writer's job; putting it somewhere is the caller's.
   *
   * `metadata` is `unknown` for the same reason `getLazyEntry`'s return is —
   * the builder states it, the filesystem carries it, and nothing in between
   * reads it.
   */
  /**
   * Register a file fetched standalone: no archive, and `url` is the whole of
   * what says where its bytes are.
   *
   * The positional shape is what recipes call. An ARCHIVE member is a
   * different operation (see {@link registerLazyArchive}): giving both one
   * name would hide which capability an implementation actually has.
   */
  /**
   * `digestHex` is the SHA-256 the fetched bytes must hash to, as 64 hex
   * characters. Optional: without it the image says, truthfully, that it
   * carries no digest for this file.
   */
  registerLazyFile(path: string, url: string, size: number, mode?: number, digestHex?: string): number;

  /**
   * Free space and free inodes in the image, judged against a profile.
   *
   * The Rust image writer owns the KIFS allocator, so it answers with a
   * verdict and the numbers behind it rather than leaving the arithmetic, and
   * therefore the decision, to TypeScript. Declared optional; the caller
   * (`images/vfs/scripts/vfs-image-helpers.ts`) fails loudly when an
   * implementation does not offer it.
   */
  checkHeadroom?(minimumFreeBytes: number, minimumFreeInodes: number): {
    met: boolean;
    freeBytes: number;
    requiredBytes: number;
    freeInodes: number;
    requiredInodes: number;
  };

  /** The raw free-space primitive. Optional; no image-builder caller reads it. */
  statfs?(path: string): { bfree: number; frsize: number; ffree: number };

  /**
   * The growth ceiling the exported image will declare.
   *
   * Optional: a caller that has no answer from the producer asks the image
   * writer module to read the ceiling from the finished bytes instead
   * (`KandeloImageFs.readImageCapacity`).
   */
  exportCapacityBytes?(): number;

  /**
   * What this image declares about itself. Every builder that reads it is
   * CHECKING it — six call sites, all comparing `kernelAbi` against what the
   * build expects — so an implementation must report what the IMAGE declared
   * and not what the builder last set.
   */
  /**
   * Register a whole lazy archive in one call.
   *
   * Declared optional; `images/vfs/scripts/shell-lazy-archives.ts` fails
   * loudly when an implementation does not offer it.
   */
  registerLazyArchive?(args: {
    url: string;
    entries: readonly unknown[];
    mountPrefix: string;
    symlinkTargets?: Map<string, string>;
    integrity?: { sha256: string; bytes: number };
  }): number;
  /** A positional form of {@link registerLazyArchive}. Optional; no image-builder caller uses it. */
  registerLazyArchiveFromEntries?(
    url: string,
    entries: readonly unknown[],
    mountPrefix: string,
    symlinkTargets?: Map<string, string>,
    integrity?: { sha256: string; bytes: number },
  ): unknown;
  getImageMetadata(): VfsImageMetadata | null;
  setImageMetadata(metadata: VfsImageMetadata | null): void;
  saveImage(options?: {
    materializeAll?: boolean;
    metadata?: unknown;
    normalizeTimestampsMs?: number;
  }): Promise<Uint8Array>;
}
