import { FILE_MODES } from "../generated/abi";
import type { PlatformIO } from "../types";
import { readPreparedPlatformFile } from "./vfs";

/**
 * One entry of a directory tree read out of the VFS, with a path relative to
 * the tree's root. A kind the reader does not carry (device, pipe, socket) is
 * still listed, so a copy made from the tree can say what it left behind.
 */
export type VfsTreeEntry =
  | { readonly path: string; readonly kind: "directory"; readonly mode: number }
  | {
      readonly path: string;
      readonly kind: "file";
      readonly mode: number;
      readonly bytes: Uint8Array;
    }
  | {
      readonly path: string;
      readonly kind: "symlink";
      readonly mode: number;
      readonly target: string;
    }
  | { readonly path: string; readonly kind: "other"; readonly mode: number };

/**
 * Read the tree under `root`, depth first, siblings in name order, so two
 * reads of equal trees give equal lists. Regular files are read whole, which
 * materializes a lazy file the way any read does.
 */
export async function readVfsTree(
  io: PlatformIO,
  root: string,
): Promise<VfsTreeEntry[]> {
  const entries: VfsTreeEntry[] = [];
  await readDirectory(io, root, "", entries);
  return entries;
}

async function readDirectory(
  io: PlatformIO,
  directory: string,
  relative: string,
  entries: VfsTreeEntry[],
): Promise<void> {
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
  names.sort();
  for (const name of names) {
    const path = directory.endsWith("/") ? directory + name : `${directory}/${name}`;
    const entryPath = relative === "" ? name : `${relative}/${name}`;
    const stat = io.lstat(path);
    const mode = stat.mode & FILE_MODES.S_MODE_BITS;
    switch (stat.mode & FILE_MODES.S_IFMT) {
      case FILE_MODES.S_IFDIR:
        entries.push({ path: entryPath, kind: "directory", mode });
        await readDirectory(io, path, entryPath, entries);
        break;
      case FILE_MODES.S_IFREG: {
        const { data } = await readPreparedPlatformFile(io, path);
        entries.push({ path: entryPath, kind: "file", mode, bytes: data });
        break;
      }
      case FILE_MODES.S_IFLNK:
        entries.push({ path: entryPath, kind: "symlink", mode, target: io.readlink(path) });
        break;
      default:
        entries.push({ path: entryPath, kind: "other", mode });
    }
  }
}
