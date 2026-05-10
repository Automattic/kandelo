// Build a wasm-posix-kernel rootfs VFS image from a source tree + manifest.
//
// Four passes (in order) so parents exist before children, file content is
// written before per-file mode/owner is applied, and archive members land
// on top of the explicit-manifest skeleton:
//
//   1. Directories  (sorted by depth: parents first)
//   2. Regular files (implicit src=sourceTree/<path>, or explicit src=)
//   3. Symlinks
//   4. Archives (zip extraction; per-archive fmode/dmode/uid/gid override
//      the zip's embedded values for deterministic builds)
//
// Validation (manifest path duplicates, missing source files, archive
// collisions, archive-vs-explicit overlaps) runs ahead of any FS work — see
// `./validate.ts`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  parseZipCentralDirectory,
  extractZipEntry,
  type ZipEntry,
} from "../../../host/src/vfs/zip";
import {
  parseManifest,
  type ManifestArchive,
  type ManifestEntry,
  type ManifestNode,
} from "./manifest.ts";
import {
  validateManifestEntries,
  validateAndPlanArchives,
  type ArchiveBundle,
  type ArchiveExtractionPlan,
} from "./validate.ts";

const DEFAULT_SAB_SIZE = 16 * 1024 * 1024;

export interface BuildOptions {
  /** Absolute or repo-relative path to the implicit source tree (typically `rootfs/`). */
  sourceTree: string;
  /** Absolute or repo-relative path to the MANIFEST file. */
  manifest: string;
  /** Root used to resolve explicit `src=` paths and `archive` URLs. */
  repoRoot: string;
  /** Backing SharedArrayBuffer size in bytes; defaults to 16 MiB. */
  sabSize?: number;
  /** Optional sink for non-fatal audit messages (archive overrides, etc.). */
  onWarn?: (msg: string) => void;
}

export async function buildImage(opts: BuildOptions): Promise<Uint8Array> {
  const manifestText = readFileSync(resolve(opts.manifest), "utf8");
  const entries = parseManifest(manifestText, opts.manifest);

  // Phase 1: text-only validation (no FS). Catches duplicate manifest paths.
  validateManifestEntries(entries);

  // Phase 2: load every archive's central directory, then validate overlaps.
  // Done up-front so an archive collision aborts before any FS write.
  const archiveBundles = loadArchives(entries, opts);
  const plan = validateAndPlanArchives(entries, archiveBundles);
  for (const w of plan.warnings) opts.onWarn?.(w);

  const sab = new SharedArrayBuffer(opts.sabSize ?? DEFAULT_SAB_SIZE);
  const mfs = MemoryFileSystem.create(sab);

  buildDirectories(mfs, entries);
  buildFiles(mfs, entries, opts);
  buildSymlinks(mfs, entries);
  buildArchives(mfs, archiveBundles, plan);

  return await mfs.saveImage();
}

function buildDirectories(mfs: MemoryFileSystem, entries: ManifestEntry[]): void {
  const dirs = entries.filter(
    (e): e is ManifestNode => e.kind === "node" && e.type === "d",
  );
  dirs.sort((a, b) => depth(a.path) - depth(b.path));
  for (const d of dirs) {
    if (d.path === "/") continue; // root is implicit
    mfs.mkdirWithOwner(d.path, d.mode, d.uid, d.gid);
  }
}

function buildFiles(
  mfs: MemoryFileSystem,
  entries: ManifestEntry[],
  opts: BuildOptions,
): void {
  const files = entries.filter(
    (e): e is ManifestNode => e.kind === "node" && e.type === "f",
  );
  for (const f of files) {
    const sourcePath = f.src
      ? resolve(opts.repoRoot, f.src)
      : resolve(opts.sourceTree, f.path.replace(/^\//, ""));
    let content: Uint8Array;
    try {
      content = new Uint8Array(readFileSync(sourcePath));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `manifest line ${f.lineNumber}: source file not found: ${sourcePath}`,
        );
      }
      throw e;
    }
    mfs.createFileWithOwner(f.path, f.mode, f.uid, f.gid, content);
  }
}

function buildSymlinks(mfs: MemoryFileSystem, entries: ManifestEntry[]): void {
  const symlinks = entries.filter(
    (e): e is ManifestNode => e.kind === "node" && e.type === "l",
  );
  for (const l of symlinks) {
    // The parser guarantees target is set for type=l; assert for typing.
    if (!l.target) throw new Error(`internal: symlink ${l.path} missing target`);
    mfs.symlinkWithOwner(l.target, l.path, l.uid, l.gid);
  }
}

interface LoadedArchive extends ArchiveBundle {
  zipBytes: Uint8Array;
}

function loadArchives(
  entries: ManifestEntry[],
  opts: BuildOptions,
): LoadedArchive[] {
  const archives = entries.filter(
    (e): e is ManifestArchive => e.kind === "archive",
  );
  const out: LoadedArchive[] = [];
  for (const a of archives) {
    const archivePath = resolve(opts.repoRoot, a.url);
    let zipBytes: Uint8Array;
    try {
      zipBytes = new Uint8Array(readFileSync(archivePath));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `manifest line ${a.lineNumber}: archive not found: ${archivePath}`,
        );
      }
      throw e;
    }
    const zipEntries = parseZipCentralDirectory(zipBytes);
    out.push({ archive: a, zipBytes, zipEntries });
  }
  return out;
}

function buildArchives(
  mfs: MemoryFileSystem,
  archives: LoadedArchive[],
  plan: ArchiveExtractionPlan,
): void {
  for (const loaded of archives) {
    const skip =
      plan.skipByArchiveUrl.get(loaded.archive.url) ?? new Set<string>();
    extractArchive(mfs, loaded.zipBytes, loaded.zipEntries, loaded.archive, skip);
  }
}

function extractArchive(
  mfs: MemoryFileSystem,
  zipBytes: Uint8Array,
  zipEntries: ZipEntry[],
  a: ManifestArchive,
  skipPaths: Set<string>,
): void {
  // Strip trailing slash on base so concatenation produces a clean path;
  // base="/" becomes "" so "/" + entry.fileName works.
  const base = a.base === "/" ? "" : a.base.replace(/\/+$/, "");

  // Two passes inside the archive: directories first (sorted by depth) so
  // parent dirs exist before their files. Tolerate leading-/ in entries.
  const dirEntries: ZipEntry[] = [];
  const fileEntries: ZipEntry[] = [];
  for (const ze of zipEntries) {
    const cleaned = { ...ze, fileName: ze.fileName.replace(/^\/+/, "") };
    if (cleaned.isDirectory) dirEntries.push(cleaned);
    else fileEntries.push(cleaned);
  }
  dirEntries.sort((x, y) => depth(x.fileName) - depth(y.fileName));

  for (const ze of dirEntries) {
    const vfsPath = base + "/" + ze.fileName.replace(/\/+$/, "");
    if (vfsPath === "" || existsAt(mfs, vfsPath)) continue;
    mfs.mkdirWithOwner(vfsPath, a.dmode, a.uid, a.gid);
  }

  for (const ze of fileEntries) {
    const vfsPath = base + "/" + ze.fileName;
    if (skipPaths.has(vfsPath)) continue;
    ensureParentDirs(mfs, vfsPath, a);
    const content = extractZipEntry(zipBytes, ze);
    mfs.createFileWithOwner(vfsPath, a.fmode, a.uid, a.gid, content);
  }
}

function ensureParentDirs(
  mfs: MemoryFileSystem,
  filePath: string,
  a: ManifestArchive,
): void {
  const parts = filePath.split("/").filter(Boolean);
  parts.pop(); // drop the file component
  let cur = "";
  for (const part of parts) {
    cur += "/" + part;
    if (existsAt(mfs, cur)) continue;
    mfs.mkdirWithOwner(cur, a.dmode, a.uid, a.gid);
  }
}

function existsAt(mfs: MemoryFileSystem, path: string): boolean {
  try {
    mfs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

function depth(p: string): number {
  return p.split("/").filter(Boolean).length;
}
