import { createHash } from "node:crypto";

import {
  derivePackageDeferredZipTree,
  type DerivedPackageDeferredZipTree,
} from "./vfs/package-deferred-tree";
import {
  HOMEBREW_PORTABLE_RUBY_OUTPUT,
  HOMEBREW_PORTABLE_RUBY_TREE_ID,
  homebrewPortableRubyExecutable,
  homebrewPortableRubyMountPrefix,
  readHomebrewPortableRubyVersion,
} from "./homebrew-portable-ruby-contract";

/**
 * Derive Homebrew's ordinary vendor/portable-ruby tree from the exact source
 * tree that names its required version.
 *
 * The source descriptor owns the guest prefix. Deriving every portable-Ruby
 * path from that descriptor keeps this valid for both compatibility images and
 * the canonical product without teaching the runtime either concrete prefix.
 */
export function deriveHomebrewPortableRubyTree(
  sourceTree: DerivedPackageDeferredZipTree,
  sourceArchiveBytes: Uint8Array,
  portableRubyArchiveBytes: Uint8Array,
): DerivedPackageDeferredZipTree {
  const source = sourceTree.descriptor;
  const atomicGroup = source.activation.atomicGroup;
  if (
    source.content_role !== "source-tree" ||
    source.package.name !== "homebrew-bootstrap" ||
    source.package.output !== "homebrew-bootstrap.zip" ||
    source.activation.mode !== "first-use" ||
    atomicGroup === undefined
  ) {
    throw new Error(
      "Homebrew portable Ruby requires an atomic deferred bootstrap source tree",
    );
  }
  if (
    sourceArchiveBytes.byteLength !== sourceTree.content.bytes ||
    !bytesEqualSha256(sourceArchiveBytes, sourceTree.content.sha256)
  ) {
    throw new Error("Homebrew bootstrap source bytes changed identity");
  }

  const version = readHomebrewPortableRubyVersion(sourceArchiveBytes);
  const mountPrefix = homebrewPortableRubyMountPrefix(source.mount_prefix);
  const rubyPath = homebrewPortableRubyExecutable(
    source.mount_prefix,
    version,
  );
  const derived = derivePackageDeferredZipTree(
    {
      schema: 1,
      kind: "kandelo-package-deferred-zip-tree",
      id: HOMEBREW_PORTABLE_RUBY_TREE_ID,
      content_role: "runtime-tree",
      package: {
        name: source.package.name,
        output: HOMEBREW_PORTABLE_RUBY_OUTPUT,
      },
      archive: {
        url: HOMEBREW_PORTABLE_RUBY_OUTPUT,
        mode_policy: "portable-posix-v1",
      },
      mount_prefix: mountPrefix,
      owner: { ...source.owner },
      activation: {
        mode: "first-use",
        capabilities: ["homebrew:runtime"],
        // The ZIP owns the real versioned executable. `current` is its normal
        // upstream symlink and resolves to this same deferred inode on access.
        roots: [rubyPath],
        atomic_group: atomicGroup.id,
      },
    },
    portableRubyArchiveBytes,
  );
  assertPortableRubyInventory(derived, version, mountPrefix, rubyPath);
  return derived;
}

function assertPortableRubyInventory(
  tree: DerivedPackageDeferredZipTree,
  version: string,
  mountPrefix: string,
  rubyPath: string,
): void {
  const currentPath = `${mountPrefix}/current`;
  const current = tree.entries.find((entry) => entry.vfsPath === currentPath);
  const ruby = tree.entries.find((entry) => entry.vfsPath === rubyPath);
  if (
    current?.type !== "symlink" ||
    current.target !== version ||
    ruby?.type !== "file" ||
    (ruby.mode & 0o111) === 0 ||
    ruby.size <= 0
  ) {
    throw new Error(
      "Homebrew portable Ruby archive does not expose its source-matched executable",
    );
  }
  const allowedTopLevel = new Set([version, "current"]);
  if (
    tree.entries.some((entry) => {
      const relative = entry.vfsPath.slice(mountPrefix.length + 1);
      return !allowedTopLevel.has(relative.split("/", 1)[0]!);
    })
  ) {
    throw new Error("Homebrew portable Ruby archive has an unexpected root");
  }
}

function bytesEqualSha256(bytes: Uint8Array, expected: string): boolean {
  // Avoid a second archive parser/descriptor implementation: the exact bytes
  // must bind to the already-derived source tree before cross-output checks.
  return createHash("sha256").update(bytes).digest("hex") === expected;
}
