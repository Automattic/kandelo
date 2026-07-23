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

const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;
const S_IFLNK = 0xa000;
const MAX_OWNER_ID = 0xffff_ffff;
const PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9+._-]*$/;
const OUTPUT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9+._-]*$/;
const TREE_ID_RE = /^[a-z0-9][a-z0-9+._/-]*$/;
const textEncoder = new TextEncoder();

export interface PackageDeferredZipTreeSpec {
  schema: 1;
  kind: "kandelo-package-deferred-zip-tree";
  id: string;
  /** Distribution meaning; source trees are not package/bottle payloads. */
  content_role: "source-tree" | "runtime-tree";
  package: {
    name: string;
    output: string;
  };
  archive: {
    url: string;
    mode_policy: "portable-posix-v1";
  };
  mount_prefix: string;
  owner: {
    uid: number;
    gid: number;
  };
  activation: LazyTreeActivation;
}

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

/** Parse the reviewable recipe without trusting unknown fields or host paths. */
export function parsePackageDeferredZipTreeSpec(
  value: unknown,
): PackageDeferredZipTreeSpec {
  const record = exactRecord(value, [
    "schema",
    "kind",
    "id",
    "content_role",
    "package",
    "archive",
    "mount_prefix",
    "owner",
    "activation",
  ], "package deferred ZIP tree spec");
  const packageRecord = exactRecord(
    record.package,
    ["name", "output"],
    "package deferred ZIP tree package",
  );
  const archive = exactRecord(
    record.archive,
    ["url", "mode_policy"],
    "package deferred ZIP tree archive",
  );
  const owner = exactRecord(
    record.owner,
    ["uid", "gid"],
    "package deferred ZIP tree owner",
  );
  const activation = exactRecord(
    record.activation,
    ["mode", "capabilities", "roots"],
    "package deferred ZIP tree activation",
  );
  if (
    record.schema !== 1 ||
    record.kind !== "kandelo-package-deferred-zip-tree" ||
    typeof record.id !== "string" || !TREE_ID_RE.test(record.id) ||
    utf8Length(record.id) > 255 ||
    record.id.includes("//") || record.id.endsWith("/") ||
    (record.content_role !== "source-tree" && record.content_role !== "runtime-tree") ||
    typeof packageRecord.name !== "string" ||
      !PACKAGE_NAME_RE.test(packageRecord.name) || utf8Length(packageRecord.name) > 255 ||
    typeof packageRecord.output !== "string" ||
      !OUTPUT_NAME_RE.test(packageRecord.output) || utf8Length(packageRecord.output) > 255 ||
    typeof archive.url !== "string" || !isRelativeAssetUrl(archive.url) ||
    archive.url !== packageRecord.output ||
    archive.mode_policy !== "portable-posix-v1" ||
    typeof record.mount_prefix !== "string" ||
      utf8Length(record.mount_prefix) > VFS_DEFERRED_TREE_LIMITS.maxPathBytes ||
      canonicalAbsolutePath(record.mount_prefix, true) !== record.mount_prefix ||
    !isOwnerId(owner.uid) || !isOwnerId(owner.gid) ||
    (activation.mode !== "first-use" && activation.mode !== "boot-prefetch") ||
    !Array.isArray(activation.capabilities) || activation.capabilities.length === 0 ||
    activation.capabilities.length >
      VFS_DEFERRED_TREE_LIMITS.maxActivationCapabilities ||
    !activation.capabilities.every((capability) =>
      typeof capability === "string" &&
      utf8Length(capability) <= VFS_DEFERRED_TREE_LIMITS.maxActivationCapabilityBytes &&
      /^[a-z0-9][a-z0-9:._-]*$/.test(capability)
    ) ||
    new Set(activation.capabilities).size !== activation.capabilities.length ||
    !Array.isArray(activation.roots) || activation.roots.length === 0 ||
    activation.roots.length > VFS_DEFERRED_TREE_LIMITS.maxActivationRoots ||
    !activation.roots.every((root) =>
      typeof root === "string" &&
      utf8Length(root) <= VFS_DEFERRED_TREE_LIMITS.maxPathBytes &&
      canonicalAbsolutePath(root, true) === root
    ) ||
    new Set(activation.roots).size !== activation.roots.length
  ) {
    throw new Error("package deferred ZIP tree spec is invalid");
  }
  for (const root of activation.roots as string[]) {
    if (
      record.mount_prefix !== "/" &&
      root !== record.mount_prefix &&
      !root.startsWith(`${record.mount_prefix}/`)
    ) {
      throw new Error(`package deferred ZIP tree activation root escapes its mount: ${root}`);
    }
  }
  return {
    schema: 1,
    kind: "kandelo-package-deferred-zip-tree",
    id: record.id,
    content_role: record.content_role,
    package: {
      name: packageRecord.name,
      output: packageRecord.output,
    },
    archive: {
      url: archive.url,
      mode_policy: "portable-posix-v1",
    },
    mount_prefix: record.mount_prefix,
    owner: { uid: owner.uid, gid: owner.gid },
    activation: {
      mode: activation.mode,
      capabilities: [...activation.capabilities] as string[],
      roots: [...activation.roots] as string[],
    },
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
  );
  for (const entry of derived.entries) {
    fs.lchown(
      entry.vfsPath,
      derived.descriptor.owner.uid,
      derived.descriptor.owner.gid,
    );
  }
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
    if (
      tree.mountPrefix !== derived.descriptor.mount_prefix ||
      JSON.stringify(tree.content) !== JSON.stringify(derived.content) ||
      JSON.stringify(tree.inventory) !== JSON.stringify(derived.entries) ||
      JSON.stringify(tree.activation) !== JSON.stringify(derived.descriptor.activation)
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
  for (const path of orderedPaths) {
    let existing;
    try {
      existing = fs.lstat(path);
    } catch {
      continue;
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

function exactRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(record).sort()) !==
      JSON.stringify([...fields].sort())
  ) {
    throw new Error(`${label} has unsupported fields`);
  }
  return record;
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

function canonicalAbsolutePath(value: string, allowRoot: boolean): string | null {
  if (allowRoot && value === "/") return value;
  if (
    !value.startsWith("/") || value.endsWith("/") || value.includes("\\") ||
    value.includes("\0") ||
    value.slice(1).split("/").some((segment) =>
      segment === "" || segment === "." || segment === ".."
    )
  ) return null;
  return value;
}

function isRelativeAssetUrl(value: string): boolean {
  return (
    value.length > 0 && value.length <= 255 && !value.startsWith("/") &&
    !value.includes("\\") && !value.includes("\0") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(value) &&
    value.split("/").every((segment) =>
      segment !== "" && segment !== "." && segment !== ".."
    )
  );
}

function isOwnerId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 &&
    (value as number) <= MAX_OWNER_ID;
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
