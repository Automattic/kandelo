// `mkrootfs extract` — write a VFS image's tree out to a directory on disk.
//
// Walks the image with lstat + opendir (so symlinks surface as symlinks rather
// than as the target's type), creating dirs/files/symlinks under <out-dir>.
// chmod is applied after every write so executable / sticky / setuid bits
// survive the round-trip; uid/gid are dropped silently because the host
// running `mkrootfs` is rarely root and `chown` would just fail.
//
// `--manifest` opts into a sidecar `<out-dir>/MANIFEST` capturing every entry's
// uid/gid + mode in the manifest grammar from `src/manifest.ts`, so the tree is
// fully round-trippable through `mkrootfs build` even though uid/gid weren't
// preserved on the host filesystem.
//
// `--force` allows extraction over an existing directory (useful for repeated
// round-trip tests); without it, an existing out-dir is a hard error so users
// don't accidentally clobber a tree in place.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs.ts";

const SUBCOMMAND_USAGE = `Usage: mkrootfs extract <image> <out-dir> [options]

Required:
  <image>      path to a .vfs image
  <out-dir>    directory to extract into; must not already exist (or use --force)

Options:
  --force      extract even if <out-dir> exists (overlays; chmod/symlink may
               fail on existing entries)
  --manifest   also write <out-dir>/MANIFEST capturing uid/gid + mode for
               full round-trippability (host fs can't preserve uid/gid)
  --help       print this message
`;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

interface ParsedArgs {
  image: string;
  outDir: string;
  force: boolean;
  manifest: boolean;
}

class UsageError extends Error {}

function parseArgs(args: string[]): ParsedArgs | "help" {
  const positional: string[] = [];
  let force = false;
  let manifest = false;

  for (const a of args) {
    if (a === "--help" || a === "-h") return "help";
    if (a === "--force") {
      force = true;
      continue;
    }
    if (a === "--manifest") {
      manifest = true;
      continue;
    }
    if (a.startsWith("-")) {
      throw new UsageError(`unknown flag "${a}"`);
    }
    positional.push(a);
  }

  if (positional.length !== 2) {
    throw new UsageError(
      `expected 2 positional args (image, out-dir), got ${positional.length}`,
    );
  }
  return { image: positional[0], outDir: positional[1], force, manifest };
}

interface ExtractEntry {
  /** Absolute VFS path (always starts with "/"). */
  path: string;
  type: "d" | "f" | "l";
  mode: number;
  uid: number;
  gid: number;
  /** For type "f": file content. */
  content?: Uint8Array;
  /** For type "l": symlink target as stored in the image. */
  target?: string;
}

function collectEntries(mfs: MemoryFileSystem): ExtractEntry[] {
  const out: ExtractEntry[] = [];

  function readFileContent(path: string, size: number): Uint8Array {
    const fd = mfs.open(path, 0, 0); // O_RDONLY
    try {
      const buf = new Uint8Array(size);
      if (size > 0) mfs.read(fd, buf, null, size);
      return buf;
    } finally {
      mfs.close(fd);
    }
  }

  function visit(path: string): void {
    const st = mfs.lstat(path);
    const fileType = st.mode & S_IFMT;
    if (fileType === S_IFDIR) {
      out.push({ path, type: "d", mode: st.mode, uid: st.uid, gid: st.gid });
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
        const child = path === "/" ? `/${n}` : `${path}/${n}`;
        visit(child);
      }
    } else if (fileType === S_IFLNK) {
      let target = "";
      try { target = mfs.readlink(path); } catch { /* dangling */ }
      out.push({
        path,
        type: "l",
        mode: st.mode,
        uid: st.uid,
        gid: st.gid,
        target,
      });
    } else if (fileType === S_IFREG) {
      out.push({
        path,
        type: "f",
        mode: st.mode,
        uid: st.uid,
        gid: st.gid,
        content: readFileContent(path, st.size),
      });
    } else {
      // Skip device / fifo / socket — extract has no host-fs path that can
      // create them without privileges. The MANIFEST sidecar still won't
      // capture them; that's an explicit limitation of the host-fs round-trip.
    }
  }

  visit("/");
  return out;
}

function hostPath(outDir: string, vfsPath: string): string {
  if (vfsPath === "/") return outDir;
  return join(outDir, vfsPath.replace(/^\//, ""));
}

function writeEntries(outDir: string, entries: ExtractEntry[]): void {
  for (const e of entries) {
    const dest = hostPath(outDir, e.path);
    const modeBits = e.mode & 0o7777;
    switch (e.type) {
      case "d": {
        // mkdir recursive so the root case (outDir itself) is idempotent and
        // any missing intermediate dirs (shouldn't happen given parent-first
        // walk) don't blow up.
        mkdirSync(dest, { recursive: true, mode: modeBits });
        chmodSync(dest, modeBits);
        break;
      }
      case "f": {
        writeFileSync(dest, e.content ?? new Uint8Array(0));
        chmodSync(dest, modeBits);
        break;
      }
      case "l": {
        symlinkSync(e.target ?? "", dest);
        // chmod on symlinks is a no-op on Linux/macOS — mode is implicit.
        break;
      }
    }
  }
}

function formatManifest(entries: ExtractEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    const mode = (e.mode & 0o7777).toString(8).padStart(4, "0");
    const base = `${e.path}  ${e.type}  ${mode}  ${e.uid}  ${e.gid}`;
    if (e.type === "l") {
      lines.push(`${base}  target=${e.target ?? ""}`);
    } else {
      lines.push(base);
    }
  }
  return lines.join("\n") + "\n";
}

export async function runExtract(args: string[]): Promise<number> {
  let parsed: ParsedArgs | "help";
  try {
    parsed = parseArgs(args);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`mkrootfs extract: ${e.message}\n`);
      process.stderr.write(SUBCOMMAND_USAGE);
      return 2;
    }
    throw e;
  }
  if (parsed === "help") {
    process.stdout.write(SUBCOMMAND_USAGE);
    return 0;
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(parsed.image));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      process.stderr.write(`mkrootfs extract: image not found: ${parsed.image}\n`);
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`mkrootfs extract: failed to read ${parsed.image}: ${msg}\n`);
    }
    return 1;
  }

  let mfs: MemoryFileSystem;
  try {
    mfs = MemoryFileSystem.fromImage(bytes);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `mkrootfs extract: not a valid VFS image (${parsed.image}): ${msg}\n`,
    );
    return 1;
  }

  if (existsSync(parsed.outDir) && !parsed.force) {
    process.stderr.write(
      `mkrootfs extract: out-dir already exists: ${parsed.outDir} (use --force to overlay)\n`,
    );
    return 1;
  }

  const entries = collectEntries(mfs);

  try {
    writeEntries(parsed.outDir, entries);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`mkrootfs extract: ${msg}\n`);
    return 1;
  }

  if (parsed.manifest) {
    try {
      writeFileSync(join(parsed.outDir, "MANIFEST"), formatManifest(entries));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`mkrootfs extract: failed to write MANIFEST: ${msg}\n`);
      return 1;
    }
  }

  return 0;
}
