import { createHash } from "node:crypto";

import {
  MemoryFileSystem,
  type DeferredTreeMaterializationHandle,
  type LazyTreeActivation,
  type LazyTreeContent,
  type LazyTreeRegistrationEntry,
} from "./memory-fs";
import {
  extractZipEntryBounded,
  parseZipCentralDirectory,
  type ZipEntry,
} from "./zip";
import { VFS_DEFERRED_TREE_LIMITS } from "./deferred-tree-limits";
import {
  parsePackageDeferredZipTreeSpec,
  type PackageDeferredZipTreeSpec,
} from "./package-deferred-tree-contract";
import { ENOENT, SFSError } from "./sharedfs-vendor";
export {
  parsePackageDeferredZipTreeSpec,
  type PackageDeferredZipTreeSpec,
} from "./package-deferred-tree-contract";

const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;
const S_IFLNK = 0xa000;
const textEncoder = new TextEncoder();

export interface PackageDeferredZipTreeDescriptor {
  schema: 1;
  kind: "kandelo-package-deferred-zip-tree";
  id: string;
  content_role: PackageDeferredZipTreeSpec["content_role"];
  package: PackageDeferredZipTreeSpec["package"];
  archive: PackageDeferredZipTreeSpec["archive"] & {
    decoder: "zip-v1";
    media_type: "application/zip";
    sha256: string;
    bytes: number;
    expanded_bytes: number;
    source_entry_count: number;
  };
  mount_prefix: string;
  owner: PackageDeferredZipTreeSpec["owner"];
  activation: LazyTreeActivation;
  inventory: Array<{
    vfs_path: string;
    source_path: string;
    type: "directory" | "file" | "symlink";
    mode: number;
    size: number;
    target?: string;
    inode_group?: string;
  }>;
}

export interface DerivedPackageDeferredZipTree {
  descriptor: PackageDeferredZipTreeDescriptor;
  descriptorBytes: Uint8Array;
  descriptorSha256: string;
  content: LazyTreeContent;
  entries: LazyTreeRegistrationEntry[];
}

export interface RegisteredPackageDeferredZipTree extends
  DerivedPackageDeferredZipTree {
  materialization: DeferredTreeMaterializationHandle;
}

export interface PackageDeferredZipTreeDescriptorExpectation {
  id: string;
  package: {
    name: string;
    output: string;
  };
  archive: {
    sha256: string;
    bytes: number;
    reference: string;
  };
}

/**
 * Derive the complete typed-tree contract from one exact package output.
 * The returned descriptor is the only recipe used by lazy registration and
 * build-time eager materialization.
 */
export function derivePackageDeferredZipTree(
  specValue: unknown,
  archiveBytes: Uint8Array,
): DerivedPackageDeferredZipTree {
  const spec = parsePackageDeferredZipTreeSpec(specValue);
  if (!(archiveBytes instanceof Uint8Array) || archiveBytes.byteLength === 0) {
    throw new Error("package deferred ZIP tree archive is empty");
  }
  if (archiveBytes.byteLength > VFS_DEFERRED_TREE_LIMITS.maxArchiveBytes) {
    throw new Error("package deferred ZIP tree archive exceeds the byte limit");
  }
  const zipEntries = parseZipCentralDirectory(archiveBytes);
  if (zipEntries.length === 0) {
    throw new Error("package deferred ZIP tree archive has no entries");
  }
  if (zipEntries.length > VFS_DEFERRED_TREE_LIMITS.maxEntries) {
    throw new Error("package deferred ZIP tree archive has too many entries");
  }
  const expandedBytes = zipEntries.reduce((total, entry) => {
    const next = total + entry.uncompressedSize;
    if (
      !Number.isSafeInteger(next) ||
      next > VFS_DEFERRED_TREE_LIMITS.maxExpandedBytes
    ) {
      throw new Error("package deferred ZIP tree expanded size exceeds the limit");
    }
    return next;
  }, 0);
  const entries = zipEntries.map((entry, index) =>
    deriveEntry(spec, archiveBytes, entry, index)
  );
  assertCompleteDirectoryInventory(spec.mount_prefix, entries);
  const sha256 = createHash("sha256").update(archiveBytes).digest("hex");
  const content: LazyTreeContent = {
    decoder: "zip-v1",
    mediaType: "application/zip",
    sha256,
    bytes: archiveBytes.byteLength,
    expandedBytes,
    sourceEntryCount: zipEntries.length,
    transports: [spec.archive.url],
    modePolicy: spec.archive.mode_policy,
  };
  const descriptor: PackageDeferredZipTreeDescriptor = {
    schema: 1,
    kind: "kandelo-package-deferred-zip-tree",
    id: spec.id,
    content_role: spec.content_role,
    package: { ...spec.package },
    archive: {
      ...spec.archive,
      decoder: "zip-v1",
      media_type: "application/zip",
      sha256,
      bytes: archiveBytes.byteLength,
      expanded_bytes: expandedBytes,
      source_entry_count: zipEntries.length,
    },
    mount_prefix: spec.mount_prefix,
    owner: { ...spec.owner },
    activation: {
      mode: spec.activation.mode,
      capabilities: [...spec.activation.capabilities],
      roots: [...spec.activation.roots],
      ...(spec.activation.atomicGroup === undefined
        ? {}
        : {
            atomicGroup: {
              ...spec.activation.atomicGroup,
            },
          }),
    },
    inventory: entries.map((entry) => ({
      vfs_path: entry.vfsPath,
      source_path: entry.sourcePath,
      type: entry.type as "directory" | "file" | "symlink",
      mode: entry.mode,
      size: entry.size,
      ...(entry.target === undefined ? {} : { target: entry.target }),
      ...(entry.inodeGroup === undefined ? {} : { inode_group: entry.inodeGroup }),
    })),
  };
  const descriptorBytes = canonicalJsonBytes(descriptor);
  return {
    descriptor,
    descriptorBytes,
    descriptorSha256: createHash("sha256").update(descriptorBytes).digest("hex"),
    content,
    entries,
  };
}

/**
 * Restore the trusted lazy-tree recipe without opening the package archive.
 *
 * The descriptor remains producer evidence. The caller-provided archive
 * identity is authoritative for both the content digest and the immutable
 * transport selected by the current product build.
 */
export function parsePackageDeferredZipTreeDescriptor(
  value: unknown,
  expected: PackageDeferredZipTreeDescriptorExpectation,
): DerivedPackageDeferredZipTree {
  const descriptor = exactDescriptorRecord(value, [
    "schema",
    "kind",
    "id",
    "content_role",
    "package",
    "archive",
    "mount_prefix",
    "owner",
    "activation",
    "inventory",
  ], "package deferred ZIP tree descriptor");
  const packageValue = exactDescriptorRecord(
    descriptor.package,
    ["name", "output"],
    "package deferred ZIP tree descriptor package",
  );
  const archive = exactDescriptorRecord(
    descriptor.archive,
    [
      "url",
      "mode_policy",
      "decoder",
      "media_type",
      "sha256",
      "bytes",
      "expanded_bytes",
      "source_entry_count",
    ],
    "package deferred ZIP tree descriptor archive",
  );
  const activationValue = exactDescriptorRecord(
    descriptor.activation,
    [
      "mode",
      "capabilities",
      "roots",
      ...(hasOwn(descriptor.activation, "atomicGroup") ? ["atomicGroup"] : []),
    ],
    "package deferred ZIP tree descriptor activation",
  );
  const atomicGroupValue = activationValue.atomicGroup === undefined
    ? undefined
    : exactDescriptorRecord(
      activationValue.atomicGroup,
      ["id", "member"],
      "package deferred ZIP tree descriptor atomic group",
    );
  if (
    atomicGroupValue !== undefined &&
    atomicGroupValue.member !== descriptor.id
  ) {
    throw new Error("package deferred ZIP tree descriptor atomic member changed");
  }
  const spec = parsePackageDeferredZipTreeSpec({
    schema: descriptor.schema,
    kind: descriptor.kind,
    id: descriptor.id,
    content_role: descriptor.content_role,
    package: packageValue,
    archive: {
      url: archive.url,
      mode_policy: archive.mode_policy,
    },
    mount_prefix: descriptor.mount_prefix,
    owner: descriptor.owner,
    activation: {
      mode: activationValue.mode,
      capabilities: activationValue.capabilities,
      roots: activationValue.roots,
      ...(atomicGroupValue === undefined
        ? {}
        : { atomic_group: atomicGroupValue.id }),
    },
  });
  if (
    spec.id !== expected.id ||
    spec.package.name !== expected.package.name ||
    spec.package.output !== expected.package.output
  ) {
    throw new Error("package deferred ZIP tree descriptor identity changed");
  }
  if (
    archive.decoder !== "zip-v1" ||
    archive.media_type !== "application/zip" ||
    archive.mode_policy !== "portable-posix-v1" ||
    archive.sha256 !== expected.archive.sha256 ||
    archive.bytes !== expected.archive.bytes ||
    !isSha256(archive.sha256) ||
    !boundedInteger(
      archive.bytes,
      1,
      VFS_DEFERRED_TREE_LIMITS.maxArchiveBytes,
    ) ||
    !boundedInteger(
      archive.expanded_bytes,
      0,
      VFS_DEFERRED_TREE_LIMITS.maxExpandedBytes,
    ) ||
    !boundedInteger(
      archive.source_entry_count,
      1,
      VFS_DEFERRED_TREE_LIMITS.maxEntries,
    )
  ) {
    throw new Error("package deferred ZIP tree descriptor archive identity changed");
  }
  if (
    typeof expected.archive.reference !== "string" ||
    !expected.archive.reference.startsWith("https://") ||
    expected.archive.reference.length > VFS_DEFERRED_TREE_LIMITS.maxStringBytes ||
    !expected.archive.reference.includes(`sha256=${expected.archive.sha256}`) &&
      !expected.archive.reference.includes(`sha256:${expected.archive.sha256}`)
  ) {
    throw new Error("package deferred ZIP tree archive reference is not immutable HTTPS");
  }
  if (
    !Array.isArray(descriptor.inventory) ||
    descriptor.inventory.length !== archive.source_entry_count
  ) {
    throw new Error("package deferred ZIP tree descriptor inventory count changed");
  }
  const seenVfsPaths = new Set<string>();
  const seenSourcePaths = new Set<string>();
  let expandedBytes = 0;
  const entries = descriptor.inventory.map((raw, index): LazyTreeRegistrationEntry => {
    const initial = descriptorRecord(raw, `package deferred ZIP tree inventory ${index}`);
    const type = initial.type;
    const fields = type === "directory"
      ? ["vfs_path", "source_path", "type", "mode", "size"]
      : type === "file"
      ? ["vfs_path", "source_path", "type", "mode", "size", "inode_group"]
      : type === "symlink"
      ? ["vfs_path", "source_path", "type", "mode", "size", "target"]
      : [];
    if (fields.length === 0) {
      throw new Error(`package deferred ZIP tree inventory ${index} type is invalid`);
    }
    const item = exactDescriptorRecord(
      raw,
      fields,
      `package deferred ZIP tree inventory ${index}`,
    );
    const vfsPath = canonicalDescriptorAbsolutePath(
      item.vfs_path,
      `package deferred ZIP tree inventory ${index} VFS path`,
    );
    const sourcePath = canonicalDescriptorRelativePath(
      item.source_path,
      `package deferred ZIP tree inventory ${index} source path`,
    );
    if (
      spec.mount_prefix !== "/" &&
      vfsPath !== spec.mount_prefix &&
      !vfsPath.startsWith(`${spec.mount_prefix}/`)
    ) {
      throw new Error(`package deferred ZIP tree inventory ${vfsPath} escapes its mount`);
    }
    if (seenVfsPaths.has(vfsPath) || seenSourcePaths.has(sourcePath)) {
      throw new Error("package deferred ZIP tree descriptor inventory repeats a path");
    }
    seenVfsPaths.add(vfsPath);
    seenSourcePaths.add(sourcePath);
    const size = descriptorInteger(
      item.size,
      0,
      VFS_DEFERRED_TREE_LIMITS.maxExpandedBytes,
      `package deferred ZIP tree inventory ${vfsPath} size`,
    );
    const mode = descriptorInteger(
      item.mode,
      0,
      0o7777,
      `package deferred ZIP tree inventory ${vfsPath} mode`,
    );
    expandedBytes += size;
    if (
      !Number.isSafeInteger(expandedBytes) ||
      expandedBytes > VFS_DEFERRED_TREE_LIMITS.maxExpandedBytes
    ) {
      throw new Error("package deferred ZIP tree descriptor expansion exceeds its limit");
    }
    if (type === "directory") {
      if (size !== 0 || mode !== 0o755) {
        throw new Error(`package deferred ZIP tree directory ${vfsPath} changed`);
      }
      return { vfsPath, sourcePath, type, mode, size };
    }
    if (type === "symlink") {
      if (
        mode !== 0o777 ||
        typeof item.target !== "string" ||
        item.target.length === 0 ||
        item.target.includes("\0") ||
        utf8Length(item.target) !== size ||
        size > VFS_DEFERRED_TREE_LIMITS.maxSymlinkTargetBytes
      ) {
        throw new Error(`package deferred ZIP tree symlink ${vfsPath} changed`);
      }
      return {
        vfsPath,
        sourcePath,
        type,
        mode,
        size,
        target: item.target,
      };
    }
    if (
      (mode !== 0o644 && mode !== 0o755) ||
      item.inode_group !== `zip:${sourcePath}`
    ) {
      throw new Error(`package deferred ZIP tree file ${vfsPath} changed`);
    }
    return {
      vfsPath,
      sourcePath,
      type,
      mode,
      size,
      inodeGroup: item.inode_group,
    };
  });
  if (expandedBytes !== archive.expanded_bytes) {
    throw new Error("package deferred ZIP tree descriptor expansion changed");
  }
  assertCompleteDirectoryInventory(spec.mount_prefix, entries);
  for (const root of spec.activation.roots) {
    if (!entries.some((entry) =>
      entry.vfsPath === root || entry.vfsPath.startsWith(`${root}/`)
    )) {
      throw new Error(`package deferred ZIP tree activation root ${root} is absent`);
    }
  }
  const checkedDescriptor = descriptor as unknown as PackageDeferredZipTreeDescriptor;
  const descriptorBytes = canonicalJsonBytes(checkedDescriptor);
  return {
    descriptor: checkedDescriptor,
    descriptorBytes,
    descriptorSha256: createHash("sha256").update(descriptorBytes).digest("hex"),
    content: {
      decoder: "zip-v1",
      mediaType: "application/zip",
      sha256: expected.archive.sha256,
      bytes: expected.archive.bytes,
      expandedBytes: archive.expanded_bytes,
      sourceEntryCount: archive.source_entry_count,
      transports: [expected.archive.reference],
      modePolicy: "portable-posix-v1",
    },
    entries,
  };
}

/** Register one derived package tree and preserve its declared POSIX owner. */
export function registerPackageDeferredZipTree(
  fs: MemoryFileSystem,
  derived: DerivedPackageDeferredZipTree,
): RegisteredPackageDeferredZipTree {
  preflightNamespace(fs, derived.descriptor, derived.entries);
  const materialization = fs.registerLazyTreeWithMaterializationHandle(
    derived.content,
    derived.entries,
    derived.descriptor.mount_prefix,
    derived.descriptor.activation,
    derived.descriptor.owner,
  );
  return { ...derived, materialization };
}

/** Materialize the same registered descriptor from its exact package bytes. */
export async function materializePackageDeferredZipTree(
  fs: MemoryFileSystem,
  registered: RegisteredPackageDeferredZipTree,
  archiveBytes: Uint8Array,
): Promise<void> {
  if (
    archiveBytes.byteLength !== registered.content.bytes ||
    createHash("sha256").update(archiveBytes).digest("hex") !==
      registered.content.sha256
  ) {
    throw new Error("package deferred ZIP tree materialization bytes changed identity");
  }
  if (!await fs.materializeRegisteredDeferredTree(
    registered.materialization,
    archiveBytes,
  )) {
    throw new Error("package deferred ZIP tree was already materialized");
  }
}

/** Prove the same descriptor survived either lazy serialization or eager pour. */
export function assertPackageDeferredZipTreeState(
  fs: MemoryFileSystem,
  derived: DerivedPackageDeferredZipTree,
  expected: "deferred" | "materialized",
): void {
  const matching = fs.exportLazyArchiveEntries().filter((tree) =>
    tree.content?.sha256 === derived.content.sha256 &&
    tree.content.bytes === derived.content.bytes
  );
  if (expected === "deferred") {
    if (matching.length !== 1) {
      throw new Error(
        `package deferred ZIP tree ${derived.descriptor.id} is not pending exactly once`,
      );
    }
    const tree = matching[0]!;
    const actualActivation = tree.activation === undefined
      ? undefined
      : {
          ...tree.activation,
          ...(tree.activation.atomicGroup === undefined
            ? {}
            : {
                // WHY: sealing adds cohort-wide integrity fields after the
                // producer descriptor is derived. Membership is the stable
                // package contract; export validation proves the added seal.
                atomicGroup: {
                  id: tree.activation.atomicGroup.id,
                  member: tree.activation.atomicGroup.member,
                },
              }),
        };
    if (
      tree.mountPrefix !== derived.descriptor.mount_prefix ||
      JSON.stringify(tree.content) !== JSON.stringify(derived.content) ||
      JSON.stringify(tree.inventory) !== JSON.stringify(derived.entries) ||
      JSON.stringify(actualActivation) !==
        JSON.stringify(derived.descriptor.activation)
    ) {
      throw new Error(
        `package deferred ZIP tree ${derived.descriptor.id} changed descriptor`,
      );
    }
  } else if (matching.length !== 0) {
    throw new Error(
      `materialized package ZIP tree ${derived.descriptor.id} remains pending`,
    );
  }

  for (const entry of derived.entries) {
    const stat = fs.lstat(entry.vfsPath);
    const expectedType = entry.type === "directory"
      ? S_IFDIR
      : entry.type === "symlink"
        ? S_IFLNK
        : S_IFREG;
    if (
      (stat.mode & S_IFMT) !== expectedType ||
      (stat.mode & 0o7777) !== entry.mode ||
      stat.uid !== derived.descriptor.owner.uid ||
      stat.gid !== derived.descriptor.owner.gid ||
      (entry.type !== "directory" && stat.size !== entry.size) ||
      (entry.type === "file" &&
        fs.isPathDeferred(entry.vfsPath) !== (expected === "deferred")) ||
      (entry.type === "symlink" && fs.readlink(entry.vfsPath) !== entry.target)
    ) {
      throw new Error(
        `package deferred ZIP tree ${derived.descriptor.id} changed ${entry.vfsPath}`,
      );
    }
  }
}

function deriveEntry(
  spec: PackageDeferredZipTreeSpec,
  archiveBytes: Uint8Array,
  entry: ZipEntry,
  index: number,
): LazyTreeRegistrationEntry {
  if (entry.isDirectory !== entry.fileName.endsWith("/")) {
    throw new Error(`package deferred ZIP entry ${index} has inconsistent directory metadata`);
  }
  const sourcePath = canonicalRelativePath(
    entry.isDirectory ? entry.fileName.slice(0, -1) : entry.fileName,
  );
  const vfsPath = spec.mount_prefix === "/"
    ? `/${sourcePath}`
    : `${spec.mount_prefix}/${sourcePath}`;
  const fileType = entry.creatorOS === 3 ? entry.mode & S_IFMT : 0;
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new Error(
      `package deferred ZIP entry ${sourcePath} uses unsupported compression`,
    );
  }
  if (
    fileType !== 0 && fileType !== S_IFREG && fileType !== S_IFDIR &&
    fileType !== S_IFLNK
  ) {
    throw new Error(`package deferred ZIP entry ${sourcePath} has unsupported file type`);
  }
  if (entry.isDirectory) {
    if (fileType !== 0 && fileType !== S_IFDIR || entry.uncompressedSize !== 0) {
      throw new Error(`package deferred ZIP directory ${sourcePath} is invalid`);
    }
    extractZipEntryBounded(archiveBytes, entry, 0);
    return {
      vfsPath,
      sourcePath,
      type: "directory",
      mode: 0o755,
      size: 0,
    };
  }
  if (entry.isSymlink) {
    if (fileType !== S_IFLNK) {
      throw new Error(`package deferred ZIP symlink ${sourcePath} is invalid`);
    }
    if (
      entry.uncompressedSize > VFS_DEFERRED_TREE_LIMITS.maxSymlinkTargetBytes
    ) {
      throw new Error(
        `package deferred ZIP symlink ${sourcePath} target is too large`,
      );
    }
    const targetBytes = extractZipEntryBounded(
      archiveBytes,
      entry,
      entry.uncompressedSize,
    );
    if (targetBytes.byteLength === 0 || targetBytes.includes(0)) {
      throw new Error(`package deferred ZIP symlink ${sourcePath} has an invalid target`);
    }
    let target: string;
    try {
      target = new TextDecoder("utf-8", { fatal: true }).decode(targetBytes);
    } catch (error) {
      throw new Error(
        `package deferred ZIP symlink ${sourcePath} target is not UTF-8`,
        { cause: error },
      );
    }
    if (!bytesEqual(targetBytes, new TextEncoder().encode(target))) {
      throw new Error(
        `package deferred ZIP symlink ${sourcePath} target is not byte-preserving`,
      );
    }
    // WHY: a symlink target is guest namespace text, not an archive extraction
    // path. Registration creates the link itself without following it, and
    // packages legitimately use absolute or parent-relative links to reach
    // files supplied by the base image or a dependency.
    return {
      vfsPath,
      sourcePath,
      type: "symlink",
      mode: 0o777,
      size: targetBytes.byteLength,
      target,
    };
  }
  if (fileType !== 0 && fileType !== S_IFREG) {
    throw new Error(`package deferred ZIP file ${sourcePath} is invalid`);
  }
  extractZipEntryBounded(archiveBytes, entry, entry.uncompressedSize);
  // WHY: producer umasks and host-specific permission bits are not part of the
  // package contract. Preserve executability while giving eager and lazy
  // materialization the same portable mode.
  const executable = (entry.mode & 0o111) !== 0;
  return {
    vfsPath,
    sourcePath,
    type: "file",
    mode: executable ? 0o755 : 0o644,
    size: entry.uncompressedSize,
    inodeGroup: `zip:${sourcePath}`,
  };
}

function assertCompleteDirectoryInventory(
  mountPrefix: string,
  entries: readonly LazyTreeRegistrationEntry[],
): void {
  const paths = new Set(entries.map((entry) => entry.vfsPath));
  const types = new Map(entries.map((entry) => [entry.vfsPath, entry.type]));
  if (paths.size !== entries.length) {
    throw new Error("package deferred ZIP tree contains duplicate paths");
  }
  for (const entry of entries) {
    let parent = entry.vfsPath.slice(0, entry.vfsPath.lastIndexOf("/")) || "/";
    while (parent !== "/" && parent !== mountPrefix) {
      if (!paths.has(parent) || types.get(parent) !== "directory") {
        throw new Error(
          `package deferred ZIP tree omits directory entry ${parent}`,
        );
      }
      parent = parent.slice(0, parent.lastIndexOf("/")) || "/";
    }
  }
}

function preflightNamespace(
  fs: MemoryFileSystem,
  descriptor: PackageDeferredZipTreeDescriptor,
  entries: readonly LazyTreeRegistrationEntry[],
): void {
  const entryByPath = new Map(entries.map((entry) => [entry.vfsPath, entry]));
  const requiredPaths = new Set<string>();
  for (const entry of entries) {
    let path = entry.vfsPath;
    while (path !== "/") {
      requiredPaths.add(path);
      path = path.slice(0, path.lastIndexOf("/")) || "/";
    }
  }
  const orderedPaths = [...requiredPaths].sort((left, right) =>
    left.split("/").length - right.split("/").length ||
    compareUnicodeScalars(left, right)
  );
  // WHY: reject the whole layer before registration mutates the namespace.
  // Existing directories are shareable only when their package-visible
  // ownership and mode agree, so a layer cannot silently rewrite the base.
  for (const path of orderedPaths) {
    let existing;
    try {
      existing = fs.lstat(path);
    } catch (error) {
      if (error instanceof SFSError && error.code === ENOENT) continue;
      throw error;
    }
    const entry = entryByPath.get(path);
    if (entry === undefined) {
      if ((existing.mode & S_IFMT) !== S_IFDIR) {
        throw new Error(
          `package deferred ZIP tree ancestor collides at ${path}`,
        );
      }
      continue;
    }
    if (
      entry.type !== "directory" ||
      (existing.mode & S_IFMT) !== S_IFDIR ||
      (existing.mode & 0o7777) !== entry.mode ||
      existing.uid !== descriptor.owner.uid ||
      existing.gid !== descriptor.owner.gid
    ) {
      throw new Error(
        `package deferred ZIP tree collides with the base at ${path}`,
      );
    }
  }
}

function canonicalRelativePath(value: string): string {
  if (
    value.length === 0 || value.startsWith("/") || value.includes("\\") ||
    value.includes("\0") ||
    utf8Length(value) > VFS_DEFERRED_TREE_LIMITS.maxPathBytes ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`package deferred ZIP member is not a canonical relative path: ${value}`);
  }
  return value;
}

function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(sortJson(value))}\n`);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareUnicodeScalars(left, right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function compareUnicodeScalars(left: string, right: string): number {
  const leftScalars = Array.from(left, (value) => value.codePointAt(0)!);
  const rightScalars = Array.from(right, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(leftScalars.length, rightScalars.length); index++) {
    if (leftScalars[index] !== rightScalars[index]) {
      return leftScalars[index]! < rightScalars[index]! ? -1 : 1;
    }
  }
  return leftScalars.length - rightScalars.length;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}

function utf8Length(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function descriptorRecord(value: unknown, label: string): Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, any>;
}

function exactDescriptorRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, any> {
  const record = descriptorRecord(value, label);
  const actual = Object.keys(record).sort(compareUnicodeScalars);
  const expected = [...fields].sort(compareUnicodeScalars);
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error(`${label} has unsupported fields`);
  }
  return record;
}

function hasOwn(value: unknown, field: string): boolean {
  return typeof value === "object" && value !== null &&
    Object.prototype.hasOwnProperty.call(value, field);
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return Number.isSafeInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= maximum;
}

function descriptorInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!boundedInteger(value, minimum, maximum)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function canonicalDescriptorAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value === "/" ||
    !value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    utf8Length(value) > VFS_DEFERRED_TREE_LIMITS.maxPathBytes ||
    value.slice(1).split("/").some((component) =>
      component === "" || component === "." || component === ".."
    )
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function canonicalDescriptorRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  try {
    return canonicalRelativePath(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
}
