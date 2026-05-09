// `mkrootfs inspect` — load a VFS image and print every entry.
//
// Default `table` format prints one row per path with type letter, octal
// mode, uid, gid, size, and (for symlinks) target. `--format json` emits a
// sorted array of structured entries for programmatic consumers.
//
// Walks the filesystem with lstat + opendir/readdir/closedir (so symlinks
// surface as `l` rather than the target's type) and sorts every path
// alphabetically before output, so diffs across builds are stable.

import { readFileSync } from "node:fs";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs.ts";

const SUBCOMMAND_USAGE = `Usage: mkrootfs inspect <image> [options]

Required:
  <image>                path to a .vfs image

Options:
  --format <table|json>  output format (default: table)
  --help                 print this message
`;

const S_IFMT  = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFCHR = 0o020000;
const S_IFBLK = 0o060000;
const S_IFSOCK = 0o140000;
const S_IFIFO = 0o010000;

interface ParsedArgs {
  image: string;
  format: "table" | "json";
}

class UsageError extends Error {}

function parseArgs(args: string[]): ParsedArgs | "help" {
  const positional: string[] = [];
  let format: "table" | "json" = "table";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") return "help";
    if (a === "--format") {
      const v = args[++i];
      if (v === undefined) throw new UsageError(`flag "${a}" requires a value`);
      if (v !== "table" && v !== "json") {
        throw new UsageError(`--format must be "table" or "json", got "${v}"`);
      }
      format = v;
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      const key = a.slice(0, eq);
      const value = a.slice(eq + 1);
      if (key === "--format") {
        if (value !== "table" && value !== "json") {
          throw new UsageError(`--format must be "table" or "json", got "${value}"`);
        }
        format = value;
        continue;
      }
      throw new UsageError(`unknown flag "${key}"`);
    }
    if (a.startsWith("-")) {
      throw new UsageError(`unknown flag "${a}"`);
    }
    positional.push(a);
  }

  if (positional.length !== 1) {
    throw new UsageError(
      `expected 1 positional arg (image), got ${positional.length}`,
    );
  }
  return { image: positional[0], format };
}

function typeChar(mode: number): string {
  switch (mode & S_IFMT) {
    case S_IFDIR: return "d";
    case S_IFLNK: return "l";
    case S_IFREG: return "f";
    case S_IFCHR: return "c";
    case S_IFBLK: return "b";
    case S_IFSOCK: return "s";
    case S_IFIFO: return "p";
    default: return "?";
  }
}

export interface InspectEntry {
  path: string;
  type: string;
  mode: string;
  uid: number;
  gid: number;
  size: number | null;
  target?: string;
}

function collectEntries(mfs: MemoryFileSystem): InspectEntry[] {
  const out: InspectEntry[] = [];

  function visit(path: string): void {
    const st = mfs.lstat(path);
    const t = typeChar(st.mode);
    const entry: InspectEntry = {
      path,
      type: t,
      mode: (st.mode & 0o7777).toString(8).padStart(4, "0"),
      uid: st.uid,
      gid: st.gid,
      size: t === "f" ? st.size : null,
    };
    if (t === "l") {
      try { entry.target = mfs.readlink(path); } catch { /* dangling */ }
    }
    out.push(entry);

    if (t === "d") {
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
    }
  }

  visit("/");
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function formatTable(entries: InspectEntry[]): string {
  const header = ["type", "mode", "uid", "gid", "size", "path"];
  const rows: string[][] = [header];
  for (const e of entries) {
    const sizeCol = e.size === null ? "-" : String(e.size);
    const pathCol = e.target ? `${e.path} -> ${e.target}` : e.path;
    rows.push([e.type, e.mode, String(e.uid), String(e.gid), sizeCol, pathCol]);
  }
  const widths = rows[0].map((_, col) =>
    Math.max(...rows.map((r) => r[col].length)),
  );
  const lines: string[] = [];
  for (const r of rows) {
    const padded = r.map((cell, col) =>
      col === r.length - 1 ? cell : cell.padEnd(widths[col]),
    );
    lines.push(padded.join("  "));
  }
  return lines.join("\n") + "\n";
}

export async function runInspect(args: string[]): Promise<number> {
  let parsed: ParsedArgs | "help";
  try {
    parsed = parseArgs(args);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`mkrootfs inspect: ${e.message}\n`);
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
      process.stderr.write(`mkrootfs inspect: image not found: ${parsed.image}\n`);
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`mkrootfs inspect: failed to read ${parsed.image}: ${msg}\n`);
    }
    return 1;
  }

  let mfs: MemoryFileSystem;
  try {
    mfs = MemoryFileSystem.fromImage(bytes);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`mkrootfs inspect: not a valid VFS image (${parsed.image}): ${msg}\n`);
    return 1;
  }

  const entries = collectEntries(mfs);

  if (parsed.format === "json") {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
  } else {
    process.stdout.write(formatTable(entries));
  }
  return 0;
}
