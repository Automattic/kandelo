import { FILE_MODES, OPEN_FLAGS } from "../generated/abi";
import type { PlatformIO } from "../types";
import { readPreparedPlatformFile } from "./vfs";

const O_WRONLY_CREAT_TRUNC =
  OPEN_FLAGS.O_WRONLY | OPEN_FLAGS.O_CREAT | OPEN_FLAGS.O_TRUNC;

interface VfsTreeNode {
  readonly path: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

/**
 * One entry of a directory tree read out of the VFS, with a path relative to
 * the tree's root. A kind the reader does not carry (device, pipe, socket) is
 * still listed, so a copy made from the tree can say what it left behind.
 *
 * A file's `fingerprint` changes whenever its inode, size, modification time,
 * or change time does. `bytes` is null when the reader was told the file's
 * current fingerprint and skipped reading it.
 */
export type VfsTreeEntry =
  | (VfsTreeNode & { readonly kind: "directory" })
  | (VfsTreeNode & {
      readonly kind: "file";
      readonly mtimeMs: number;
      readonly fingerprint: string;
      readonly bytes: Uint8Array | null;
    })
  | (VfsTreeNode & { readonly kind: "symlink"; readonly target: string })
  | (VfsTreeNode & { readonly kind: "other" });

/** Path → fingerprint of the files whose bytes a reader already holds. */
export type VfsTreeFingerprints = Readonly<Record<string, string>>;

/**
 * A tree a kernel writes at `path` after its mounts exist and before its first
 * process starts, with `writeVfsTree`.
 */
export interface VfsSeedTree {
  path: string;
  entries: VfsTreeEntry[];
}

/**
 * Read the tree under `root`, depth first, siblings in name order, so two
 * reads of equal trees give equal lists. Regular files are read whole, which
 * materializes a lazy file the way any read does, except a file whose
 * fingerprint `known` names: its bytes are null.
 *
 * A named FIFO is a regular marker file in the VFS, and only the kernel knows
 * which marker names one. `fifos` holds the kernel's absolute FIFO paths; a
 * regular file at one of them is listed as `other`.
 */
export async function readVfsTree(
  io: PlatformIO,
  root: string,
  known: VfsTreeFingerprints = {},
  fifos: ReadonlySet<string> = new Set(),
): Promise<VfsTreeEntry[]> {
  const entries: VfsTreeEntry[] = [];
  await readDirectory(io, root, "", known, fifos, entries);
  return entries;
}

async function readDirectory(
  io: PlatformIO,
  directory: string,
  relative: string,
  known: VfsTreeFingerprints,
  fifos: ReadonlySet<string>,
  entries: VfsTreeEntry[],
): Promise<void> {
  for (const name of listNames(io, directory)) {
    const path = joinPath(directory, name);
    const entryPath = relative === "" ? name : `${relative}/${name}`;
    const stat = io.lstat(path);
    const node = {
      path: entryPath,
      mode: stat.mode & FILE_MODES.S_MODE_BITS,
      uid: stat.uid,
      gid: stat.gid,
    };
    switch (stat.mode & FILE_MODES.S_IFMT) {
      case FILE_MODES.S_IFDIR:
        entries.push({ ...node, kind: "directory" });
        await readDirectory(io, path, entryPath, known, fifos, entries);
        break;
      case FILE_MODES.S_IFREG: {
        if (fifos.has(path)) {
          entries.push({ ...node, kind: "other" });
          break;
        }
        const fingerprint =
          `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        const bytes = Object.hasOwn(known, entryPath) && known[entryPath] === fingerprint
          ? null
          : (await readPreparedPlatformFile(io, path)).data;
        entries.push({ ...node, kind: "file", mtimeMs: stat.mtimeMs, fingerprint, bytes });
        break;
      }
      case FILE_MODES.S_IFLNK:
        entries.push({ ...node, kind: "symlink", target: io.readlink(path) });
        break;
      default:
        entries.push({ ...node, kind: "other" });
    }
  }
}

/**
 * Make the tree under `root` hold exactly `entries`: every entry is written
 * with its mode, owner, and, for a file, its modification time, and anything
 * else under `root` is removed. Entries must list a directory before its
 * children, as `readVfsTree` does. A file without bytes, or a node of a kind
 * the VFS cannot create from a tree, is refused before anything changes.
 */
export async function writeVfsTree(
  io: PlatformIO,
  root: string,
  entries: readonly VfsTreeEntry[],
): Promise<void> {
  const wanted = new Map<string, VfsTreeEntry["kind"]>();
  for (const entry of entries) {
    if (entry.kind === "other") {
      throw new Error(`cannot write ${entry.path}: not a file, directory, or symlink`);
    }
    if (entry.kind === "file" && entry.bytes === null) {
      throw new Error(`cannot write ${entry.path}: the tree holds no bytes for it`);
    }
    const slash = entry.path.lastIndexOf("/");
    if (slash !== -1 && wanted.get(entry.path.slice(0, slash)) !== "directory") {
      throw new Error(`tree entry ${entry.path} arrived before its directory`);
    }
    wanted.set(entry.path, entry.kind);
  }

  removeUnwanted(io, root, "", wanted);

  for (const entry of entries) {
    const path = joinPath(root, entry.path);
    if (entry.kind === "directory") {
      if (!existingKindIs(io, path, FILE_MODES.S_IFDIR)) io.mkdir(path, entry.mode);
      io.chown(path, entry.uid, entry.gid);
      io.chmod(path, entry.mode);
      continue;
    }
    if (entry.kind === "symlink") {
      io.symlink(entry.target, path);
      io.lchown(path, entry.uid, entry.gid);
      continue;
    }
    if (entry.kind !== "file" || entry.bytes === null) continue;
    writeWholeFile(io, path, entry.bytes, entry.mode);
    io.chown(path, entry.uid, entry.gid);
    io.chmod(path, entry.mode);
    const sec = Math.floor(entry.mtimeMs / 1000);
    const nsec = Math.round((entry.mtimeMs - sec * 1000) * 1_000_000);
    io.utimensat(path, sec, nsec, sec, nsec);
  }
}

/**
 * Remove what `wanted` does not keep under `directory`, deepest first. A
 * directory whose kind is kept is descended into; a file or symlink is always
 * removed, since writing it again replaces its bytes or target.
 */
function removeUnwanted(
  io: PlatformIO,
  directory: string,
  relative: string,
  wanted: ReadonlyMap<string, VfsTreeEntry["kind"]>,
): void {
  const absolute = relative === "" ? directory : joinPath(directory, relative);
  for (const name of listNames(io, absolute)) {
    const entryPath = relative === "" ? name : `${relative}/${name}`;
    const path = joinPath(directory, entryPath);
    const isDirectory = (io.lstat(path).mode & FILE_MODES.S_IFMT) === FILE_MODES.S_IFDIR;
    if (isDirectory) {
      removeUnwanted(io, directory, entryPath, wanted);
      if (wanted.get(entryPath) !== "directory") io.rmdir(path);
      continue;
    }
    io.unlink(path);
  }
}

function writeWholeFile(io: PlatformIO, path: string, bytes: Uint8Array, mode: number): void {
  const fd = io.open(path, O_WRONLY_CREAT_TRUNC, mode);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = io.write(fd, bytes.subarray(offset), null, bytes.byteLength - offset);
      if (written <= 0) throw new Error(`short write while writing ${path}`);
      offset += written;
    }
  } finally {
    io.close(fd);
  }
}

function existingKindIs(io: PlatformIO, path: string, kind: number): boolean {
  try {
    return (io.lstat(path).mode & FILE_MODES.S_IFMT) === kind;
  } catch {
    return false;
  }
}

function listNames(io: PlatformIO, directory: string): string[] {
  const names: string[] = [];
  const handle = io.opendir(directory);
  try {
    for (let entry = io.readdir(handle); entry !== null; entry = io.readdir(handle)) {
      if (entry.name === "." || entry.name === "..") continue;
      names.push(entry.name);
    }
  } finally {
    io.closedir(handle);
  }
  return names.sort();
}

function joinPath(directory: string, name: string): string {
  return directory.endsWith("/") ? directory + name : `${directory}/${name}`;
}
