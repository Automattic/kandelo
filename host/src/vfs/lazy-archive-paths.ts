/**
 * Where a lazy archive's members are allowed to land, and nothing else.
 *
 * Extracted from `memory-fs.ts` unchanged, because BOTH filesystems need it and
 * neither may have its own copy. These rules are the reason an archive member
 * cannot escape its mount prefix: a path is resolved after it is joined, so a
 * member named `../../etc/passwd` would land wherever resolution took it. Two
 * implementations of that check are two chances to get it subtly different, and
 * the difference would be invisible until an archive exploited it.
 *
 * It is pure path logic — no filesystem, no inodes, no state — which is why it
 * can be shared rather than reimplemented, and why it outlives the class it was
 * extracted from.
 *
 * The `MemoryFileSystem` original planned the WHOLE archive before creating
 * even one directory, stub or symlink, so that a member rejected halfway
 * through could not leave a partial tree behind. That ordering is a property of
 * the caller, not of this module, and both callers keep it.
 */
import type { ZipEntry } from "./zip";
import { VFS_DEFERRED_TREE_LIMITS } from "./deferred-tree-limits";

const MAX_LAZY_TREE_PATH_BYTES = VFS_DEFERRED_TREE_LIMITS.maxPathBytes;

export interface PlannedLazyArchiveEntry {
  entry: ZipEntry;
  archivePath: string;
  vfsPath: string;
}

export function normalizeLazyArchiveMountPrefix(mountPrefix: unknown): string {
  if (
    typeof mountPrefix !== "string" ||
    !mountPrefix.startsWith("/") ||
    new TextEncoder().encode(mountPrefix).byteLength > MAX_LAZY_TREE_PATH_BYTES ||
    mountPrefix.includes("\0") ||
    mountPrefix.includes("\\")
  ) {
    throw new Error(
      `Lazy archive mount prefix must be an absolute POSIX path: ${JSON.stringify(mountPrefix)}`,
    );
  }
  const normalized = mountPrefix.replace(/\/+$/, "");
  if (normalized === "") return "/";
  const segments = normalized.slice(1).split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(
      `Lazy archive mount prefix is not canonical: ${JSON.stringify(mountPrefix)}`,
    );
  }
  return normalized;
}

export function planLazyArchiveEntries(
  url: string,
  zipEntries: ZipEntry[],
  mountPrefix: string,
  symlinkTargets?: Map<string, string>,
): PlannedLazyArchiveEntry[] {
  const normalizedPrefix = normalizeLazyArchiveMountPrefix(mountPrefix);
  const seen = new Map<string, ZipEntry>();
  const planned = zipEntries.map((entry): PlannedLazyArchiveEntry => {
    const member = entry.fileName;
    const context = `Lazy archive ${JSON.stringify(url)} member ${JSON.stringify(member)}`;
    if (member.length === 0) {
      throw new Error(`${context} has an empty path`);
    }
    if (member.includes("\0")) {
      throw new Error(`${context} contains a NUL byte`);
    }
    if (member.includes("\\")) {
      throw new Error(`${context} contains a backslash`);
    }
    if (member.startsWith("/") || /^[A-Za-z]:\//.test(member)) {
      throw new Error(`${context} must be relative, not absolute`);
    }
    if (entry.isDirectory && entry.isSymlink) {
      throw new Error(`${context} has conflicting directory and symlink types`);
    }
    if (entry.isDirectory !== member.endsWith("/")) {
      throw new Error(`${context} has inconsistent directory metadata`);
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
        `${context} is not a canonical relative POSIX path`,
      );
    }
    if (seen.has(archivePath)) {
      throw new Error(
        `${context} collides with another member at ${JSON.stringify(archivePath)}`,
      );
    }
    if (entry.isSymlink && !symlinkTargets?.has(member)) {
      throw new Error(`Lazy archive symlink target was not provided: ${member}`);
    }
    seen.set(archivePath, entry);
    return {
      entry,
      archivePath,
      vfsPath: normalizedPrefix === "/"
        ? `/${archivePath}`
        : `${normalizedPrefix}/${archivePath}`,
    };
  });

  for (const { archivePath } of planned) {
    const segments = archivePath.split("/");
    for (let length = 1; length < segments.length; length++) {
      const ancestorPath = segments.slice(0, length).join("/");
      const ancestor = seen.get(ancestorPath);
      if (ancestor && !ancestor.isDirectory) {
        throw new Error(
          `Lazy archive member ${JSON.stringify(archivePath)} descends ` +
            `through non-directory ${JSON.stringify(ancestorPath)}`,
        );
      }
    }
  }
  return planned;
}
