/**
 * Merge a rootfs image's canonical `/etc` into an image under construction.
 *
 * MOVED out of `host/src/vfs/` on 2026-09-16, and the move is the point rather
 * than tidying. This is an IMAGE BUILDER: its one production caller is the
 * browser demo's boot, which assembles a kernel-owned image before any kernel
 * exists. It lived in the host runtime only because its source filesystem was
 * `KandeloImageFs`, and `host/src` may not import from `images/` — enforced
 * by the host package's own `rootDir`. So the reader it needed could not
 * follow it, and it could not follow the reader.
 *
 * Here it reads through `KandeloImageFs`, which is what every other builder
 * uses, and the seal check it used to perform explicitly is now inherent:
 * `loadImage` authenticates cohorts because `sm_load_image` does. A
 * verification a caller can forget is one some caller eventually will.
 */
import {
  ENOENT,
  ENOSPC,
  SFSError,
} from "../../../host/src/vfs/vfs-errors";
import { OPEN_FLAGS } from "../../../host/src/generated/abi";
import { KandeloImageFs } from "./kandelo-image-fs";
import type { HostFileOffset, StatResult } from "../../../host/src/types";
import type { DirEntry } from "../../../host/src/vfs/types";

/**
 * What this module needs from a filesystem, split by the three roles it
 * actually uses rather than by the class that happens to provide all of them.
 *
 * Typed against `KandeloImageFs` before — the 8,000-line class lane V is
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
  /**
   * `void` rather than `number`: nothing here reads the result, and a method
   * returning a number still satisfies a `void` declaration — so this admits
   * both implementations while promising only what is used. The same shape
   * `VfsImageFilesystem` settled on, for the same reason.
   */
  close(handle: number): void;
  opendir(path: string): number;
  readdir(handle: number): DirEntry | null;
  closedir(handle: number): void;
}

/** The write half: creating entries and setting their metadata. */
export interface RootfsOverlayWriter {
  /**
   * Only the fields this module reads. Narrowed from `StatResult` so a writer
   * that is not a `KandeloImageFs` can satisfy it: `KandeloImageFs` describes an
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
import { FILE_MODES } from "../../../host/src/generated/abi";

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
 * `KandeloImageFs` raises `SFSError` with `code`; `KandeloImageFs` raises
 * `KandeloImageError` with `errno`. Both mean ENOENT and this function is the one
 * place that has to know it — an `instanceof` check against one class silently
 * RETHROWS the other's not-found, which turns "copy this path if it is
 * missing" into a crash on the ordinary case.
 *
 * THE TWO USE OPPOSITE SIGNS, and this is the whole reason the function is
 * worth reading. `vfs-errors.ts` numbers errnos NEGATIVELY — `ENOENT` is `-2`,
 * because `SFSError` carries the code a call returned. The bridge raises
 * `KandeloImageError` with the POSITIVE errno (`2`), because it negates the
 * return code at the boundary. Comparing one against the other is not a type
 * error and not a runtime error; it is silently always-false. That is how the
 * first version of this escaped its own catch and failed 59 browser tests on
 * `/etc`, a path that is simply absent from a fresh image.
 */
function isNotFound(error: unknown): boolean {
  if (error instanceof SFSError && error.code === ENOENT) return true;
  const errno = (error as { errno?: unknown } | null | undefined)?.errno;
  // `-ENOENT` because ENOENT is negative here and positive there.
  return typeof errno === "number" && errno === -ENOENT;
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
  const source = KandeloImageFs.create();
  // NO SEPARATE VERIFY. `loadImage` authenticates every cohort seal the image
  // carries, because `sm_load_image` does — so forged imported metadata is
  // refused here by the act of reading the image, rather than by a call the
  // next author of this function could omit. That is what the explicit
  // `await source.verifyImportedLazyAtomicGroupSeals()` bought, and it bought
  // it only for as long as someone remembered to write it.
  source.loadImage(rootfsImage);
  copyMissingRootfsPath(source, target, "/etc");
}
