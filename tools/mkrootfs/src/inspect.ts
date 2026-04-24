// `mkrootfs inspect <image>` — walk a VFS image and print each entry
// with its type, octal mode, uid:gid, and path. Output is one line per
// entry, sorted by path within a directory (insertion order via readdir).

import { readFileSync } from "node:fs";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

const S_IFMT  = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFCHR = 0o020000;
const S_IFBLK = 0o060000;
const S_IFSOCK = 0o140000;
const S_IFIFO = 0o010000;

function typeChar(mode: number): string {
  switch (mode & S_IFMT) {
    case S_IFDIR: return "d";
    case S_IFLNK: return "l";
    case S_IFCHR: return "c";
    case S_IFBLK: return "b";
    case S_IFSOCK: return "s";
    case S_IFIFO: return "p";
    case S_IFREG: return "-";
    default: return "?";
  }
}

export interface InspectLine {
  type: string;
  modeOctal: string;
  uid: number;
  gid: number;
  path: string;
  size: number;
  target?: string; // for symlinks
}

export function inspectImage(imagePath: string, write: (line: string) => void = (s) => process.stdout.write(s + "\n")): InspectLine[] {
  const image = new Uint8Array(readFileSync(imagePath));
  const mfs = MemoryFileSystem.fromImage(image);
  const lines: InspectLine[] = [];
  walk(mfs, "/", lines);
  for (const l of lines) {
    const suffix = l.target ? ` -> ${l.target}` : "";
    write(`${l.type}${l.modeOctal}  ${l.uid}:${l.gid}  ${String(l.size).padStart(8)}  ${l.path}${suffix}`);
  }
  return lines;
}

function walk(mfs: MemoryFileSystem, path: string, out: InspectLine[]): void {
  const st = mfs.lstat(path);
  const type = typeChar(st.mode);
  const line: InspectLine = {
    type,
    modeOctal: (st.mode & 0o7777).toString(8).padStart(4, "0"),
    uid: st.uid,
    gid: st.gid,
    path,
    size: st.size,
  };
  if ((st.mode & S_IFMT) === S_IFLNK) {
    try { line.target = mfs.readlink(path); } catch { /* dangling */ }
  }
  out.push(line);

  if ((st.mode & S_IFMT) === S_IFDIR) {
    const names: string[] = [];
    const handle = mfs.opendir(path);
    try {
      while (true) {
        const e = mfs.readdir(handle);
        if (!e) break;
        if (e.name === "." || e.name === "..") continue;
        names.push(e.name);
      }
    } finally {
      mfs.closedir(handle);
    }
    names.sort();
    for (const n of names) {
      const childPath = path === "/" ? `/${n}` : `${path}/${n}`;
      walk(mfs, childPath, out);
    }
  }
}
