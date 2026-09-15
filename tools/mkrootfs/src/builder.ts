// Build a kandelo rootfs VFS image from a source tree + manifest.
//
// Four passes (in order) so parents exist before children, file content is
// written before per-file mode/owner is applied, and archive members land
// on top of the explicit-manifest skeleton:
//
//   1. Directories  (sorted by depth: parents first)
//   2. Regular files (implicit src=sourceTree/<path>, or explicit src=)
//   3. Symlinks
//   4. Archives (zip extraction; per-archive fmode/dmode/uid/gid normalize
//      regular-file and directory values for deterministic builds, with an
//      explicit policy for trusted Unix executable bits; Unix symlink entries
//      retain their targets)
//
// Validation (manifest path duplicates, missing source files, archive
// collisions, archive-vs-explicit overlaps) runs ahead of any FS work — see
// `./validate.ts`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SffsImageFs } from "../../../images/vfs/lib/sffs-image-fs";
import type { VfsImageMetadata } from "../../../host/src/vfs/vfs-image-filesystem";
import {
  parseZipCentralDirectory,
  extractZipEntry,
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
  type PlannedArchiveMember,
} from "./validate.ts";

const DEFAULT_SAB_SIZE = 16 * 1024 * 1024;
const DEFAULT_SOURCE_DATE_EPOCH_SECONDS = 0;
const MAX_SOURCE_DATE_EPOCH_SECONDS = Math.floor(
  Number.MAX_SAFE_INTEGER / 1000,
);
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const textEncoder = new TextEncoder();
const symlinkTargetDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

export interface BuildOptions {
  /** Absolute or repo-relative path to the implicit source tree (typically `images/rootfs/`). */
  sourceTree: string;
  /** Absolute or repo-relative path to the MANIFEST file. */
  manifest: string;
  /** Additional manifests applied after `manifest`, in order. */
  manifestFragments?: string[];
  /** Root used to resolve explicit `src=` paths and `archive` URLs. */
  repoRoot: string;
  /** Backing SharedArrayBuffer size in bytes; defaults to 16 MiB. */
  sabSize?: number;
  /** Maximum growable filesystem size in bytes; defaults to SharedFS's 4x initial cap. */
  maxSizeBytes?: number;
  /** Optional image-level declarations, such as the required kernel ABI. */
  metadata?: VfsImageMetadata;
  /**
   * Canonical inode timestamp in whole seconds since the Unix epoch. Defaults
   * to zero so identical inputs produce byte-identical images.
   */
  sourceDateEpochSeconds?: number;
  /** Optional sink for non-fatal audit messages (archive overrides, etc.). */
  onWarn?: (msg: string) => void;
}

export async function buildImage(opts: BuildOptions): Promise<Uint8Array> {
  const sourceDateEpochSeconds =
    opts.sourceDateEpochSeconds ?? DEFAULT_SOURCE_DATE_EPOCH_SECONDS;
  if (
    !Number.isSafeInteger(sourceDateEpochSeconds) ||
    sourceDateEpochSeconds < 0 ||
    sourceDateEpochSeconds > MAX_SOURCE_DATE_EPOCH_SECONDS
  ) {
    throw new Error(
      `sourceDateEpochSeconds must be an integer from 0 through ${MAX_SOURCE_DATE_EPOCH_SECONDS}`,
    );
  }

  const entries = loadManifestEntries(opts);

  // Phase 1: text-only validation (no FS). Catches duplicate manifest paths.
  validateManifestEntries(entries);

  // Phase 2: load every archive's central directory, then validate overlaps.
  // Done up-front so an archive collision aborts before any FS write.
  const archiveBundles = loadArchives(entries, opts);
  const plan = validateAndPlanArchives(entries, archiveBundles);
  for (const w of plan.warnings) opts.onWarn?.(w);

  const sabSize = opts.sabSize ?? DEFAULT_SAB_SIZE;
  if (opts.maxSizeBytes !== undefined && opts.maxSizeBytes < sabSize) {
    throw new Error("maxSizeBytes must be greater than or equal to sabSize");
  }

  // `maxSizeBytes` is a DECLARED capacity on the artifact, not an allocation.
  // The SharedArrayBuffer it used to size is gone with the memfs backing
  // store: the Rust writer builds a plan and streams it, so there is no live
  // filesystem to reserve memory for. `sabSize` survives only as the floor
  // this default is computed from, which is what every caller passing one
  // meant by it.
  const maxSizeBytes = opts.maxSizeBytes ?? sabSize * 4;
  const mfs = SffsImageFs.create();
  mfs.setImageCapacity(maxSizeBytes);

  buildDirectories(mfs, entries);
  buildFiles(mfs, entries, opts);
  buildSymlinks(mfs, entries);
  buildArchives(mfs, archiveBundles, plan);

  // The declared capacity is a PROMISE about the artifact, so it is checked
  // before the artifact exists rather than discovered while writing it.
  //
  // It used to be checked by accident: the memfs backing store was a
  // SharedArrayBuffer of exactly this size, so an oversized tree ran out of
  // buffer and a file came up short. That produced a real refusal from an
  // allocation failure, which is a guarantee only for as long as the writer
  // happens to allocate. The Rust writer plans and streams, so nothing runs
  // out — and without this the same manifest would have produced a 2.4 MB
  // image declaring a 1 MB capacity, silently.
  //
  // The check is against the EMITTED artifact, because that is what the
  // promise is about: an image whose declared growth ceiling is below its own
  // size declares a ceiling under its floor, and every consumer that sizes a
  // buffer from that declaration is then wrong. The message carries both
  // numbers, because a caller told only "too big" cannot tell whether to raise
  // the cap or shrink the tree.
  const image = await mfs.saveImage({
    metadata: opts.metadata,
    normalizeTimestampsMs: sourceDateEpochSeconds * 1000,
  });
  if (image.byteLength > maxSizeBytes) {
    throw new Error(
      `image does not fit its declared capacity: ${image.byteLength} bytes emitted, `
        + `${maxSizeBytes} declared (maxSizeBytes)`,
    );
  }
  return image;
}

function loadManifestEntries(opts: BuildOptions): ManifestEntry[] {
  const manifestPaths = [opts.manifest, ...(opts.manifestFragments ?? [])];
  return manifestPaths.flatMap((manifestPath) => {
    const resolvedManifestPath = resolve(manifestPath);
    const manifestText = readFileSync(resolvedManifestPath, "utf8");
    return parseManifest(manifestText, resolvedManifestPath);
  });
}

function buildDirectories(mfs: SffsImageFs, entries: ManifestEntry[]): void {
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
  mfs: SffsImageFs,
  entries: ManifestEntry[],
  opts: BuildOptions,
): void {
  const files = entries.filter(
    (e): e is ManifestNode => e.kind === "node" && e.type === "f",
  );
  for (const f of files) {
    if (f.lazyUrl !== undefined) {
      mfs.registerLazyFile(f.path, f.lazyUrl, f.lazySize ?? 0, f.mode, f.lazyDigest);
      mfs.chown(f.path, f.uid, f.gid);
      mfs.chmod(f.path, f.mode);
      continue;
    }
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

function buildSymlinks(mfs: SffsImageFs, entries: ManifestEntry[]): void {
  const symlinks = entries.filter(
    (e): e is ManifestNode => e.kind === "node" && e.type === "l",
  );
  for (const l of symlinks) {
    // The parser guarantees target is set for type=l; assert for typing.
    if (!l.target) throw new Error(`internal: symlink ${l.path} missing target`);
    mfs.symlink(l.target, l.path, l.uid, l.gid);
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
  mfs: SffsImageFs,
  archives: LoadedArchive[],
  plan: ArchiveExtractionPlan,
): void {
  for (const loaded of archives) {
    const members = plan.membersByArchive.get(loaded.archive);
    const skip = plan.skipByArchive.get(loaded.archive);
    if (!members || !skip) {
      throw new Error(
        `internal: archive "${loaded.archive.url}" has no validated extraction plan`,
      );
    }
    extractArchive(mfs, loaded.zipBytes, members, loaded.archive, skip);
  }
}

function extractArchive(
  mfs: SffsImageFs,
  zipBytes: Uint8Array,
  members: PlannedArchiveMember[],
  a: ManifestArchive,
  skipPaths: Set<string>,
): void {
  // Directories must land first so parents exist before regular files and
  // symlinks. The planner has already rejected every non-canonical or unsafe
  // path graph, so extraction never normalizes archive-supplied names.
  const directories = members
    .filter((member) => member.kind === "directory")
    .sort((x, y) => depth(x.vfsPath) - depth(y.vfsPath));
  const files = members.filter((member) => member.kind === "file");
  const symlinks = members.filter((member) => member.kind === "symlink");

  for (const member of directories) {
    if (existsAt(mfs, member.vfsPath)) {
      requireDirectory(mfs, member.vfsPath, a);
      continue;
    }
    mfs.mkdirWithOwner(member.vfsPath, a.dmode, a.uid, a.gid);
  }

  for (const member of files) {
    if (skipPaths.has(member.vfsPath)) continue;
    ensureParentDirs(mfs, member.vfsPath, a);
    const content = extractZipEntry(zipBytes, member.entry);
    mfs.createFileWithOwner(member.vfsPath, member.fileMode, a.uid, a.gid, content);
  }

  for (const member of symlinks) {
    if (skipPaths.has(member.vfsPath)) continue;
    ensureParentDirs(mfs, member.vfsPath, a);
    const targetBytes = extractZipEntry(zipBytes, member.entry);
    const target = decodeSymlinkTarget(targetBytes, member);
    mfs.symlink(target, member.vfsPath, a.uid, a.gid);
  }
}

function decodeSymlinkTarget(
  bytes: Uint8Array,
  member: PlannedArchiveMember,
): string {
  const context = `archive symlink "${member.vfsPath}" (member ${JSON.stringify(member.entry.fileName)})`;
  if (bytes.byteLength === 0) {
    throw new Error(`${context} has an empty target`);
  }
  if (bytes.includes(0)) {
    throw new Error(`${context} target contains a NUL byte`);
  }

  let target: string;
  try {
    target = symlinkTargetDecoder.decode(bytes);
  } catch {
    throw new Error(`${context} target is not valid UTF-8`);
  }

  const roundTrip = textEncoder.encode(target);
  if (!bytesEqual(bytes, roundTrip)) {
    throw new Error(`${context} target cannot be preserved byte-for-byte`);
  }
  return target;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function ensureParentDirs(
  mfs: SffsImageFs,
  filePath: string,
  a: ManifestArchive,
): void {
  const parts = filePath.split("/").filter(Boolean);
  parts.pop(); // drop the file component
  let cur = "";
  for (const part of parts) {
    cur += "/" + part;
    if (existsAt(mfs, cur)) {
      requireDirectory(mfs, cur, a);
      continue;
    }
    mfs.mkdirWithOwner(cur, a.dmode, a.uid, a.gid);
  }
}

function requireDirectory(
  mfs: SffsImageFs,
  path: string,
  a: ManifestArchive,
): void {
  const st = mfs.lstat(path);
  if ((st.mode & S_IFMT) !== S_IFDIR) {
    throw new Error(
      `archive "${a.url}" cannot create a member below "${path}": existing path is not a directory`,
    );
  }
}

function existsAt(mfs: SffsImageFs, path: string): boolean {
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
