// `mkrootfs add` — programmatically inject a single entry into an existing
// VFS image, in place. Useful for ad-hoc edits when rebuilding from MANIFEST
// would be overkill.
//
// Three operation modes (mutually exclusive):
//   --file <local-path>   add a regular file with content from disk
//   --dir                 add a directory
//   --symlink <target>    add a symlink with the given target
//
// Parent directory must already exist (intentional — auto-creating parents
// hides typos). `--force` allows overwriting an existing entry of the same
// type; replacing across types (e.g. file → dir) is rejected even with
// --force, because the safe path there is unlink + add via two invocations.
//
// Atomic write: the updated image is written to `<image>.tmp-<pid>` and then
// renamed over the original, so a failure mid-write leaves the original
// untouched.

import {
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs.ts";

const SUBCOMMAND_USAGE = `Usage: mkrootfs add <image> <vfs-path> [options]

Required:
  <image>             path to a .vfs image (modified in place)
  <vfs-path>          absolute destination path inside the VFS

Operation (exactly one required):
  --file <path>       add a regular file with content from <path>
  --dir               add a directory
  --symlink <target>  add a symlink with the given target

Metadata:
  --mode <octal>      permission bits (default: 0644 file / 0755 dir / 0777 symlink)
  --uid <n>           owner uid (default: 0)
  --gid <n>           owner gid (default: 0)

Other:
  --force             overwrite if <vfs-path> already exists (same-type only)
  --help              print this message
`;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

type Op = "file" | "dir" | "symlink";

interface ParsedArgs {
  image: string;
  vfsPath: string;
  op: Op;
  /** for --file: local source path. for --symlink: target. */
  arg?: string;
  mode?: number;
  uid: number;
  gid: number;
  force: boolean;
}

class UsageError extends Error {}

function parseOctal(name: string, value: string): number {
  // Accept "0644", "644", "0o644".
  const cleaned = value.replace(/^0o/i, "");
  if (!/^[0-7]+$/.test(cleaned)) {
    throw new UsageError(`${name} must be octal, got "${value}"`);
  }
  return parseInt(cleaned, 8);
}

function parseUint(name: string, value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`${name} must be a non-negative integer, got "${value}"`);
  }
  return parseInt(value, 10);
}

function parseArgs(args: string[]): ParsedArgs | "help" {
  const positional: string[] = [];
  let opCount = 0;
  let op: Op | undefined;
  let opArg: string | undefined;
  let mode: number | undefined;
  let uid = 0;
  let gid = 0;
  let force = false;

  function takeValue(flag: string, next: string | undefined): string {
    if (next === undefined) throw new UsageError(`flag "${flag}" requires a value`);
    return next;
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") return "help";

    // --key=value form
    const eq = a.indexOf("=");
    let key = a;
    let inlineVal: string | undefined;
    if (a.startsWith("--") && eq > 0) {
      key = a.slice(0, eq);
      inlineVal = a.slice(eq + 1);
    }

    switch (key) {
      case "--file":
        op = "file";
        opCount++;
        opArg = inlineVal ?? takeValue(key, args[++i]);
        continue;
      case "--symlink":
        op = "symlink";
        opCount++;
        opArg = inlineVal ?? takeValue(key, args[++i]);
        continue;
      case "--dir":
        op = "dir";
        opCount++;
        if (inlineVal !== undefined) {
          throw new UsageError(`--dir does not take a value`);
        }
        continue;
      case "--mode":
        mode = parseOctal("--mode", inlineVal ?? takeValue(key, args[++i]));
        continue;
      case "--uid":
        uid = parseUint("--uid", inlineVal ?? takeValue(key, args[++i]));
        continue;
      case "--gid":
        gid = parseUint("--gid", inlineVal ?? takeValue(key, args[++i]));
        continue;
      case "--force":
        if (inlineVal !== undefined) {
          throw new UsageError(`--force does not take a value`);
        }
        force = true;
        continue;
    }

    if (a.startsWith("-")) {
      throw new UsageError(`unknown flag "${a}"`);
    }
    positional.push(a);
  }

  if (positional.length !== 2) {
    throw new UsageError(
      `expected 2 positional args (image, vfs-path), got ${positional.length}`,
    );
  }
  if (opCount === 0) {
    throw new UsageError(
      `missing operation flag — pass exactly one of --file, --dir, --symlink`,
    );
  }
  if (opCount > 1) {
    throw new UsageError(
      `--file, --dir, --symlink are mutually exclusive (got ${opCount})`,
    );
  }

  const vfsPath = positional[1];
  if (!vfsPath.startsWith("/")) {
    throw new UsageError(`<vfs-path> must be absolute, got "${vfsPath}"`);
  }
  if (vfsPath === "/") {
    throw new UsageError(`<vfs-path> must not be "/"`);
  }

  return {
    image: positional[0],
    vfsPath,
    op: op!,
    arg: opArg,
    mode,
    uid,
    gid,
    force,
  };
}

function defaultMode(op: Op): number {
  switch (op) {
    case "file": return 0o644;
    case "dir": return 0o755;
    case "symlink": return 0o777;
  }
}

function typeChar(mode: number): "f" | "d" | "l" | "?" {
  switch (mode & S_IFMT) {
    case S_IFREG: return "f";
    case S_IFDIR: return "d";
    case S_IFLNK: return "l";
    default: return "?";
  }
}

function lookupExisting(mfs: MemoryFileSystem, path: string): "f" | "d" | "l" | "?" | null {
  try {
    const st = mfs.lstat(path);
    return typeChar(st.mode);
  } catch {
    return null;
  }
}

async function writeAtomic(imagePath: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${imagePath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, imagePath);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw e;
  }
}

export async function runAdd(args: string[]): Promise<number> {
  let parsed: ParsedArgs | "help";
  try {
    parsed = parseArgs(args);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`mkrootfs add: ${e.message}\n`);
      process.stderr.write(SUBCOMMAND_USAGE);
      return 2;
    }
    throw e;
  }
  if (parsed === "help") {
    process.stdout.write(SUBCOMMAND_USAGE);
    return 0;
  }

  let imageBytes: Uint8Array;
  try {
    imageBytes = new Uint8Array(readFileSync(parsed.image));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      process.stderr.write(`mkrootfs add: image not found: ${parsed.image}\n`);
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`mkrootfs add: failed to read ${parsed.image}: ${msg}\n`);
    }
    return 1;
  }

  let mfs: MemoryFileSystem;
  try {
    mfs = MemoryFileSystem.fromImage(imageBytes);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `mkrootfs add: not a valid VFS image (${parsed.image}): ${msg}\n`,
    );
    return 1;
  }

  // For --file, read source up-front so we surface a missing source as a
  // clean error before mutating anything.
  let fileContent: Uint8Array | undefined;
  if (parsed.op === "file") {
    try {
      fileContent = new Uint8Array(readFileSync(parsed.arg!));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        process.stderr.write(`mkrootfs add: source file not found: ${parsed.arg}\n`);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`mkrootfs add: failed to read ${parsed.arg}: ${msg}\n`);
      }
      return 1;
    }
  }

  // Parent directory must exist. Don't auto-create.
  const parent = dirname(parsed.vfsPath);
  const parentType = lookupExisting(mfs, parent);
  if (parentType === null) {
    process.stderr.write(
      `mkrootfs add: parent directory does not exist: ${parent}\n`,
    );
    return 1;
  }
  if (parentType !== "d") {
    process.stderr.write(
      `mkrootfs add: parent is not a directory: ${parent}\n`,
    );
    return 1;
  }

  // Existing-entry check. --force allows same-type overwrite; cross-type
  // overwrite is rejected even with --force.
  const existing = lookupExisting(mfs, parsed.vfsPath);
  const desiredType: "f" | "d" | "l" =
    parsed.op === "file" ? "f" : parsed.op === "dir" ? "d" : "l";
  if (existing !== null) {
    if (!parsed.force) {
      process.stderr.write(
        `mkrootfs add: ${parsed.vfsPath} already exists (use --force to overwrite)\n`,
      );
      return 1;
    }
    if (existing !== desiredType) {
      process.stderr.write(
        `mkrootfs add: ${parsed.vfsPath} exists as type "${existing}" but adding "${desiredType}"; ` +
          `cross-type replace not supported — use a separate tool to remove first\n`,
      );
      return 1;
    }
  }

  const mode = parsed.mode ?? defaultMode(parsed.op);

  try {
    if (parsed.op === "file") {
      // Same-type overwrite for files: unlink then recreate so size /
      // metadata reset cleanly.
      if (existing === "f") mfs.unlink(parsed.vfsPath);
      mfs.createFileWithOwner(parsed.vfsPath, mode, parsed.uid, parsed.gid, fileContent!);
    } else if (parsed.op === "dir") {
      // Same-type overwrite for dirs is idempotent: keep existing entry,
      // just update mode + ownership.
      if (existing === "d") {
        mfs.chmod(parsed.vfsPath, mode);
        mfs.chown(parsed.vfsPath, parsed.uid, parsed.gid);
      } else {
        mfs.mkdirWithOwner(parsed.vfsPath, mode, parsed.uid, parsed.gid);
      }
    } else {
      // symlink: unlink existing same-type link before recreating so the
      // target string is honestly replaced.
      if (existing === "l") mfs.unlink(parsed.vfsPath);
      mfs.symlinkWithOwner(parsed.arg!, parsed.vfsPath, parsed.uid, parsed.gid);
      // Mode on symlinks is metadata-only on most hosts; chmod here keeps
      // the bits in the image for round-trip fidelity even if --mode was
      // explicit.
      if (parsed.mode !== undefined) {
        try { mfs.chmod(parsed.vfsPath, mode); } catch { /* mfs may noop */ }
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`mkrootfs add: failed to apply: ${msg}\n`);
    return 1;
  }

  let updated: Uint8Array;
  try {
    updated = await mfs.saveImage();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`mkrootfs add: failed to serialize image: ${msg}\n`);
    return 1;
  }

  try {
    await writeAtomic(parsed.image, updated);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`mkrootfs add: failed to write ${parsed.image}: ${msg}\n`);
    return 1;
  }

  return 0;
}
