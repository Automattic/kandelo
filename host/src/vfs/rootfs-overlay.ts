import { MemoryFileSystem } from "./memory-fs";
import { ENOENT, ENOSPC, SFSError } from "./sharedfs-vendor";

const S_IFMT = 0xf000;
const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;
const S_IFLNK = 0xa000;

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
  const fd = fs.open(path, 0, 0);
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const n = fs.read(
        fd,
        bytes.subarray(offset),
        null,
        bytes.length - offset,
      );
      if (n <= 0) break;
      offset += n;
    }
  } finally {
    fs.close(fd);
  }
  if (offset !== bytes.length) {
    throw new Error(
      `short read while overlaying ${path}: expected ${bytes.length}, got ${offset}`,
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
  const fd = fs.open(path, 0o1101, mode); // O_WRONLY | O_CREAT | O_TRUNC
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const written = fs.write(
        fd,
        bytes.subarray(offset),
        null,
        bytes.length - offset,
      );
      if (written <= 0) {
        throw new SFSError(
          ENOSPC,
          `No space left on device while overlaying ${path}: expected ${bytes.length}, wrote ${offset}`,
        );
      }
      offset += written;
    }
  } finally {
    fs.close(fd);
  }
  fs.chown(path, uid, gid);
  fs.chmod(path, mode);
}

/**
 * Merge one rootfs path into a demo-owned filesystem without overwriting any
 * existing leaf. Existing directories are traversed so canonical nested files
 * can still be added below demo-provided directory trees.
 */
function copyMissingPath(
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
        if (!entry) break;
        if (entry.name === "." || entry.name === "..") continue;
        const child = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
        copyMissingPath(source, target, child);
      }
    } finally {
      source.closedir(dh);
    }
    return;
  }

  // A demo-owned file or symlink is authoritative for that exact leaf.
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

  if (sourceKind !== S_IFREG) return;
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
 * Recursively overlay canonical `/etc` image state into a browser image under
 * construction. Existing leaves remain caller-owned, while existing
 * directories are traversed so missing canonical descendants are installed.
 */
export function overlayEtcFromRootfs(
  target: MemoryFileSystem,
  rootfsImage: Uint8Array,
): void {
  const source = MemoryFileSystem.fromImage(rootfsImage);
  copyMissingPath(source, target, "/etc");
}
