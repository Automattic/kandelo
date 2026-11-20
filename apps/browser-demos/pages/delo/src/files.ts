// The files of a delo computer's disk as the files pane of `delo config` shows and changes
// them: one folder's entries, a file's bytes, a folder as a zip, and uploads
// into a folder. Delo acts as root: an upload writes files 644 and folders 755,
// owned by uid 0. Kept free of the DOM and of workers so it runs under test.

import { zipSync, type Zippable } from "fflate";

import type { KandeloImageFs } from "../../../../../images/vfs/lib/kandelo-image-fs";
import { ensureDirRecursive } from "../../../../../host/src/vfs/image-helpers";

type DeloFilesKind = "folder" | "file" | "symlink" | "other";

export interface DeloFilesEntry {
  name: string;
  path: string;
  kind: DeloFilesKind;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  /** The disk describes the file's bytes but does not hold them: the
   *  computer downloads them when a program first reads the file. */
  lazy: boolean;
  target: string | null;
}

export interface DeloUpload {
  /** Relative to the folder it is uploaded into: `foo` or `foo/bar/baz`. */
  path: string;
  bytes: Uint8Array;
}

const KIND: Record<number, DeloFilesKind> = { 0x4000: "folder", 0x8000: "file", 0xa000: "symlink" };

export const childPath = (folder: string, name: string) => folder === "/" ? `/${name}` : `${folder}/${name}`;

export const parentPath = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

function entryOf(fs: KandeloImageFs, path: string): DeloFilesEntry {
  const stat = fs.lstat(path);
  const kind = KIND[stat.mode & 0xf000] ?? "other";
  return {
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    kind,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    size: stat.size,
    lazy: stat.deferred,
    target: kind === "symlink" ? fs.readlink(path) : null,
  };
}

const exists = (fs: KandeloImageFs, path: string) => {
  try {
    fs.lstat(path);
    return true;
  } catch {
    return false;
  }
};

/** The entries of `folder`, folders first, then by name. */
export function listFolder(fs: KandeloImageFs, folder: string): DeloFilesEntry[] {
  if (entryOf(fs, folder).kind !== "folder") throw new Error(`${folder} is not a folder`);
  const entries = fs.readDirNames(folder).filter((name) => name !== "." && name !== "..").map((name) => entryOf(fs, childPath(folder, name)));
  return entries.sort((a, b) => Number(b.kind === "folder") - Number(a.kind === "folder") || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function readRegularFile(fs: KandeloImageFs, path: string): Uint8Array {
  const entry = entryOf(fs, path);
  if (entry.kind !== "file") throw new Error(`${path} is not a file`);
  if (entry.lazy) throw new Error(`${path} is not on the disk yet: the computer downloads it when a program reads it`);
  return fs.readFile(path);
}

/** `folder` as a zip whose entries are named under the folder's own name.
 *  Symlinks, lazy files and special files have no bytes to put in it, so
 *  each one is an empty file whose name ends with `.symlink`, `.lazy` or
 *  `.special`. */
export function zipFolder(fs: KandeloImageFs, folder: string): Uint8Array {
  const root = folder === "/" ? "disk" : folder.slice(folder.lastIndexOf("/") + 1);
  const files: Zippable = {};
  const walk = (path: string, name: string) => {
    files[`${name}/`] = new Uint8Array();
    for (const entry of listFolder(fs, path)) {
      const inner = `${name}/${entry.name}`;
      if (entry.kind === "folder") walk(entry.path, inner);
      else if (entry.kind === "file" && !entry.lazy) files[inner] = fs.readFile(entry.path);
      else files[`${inner}.${entry.kind === "symlink" ? "symlink" : entry.lazy ? "lazy" : "special"}`] = new Uint8Array();
    }
  };
  walk(folder, root);
  return zipSync(files);
}

function uploadPath(folder: string, path: string): string {
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error(`${path} is not a path inside a folder`);
  return parts.reduce(childPath, folder);
}

/** The uploads that would replace a file that is already on the disk. */
export function uploadConflicts(fs: KandeloImageFs, folder: string, paths: string[]): string[] {
  return paths.filter((path) => exists(fs, uploadPath(folder, path)));
}

/** Write every upload into `folder`, creating the folders its paths name. A
 *  path that runs into something that is not a folder, or lands on something
 *  that is not a file, stops the upload before anything is written. */
export function upload(fs: KandeloImageFs, folder: string, uploads: DeloUpload[]): void {
  const targets = uploads.map((item) => ({ path: uploadPath(folder, item.path), bytes: item.bytes }));
  for (const { path } of targets) {
    for (let parent = parentPath(path); parent !== folder && parent !== "/"; parent = parentPath(parent)) {
      if (exists(fs, parent) && entryOf(fs, parent).kind !== "folder") throw new Error(`${parent} is not a folder`);
    }
    if (exists(fs, path) && entryOf(fs, path).kind !== "file") throw new Error(`${path} is not a file`);
    const inside = targets.find((other) => other.path.startsWith(`${path}/`));
    if (inside !== undefined) throw new Error(`${path} is a file, so ${inside.path} cannot go inside it`);
  }
  for (const { path, bytes } of targets) {
    ensureDirRecursive(fs, parentPath(path));
    fs.writeFile(path, bytes, 0o644);
  }
}
