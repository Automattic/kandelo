import type {
  LazyFileEntry,
  MemoryFileSystem,
} from "../../../../host/src/vfs/memory-fs";
import {
  NODE_LAZY_BINARY_SPEC,
  shellLazyPlaceholderUrl,
} from "../../../../images/vfs/lib/init/shell-binaries";

const NODE_COMPATIBILITY_ALIAS = "/usr/bin/spidermonkey-node";

/**
 * Bind the image-owned lazy Node executable to its browser asset.
 *
 * The VFS image, not the demo page, owns Node and the surrounding shell. This
 * helper may rewrite transport metadata and add the historical command alias,
 * but it must never replace the executable stub or materialize its bytes.
 */
export function bindImageOwnedNodeRuntime(
  fs: MemoryFileSystem,
  assetUrl: string,
): void {
  const before = requireNodeLazyEntry(fs);
  const placeholder = shellLazyPlaceholderUrl(NODE_LAZY_BINARY_SPEC);
  if (before.url !== placeholder && before.url !== assetUrl) {
    throw new Error(
      `image-owned Node lazy entry has an unexpected URL: ${before.url}`,
    );
  }

  ensureCompatibilityAlias(fs);
  fs.rewriteLazyFileUrls((url, path) =>
    path === NODE_LAZY_BINARY_SPEC.vfsPath && url === placeholder
      ? assetUrl
      : url
  );

  const after = requireNodeLazyEntry(fs);
  assertSameLazyIdentity(before, after);
  if (after.url !== assetUrl) {
    throw new Error("image-owned Node lazy entry was not bound to its browser asset");
  }
}

function requireNodeLazyEntry(fs: MemoryFileSystem): LazyFileEntry {
  const entry = fs.getLazyEntry(NODE_LAZY_BINARY_SPEC.vfsPath);
  if (!entry) {
    throw new Error(
      `VFS image must own deferred ${NODE_LAZY_BINARY_SPEC.vfsPath}`,
    );
  }
  return entry;
}

function assertSameLazyIdentity(
  before: LazyFileEntry,
  after: LazyFileEntry,
): void {
  if (
    before.ino !== after.ino ||
    before.generation !== after.generation ||
    before.dataSequence !== after.dataSequence ||
    before.path !== after.path ||
    before.size !== after.size ||
    !sameStrings(before.paths ?? [before.path], after.paths ?? [after.path])
  ) {
    throw new Error(
      "binding the image-owned Node asset changed its lazy filesystem identity",
    );
  }
}

function ensureCompatibilityAlias(fs: MemoryFileSystem): void {
  try {
    const stat = fs.lstat(NODE_COMPATIBILITY_ALIAS);
    if (
      (stat.mode & 0xf000) !== 0xa000 ||
      fs.readlink(NODE_COMPATIBILITY_ALIAS) !==
        NODE_LAZY_BINARY_SPEC.vfsPath
    ) {
      throw new Error(
        `${NODE_COMPATIBILITY_ALIAS} conflicts with the image-owned Node runtime`,
      );
    }
  } catch (error) {
    if (!isMissingVfsPath(error)) throw error;
    // WHY: older sealed node-vfs artifacts predate this compatibility alias.
    // Adding a namespace alias preserves their command surface without
    // replacing or eagerly materializing the image-owned Node executable.
    fs.symlink(NODE_LAZY_BINARY_SPEC.vfsPath, NODE_COMPATIBILITY_ALIAS);
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function isMissingVfsPath(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === -2 || code === "ENOENT") return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\bENOENT\b/.test(message) ||
    message.includes("No such file or directory");
}
