// Static validation over a parsed manifest, run before any FS work or
// archive ingestion. Catches user errors that the per-pass builder would
// otherwise surface as obscure mid-build failures (or worse, silently
// drop entries).
//
// Two surfaces are validated here:
//
//   1. Duplicate explicit paths inside the manifest itself — two node
//      entries (any combination of d/f/l/c/b) that claim the same path.
//      No deterministic resolution exists; refuse the build.
//
//   2. Archive ingestion overlaps — handled in `validateAndPlanArchives`
//      below, called by the builder once it has loaded zip indexes.
//      That function returns an extraction plan describing which archive
//      entries to skip (because an explicit f-entry overrides them) and
//      a list of audit warnings the caller can surface.
//
// The two surfaces are split because (1) is pure-text — runs immediately
// after parse, no FS — while (2) needs the zip directories already
// loaded.  Both share the same line-numbered error style.

import type {
  ManifestArchive,
  ManifestEntry,
  ManifestNode,
} from "./manifest.ts";
import type { ZipEntry } from "../../../host/src/vfs/zip";

export interface ArchiveBundle {
  archive: ManifestArchive;
  zipEntries: ZipEntry[];
}

export type ArchiveMemberKind = "directory" | "file" | "symlink";

export interface PlannedArchiveMember {
  archive: ManifestArchive;
  entry: ZipEntry;
  /** Canonical relative POSIX path from the ZIP central directory. */
  archivePath: string;
  /** Canonical absolute path where the member will be created in the VFS. */
  vfsPath: string;
  kind: ArchiveMemberKind;
  /** Manifest-normalized mode for a regular file; unused for other kinds. */
  fileMode: number;
}

export interface ArchiveExtractionPlan {
  /** Validated members, keyed by the exact manifest archive directive. */
  membersByArchive: Map<ManifestArchive, PlannedArchiveMember[]>;
  /** Per-archive set of member paths (VFS absolute) to skip during extraction. */
  skipByArchive: Map<ManifestArchive, Set<string>>;
  /** Human-readable audit lines describing every override. */
  warnings: string[];
}

/**
 * Validate the combined manifest before archives or the VFS are opened.
 * Throws on non-canonical node/base paths and duplicate node paths, citing
 * manifest line numbers in every diagnostic.
 */
export function validateManifestEntries(entries: ManifestEntry[]): void {
  // SharedFS resolves repeated separators plus "." and ".." components.
  // Reject aliases here rather than letting validation reason about a raw
  // spelling while later writes operate on a different canonical inode.
  for (const entry of entries) {
    if (entry.kind === "node") {
      validateCanonicalAbsoluteVfsPath(
        entry.path,
        `manifest path ${JSON.stringify(entry.path)} (line ${entry.lineNumber})`,
      );
    } else {
      validateCanonicalAbsoluteVfsPath(
        entry.base,
        `archive "${entry.url}" (manifest line ${entry.lineNumber}) base ${JSON.stringify(entry.base)}`,
      );
    }
  }

  const seen = new Map<string, ManifestNode>();
  for (const e of entries) {
    if (e.kind !== "node") continue;
    const prior = seen.get(e.path);
    if (prior) {
      throw new Error(
        `duplicate manifest path "${e.path}" — declared on line ${prior.lineNumber} and line ${e.lineNumber}`,
      );
    }
    seen.set(e.path, e);
  }
}

/**
 * Validate archive overlaps and produce an extraction plan.
 *
 * Errors:
 *   - non-canonical or escaping archive member paths.
 *   - duplicate non-directory paths or incompatible file types.
 *   - descendants below a regular file or symlink.
 *   - implicit f-entry (no src=) overlapping with archive content.
 *
 * Allowed (with audit warning):
 *   - explicit f-entry with src= overlapping with archive content; the
 *     manifest wins, the archive entry is filtered from extraction.
 */
export function validateAndPlanArchives(
  entries: ManifestEntry[],
  bundles: ArchiveBundle[],
): ArchiveExtractionPlan {
  const explicitNodes = new Map<string, ManifestNode>();
  for (const e of entries) {
    if (e.kind === "node") explicitNodes.set(e.path, e);
  }

  const membersByArchive = new Map<ManifestArchive, PlannedArchiveMember[]>();
  const skipByArchive = new Map<ManifestArchive, Set<string>>();
  const warnings: string[] = [];
  const archiveOwner = new Map<string, PlannedArchiveMember>();
  const allMembers: PlannedArchiveMember[] = [];

  for (const { archive, zipEntries } of bundles) {
    const base = archiveBasePrefix(archive);
    const members = zipEntries.map((entry) => planMember(archive, base, entry));
    membersByArchive.set(archive, members);
    skipByArchive.set(archive, new Set());

    for (const member of members) {
      const prior = archiveOwner.get(member.vfsPath);
      if (
        prior &&
        !(prior.kind === "directory" && member.kind === "directory")
      ) {
        if (prior.kind !== member.kind) {
          throw new Error(
            `archive type collision at "${member.vfsPath}": ${prior.kind} from ${describeMember(prior)} conflicts with ${member.kind} from ${describeMember(member)}`,
          );
        }
        throw new Error(
          `archive collision at "${member.vfsPath}": shipped by both ${describeMember(prior)} and ${describeMember(member)}`,
        );
      }
      if (!prior) archiveOwner.set(member.vfsPath, member);
      allMembers.push(member);
    }
  }

  // Reject path graphs that would make extraction traverse an archive-created
  // regular file or symlink while adding a later member.
  for (const member of allMembers) {
    for (const ancestor of ancestorPaths(member.vfsPath)) {
      const prior = archiveOwner.get(ancestor);
      if (prior && prior.kind !== "directory") {
        throw new Error(
          `archive member "${member.vfsPath}" from ${describeMember(member)} descends through archive ${prior.kind} "${ancestor}" from ${describeMember(prior)}`,
        );
      }
    }
  }

  for (const member of allMembers) {
    const skip = skipByArchive.get(member.archive)!;

    for (const ancestor of ancestorPaths(member.vfsPath)) {
      const explicitAncestor = explicitNodes.get(ancestor);
      if (explicitAncestor && explicitAncestor.type !== "d") {
        throw new Error(
          `archive member "${member.vfsPath}" from ${describeMember(member)} descends through manifest ${nodeTypeName(explicitAncestor)} "${ancestor}" (line ${explicitAncestor.lineNumber})`,
        );
      }
    }

    const explicit = explicitNodes.get(member.vfsPath);
    if (!explicit) continue;
    if (member.kind === "directory" && explicit.type === "d") continue;

    if (member.kind !== "directory" && explicit.type === "f") {
      if (!explicit.src) {
        throw new Error(
          `path "${member.vfsPath}" is declared as an implicit file (manifest line ${explicit.lineNumber}) and also shipped by archive "${member.archive.url}" (manifest line ${member.archive.lineNumber}); add src= to the manifest entry to make the override intent explicit, or remove the manifest entry to take the archive's content`,
        );
      }
      // Explicit src= override: the manifest wins. Skip during extraction
      // and surface as a warning so users can audit.
      skip.add(member.vfsPath);
      warnings.push(
        `override: "${member.vfsPath}" — manifest line ${explicit.lineNumber} (src=${explicit.src}) overrides archive "${member.archive.url}" (manifest line ${member.archive.lineNumber})`,
      );
      continue;
    }

    throw new Error(
      `path type collision at "${member.vfsPath}": archive ${member.kind} from ${describeMember(member)} conflicts with manifest ${nodeTypeName(explicit)} (line ${explicit.lineNumber})`,
    );
  }

  // Catch the inverse case: an explicit manifest path cannot live below an
  // archive file or symlink. A skipped member is absent at extraction time.
  for (const explicit of explicitNodes.values()) {
    for (const ancestor of ancestorPaths(explicit.path)) {
      const archiveAncestor = archiveOwner.get(ancestor);
      if (!archiveAncestor || archiveAncestor.kind === "directory") continue;
      if (skipByArchive.get(archiveAncestor.archive)?.has(ancestor)) continue;
      throw new Error(
        `manifest path "${explicit.path}" (line ${explicit.lineNumber}) descends through archive ${archiveAncestor.kind} "${ancestor}" from ${describeMember(archiveAncestor)}`,
      );
    }
  }

  return { membersByArchive, skipByArchive, warnings };
}

function planMember(
  archive: ManifestArchive,
  base: string,
  entry: ZipEntry,
): PlannedArchiveMember {
  const member = entry.fileName;
  const context = `archive "${archive.url}" (manifest line ${archive.lineNumber}) member ${JSON.stringify(member)}`;

  if (member.length === 0) {
    throw new Error(`${context} has an empty path`);
  }
  if (member.includes("\0")) {
    throw new Error(`${context} contains a NUL byte`);
  }
  if (member.includes("\\")) {
    throw new Error(
      `${context} contains a backslash; ZIP member paths must use POSIX separators`,
    );
  }
  if (member.startsWith("/") || /^[A-Za-z]:\//.test(member)) {
    throw new Error(`${context} must be relative, not absolute`);
  }
  if (entry.isDirectory && entry.isSymlink) {
    throw new Error(`${context} has conflicting directory and symlink types`);
  }

  const archivePath = entry.isDirectory ? member.slice(0, -1) : member;
  const segments = archivePath.split("/");
  if (
    archivePath.length === 0 ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(
      `${context} is not a canonical relative path (empty, ".", and ".." components are forbidden)`,
    );
  }

  const kind: ArchiveMemberKind = entry.isDirectory
    ? "directory"
    : entry.isSymlink
      ? "symlink"
      : "file";
  const fileMode = archiveFileMode(archive, entry);
  return {
    archive,
    entry,
    archivePath,
    vfsPath: `${base}/${archivePath}`,
    kind,
    fileMode,
  };
}

function archiveFileMode(
  archive: ManifestArchive,
  entry: ZipEntry,
): number {
  if (archive.fmodePolicy === "fixed") return archive.fmode;

  // Only a Unix central-directory entry carries authoritative POSIX mode
  // metadata. `ZipEntry.mode` has path-based compatibility defaults for other
  // creator OSes, which must not silently make archive members executable.
  const executableBits = entry.creatorOS === 3 ? entry.mode & 0o111 : 0;
  return archive.fmode | executableBits;
}

function describeMember(member: PlannedArchiveMember): string {
  return `"${member.archive.url}" (manifest line ${member.archive.lineNumber}, member ${JSON.stringify(member.entry.fileName)})`;
}

function nodeTypeName(node: ManifestNode): string {
  switch (node.type) {
    case "d": return "directory";
    case "f": return "file";
    case "l": return "symlink";
    case "c": return "character device";
    case "b": return "block device";
  }
}

function ancestorPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const ancestors = ["/"];
  let current = "";
  for (let i = 0; i < parts.length - 1; i++) {
    current += `/${parts[i]}`;
    ancestors.push(current);
  }
  return ancestors;
}

function archiveBasePrefix(archive: ManifestArchive): string {
  return archive.base === "/" ? "" : archive.base;
}

function validateCanonicalAbsoluteVfsPath(
  path: string,
  context: string,
): void {
  let valid = path.startsWith("/") && !path.includes("\0") && !path.includes("\\");
  if (valid && path !== "/") {
    const segments = path.slice(1).split("/");
    valid = segments.every(
      (segment) => segment !== "" && segment !== "." && segment !== "..",
    );
  }
  if (!valid) {
    throw new Error(`${context} is not a canonical absolute POSIX path`);
  }
}
