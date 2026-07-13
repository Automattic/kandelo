import { MemoryFileSystem } from "./memory-fs";
import {
  ENOENT,
  ENOSPC,
  O_CREAT,
  O_RDONLY,
  O_TRUNC,
  O_WRONLY,
  S_IFDIR,
  S_IFLNK,
  S_IFMT,
  S_IFREG,
  SFSError,
} from "./sharedfs-vendor";

function lstatIfPresent(fs: MemoryFileSystem, path: string) {
  try {
    return fs.lstat(path);
  } catch (error) {
    if (error instanceof SFSError && error.code === ENOENT) return null;
    throw error;
  }
}

function readFile(
  fs: MemoryFileSystem,
  path: string,
  size: number,
): Uint8Array {
  const bytes = new Uint8Array(size);
  const fd = fs.open(path, O_RDONLY, 0);
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
  fs: MemoryFileSystem,
  path: string,
  bytes: Uint8Array,
  mode: number,
  uid: number,
  gid: number,
): void {
  const fd = fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, mode);
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
  source: MemoryFileSystem,
  target: MemoryFileSystem,
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
        sourceStat.mode & 0o7777,
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
    sourceStat.mode & 0o7777,
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
export function overlayEtcFromRootfs(
  target: MemoryFileSystem,
  rootfsImage: Uint8Array,
): void {
  const source = MemoryFileSystem.fromImage(rootfsImage);
  copyMissingRootfsPath(source, target, "/etc");
}
