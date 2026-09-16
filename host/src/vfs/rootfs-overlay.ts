import {
  ENOENT,
  ENOSPC,
  SFSError,
} from "./vfs-errors";
import { OPEN_FLAGS } from "../generated/abi";
import { MemoryFileSystem } from "./memory-fs";
import type { HostFileOffset, StatResult } from "../types";
import type { DirEntry } from "./types";

/**
 * What this module needs from a filesystem, split by the three roles it
 * actually uses rather than by the class that happens to provide all of them.
 *
 * Typed against `MemoryFileSystem` before — the 8,000-line class lane V is
 * deleting. Measured at the call sites, the reads and the writes are disjoint
 * enough to name separately, which is worth doing: `readFile` cannot write and
 * the type now says so.
 */
export interface RootfsOverlayReader {
  lstat(path: string): StatResult;
  readlink(path: string): string;
  open(path: string, flags: number, mode: number): number;
  read(
    handle: number,
    buffer: Uint8Array,
    offset: HostFileOffset | null,
    length: number,
  ): number;
  close(handle: number): number;
  opendir(path: string): number;
  readdir(handle: number): DirEntry | null;
  closedir(handle: number): void;
  verifyImportedLazyAtomicGroupSeals(): Promise<void>;
}

/** The write half: creating entries and setting their metadata. */
export interface RootfsOverlayWriter {
  /**
   * Only the fields this module reads. Narrowed from `StatResult` so a writer
   * that is not a `MemoryFileSystem` can satisfy it: `SffsImageFs` describes an
   * image, and an image records no access or change times to report.
   */
  lstat(path: string): Pick<StatResult, "mode" | "uid" | "gid" | "size">;
  open(path: string, flags: number, mode: number): number;
  write(
    handle: number,
    buffer: Uint8Array,
    offset: HostFileOffset | null,
    length: number,
  ): number;
  /** The return is not read here; a writer may report nothing. */
  close(handle: number): void | number;
  chmod(path: string, mode: number): void;
  chown(path: string, uid: number, gid: number): void;
  mkdirWithOwner(path: string, mode: number, uid: number, gid: number): void;
  symlinkWithOwner(
    target: string,
    path: string,
    uid: number,
    gid: number,
  ): void;
}
import { FILE_MODES } from "../generated/abi";

const { S_IFDIR, S_IFLNK, S_IFMT, S_IFREG } = FILE_MODES;

// Needs `lstat` and nothing else, and is called with both a reader and a
// writer — so it is typed to the one method rather than to either role.
function lstatIfPresent(
  // The NARROW shape, so both roles pass: a reader's fuller `StatResult` is
  // assignable to it, and a writer that describes an image (which records no
  // access or change times) satisfies it exactly.
  fs: { lstat(path: string): Pick<StatResult, "mode" | "uid" | "gid" | "size"> },
  path: string,
) {
  try {
    return fs.lstat(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * "This path is not there" from either filesystem.
 *
 * `MemoryFileSystem` raises `SFSError` with `code`; `SffsImageFs` raises
 * `SffsImageError` with `errno`. Both mean ENOENT and this function is the one
 * place that has to know it — an `instanceof` check against one class silently
 * RETHROWS the other's not-found, which turns "copy this path if it is
 * missing" into a crash on the ordinary case.
 */
function isNotFound(error: unknown): boolean {
  if (error instanceof SFSError && error.code === ENOENT) return true;
  return typeof error === "object" && error !== null
    && (error as { errno?: unknown }).errno === ENOENT;
}

function readFile(
  fs: RootfsOverlayReader,
  path: string,
  size: number,
): Uint8Array {
  const bytes = new Uint8Array(size);
  const fd = fs.open(path, OPEN_FLAGS.O_RDONLY, 0);
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const count = fs.read(
        fd,
        bytes.subarray(offset),
        null,
        bytes.length - offset,
      );
      if (count <= 0) break;
      offset += count;
    }
  } finally {
    fs.close(fd);
  }

  if (offset !== bytes.length) {
    throw new Error(
      `Short read while copying canonical rootfs path ${path}: ` +
        `${offset}/${bytes.length} bytes`,
    );
  }
  return bytes;
}

function writeFile(
  fs: RootfsOverlayWriter,
  path: string,
  bytes: Uint8Array,
  mode: number,
  uid: number,
  gid: number,
): void {
  const fd = fs.open(path, OPEN_FLAGS.O_WRONLY | OPEN_FLAGS.O_CREAT | OPEN_FLAGS.O_TRUNC, mode);
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const count = fs.write(
        fd,
        bytes.subarray(offset),
        null,
        bytes.length - offset,
      );
      if (count <= 0) {
        throw new SFSError(
          ENOSPC,
          `No space left on device while copying canonical rootfs path ${path}: ` +
            `${offset}/${bytes.length} bytes`,
        );
      }
      offset += count;
    }
  } finally {
    fs.close(fd);
  }
  fs.chown(path, uid, gid);
  fs.chmod(path, mode);
}

/**
 * Merge one canonical rootfs path into a caller-owned filesystem without
 * overwriting an existing leaf. Existing directories are traversed so missing
 * canonical descendants can still be added below caller-owned directory trees.
 */
function copyMissingRootfsPath(
  source: RootfsOverlayReader,
  target: RootfsOverlayWriter,
  path: string,
): void {
  const sourceStat = source.lstat(path);
  const sourceKind = sourceStat.mode & S_IFMT;
  const targetStat = lstatIfPresent(target, path);

  if (sourceKind === S_IFDIR) {
    if (targetStat) {
      if ((targetStat.mode & S_IFMT) !== S_IFDIR) return;
    } else {
      target.mkdirWithOwner(
        path,
        sourceStat.mode & FILE_MODES.S_MODE_BITS,
        sourceStat.uid,
        sourceStat.gid,
      );
    }

    const dh = source.opendir(path);
    try {
      for (;;) {
        const entry = source.readdir(dh);
        if (entry === null) break;
        if (entry.name === "." || entry.name === "..") continue;
        const child = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
        copyMissingRootfsPath(source, target, child);
      }
    } finally {
      source.closedir(dh);
    }
    return;
  }

  // A caller-owned file or symlink is authoritative for that exact leaf.
  if (targetStat) return;

  if (sourceKind === S_IFLNK) {
    target.symlinkWithOwner(
      source.readlink(path),
      path,
      sourceStat.uid,
      sourceStat.gid,
    );
    return;
  }

  if (sourceKind !== S_IFREG) {
    throw new Error(`Unsupported canonical /etc file type at ${path}`);
  }

  writeFile(
    target,
    path,
    readFile(source, path, sourceStat.size),
    sourceStat.mode & FILE_MODES.S_MODE_BITS,
    sourceStat.uid,
    sourceStat.gid,
  );
}

/**
 * Recursively merge canonical `/etc` image state into an image under
 * construction. Existing leaves and directory metadata remain caller-owned;
 * missing canonical directories, regular files, and symlinks retain their
 * source ownership and modes.
 */
export async function overlayEtcFromRootfs(
  target: RootfsOverlayWriter,
  rootfsImage: Uint8Array,
): Promise<void> {
  const source = MemoryFileSystem.fromImage(rootfsImage);
  // WHY: reject forged imported metadata before copying even one source entry.
  await source.verifyImportedLazyAtomicGroupSeals();
  copyMissingRootfsPath(source, target, "/etc");
}
