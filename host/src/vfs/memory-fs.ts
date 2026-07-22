import { decompress as zstdDecompress } from "fzstd";
import type { PathconfValue, StatResult, StatfsResult } from "../types";
import { filesystemPathconf } from "../pathconf";
import { SFFS_SUPER_MAGIC } from "../statfs";
import type { FileSystemBackend, DirEntry } from "./types";
import {
  O_CREAT,
  O_EXCL,
  O_TRUNC,
  SharedFS,
  type NamespaceEntryIdentity,
  type SharedFsIdentityState,
  type StatResult as SfsStatResult,
} from "./sharedfs-vendor";
import type { ZipEntry } from "./zip";
import { resolveHardlinkGraph } from "./hardlink-graph";
import {
  assertVfsDeferredTreeCollectionUsage,
  VFS_DEFERRED_TREE_COLLECTION_LIMITS,
  VFS_DEFERRED_TREE_LIMITS,
  type VfsDeferredTreeUsage,
} from "./deferred-tree-limits";
import {
  parseHomebrewInstallReceiptRelocation,
  relocateHomebrewBottleFile,
} from "../homebrew-bottle-relocation";

/** Serializable lazy file entry for transfer between instances. */
export interface LazyFileEntry {
  ino: number;
  /** Inode-slot generation; omitted only by legacy serialized metadata. */
  generation?: number;
  /** Inode data-mutation sequence; omitted only by legacy metadata. */
  dataSequence?: number;
  path: string;
  /** All hard-link names for this inode; omitted by legacy metadata. */
  paths?: string[];
  url: string;
  size: number;
}

export type LazyDownloadKind = "file" | "tree" | "archive";
export type LazyDownloadStatus = "started" | "progress" | "complete" | "error";

export interface LazyDownloadEvent {
  id: string;
  kind: LazyDownloadKind;
  status: LazyDownloadStatus;
  url: string;
  path?: string;
  mountPrefix?: string;
  loadedBytes: number;
  totalBytes?: number;
  error?: string;
  t: number;
}

export type LazyDownloadListener = (event: LazyDownloadEvent) => void;

type LazyFetch = (url: string) => Promise<Response>;

interface LazyPreparation {
  status: "pending" | "fulfilled" | "rejected";
  promise: Promise<boolean>;
  error?: unknown;
}

interface LazyBacking {
  token: object;
  path: string;
  /** Metadata-only trees have no pending inode, so prepare the group itself. */
  directGroup?: LazyArchiveGroup;
}

/** Per-file metadata for a file inside a lazy archive. */
export interface LazyArchiveFileEntry {
  ino: number;
  /** Inode-slot generation; omitted only by legacy serialized metadata. */
  generation?: number;
  /** Inode data-mutation sequence; omitted only by legacy metadata. */
  dataSequence?: number;
  size: number;
  isSymlink: boolean;
  deleted: boolean;
  /** True once this inode's archive backing is no longer pending. */
  materialized?: boolean;
  /** Original path inside the archive (stable across VFS rename/hard-link). */
  archivePath?: string;
  sourcePath?: string;
  type?: "file" | "symlink" | "hardlink";
  inodeGroup?: string;
  target?: string;
}

/** Optional immutable identity for a remotely fetched lazy archive. */
export interface LazyArchiveIntegrity {
  sha256: string;
  bytes: number;
}

/** Closed decoder set for an immutable deferred filesystem tree. */
export type LazyTreeDecoder = "zip-v1" | "homebrew-bottle-tar-gzip-v1";

export interface LazyTreeContent {
  decoder: LazyTreeDecoder;
  mediaType:
    | "application/zip"
    | "application/vnd.oci.image.layer.v1.tar+gzip";
  sha256: string;
  bytes: number;
  /** Exact decoder expansion bound declared by the trusted inventory. */
  expandedBytes: number;
  sourceEntryCount: number;
  /** Byte-identical transport mirrors, tried in declared order. */
  transports: string[];
  /** Complete source-member truth for a byte-identical original bottle. */
  source?: LazyTreeSourceInventory;
}

export interface LazyTreeSourceEntry {
  sourcePath: string;
  type: "directory" | "file" | "symlink" | "hardlink";
  mode: number;
  size: number;
  target?: string;
}

export interface LazyTreeSourceInventory {
  schema: 1;
  kind: "homebrew-bottle-tar-gzip-v1";
  entries: LazyTreeSourceEntry[];
}

export interface LazyTreeRegistrationEntry {
  /** Absolute, canonical VFS path. */
  vfsPath: string;
  /** Canonical member path interpreted by the selected decoder. */
  sourcePath: string;
  /** Explicit only for the original-bottle source-inventory contract. */
  materialization?:
    | "archive"
    | "archive-homebrew-relocate"
    | "archive-copy"
    | "archive-copy-mode"
    | "descriptor";
  type: "directory" | "file" | "symlink" | "hardlink";
  mode: number;
  /** Logical guest size; hard links repeat their canonical file's size. */
  size: number;
  /** Symlink text, or an absolute VFS target for a hard link. */
  target?: string;
  /** Required on files and hardlinks; equal values share one inode. */
  inodeGroup?: string;
}

export interface LazyTreeActivation {
  mode: "boot-prefetch" | "first-use";
  capabilities: string[];
  roots: string[];
}

/**
 * A group of files whose content comes from a single zip archive.
 * Accessing any member materializes the entire archive in one fetch.
 */
export interface LazyArchiveGroup {
  /** Format-neutral immutable content and transport identity. */
  content?: LazyTreeContent;
  /** @deprecated compatibility field for legacy serialized ZIP groups. */
  url: string;
  mountPrefix: string;
  integrity?: LazyArchiveIntegrity;
  materialized: boolean;
  /** Complete trusted source-to-namespace inventory for generic trees. */
  inventory?: LazyTreeRegistrationEntry[];
  activation?: LazyTreeActivation;
  entries: Map<string, LazyArchiveFileEntry>; // keyed by VFS absolute path
}

/** JSON-serializable form of LazyArchiveGroup for cross-worker transfer. */
export interface SerializedLazyArchiveEntry {
  /** Closed wire identity; legacy snapshots without it are migration-only. */
  kind:
    | "kandelo-legacy-zip-v1"
    | "kandelo-deferred-tree-v1"
    | "kandelo-deferred-tree-v2";
  content?: LazyTreeContent;
  inventory?: LazyTreeRegistrationEntry[];
  activation?: LazyTreeActivation;
  url: string;
  mountPrefix: string;
  integrity?: LazyArchiveIntegrity;
  materialized: boolean;
  entries: Array<{
    vfsPath: string;
    ino: number;
    generation?: number;
    dataSequence?: number;
    size: number;
    isSymlink: boolean;
    deleted: boolean;
    materialized?: boolean;
    archivePath?: string;
    sourcePath?: string;
    type?: "file" | "symlink" | "hardlink";
    inodeGroup?: string;
    target?: string;
  }>;
}

/** Format-neutral names for the runtime and serialized deferred-tree contract. */
export type LazyTreeGroup = LazyArchiveGroup;
export type SerializedLazyTree = SerializedLazyArchiveEntry;

const DEFERRED_TREE_MATERIALIZATION_HANDLE: unique symbol = Symbol(
  "DeferredTreeMaterializationHandle",
);

/** Opaque authority for one typed tree registered on one exact filesystem. */
export interface DeferredTreeMaterializationHandle {
  readonly [DEFERRED_TREE_MATERIALIZATION_HANDLE]: true;
}

/** Options for saving a VFS image. */
export interface VfsImageOptions {
  /**
   * If true, fetch and write all lazy file contents before saving.
   * The resulting image is self-contained with no external URL dependencies.
   * If false (default), lazy file metadata is preserved as-is.
   */
  materializeAll?: boolean;
  /**
   * Optional image-level metadata. `undefined` preserves any metadata loaded
   * from the source image; `null` clears it.
   */
  metadata?: VfsImageMetadata | null;
  /**
   * Replace every allocated inode's atime, mtime, and ctime in the serialized
   * snapshot with this millisecond value. The live filesystem is unchanged.
   * Omit this for ordinary runtime snapshots that must preserve POSIX times.
   */
  normalizeTimestampsMs?: number;
}

/** Versioned, image-level declarations carried outside the guest file tree. */
export interface VfsImageMetadata {
  version: 1;
  /**
   * Exact kernel ABI this image expects when it carries ABI-bound artifacts
   * such as wasm-posix user programs. Omit for data-only images.
   */
  kernelAbi?: number;
  /** Free-form builder id, e.g. "mkrootfs 0.1.0" or a package script name. */
  createdBy?: string;
  /** Preserve forwards compatibility for future signed/provenance fields. */
  [key: string]: unknown;
}

export interface VfsImageCapacity {
  /** Serialized SharedArrayBuffer length carried by the image. */
  byteLength: number;
  /** Filesystem growth ceiling declared by the image superblock. */
  maxByteLength: number;
}

// zstd frame magic (little-endian on the wire: 28 B5 2F FD).
// fromImage() auto-detects this and decompresses transparently so callers
// don't have to know whether the bytes came from a `.vfs` or `.vfs.zst`.
const ZSTD_MAGIC_BYTES = [0x28, 0xb5, 0x2f, 0xfd];

// VFS image binary format constants
const VFS_IMAGE_MAGIC = 0x56465349; // "VFSI"
const VFS_IMAGE_VERSION = 1;
const VFS_IMAGE_FLAG_HAS_LAZY = 1 << 0;
const VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES = 1 << 1;
const VFS_IMAGE_FLAG_HAS_METADATA = 1 << 2;
const VFS_IMAGE_FLAG_HAS_TYPED_LAZY_ARCHIVES = 1 << 3;
const VFS_IMAGE_HEADER_SIZE = 16; // magic(4) + version(4) + flags(4) + sabLen(4)
const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;
const S_IFLNK = 0xa000;
const O_RDONLY = 0x0000;
const O_WRONLY_CREAT_TRUNC = 0o1101;
const COPY_CHUNK_BYTES = 1024 * 1024;
const MIN_REBASE_INITIAL_BYTES = 16 * 1024 * 1024;
const VFS_IMAGE_MAX_METADATA_BYTES = 64 * 1024;
const VFS_IMAGE_MAX_LAZY_METADATA_BYTES = 16 * 1024 * 1024;
const VFS_IMAGE_MAX_LAZY_ARCHIVE_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_LAZY_ARCHIVE_BYTES = VFS_DEFERRED_TREE_LIMITS.maxArchiveBytes;
const MAX_LAZY_EXPANDED_BYTES = VFS_DEFERRED_TREE_LIMITS.maxExpandedBytes;
const MAX_LAZY_PAYLOAD_BYTES = VFS_DEFERRED_TREE_LIMITS.maxPayloadBytes;
const MAX_BOOT_DEFERRED_TREE_CONCURRENCY = 2;
const MAX_LAZY_TREE_ENTRIES = VFS_DEFERRED_TREE_LIMITS.maxEntries;
const MAX_LAZY_TREE_GROUPS = VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxGroups;
const MAX_LAZY_TREE_PATH_BYTES = VFS_DEFERRED_TREE_LIMITS.maxPathBytes;
const MAX_LAZY_TREE_SYMLINK_TARGET_BYTES =
  VFS_DEFERRED_TREE_LIMITS.maxSymlinkTargetBytes;
const MAX_LAZY_TREE_STRING_BYTES = VFS_DEFERRED_TREE_LIMITS.maxStringBytes;
const MAX_LAZY_TREE_CAPABILITIES =
  VFS_DEFERRED_TREE_LIMITS.maxActivationCapabilities;
const MAX_LAZY_TREE_ACTIVATION_ROOTS =
  VFS_DEFERRED_TREE_LIMITS.maxActivationRoots;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SERIALIZED_LEGACY_ARCHIVE_KIND = "kandelo-legacy-zip-v1";
const SERIALIZED_DEFERRED_TREE_V1_KIND = "kandelo-deferred-tree-v1";
const SERIALIZED_DEFERRED_TREE_V2_KIND = "kandelo-deferred-tree-v2";

interface PlannedLazyArchiveEntry {
  entry: ZipEntry;
  archivePath: string;
  vfsPath: string;
}

function normalizeLazyArchiveMountPrefix(mountPrefix: unknown): string {
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

function planLazyArchiveEntries(
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

function cloneMetadata(
  metadata: VfsImageMetadata | null,
): VfsImageMetadata | null {
  return metadata === null ? null : { ...metadata };
}

function validateMetadata(metadata: VfsImageMetadata): VfsImageMetadata {
  if (!metadata || typeof metadata !== "object") {
    throw new Error("VFS image metadata must be an object");
  }
  if (metadata.version !== 1) {
    throw new Error(
      `Unsupported VFS image metadata version: ${String(metadata.version)}`,
    );
  }
  if (
    metadata.kernelAbi !== undefined &&
    (!Number.isInteger(metadata.kernelAbi) || metadata.kernelAbi < 0)
  ) {
    throw new Error(
      `VFS image metadata kernelAbi must be a non-negative integer`,
    );
  }
  if (
    metadata.createdBy !== undefined &&
    typeof metadata.createdBy !== "string"
  ) {
    throw new Error("VFS image metadata createdBy must be a string");
  }
  return { ...metadata };
}

function decodeMetadata(bytes: Uint8Array): VfsImageMetadata {
  if (bytes.byteLength > VFS_IMAGE_MAX_METADATA_BYTES) {
    throw new Error(
      `VFS image metadata exceeds ${VFS_IMAGE_MAX_METADATA_BYTES} bytes`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid VFS image metadata JSON: ${msg}`);
  }
  return validateMetadata(parsed as VfsImageMetadata);
}

function encodeMetadata(metadata: VfsImageMetadata | null): Uint8Array {
  if (metadata === null) return new Uint8Array(0);
  const normalized = validateMetadata(metadata);
  const bytes = new TextEncoder().encode(JSON.stringify(normalized));
  if (bytes.byteLength > VFS_IMAGE_MAX_METADATA_BYTES) {
    throw new Error(
      `VFS image metadata exceeds ${VFS_IMAGE_MAX_METADATA_BYTES} bytes`,
    );
  }
  return bytes;
}

function maybeDecompressImage(image: Uint8Array): Uint8Array {
  if (
    image.byteLength >= ZSTD_MAGIC_BYTES.length &&
    image[0] === ZSTD_MAGIC_BYTES[0] &&
    image[1] === ZSTD_MAGIC_BYTES[1] &&
    image[2] === ZSTD_MAGIC_BYTES[2] &&
    image[3] === ZSTD_MAGIC_BYTES[3]
  ) {
    return decompressZstd(image);
  }
  return image;
}

interface ParsedImageHeader {
  image: Uint8Array;
  view: DataView;
  flags: number;
  sabLen: number;
}

function parseImageHeader(input: Uint8Array): ParsedImageHeader {
  const image = maybeDecompressImage(input);

  if (image.byteLength < VFS_IMAGE_HEADER_SIZE) {
    throw new Error("VFS image too small");
  }

  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== VFS_IMAGE_MAGIC) {
    throw new Error(
      `Bad VFS image magic: 0x${magic.toString(16)} (expected 0x${VFS_IMAGE_MAGIC.toString(16)})`,
    );
  }
  const version = view.getUint32(4, true);
  if (version !== VFS_IMAGE_VERSION) {
    throw new Error(
      `Unsupported VFS image version: ${version} (expected ${VFS_IMAGE_VERSION})`,
    );
  }
  const flags = view.getUint32(8, true);
  const sabLen = view.getUint32(12, true);

  if (image.byteLength < VFS_IMAGE_HEADER_SIZE + sabLen + 4) {
    throw new Error("VFS image truncated");
  }

  return { image, view, flags, sabLen };
}

function sectionOffsetAfterArchives(
  image: Uint8Array,
  view: DataView,
  flags: number,
  sabLen: number,
): { lazyLen: number; archiveOffset: number; metadataOffset: number } {
  const lazyOffset = VFS_IMAGE_HEADER_SIZE + sabLen;
  const lazyLen = view.getUint32(lazyOffset, true);
  if (lazyLen > VFS_IMAGE_MAX_LAZY_METADATA_BYTES) {
    throw new Error(
      `VFS image lazy metadata exceeds ${VFS_IMAGE_MAX_LAZY_METADATA_BYTES} bytes`,
    );
  }
  if (image.byteLength < lazyOffset + 4 + lazyLen) {
    throw new Error("VFS image truncated (lazy metadata section)");
  }
  const archiveOffset = lazyOffset + 4 + lazyLen;
  let metadataOffset = archiveOffset;

  if (flags & VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES) {
    if (image.byteLength < archiveOffset + 4) {
      throw new Error("VFS image truncated (lazy archive section)");
    }
    const archiveLen = view.getUint32(archiveOffset, true);
    if (archiveLen > VFS_IMAGE_MAX_LAZY_ARCHIVE_METADATA_BYTES) {
      throw new Error(
        `VFS image lazy archive metadata exceeds ` +
          `${VFS_IMAGE_MAX_LAZY_ARCHIVE_METADATA_BYTES} bytes`,
      );
    }
    if (image.byteLength < archiveOffset + 4 + archiveLen) {
      throw new Error("VFS image truncated (lazy archive payload)");
    }
    metadataOffset = archiveOffset + 4 + archiveLen;
  }

  return { lazyLen, archiveOffset, metadataOffset };
}

function decodeJsonSection(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid UTF-8 JSON: ${detail}`);
  }
}

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function parseContentLength(headers: Headers | undefined): number | undefined {
  const encoding = headers?.get("content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity") return undefined;
  const raw = headers?.get("content-length");
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function validateLazyArchiveIntegrity(
  value: unknown,
): LazyArchiveIntegrity | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Lazy archive integrity must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !("sha256" in record) ||
    !("bytes" in record)
  ) {
    throw new Error("Lazy archive integrity has unexpected fields");
  }
  if (typeof record.sha256 !== "string" || !SHA256_RE.test(record.sha256)) {
    throw new Error("Lazy archive integrity has an invalid SHA-256 digest");
  }
  if (
    !Number.isSafeInteger(record.bytes) ||
    Number(record.bytes) <= 0 ||
    Number(record.bytes) > MAX_LAZY_ARCHIVE_BYTES
  ) {
    throw new Error(
      `Lazy archive integrity byte count must be between 1 and ` +
        `${MAX_LAZY_ARCHIVE_BYTES}`,
    );
  }
  return { sha256: record.sha256, bytes: Number(record.bytes) };
}

function exactLazyTreeRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
  return record;
}

function boundedLazyTreeRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
  return record;
}

function requireLazyTreeArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must contain ${minimum} to ${maximum} items`);
  }
  return value;
}

function requireLazyTreeString(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\0") ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  ) {
    throw new Error(`${label} is invalid or exceeds ${maximumBytes} bytes`);
  }
  return value;
}

function requireLazyTreeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function validateLazyTreeContent(
  value: unknown,
  minimumTransports = 1,
): LazyTreeContent {
  const initial = value as Record<string, unknown> | null;
  const hasSource = typeof initial === "object" && initial !== null &&
    !Array.isArray(initial) && initial.source !== undefined;
  const record = exactLazyTreeRecord(value, [
    "decoder",
    "mediaType",
    "sha256",
    "bytes",
    "expandedBytes",
    "sourceEntryCount",
    "transports",
    ...(hasSource ? ["source"] : []),
  ], "Lazy tree content");
  const expectedMediaType = record.decoder === "zip-v1"
    ? "application/zip"
    : record.decoder === "homebrew-bottle-tar-gzip-v1"
      ? "application/vnd.oci.image.layer.v1.tar+gzip"
      : null;
  if (expectedMediaType === null || record.mediaType !== expectedMediaType) {
    throw new Error("Lazy tree decoder and media type are inconsistent");
  }
  const integrity = validateLazyArchiveIntegrity({
    sha256: record.sha256,
    bytes: record.bytes,
  });
  if (!integrity) throw new Error("Lazy tree integrity is required");
  const transports = requireLazyTreeArray(
    record.transports,
    "Lazy tree transports",
    minimumTransports,
    VFS_DEFERRED_TREE_LIMITS.maxTransportsPerTree,
  ).map((url, index) =>
    requireLazyTreeString(
      url,
      `Lazy tree transport ${index}`,
      MAX_LAZY_TREE_STRING_BYTES,
    )
  );
  if (new Set(transports).size !== transports.length) {
    throw new Error("Lazy tree transports contain duplicates");
  }
  const expandedBytes = requireLazyTreeInteger(
    record.expandedBytes,
    "Lazy tree expanded byte count",
    0,
    MAX_LAZY_EXPANDED_BYTES,
  );
  const sourceEntryCount = requireLazyTreeInteger(
    record.sourceEntryCount,
    "Lazy tree source entry count",
    1,
    MAX_LAZY_TREE_ENTRIES,
  );
  const source = hasSource
    ? validateLazyTreeSourceInventory(record.source, record.decoder)
    : undefined;
  if (source !== undefined && source.entries.length !== sourceEntryCount) {
    throw new Error("Lazy tree source inventory count differs from its content");
  }
  return {
    decoder: record.decoder as LazyTreeDecoder,
    mediaType: expectedMediaType,
    sha256: integrity.sha256,
    bytes: integrity.bytes,
    expandedBytes,
    sourceEntryCount,
    transports,
    ...(source === undefined ? {} : { source }),
  };
}

function summarizeSerializedDeferredTreeCollection(
  serialized: readonly SerializedLazyArchiveEntry[],
): VfsDeferredTreeUsage {
  const usage: VfsDeferredTreeUsage = {
    groups: serialized.length,
    archiveBytes: 0,
    expandedBytes: 0,
    payloadBytes: 0,
    entries: 0,
  };
  for (const group of serialized) {
    if (group.content === undefined || group.inventory === undefined) continue;
    usage.archiveBytes += group.content.bytes;
    usage.expandedBytes += group.content.expandedBytes;
    usage.payloadBytes += group.inventory
      .filter((entry) => entry.type === "file")
      .reduce((total, entry) => total + entry.size, 0);
    usage.entries += group.inventory.length +
      (group.content.source?.entries.length ?? 0);
  }
  return usage;
}

function validateDeferredTreeUsage(usage: VfsDeferredTreeUsage): void {
  assertVfsDeferredTreeCollectionUsage(
    usage,
    "Serialized lazy tree collection",
  );
}

function validateSerializedDeferredTreeCollection(
  serialized: readonly SerializedLazyArchiveEntry[],
): void {
  validateDeferredTreeUsage(summarizeSerializedDeferredTreeCollection(serialized));
}

function validateLazyTreeSourceInventory(
  value: unknown,
  decoder: unknown,
): LazyTreeSourceInventory {
  if (decoder !== "homebrew-bottle-tar-gzip-v1") {
    throw new Error("Lazy tree source inventory is valid only for original bottles");
  }
  const record = exactLazyTreeRecord(
    value,
    ["schema", "kind", "entries"],
    "Lazy tree source inventory",
  );
  if (record.schema !== 1 || record.kind !== "homebrew-bottle-tar-gzip-v1") {
    throw new Error("Lazy tree source inventory has an unsupported identity");
  }
  const byPath = new Map<string, LazyTreeSourceEntry>();
  const entries = requireLazyTreeArray(
    record.entries,
    "Lazy tree source entries",
    1,
    MAX_LAZY_TREE_ENTRIES,
  ).map((value, index) => {
    const initial = value as Record<string, unknown> | null;
    const type = typeof initial === "object" && initial !== null && !Array.isArray(initial)
      ? initial.type
      : undefined;
    const keys = type === "directory" || type === "file"
      ? ["sourcePath", "type", "mode", "size"]
      : type === "symlink" || type === "hardlink"
        ? ["sourcePath", "type", "mode", "size", "target"]
        : null;
    if (keys === null) throw new Error(`Lazy tree source entry ${index} has invalid type`);
    const entry = exactLazyTreeRecord(value, keys, `Lazy tree source entry ${index}`);
    const sourcePath = requireCanonicalTreePath(
      entry.sourcePath,
      false,
      `Lazy tree source entry ${index} path`,
    );
    if (byPath.has(sourcePath)) {
      throw new Error(`Lazy tree source inventory duplicates ${sourcePath}`);
    }
    const mode = requireLazyTreeInteger(
      entry.mode,
      `Lazy tree source entry ${sourcePath} mode`,
      0,
      0o7777,
    );
    const size = requireLazyTreeInteger(
      entry.size,
      `Lazy tree source entry ${sourcePath} size`,
      0,
      MAX_LAZY_PAYLOAD_BYTES,
    );
    let target: string | undefined;
    if (type === "directory" || type === "symlink" || type === "hardlink") {
      if (size !== 0) {
        throw new Error(`Lazy tree source ${sourcePath} has payload for ${String(type)}`);
      }
    }
    if (type === "symlink") {
      target = requireLazyTreeString(
        entry.target,
        `Lazy tree source symlink ${sourcePath} target`,
        MAX_LAZY_TREE_SYMLINK_TARGET_BYTES,
      );
    } else if (type === "hardlink") {
      target = requireCanonicalTreePath(
        entry.target,
        false,
        `Lazy tree source hardlink ${sourcePath} target`,
      );
    }
    const result: LazyTreeSourceEntry = {
      sourcePath,
      type: type as LazyTreeSourceEntry["type"],
      mode,
      size,
      ...(target === undefined ? {} : { target }),
    };
    byPath.set(sourcePath, result);
    return result;
  });
  const paths = entries.map((entry) => entry.sourcePath);
  if (paths.some((path, index) => index > 0 && paths[index - 1] >= path)) {
    throw new Error("Lazy tree source inventory is not in canonical path order");
  }
  return { schema: 1, kind: "homebrew-bottle-tar-gzip-v1", entries };
}

function resolveLazyTreeSourceHardlinks(
  entries: readonly LazyTreeSourceEntry[],
): Map<string, LazyTreeSourceEntry> {
  const byPath = new Map(entries.map((entry) => [entry.sourcePath, entry]));
  const canonicalByPath = new Map<string, LazyTreeSourceEntry>();
  for (const start of entries) {
    if (start.type !== "hardlink" || canonicalByPath.has(start.sourcePath)) continue;
    const chain: LazyTreeSourceEntry[] = [];
    const seen = new Set<string>();
    let current = start;
    let canonical: LazyTreeSourceEntry | undefined;
    while (current.type === "hardlink") {
      canonical = canonicalByPath.get(current.sourcePath);
      if (canonical !== undefined) break;
      if (seen.has(current.sourcePath)) {
        throw new Error(`Lazy tree source hardlink cycle includes ${current.sourcePath}`);
      }
      seen.add(current.sourcePath);
      chain.push(current);
      const target = byPath.get(current.target!);
      if (target === undefined) {
        throw new Error(`Lazy tree source hardlink ${current.sourcePath} target is absent`);
      }
      if (target.type !== "file" && target.type !== "hardlink") {
        throw new Error(`Lazy tree source hardlink ${current.sourcePath} target is not regular`);
      }
      current = target;
    }
    if (canonical === undefined) canonical = current;
    for (const link of chain) canonicalByPath.set(link.sourcePath, canonical);
  }
  return canonicalByPath;
}

function requireCanonicalTreePath(
  path: unknown,
  absolute: boolean,
  label: string,
  allowAbsoluteRoot = false,
): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    new TextEncoder().encode(path).byteLength > MAX_LAZY_TREE_PATH_BYTES ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") !== absolute
  ) {
    throw new Error(`${label} is not a canonical ${absolute ? "absolute" : "relative"} path`);
  }
  if (allowAbsoluteRoot && absolute && path === "/") return path;
  const segments = path.slice(absolute ? 1 : 0).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} has an unsafe path segment`);
  }
  return path;
}

interface ValidatedLazyTreeDefinition {
  content: LazyTreeContent;
  entries: LazyTreeRegistrationEntry[];
  mountPrefix: string;
  activation: LazyTreeActivation;
  canonicalByGroup: Map<string, LazyTreeRegistrationEntry>;
}

function validateLazyTreeDefinition(
  contentValue: unknown,
  entriesValue: unknown,
  mountPrefixValue: unknown,
  activationValue: unknown,
  minimumTransports = 1,
): ValidatedLazyTreeDefinition {
  const content = validateLazyTreeContent(contentValue, minimumTransports);
  const mountPrefix = normalizeLazyArchiveMountPrefix(mountPrefixValue);
  const activationRecord = exactLazyTreeRecord(
    activationValue,
    ["mode", "capabilities", "roots"],
    "Lazy tree activation",
  );
  if (
    activationRecord.mode !== "boot-prefetch" &&
    activationRecord.mode !== "first-use"
  ) {
    throw new Error("Lazy tree activation mode is invalid");
  }
  const capabilities = requireLazyTreeArray(
    activationRecord.capabilities,
    "Lazy tree activation capabilities",
    1,
    MAX_LAZY_TREE_CAPABILITIES,
  ).map((capability, index) => {
    const text = requireLazyTreeString(
      capability,
      `Lazy tree activation capability ${index}`,
      VFS_DEFERRED_TREE_LIMITS.maxActivationCapabilityBytes,
    );
    if (!/^[a-z0-9][a-z0-9:._-]*$/.test(text)) {
      throw new Error(`Lazy tree activation capability ${index} is invalid`);
    }
    return text;
  });
  const roots = requireLazyTreeArray(
    activationRecord.roots,
    "Lazy tree activation roots",
    1,
    MAX_LAZY_TREE_ACTIVATION_ROOTS,
  ).map((root, index) =>
    requireCanonicalTreePath(
      root,
      true,
      `Lazy tree activation root ${index}`,
      true,
    )
  );
  if (
    new Set(capabilities).size !== capabilities.length ||
    new Set(roots).size !== roots.length
  ) {
    throw new Error("Lazy tree activation contains duplicates");
  }
  const activation: LazyTreeActivation = {
    mode: activationRecord.mode,
    capabilities,
    roots,
  };

  const rawEntries = requireLazyTreeArray(
    entriesValue,
    "Lazy tree inventory",
    1,
    MAX_LAZY_TREE_ENTRIES,
  );
  const entries: LazyTreeRegistrationEntry[] = [];
  const byPath = new Map<string, LazyTreeRegistrationEntry>();
  const sourceEntries = new Map<string, LazyTreeRegistrationEntry>();
  const completeSources = content.source === undefined
    ? undefined
    : new Map(content.source.entries.map((entry) => [entry.sourcePath, entry]));
  const canonicalSourceByPath = content.source === undefined
    ? undefined
    : resolveLazyTreeSourceHardlinks(content.source.entries);
  let decodedPayloadBytes = 0;
  for (const [index, value] of rawEntries.entries()) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Lazy tree entry ${index} must be an object`);
    }
    const type = (value as Record<string, unknown>).type;
    const keys = type === "directory"
      ? ["vfsPath", "sourcePath", "type", "mode", "size"]
      : type === "file"
        ? ["vfsPath", "sourcePath", "type", "mode", "size", "inodeGroup"]
        : type === "symlink"
          ? ["vfsPath", "sourcePath", "type", "mode", "size", "target"]
          : type === "hardlink"
            ? [
              "vfsPath",
              "sourcePath",
              "type",
              "mode",
              "size",
              "target",
              "inodeGroup",
            ]
            : null;
    if (!keys) throw new Error(`Lazy tree entry ${index} has an invalid type`);
    const record = exactLazyTreeRecord(
      value,
      [...keys, ...(completeSources === undefined ? [] : ["materialization"])],
      `Lazy tree entry ${index}`,
    );
    const vfsPath = requireCanonicalTreePath(
      record.vfsPath,
      true,
      `Lazy tree entry ${index} VFS path`,
    );
    const sourcePath = requireCanonicalTreePath(
      record.sourcePath,
      false,
      `Lazy tree entry ${index} source path`,
    );
    const materialization = completeSources === undefined
      ? undefined
      : record.materialization;
    if (
      completeSources !== undefined &&
      materialization !== "archive" &&
      materialization !== "archive-homebrew-relocate" &&
      materialization !== "archive-copy" &&
      materialization !== "archive-copy-mode" &&
      materialization !== "descriptor"
    ) {
      throw new Error(`Lazy tree entry ${vfsPath} has invalid materialization provenance`);
    }
    if (
      mountPrefix !== "/" && vfsPath !== mountPrefix &&
      !vfsPath.startsWith(`${mountPrefix}/`)
    ) {
      throw new Error(`Lazy tree entry ${vfsPath} escapes its mount prefix`);
    }
    if (byPath.has(vfsPath)) {
      throw new Error(`Lazy tree duplicates VFS path ${vfsPath}`);
    }
    const mode = requireLazyTreeInteger(
      record.mode,
      `Lazy tree entry ${vfsPath} mode`,
      0,
      0o7777,
    );
    const size = requireLazyTreeInteger(
      record.size,
      `Lazy tree entry ${vfsPath} size`,
      0,
      MAX_LAZY_PAYLOAD_BYTES,
    );
    let target: string | undefined;
    let inodeGroup: string | undefined;
    if (type === "directory") {
      if (size !== 0) {
        throw new Error(`Lazy tree directory ${vfsPath} has nonzero size`);
      }
    } else if (type === "symlink") {
      target = requireLazyTreeString(
        record.target,
        `Lazy tree symlink ${vfsPath} target`,
        MAX_LAZY_TREE_SYMLINK_TARGET_BYTES,
      );
      if (new TextEncoder().encode(target).byteLength !== size) {
        throw new Error(`Lazy tree symlink ${vfsPath} size differs from its target`);
      }
    } else {
      inodeGroup = requireLazyTreeString(
        record.inodeGroup,
        `Lazy tree entry ${vfsPath} inode group`,
        MAX_LAZY_TREE_PATH_BYTES,
      );
      if (type === "hardlink") {
        target = requireCanonicalTreePath(
          record.target,
          true,
          `Lazy tree hardlink ${vfsPath} target`,
        );
      }
    }
    if (type !== "hardlink") {
      decodedPayloadBytes += size;
      if (decodedPayloadBytes > MAX_LAZY_PAYLOAD_BYTES) {
        throw new Error("Lazy tree inventory exceeds the expansion limit");
      }
    }
    const entry: LazyTreeRegistrationEntry = {
      vfsPath,
      sourcePath,
      ...(materialization === undefined ? {} : {
        materialization: materialization as LazyTreeRegistrationEntry["materialization"],
      }),
      type: type as LazyTreeRegistrationEntry["type"],
      mode,
      size,
      ...(target === undefined ? {} : { target }),
      ...(inodeGroup === undefined ? {} : { inodeGroup }),
    };
    if (completeSources === undefined) {
      const priorSource = sourceEntries.get(sourcePath);
      if (priorSource) {
        if (
          content.decoder !== "zip-v1" || entry.type !== "hardlink" ||
          priorSource.inodeGroup !== entry.inodeGroup
        ) {
          throw new Error(`Lazy tree duplicates source path ${sourcePath}`);
        }
      } else {
        if (content.decoder === "zip-v1" && entry.type === "hardlink") {
          throw new Error(
            `Lazy ZIP hardlink ${vfsPath} does not reuse a canonical source path`,
          );
        }
        sourceEntries.set(sourcePath, entry);
      }
    } else if (entry.materialization === "descriptor") {
      if (entry.type !== "directory" && entry.type !== "symlink") {
        throw new Error(`Lazy tree descriptor entry ${vfsPath} is not structural`);
      }
      if (completeSources.has(sourcePath)) {
        throw new Error(`Lazy tree descriptor entry ${vfsPath} impersonates a source member`);
      }
    } else {
      const source = completeSources.get(sourcePath);
      if (source === undefined) {
        throw new Error(`Lazy tree entry ${vfsPath} names absent source ${sourcePath}`);
      }
      if (
        entry.materialization === "archive-copy" ||
        entry.materialization === "archive-copy-mode"
      ) {
        if (
          entry.type !== "file" || source.type !== "file" ||
          (entry.materialization === "archive-copy" && entry.mode !== source.mode)
        ) {
          throw new Error(`Lazy tree archive copy ${vfsPath} differs from its source`);
        }
      } else if (entry.materialization === "archive-homebrew-relocate") {
        if (
          (entry.type !== "file" && entry.type !== "hardlink") ||
          source.type !== entry.type ||
          (entry.type === "file" && source.mode !== entry.mode)
        ) {
          throw new Error(`Lazy tree receipt-relocated entry ${vfsPath} differs from its source`);
        }
      } else if (
        source.type !== entry.type ||
        (entry.type === "symlink" && source.target !== entry.target) ||
        (entry.type !== "hardlink" && source.mode !== entry.mode)
      ) {
        throw new Error(`Lazy tree archive entry ${vfsPath} differs from its source`);
      }
    }
    entries.push(entry);
    byPath.set(vfsPath, entry);
  }

  for (const entry of entries) {
    const components = entry.vfsPath.split("/").filter(Boolean);
    for (let length = 1; length < components.length; length += 1) {
      const ancestorPath = `/${components.slice(0, length).join("/")}`;
      const ancestor = byPath.get(ancestorPath);
      if (ancestor && ancestor.type !== "directory") {
        throw new Error(
          `Lazy tree entry ${entry.vfsPath} descends through non-directory ${ancestorPath}`,
        );
      }
    }
  }
  const graph = resolveHardlinkGraph(
    entries.map((entry) => ({
      path: entry.vfsPath,
      type: entry.type,
      mode: entry.mode,
      size: entry.size,
      target: entry.target,
      inodeGroup: entry.inodeGroup,
    })),
    "Lazy tree",
  );
  if (completeSources !== undefined) {
    const relocatedCanonicalSources = new Set<string>();
    for (const entry of entries) {
      if (entry.materialization !== "archive-homebrew-relocate") continue;
      const source = completeSources.get(entry.sourcePath)!;
      const canonical = source.type === "file"
        ? source
        : canonicalSourceByPath!.get(source.sourcePath);
      if (canonical?.type !== "file") {
        throw new Error(`Lazy tree receipt-relocated entry ${entry.vfsPath} is not regular`);
      }
      relocatedCanonicalSources.add(canonical.sourcePath);
    }
    for (const entry of entries) {
      if (
        entry.materialization === "descriptor" ||
        (entry.type !== "file" && entry.type !== "hardlink")
      ) continue;
      const source = completeSources.get(entry.sourcePath)!;
      const canonical = source.type === "file"
        ? source
        : canonicalSourceByPath!.get(source.sourcePath);
      if (
        canonical?.type !== "file" ||
        !relocatedCanonicalSources.has(canonical.sourcePath) &&
          entry.size !== canonical.size
      ) {
        throw new Error(`Lazy tree archive entry ${entry.vfsPath} differs from its source`);
      }
    }
    for (const entry of entries) {
      if (
        entry.type !== "hardlink" ||
        (entry.materialization !== "archive" &&
          entry.materialization !== "archive-homebrew-relocate")
      ) continue;
      const source = completeSources.get(entry.sourcePath)!;
      const target = byPath.get(entry.target!);
      const regularSource = canonicalSourceByPath!.get(source.sourcePath);
      if (
        source.target !== target?.sourcePath ||
        regularSource?.type !== "file" ||
        regularSource.mode !== entry.mode ||
        target?.mode !== entry.mode
      ) {
        throw new Error(`Lazy tree hardlink ${entry.vfsPath} differs from its source`);
      }
    }
  }
  if (
    content.sourceEntryCount !==
      (completeSources === undefined ? sourceEntries.size : completeSources.size)
  ) {
    throw new Error("Lazy tree source entry count differs from its inventory");
  }
  if (
    (content.source === undefined && content.expandedBytes < decodedPayloadBytes) ||
    (content.decoder === "zip-v1" && content.expandedBytes !== decodedPayloadBytes)
  ) {
    throw new Error("Lazy tree expanded byte count differs from its inventory");
  }
  for (const root of activation.roots) {
    if (
      root !== "/" &&
      !entries.some((entry) =>
        entry.vfsPath === root || entry.vfsPath.startsWith(`${root}/`)
      )
    ) {
      throw new Error(`Lazy tree activation root ${root} is not owned by its inventory`);
    }
  }
  const canonicalByGroup = new Map<string, LazyTreeRegistrationEntry>();
  for (const entry of entries) {
    if (entry.type === "file") canonicalByGroup.set(entry.inodeGroup!, entry);
  }
  if (canonicalByGroup.size !== graph.canonicalByGroup.size) {
    throw new Error("Lazy tree regular inode inventory is inconsistent");
  }
  return { content, entries, mountPrefix, activation, canonicalByGroup };
}

function lazyTreeInventoryIdentityKey(value: {
  sourcePath?: string;
  type?: string;
  inodeGroup?: string;
  target?: string;
}): string {
  return JSON.stringify([
    value.sourcePath,
    value.type,
    value.inodeGroup,
    value.target,
  ]);
}

function validateSerializedLegacyArchive(
  value: unknown,
  allowUntaggedSnapshot: boolean,
): SerializedLazyArchiveEntry {
  const record = boundedLazyTreeRecord(value, [
    "kind",
    "content",
    "url",
    "mountPrefix",
    "integrity",
    "materialized",
    "entries",
  ], [
    "url",
    "mountPrefix",
    "materialized",
    "entries",
  ], "Serialized legacy lazy archive");
  if (record.kind === undefined) {
    if (!allowUntaggedSnapshot) {
      throw new Error("Serialized lazy archive is missing its kind discriminator");
    }
  } else if (record.kind !== SERIALIZED_LEGACY_ARCHIVE_KIND) {
    throw new Error("Serialized legacy lazy archive has an unsupported kind");
  }
  const url = requireLazyTreeString(
    record.url,
    "Serialized legacy lazy archive URL",
    MAX_LAZY_TREE_STRING_BYTES,
  );
  const mountPrefix = normalizeLazyArchiveMountPrefix(record.mountPrefix);
  const integrity = validateLazyArchiveIntegrity(record.integrity);
  if (record.content !== undefined) {
    if (!allowUntaggedSnapshot || record.kind !== undefined) {
      throw new Error("Typed legacy lazy archives cannot carry generic content");
    }
    const legacyContent = validateLazyTreeContent(record.content);
    if (
      legacyContent.decoder !== "zip-v1" ||
      legacyContent.transports.length !== 1 ||
      legacyContent.transports[0] !== url ||
      !integrity || legacyContent.sha256 !== integrity.sha256 ||
      legacyContent.bytes !== integrity.bytes
    ) {
      throw new Error("Untagged legacy ZIP content identity is inconsistent");
    }
  }
  if (record.materialized !== false) {
    throw new Error("Serialized legacy lazy archive must describe pending content");
  }

  const paths = new Set<string>();
  const entries = requireLazyTreeArray(
    record.entries,
    "Serialized legacy lazy archive entries",
    1,
    MAX_LAZY_TREE_ENTRIES,
  ).map((value, index): SerializedLazyArchiveEntry["entries"][number] => {
    const entry = boundedLazyTreeRecord(value, [
      "vfsPath",
      "ino",
      "generation",
      "dataSequence",
      "size",
      "isSymlink",
      "deleted",
      "materialized",
      "archivePath",
      "sourcePath",
      "type",
      "inodeGroup",
      "target",
    ], [
      "vfsPath",
      "ino",
      "size",
      "isSymlink",
      "deleted",
    ], `Serialized legacy lazy archive entry ${index}`);
    const vfsPath = requireCanonicalTreePath(
      entry.vfsPath,
      true,
      `Serialized legacy lazy archive entry ${index} VFS path`,
    );
    if (paths.has(vfsPath)) {
      throw new Error(`Serialized legacy lazy archive duplicates path ${vfsPath}`);
    }
    paths.add(vfsPath);
    const ino = requireLazyTreeInteger(
      entry.ino,
      `Serialized legacy lazy archive entry ${vfsPath} inode`,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const generation = entry.generation === undefined
      ? undefined
      : requireLazyTreeInteger(
        entry.generation,
        `Serialized legacy lazy archive entry ${vfsPath} generation`,
        0,
        Number.MAX_SAFE_INTEGER,
      );
    const dataSequence = entry.dataSequence === undefined
      ? undefined
      : requireLazyTreeInteger(
        entry.dataSequence,
        `Serialized legacy lazy archive entry ${vfsPath} data sequence`,
        0,
        Number.MAX_SAFE_INTEGER,
      );
    const size = requireLazyTreeInteger(
      entry.size,
      `Serialized legacy lazy archive entry ${vfsPath} size`,
      0,
      MAX_LAZY_PAYLOAD_BYTES,
    );
    if (
      entry.isSymlink !== false || entry.deleted !== false ||
      (entry.materialized !== undefined && entry.materialized !== false)
    ) {
      throw new Error(
        `Serialized legacy lazy archive entry ${vfsPath} is not pending`,
      );
    }
    if (entry.type !== undefined && entry.type !== "file") {
      throw new Error(
        `Serialized legacy lazy archive entry ${vfsPath} has an invalid type`,
      );
    }
    const archivePath = entry.archivePath === undefined
      ? undefined
      : requireCanonicalTreePath(
        entry.archivePath,
        false,
        `Serialized legacy lazy archive entry ${vfsPath} archive path`,
      );
    const sourcePath = entry.sourcePath === undefined
      ? undefined
      : requireCanonicalTreePath(
        entry.sourcePath,
        false,
        `Serialized legacy lazy archive entry ${vfsPath} source path`,
      );
    const inodeGroup = entry.inodeGroup === undefined
      ? undefined
      : requireLazyTreeString(
        entry.inodeGroup,
        `Serialized legacy lazy archive entry ${vfsPath} inode group`,
        MAX_LAZY_TREE_PATH_BYTES,
      );
    if (entry.target !== undefined) {
      throw new Error(
        `Serialized legacy lazy archive entry ${vfsPath} has a link target`,
      );
    }
    return {
      vfsPath,
      ino,
      ...(generation === undefined ? {} : { generation }),
      ...(dataSequence === undefined ? {} : { dataSequence }),
      size,
      isSymlink: false,
      deleted: false,
      materialized: false,
      ...(archivePath === undefined ? {} : { archivePath }),
      ...(sourcePath === undefined ? {} : { sourcePath }),
      type: "file",
      ...(inodeGroup === undefined ? {} : { inodeGroup }),
    };
  });
  return {
    kind: SERIALIZED_LEGACY_ARCHIVE_KIND,
    url,
    mountPrefix,
    ...(integrity === undefined ? {} : { integrity }),
    materialized: false,
    entries,
  };
}

function validateSerializedGenericTree(
  value: unknown,
  expectedKind:
    | typeof SERIALIZED_DEFERRED_TREE_V1_KIND
    | typeof SERIALIZED_DEFERRED_TREE_V2_KIND,
): SerializedLazyArchiveEntry {
  const record = exactLazyTreeRecord(value, [
    "kind",
    "content",
    "inventory",
    "activation",
    "url",
    "mountPrefix",
    "integrity",
    "materialized",
    "entries",
  ], "Serialized lazy tree");
  if (record.kind !== expectedKind) {
    throw new Error("Serialized lazy tree has an unsupported kind");
  }
  const definition = validateLazyTreeDefinition(
    record.content,
    record.inventory,
    record.mountPrefix,
    record.activation,
  );
  if (
    (expectedKind === SERIALIZED_DEFERRED_TREE_V1_KIND) !==
      (definition.content.source === undefined)
  ) {
    throw new Error(
      expectedKind === SERIALIZED_DEFERRED_TREE_V1_KIND
        ? "Serialized deferred-tree-v1 cannot contain original-bottle source metadata"
        : "Serialized deferred-tree-v2 requires original-bottle source metadata",
    );
  }
  const url = requireLazyTreeString(
    record.url,
    "Serialized lazy tree URL",
    MAX_LAZY_TREE_STRING_BYTES,
  );
  if (url !== definition.content.transports[0]) {
    throw new Error("Serialized lazy tree URL differs from its primary transport");
  }
  const integrity = validateLazyArchiveIntegrity(record.integrity);
  if (
    !integrity || integrity.sha256 !== definition.content.sha256 ||
    integrity.bytes !== definition.content.bytes
  ) {
    throw new Error("Serialized lazy tree integrity differs from its content");
  }
  if (record.materialized !== false) {
    throw new Error("Serialized lazy tree must describe pending content");
  }

  const inventoryByPath = new Map(
    definition.entries.map((entry) => [entry.vfsPath, entry]),
  );
  const inventoryByIdentity = new Map(
    definition.entries.map((entry) => [
      lazyTreeInventoryIdentityKey(entry),
      entry,
    ]),
  );
  const pendingValues = requireLazyTreeArray(
    record.entries,
    "Serialized lazy tree entries",
    0,
    MAX_LAZY_TREE_ENTRIES,
  );
  const pendingPaths = new Set<string>();
  const pending = pendingValues.map((value, index) => {
    const entry = boundedLazyTreeRecord(value, [
      "vfsPath",
      "ino",
      "generation",
      "dataSequence",
      "size",
      "isSymlink",
      "deleted",
      "materialized",
      "archivePath",
      "sourcePath",
      "type",
      "inodeGroup",
      "target",
    ], [
      "vfsPath",
      "ino",
      "generation",
      "dataSequence",
      "size",
      "isSymlink",
      "deleted",
      "materialized",
      "archivePath",
      "sourcePath",
      "type",
      "inodeGroup",
    ], `Serialized lazy tree entry ${index}`);
    const vfsPath = requireCanonicalTreePath(
      entry.vfsPath,
      true,
      `Serialized lazy tree entry ${index} VFS path`,
    );
    if (pendingPaths.has(vfsPath)) {
      throw new Error(`Serialized lazy tree duplicates pending path ${vfsPath}`);
    }
    pendingPaths.add(vfsPath);
    const sourcePath = requireCanonicalTreePath(
      entry.sourcePath,
      false,
      `Serialized lazy tree entry ${index} source path`,
    );
    const archivePath = requireCanonicalTreePath(
      entry.archivePath,
      false,
      `Serialized lazy tree entry ${index} archive path`,
    );
    const inventoryAtPath = inventoryByPath.get(vfsPath);
    const inventoryEntry = inventoryByIdentity.get(lazyTreeInventoryIdentityKey({
      sourcePath,
      type: typeof entry.type === "string" ? entry.type : undefined,
      inodeGroup: typeof entry.inodeGroup === "string"
        ? entry.inodeGroup
        : undefined,
      target: typeof entry.target === "string" ? entry.target : undefined,
    })) ?? inventoryAtPath;
    if (
      !inventoryEntry ||
      (inventoryEntry.type !== "file" && inventoryEntry.type !== "hardlink") ||
      (inventoryAtPath?.inodeGroup !== undefined &&
        inventoryAtPath.inodeGroup !== inventoryEntry.inodeGroup)
    ) {
      throw new Error(
        `Serialized lazy tree entry ${vfsPath} is absent from its inventory`,
      );
    }
    const canonical = definition.canonicalByGroup.get(inventoryEntry.inodeGroup!);
    if (
      entry.type !== inventoryEntry.type ||
      entry.inodeGroup !== inventoryEntry.inodeGroup ||
      entry.size !== inventoryEntry.size ||
      archivePath !== canonical?.sourcePath ||
      entry.target !== inventoryEntry.target ||
      entry.isSymlink !== false || entry.deleted !== false ||
      entry.materialized !== false
    ) {
      throw new Error(
        `Serialized lazy tree entry ${vfsPath} disagrees with its inventory`,
      );
    }
    const ino = requireLazyTreeInteger(
      entry.ino,
      `Serialized lazy tree entry ${vfsPath} inode`,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const generation = requireLazyTreeInteger(
      entry.generation,
      `Serialized lazy tree entry ${vfsPath} generation`,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const dataSequence = requireLazyTreeInteger(
      entry.dataSequence,
      `Serialized lazy tree entry ${vfsPath} data sequence`,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    return {
      vfsPath,
      ino,
      generation,
      dataSequence,
      size: inventoryEntry.size,
      isSymlink: false,
      deleted: false,
      materialized: false,
      archivePath,
      sourcePath,
      type: inventoryEntry.type,
      inodeGroup: inventoryEntry.inodeGroup,
      ...(inventoryEntry.target === undefined
        ? {}
        : { target: inventoryEntry.target }),
    };
  });
  return {
    kind: expectedKind,
    content: definition.content,
    inventory: definition.entries,
    activation: definition.activation,
    url,
    mountPrefix: definition.mountPrefix,
    integrity,
    materialized: false,
    entries: pending,
  };
}

async function assertLazyIntegrity(
  data: Uint8Array,
  kind: LazyDownloadKind,
  expected: LazyArchiveIntegrity | undefined,
): Promise<void> {
  if (expected === undefined) return;
  if (data.byteLength !== expected.bytes) {
    throw new Error(
      `Lazy ${kind} byte count ${data.byteLength} does not match ` +
        `expected ${expected.bytes}`,
    );
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(`Lazy ${kind} integrity verification is unavailable`);
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = new Uint8Array(await subtle.digest("SHA-256", copy));
  const actual = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  if (actual !== expected.sha256) {
    throw new Error(
      `Lazy ${kind} SHA-256 ${actual} does not match expected ${expected.sha256}`,
    );
  }
}

export class MemoryFileSystem implements FileSystemBackend {
  private fs: SharedFS;
  private imageMetadata: VfsImageMetadata | null;
  /** Lazy files keyed by inode slot + generation (raw inode numbers are reused). */
  private lazyFiles = new Map<
    string,
    {
      ino: number;
      generation: number;
      dataSequence: number;
      path: string;
      paths: Set<string>;
      url: string;
      size: number;
    }
  >();
  /** Lazy archive groups (bundle of files backed by one zip URL). */
  private lazyArchiveGroups: LazyArchiveGroup[] = [];
  /** Build-time direct-materialization authority; handles never serialize. */
  private deferredTreeMaterializationHandles = new WeakMap<
    DeferredTreeMaterializationHandle,
    LazyArchiveGroup
  >();
  /** Fast lookup keyed by inode slot + generation. */
  private lazyArchiveInodes = new Map<string, LazyArchiveGroup>();
  private lazyDownloadListeners = new Set<LazyDownloadListener>();
  /** One in-flight fetch/commit per lazy file or archive group. */
  private lazyPreparations = new Map<object, LazyPreparation>();
  private lazyFetch: LazyFetch = (url) => globalThis.fetch(url);

  private constructor(fs: SharedFS, metadata: VfsImageMetadata | null = null) {
    this.fs = fs;
    this.imageMetadata = metadata;
  }

  private static inodeKey(ino: number, generation: number): string {
    return `${ino}:${generation}`;
  }

  private static canAdoptLegacyLazyStub(st: SfsStatResult): boolean {
    // Images from before data-sequence tracking stored regular lazy entries as
    // untouched zero-length stubs. Current registration performs one initial
    // O_TRUNC, so any later mutation sequence (or concrete bytes) is unsafe to
    // associate with metadata that cannot name the content version it saw.
    return (
      (st.mode & S_IFMT) === S_IFREG && st.size === 0 && st.dataSequence <= 1
    );
  }

  /**
   * Reconcile process-local lazy metadata with authoritative SharedFS names.
   * The identity map may come from the same transaction as a filesystem
   * snapshot, so callers can serialize matching bytes and lazy paths.
   */
  private reconcileLazyIdentityState(
    identities: Map<string, SharedFsIdentityState>,
  ): void {
    for (const [key, entry] of this.lazyFiles) {
      const identity = identities.get(key);
      if (
        !identity ||
        identity.dataSequence !== entry.dataSequence ||
        identity.paths.length === 0
      ) {
        this.lazyFiles.delete(key);
        continue;
      }
      entry.paths = new Set(identity.paths);
      if (!entry.paths.has(entry.path)) {
        entry.path = identity.paths[0];
      }
    }

    this.lazyArchiveInodes.clear();
    for (const group of this.lazyArchiveGroups) {
      const unverifiedGenericTree =
        group.content !== undefined &&
        group.inventory !== undefined &&
        !group.materialized;
      const pendingByIdentity = new Map<string, LazyArchiveFileEntry>();
      for (const entry of group.entries.values()) {
        if (
          entry.deleted ||
          entry.materialized ||
          entry.generation === undefined
        )
          continue;
        const key = MemoryFileSystem.inodeKey(entry.ino, entry.generation);
        if (!pendingByIdentity.has(key)) pendingByIdentity.set(key, entry);
      }

      const reconciled = new Map<string, LazyArchiveFileEntry>();
      for (const [key, entry] of pendingByIdentity) {
        const identity = identities.get(key);
        if (!identity || identity.dataSequence !== (entry.dataSequence ?? 0))
          continue;
        for (const path of identity.paths) {
          reconciled.set(path, {
            ...entry,
            ino: identity.ino,
            generation: identity.generation,
            dataSequence: identity.dataSequence,
            deleted: false,
            materialized: false,
          });
        }
        if (identity.paths.length > 0) {
          this.lazyArchiveInodes.set(key, group);
        }
      }
      group.entries = reconciled;
      group.materialized = reconciled.size === 0 && !unverifiedGenericTree;
    }
  }

  private lazyFileForStat(st: SfsStatResult) {
    const key = MemoryFileSystem.inodeKey(st.ino, st.generation);
    const entry = this.lazyFiles.get(key);
    if (entry && entry.dataSequence !== st.dataSequence) {
      this.lazyFiles.delete(key);
      return undefined;
    }
    return entry;
  }

  private lazyArchiveForStat(st: SfsStatResult) {
    const key = MemoryFileSystem.inodeKey(st.ino, st.generation);
    const group = this.lazyArchiveInodes.get(key);
    if (!group) return undefined;
    const entries = Array.from(group.entries.values()).filter(
      (entry) =>
        entry.ino === st.ino &&
        entry.generation === st.generation &&
        !entry.deleted &&
        !entry.materialized,
    );
    if (entries.some((entry) => entry.dataSequence === st.dataSequence)) {
      return group;
    }
    this.lazyArchiveInodes.delete(key);
    for (const entry of entries) entry.materialized = true;
    return undefined;
  }

  private lazyBackingForStat(st: SfsStatResult): LazyBacking | null {
    const key = MemoryFileSystem.inodeKey(st.ino, st.generation);
    // Preparation deliberately observes the registered identity even when a
    // peer advanced its data sequence. The identity-guarded commit will then
    // reconcile and preserve the peer's bytes, while callers still learn that
    // the deferred backing was conclusively resolved.
    const file = this.lazyFiles.get(key);
    if (file) return { token: file, path: file.path };
    const archive = this.lazyArchiveInodes.get(key);
    if (!archive) return null;
    const path = Array.from(archive.entries.entries()).find(([, entry]) =>
      entry.ino === st.ino &&
      entry.generation === st.generation &&
      !entry.deleted &&
      !entry.materialized
    )?.[0];
    return path === undefined ? null : { token: archive, path };
  }

  private lazyBackingForPath(path: string): LazyBacking | null {
    // A directory/symlink-only tree has no empty regular inode to carry its
    // deferred identity. Preserve first-use semantics through the declared
    // activation roots instead of silently treating the tree as concrete.
    const metadataOnlyGroup = this.lazyArchiveGroups.find((group) =>
      !group.materialized &&
      group.content !== undefined &&
      group.inventory !== undefined &&
      group.activation !== undefined &&
      Array.from(group.entries.values()).every(
        (entry) => entry.deleted || entry.materialized || entry.isSymlink,
      ) &&
      group.activation.roots.some((root) =>
        root === "/" || path === root || path.startsWith(`${root}/`)
      )
    );
    if (metadataOnlyGroup) {
      return {
        token: metadataOnlyGroup,
        path,
        directGroup: metadataOnlyGroup,
      };
    }
    try {
      const st = this.fs.stat(path);
      const backing = this.lazyBackingForStat(st);
      return backing ? { token: backing.token, path } : null;
    } catch {
      return null;
    }
  }

  private startLazyPreparation(backing: LazyBacking): LazyPreparation {
    const { path, token } = backing;
    const preparation = {
      status: "pending",
      promise: Promise.resolve(false),
    } as LazyPreparation;
    const materialization = backing.directGroup
      ? this.ensureArchiveMaterialized(backing.directGroup).then(() => true)
      : this.materializePath(path);
    preparation.promise = materialization.then(
      (materialized) => {
        preparation.status = "fulfilled";
        if (this.lazyPreparations.get(token) === preparation) {
          this.lazyPreparations.delete(token);
        }
        return materialized;
      },
      (error) => {
        preparation.status = "rejected";
        preparation.error = error;
        throw error;
      },
    );
    // A synchronous guest open starts the work and returns internal EAGAIN;
    // retain the rejection for its retry without creating an unhandled
    // promise rejection in the worker.
    void preparation.promise.catch(() => {});
    this.lazyPreparations.set(token, preparation);
    return preparation;
  }

  private guardSynchronousLazyAccess(path: string): void {
    const backing = this.lazyBackingForPath(path);
    if (!backing) return;
    let preparation = this.lazyPreparations.get(backing.token);
    if (preparation?.status === "fulfilled") {
      this.lazyPreparations.delete(backing.token);
      const remaining = this.lazyBackingForPath(path);
      if (!remaining) return;
      preparation = this.lazyPreparations.get(remaining.token) ??
        this.startLazyPreparation(remaining);
    } else if (preparation?.status === "rejected") {
      this.lazyPreparations.delete(backing.token);
      const detail = preparation.error instanceof Error
        ? preparation.error.message
        : String(preparation.error);
      const error = new Error(`EIO: lazy backing for ${path} failed: ${detail}`) as
        Error & { code: string; cause?: unknown };
      error.code = "EIO";
      error.cause = preparation.error;
      throw error;
    } else if (!preparation) {
      preparation = this.startLazyPreparation(backing);
    }
    const error = new Error(`EAGAIN: lazy backing for ${path} is being prepared`) as
      Error & { code: string };
    error.code = "EAGAIN";
    throw error;
  }

  /** A successful guest data mutation makes any deferred backing obsolete. */
  private invalidateLazyData(st: SfsStatResult): void {
    const key = MemoryFileSystem.inodeKey(st.ino, st.generation);
    this.lazyFiles.delete(key);

    const group = this.lazyArchiveInodes.get(key);
    if (!group) return;
    this.lazyArchiveInodes.delete(key);
    for (const entry of group.entries.values()) {
      if (entry.ino === st.ino && entry.generation === st.generation) {
        // Keep the concrete inode in the image, but prevent a later archive
        // fetch from overwriting data the guest supplied through any alias.
        entry.materialized = true;
      }
    }
  }

  private rewriteLazyNamespacePaths(
    source: NamespaceEntryIdentity,
    oldPath: string,
    newPath: string,
  ): void {
    const oldBase = oldPath.length > 1 ? oldPath.replace(/\/+$/, "") : oldPath;
    const newBase = newPath.length > 1 ? newPath.replace(/\/+$/, "") : newPath;
    const oldPrefix = `${oldBase}/`;
    const newPrefix = `${newBase}/`;
    const sourceKey = MemoryFileSystem.inodeKey(source.ino, source.generation);
    const directory = (source.mode & S_IFMT) === S_IFDIR;
    const rewrite = (candidate: string): string =>
      candidate === oldBase
        ? newBase
        : directory && candidate.startsWith(oldPrefix)
          ? newPrefix + candidate.slice(oldPrefix.length)
          : candidate;

    for (const [key, lazy] of this.lazyFiles) {
      if (!directory && key !== sourceKey) continue;
      lazy.paths = new Set(Array.from(lazy.paths, rewrite));
      lazy.path = rewrite(lazy.path);
    }

    for (const group of this.lazyArchiveGroups) {
      const rewritten = new Map<string, LazyArchiveFileEntry>();
      for (const [candidate, entry] of group.entries) {
        const entryKey =
          entry.generation === undefined
            ? null
            : MemoryFileSystem.inodeKey(entry.ino, entry.generation);
        rewritten.set(
          directory || entryKey === sourceKey ? rewrite(candidate) : candidate,
          entry,
        );
      }
      group.entries = rewritten;
      if (group.inventory) {
        group.inventory = group.inventory.map((entry) => ({
          ...entry,
          vfsPath: rewrite(entry.vfsPath),
          ...(entry.type === "hardlink" && entry.target !== undefined
            ? { target: rewrite(entry.target) }
            : {}),
        }));
      }
      if (group.activation) {
        group.activation = {
          ...group.activation,
          roots: group.activation.roots.map(rewrite),
        };
      }
    }
  }

  /** Return the underlying SharedArrayBuffer (for sharing with workers). */
  get sharedBuffer(): SharedArrayBuffer {
    return this.fs.buffer as SharedArrayBuffer;
  }

  static create(
    sab: SharedArrayBuffer,
    maxSizeBytes?: number,
  ): MemoryFileSystem {
    return new MemoryFileSystem(SharedFS.mkfs(sab, maxSizeBytes));
  }

  static fromExisting(sab: SharedArrayBuffer): MemoryFileSystem {
    return new MemoryFileSystem(SharedFS.mount(sab));
  }

  /**
   * Copy this filesystem into a freshly formatted SharedFS whose superblock
   * records `maxByteLength` as its growth ceiling. Lazy file/archive metadata
   * is rebuilt from paths so the destination carries the new inode numbers.
   */
  rebaseToNewFileSystem(maxByteLength: number): MemoryFileSystem {
    if (!Number.isSafeInteger(maxByteLength) || maxByteLength <= 0) {
      throw new Error(
        `Invalid MemoryFileSystem maxByteLength: ${maxByteLength}`,
      );
    }

    const SharedArrayBufferCtor = SharedArrayBuffer as new (
      byteLength: number,
      options?: { maxByteLength?: number },
    ) => SharedArrayBuffer;

    // Copy from one quiescent source image. Exporting lazy paths and then
    // walking the live SAB would let a peer rename an entry between those two
    // operations, making the logical lazy size disagree with the copied path.
    const { bytes: sourceBytes, identities } = this.fs.snapshotState();
    this.reconcileLazyIdentityState(identities);
    const lazyEntries = this.serializeLazyEntries();
    const lazyArchiveEntries = this.serializeLazyArchiveEntries();
    const sourceSab = new SharedArrayBufferCtor(sourceBytes.byteLength);
    new Uint8Array(sourceSab).set(sourceBytes);
    const source = new MemoryFileSystem(
      SharedFS.mount(sourceSab, { restoreImage: true }),
      this.imageMetadata,
    );
    source.importLazyEntries(lazyEntries);
    source.importLazyArchiveEntries(lazyArchiveEntries);

    const initialByteLength = Math.min(
      maxByteLength,
      Math.max(sourceBytes.byteLength, MIN_REBASE_INITIAL_BYTES),
    );
    const sab = new SharedArrayBufferCtor(initialByteLength, { maxByteLength });
    const target = MemoryFileSystem.create(sab, maxByteLength);
    target.setImageMetadata(this.imageMetadata);

    const lazyFilePaths = new Set(
      lazyEntries.flatMap((entry) => entry.paths ?? [entry.path]),
    );
    const lazyArchiveStubPaths = new Set<string>();
    for (const group of lazyArchiveEntries) {
      if (group.materialized) continue;
      for (const entry of group.entries) {
        if (!entry.deleted && !entry.isSymlink) {
          lazyArchiveStubPaths.add(entry.vfsPath);
        }
      }
    }

    source.copyPathToFreshFileSystem(
      "/",
      target,
      lazyFilePaths,
      lazyArchiveStubPaths,
      new Map(),
    );

    target.importLazyEntries(
      lazyEntries.map((entry) => {
        const st = target.fs.lstat(entry.path);
        return {
          ...entry,
          ino: st.ino,
          generation: st.generation,
          dataSequence: st.dataSequence,
        };
      }),
    );
    target.importLazyArchiveEntries(
      lazyArchiveEntries.map((group) => ({
        ...group,
        entries: group.entries.map((entry) => {
          if (entry.deleted) return { ...entry, ino: 0, generation: undefined };
          const st = target.fs.lstat(entry.vfsPath);
          return {
            ...entry,
            ino: st.ino,
            generation: st.generation,
            dataSequence: st.dataSequence,
          };
        }),
      })),
    );

    return target;
  }

  /** Return a copy of image-level metadata, or null if the image did not declare any. */
  getImageMetadata(): VfsImageMetadata | null {
    return cloneMetadata(this.imageMetadata);
  }

  /** Set or clear image-level metadata for the next saveImage() call. */
  setImageMetadata(metadata: VfsImageMetadata | null): void {
    this.imageMetadata = metadata === null ? null : validateMetadata(metadata);
  }

  subscribeLazyDownloads(listener: LazyDownloadListener): () => void {
    this.lazyDownloadListeners.add(listener);
    return () => this.lazyDownloadListeners.delete(listener);
  }

  /** Install the host-specific transport used for lazy file and archive URLs. */
  setLazyFetcher(fetcher: LazyFetch): void {
    this.lazyFetch = fetcher;
  }

  private emitLazyDownload(event: Omit<LazyDownloadEvent, "t">): void {
    if (this.lazyDownloadListeners.size === 0) return;
    const stamped: LazyDownloadEvent = { ...event, t: monotonicNow() };
    for (const listener of this.lazyDownloadListeners) {
      try {
        listener(stamped);
      } catch {
        /* listener errors must not break VFS I/O */
      }
    }
  }

  private async fetchLazyBytes(details: {
    id: string;
    kind: LazyDownloadKind;
    url: string;
    path?: string;
    mountPrefix?: string;
    fallbackTotalBytes?: number;
    integrity?: LazyArchiveIntegrity;
  }): Promise<Uint8Array> {
    let loadedBytes = 0;
    let totalBytes = details.integrity?.bytes ?? details.fallbackTotalBytes;
    const base = {
      id: details.id,
      kind: details.kind,
      url: details.url,
      path: details.path,
      mountPrefix: details.mountPrefix,
    };

    this.emitLazyDownload({
      ...base,
      status: "started",
      loadedBytes,
      totalBytes,
    });

    try {
      const resp = await this.lazyFetch(details.url);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }

      totalBytes = parseContentLength(resp.headers) ?? totalBytes;
      if (
        details.integrity &&
        totalBytes !== undefined &&
        totalBytes !== details.integrity.bytes
      ) {
        throw new Error(
          `Lazy ${details.kind} byte count ${totalBytes} does not match ` +
            `expected ${details.integrity.bytes}`,
        );
      }
      if (!resp.body) {
        const data = new Uint8Array(await resp.arrayBuffer());
        loadedBytes = data.byteLength;
        await assertLazyIntegrity(data, details.kind, details.integrity);
        this.emitLazyDownload({
          ...base,
          status: "progress",
          loadedBytes,
          totalBytes: totalBytes ?? loadedBytes,
        });
        this.emitLazyDownload({
          ...base,
          status: "complete",
          loadedBytes,
          totalBytes: totalBytes ?? loadedBytes,
        });
        return data;
      }

      const reader = resp.body.getReader();
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          chunks.push(value);
          loadedBytes += value.byteLength;
          if (details.integrity && loadedBytes > details.integrity.bytes) {
            await reader.cancel();
            throw new Error(
              `Lazy ${details.kind} exceeded expected byte count ` +
                `${details.integrity.bytes}`,
            );
          }
          this.emitLazyDownload({
            ...base,
            status: "progress",
            loadedBytes,
            totalBytes,
          });
        }
      } finally {
        reader.releaseLock();
      }

      const data = concatChunks(chunks, loadedBytes);
      await assertLazyIntegrity(data, details.kind, details.integrity);
      this.emitLazyDownload({
        ...base,
        status: "complete",
        loadedBytes,
        totalBytes: totalBytes ?? loadedBytes,
      });
      return data;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitLazyDownload({
        ...base,
        status: "error",
        loadedBytes,
        totalBytes,
        error: message,
      });
      throw err;
    }
  }

  /**
   * Register a lazy file: creates an empty stub in SharedFS and records
   * metadata for ensureMaterialized() to fetch asynchronously before a
   * synchronous read or exec path consumes the file.
   * Returns the inode number (useful for forwarding to other instances).
   */
  registerLazyFile(
    path: string,
    url: string,
    size: number,
    mode = 0o755,
  ): number {
    // Ensure parent directories exist
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current += "/" + parts[i];
      try {
        this.fs.mkdir(current, 0o755);
      } catch {
        /* exists */
      }
    }
    const st = this.fs.createLazyStub(path, mode);
    this.invalidateLazyData(st);
    this.lazyFiles.set(MemoryFileSystem.inodeKey(st.ino, st.generation), {
      ino: st.ino,
      generation: st.generation,
      dataSequence: st.dataSequence,
      path,
      paths: new Set([path]),
      url,
      size,
    });
    return st.ino;
  }

  /**
   * Import lazy file entries from another instance (e.g., main thread → worker).
   * Does not create files — assumes the files already exist in the SharedArrayBuffer.
   */
  importLazyEntries(entries: LazyFileEntry[]): void {
    this.importLazyEntriesInternal(entries, false);
  }

  private importLazyEntriesInternal(
    entries: LazyFileEntry[],
    trustedLegacySnapshot: boolean,
  ): void {
    for (const e of entries) {
      const isLegacy =
        e.generation === undefined || e.dataSequence === undefined;
      if (isLegacy && !trustedLegacySnapshot) {
        throw new Error(
          "Live lazy-file metadata requires inode generation and data sequence",
        );
      }
      const validPaths = new Set<string>();
      let identity: SfsStatResult | null = null;
      for (const path of new Set([e.path, ...(e.paths ?? [])])) {
        let st: SfsStatResult;
        try {
          st = this.fs.stat(path);
        } catch {
          continue;
        }
        if (st.ino !== e.ino) continue;
        if (e.generation !== undefined && st.generation !== e.generation) {
          continue;
        }
        if (e.dataSequence === undefined) {
          if (!MemoryFileSystem.canAdoptLegacyLazyStub(st)) continue;
        } else if (st.dataSequence !== e.dataSequence) continue;
        identity ??= st;
        validPaths.add(path);
      }
      if (!identity || validPaths.size === 0) continue;
      const primaryPath = validPaths.has(e.path)
        ? e.path
        : validPaths.values().next().value!;
      this.lazyFiles.set(
        MemoryFileSystem.inodeKey(identity.ino, identity.generation),
        {
          ino: identity.ino,
          generation: identity.generation,
          dataSequence: identity.dataSequence,
          path: primaryPath,
          paths: validPaths,
          url: e.url,
          size: e.size,
        },
      );
    }
  }

  private serializeLazyEntries(): LazyFileEntry[] {
    const entries: LazyFileEntry[] = [];
    for (const {
      ino,
      generation,
      dataSequence,
      path,
      paths,
      url,
      size,
    } of this.lazyFiles.values()) {
      entries.push({
        ino,
        generation,
        dataSequence,
        path,
        paths: Array.from(paths),
        url,
        size,
      });
    }
    return entries;
  }

  /** Export all pending lazy entries for transfer to another instance. */
  exportLazyEntries(): LazyFileEntry[] {
    this.reconcileLazyIdentityState(this.fs.identityState());
    return this.serializeLazyEntries();
  }

  /** Return lazy metadata for `path`, following symlinks through stat(). */
  getLazyEntry(path: string): LazyFileEntry | null {
    try {
      const st = this.fs.stat(path);
      const entry = this.lazyFileForStat(st);
      return entry
        ? {
            ino: st.ino,
            generation: st.generation,
            dataSequence: st.dataSequence,
            path: entry.path,
            paths: Array.from(entry.paths),
            url: entry.url,
            size: entry.size,
          }
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Report whether `path` currently resolves to any deferred backing without
   * starting I/O. This follows symlinks and covers both legacy lazy files and
   * typed archive/tree registrations.
   */
  isPathDeferred(path: string): boolean {
    return this.lazyBackingForPath(path) !== null;
  }

  /**
   * Rewrite the URL of every registered lazy file. Useful when a VFS image
   * was built with placeholder URLs and the browser runtime needs to replace
   * them with bundler-produced asset URLs.
   */
  rewriteLazyFileUrls(transform: (url: string, path: string) => string): void {
    for (const entry of this.lazyFiles.values()) {
      entry.url = transform(entry.url, entry.path);
    }
  }

  /**
   * Register a format-neutral immutable filesystem tree. The complete
   * inventory is validated before namespace mutation. One stub is created per
   * inode group and hard-link names are attached to that same SharedFS inode.
   */
  registerLazyTree(
    contentValue: LazyTreeContent,
    entriesValue: readonly LazyTreeRegistrationEntry[],
    mountPrefix = "/",
    activationValue?: LazyTreeActivation,
  ): LazyTreeGroup {
    return this.registerLazyTreeInternal(
      contentValue,
      entriesValue,
      mountPrefix,
      activationValue,
      false,
    );
  }

  private registerLazyTreeInternal(
    contentValue: LazyTreeContent,
    entriesValue: readonly LazyTreeRegistrationEntry[],
    mountPrefix: string,
    activationValue: LazyTreeActivation | undefined,
    allowTransportlessDirectMaterialization: boolean,
  ): LazyTreeGroup {
    this.assertCanRegisterPendingLazyArchiveGroup();
    const canonicalMountPrefix = normalizeLazyArchiveMountPrefix(mountPrefix);
    const {
      content,
      entries,
      mountPrefix: validatedMountPrefix,
      activation,
      canonicalByGroup,
    } = validateLazyTreeDefinition(
      contentValue,
      entriesValue,
      canonicalMountPrefix,
      activationValue ?? {
        mode: "first-use",
        capabilities: ["deferred-tree"],
        roots: [canonicalMountPrefix],
      },
      allowTransportlessDirectMaterialization ? 0 : 1,
    );

    const group: LazyTreeGroup = {
      content,
      url: content.transports[0] ?? "",
      mountPrefix: validatedMountPrefix,
      integrity: { sha256: content.sha256, bytes: content.bytes },
      materialized: false,
      inventory: entries.map((entry) => ({ ...entry })),
      activation,
      entries: new Map(),
    };
    const ensureParents = (path: string): void => {
      const parts = path.split("/").filter(Boolean);
      let current = "";
      for (let index = 0; index < parts.length - 1; index++) {
        current += `/${parts[index]}`;
        try {
          this.fs.mkdir(current, 0o755);
        } catch {
          const existing = this.fs.lstat(current);
          if ((existing.mode & S_IFMT) !== S_IFDIR) {
            throw new Error(`Lazy tree ancestor ${current} is not a directory`);
          }
        }
      }
    };

    for (const entry of [...entries].sort((left, right) =>
      left.vfsPath.split("/").length - right.vfsPath.split("/").length
    )) {
      if (entry.type !== "directory") continue;
      ensureParents(entry.vfsPath);
      try {
        this.fs.mkdir(entry.vfsPath, entry.mode);
        this.fs.chmod(entry.vfsPath, entry.mode);
      } catch {
        const existing = this.fs.lstat(entry.vfsPath);
        if ((existing.mode & S_IFMT) !== S_IFDIR) {
          throw new Error(`Lazy tree directory collides at ${entry.vfsPath}`);
        }
      }
    }

    for (const entry of entries) {
      if (entry.type !== "symlink") continue;
      ensureParents(entry.vfsPath);
      this.fs.symlink(entry.target!, entry.vfsPath);
      const st = this.fs.lstat(entry.vfsPath);
      group.entries.set(entry.vfsPath, {
        ino: st.ino,
        generation: st.generation,
        dataSequence: st.dataSequence,
        size: entry.size,
        isSymlink: true,
        deleted: false,
        materialized: true,
        archivePath: entry.sourcePath,
        sourcePath: entry.sourcePath,
        type: "symlink",
        target: entry.target,
      });
    }

    const stateByGroup = new Map<string, SfsStatResult>();
    for (const entry of entries) {
      if (entry.type !== "file") continue;
      ensureParents(entry.vfsPath);
      const st = this.fs.createLazyStub(entry.vfsPath, entry.mode);
      this.invalidateLazyData(st);
      stateByGroup.set(entry.inodeGroup!, st);
      const metadata: LazyArchiveFileEntry = {
        ino: st.ino,
        generation: st.generation,
        dataSequence: st.dataSequence,
        size: entry.size,
        isSymlink: false,
        deleted: false,
        materialized: false,
        archivePath: entry.sourcePath,
        sourcePath: entry.sourcePath,
        type: "file",
        inodeGroup: entry.inodeGroup,
      };
      group.entries.set(entry.vfsPath, metadata);
      this.lazyArchiveInodes.set(
        MemoryFileSystem.inodeKey(st.ino, st.generation),
        group,
      );
    }

    for (const entry of entries) {
      if (entry.type !== "hardlink") continue;
      const canonical = canonicalByGroup.get(entry.inodeGroup!)!;
      ensureParents(entry.vfsPath);
      this.fs.link(canonical.vfsPath, entry.vfsPath);
      const st = this.fs.lstat(entry.vfsPath);
      const expected = stateByGroup.get(entry.inodeGroup!)!;
      if (st.ino !== expected.ino || st.generation !== expected.generation) {
        throw new Error(`Lazy tree hardlink ${entry.vfsPath} did not share its inode`);
      }
      group.entries.set(entry.vfsPath, {
        ino: st.ino,
        generation: st.generation,
        dataSequence: st.dataSequence,
        size: entry.size,
        isSymlink: false,
        deleted: false,
        materialized: false,
        archivePath: canonical.sourcePath,
        sourcePath: entry.sourcePath,
        type: "hardlink",
        inodeGroup: entry.inodeGroup,
        target: entry.target,
      });
    }

    this.lazyArchiveGroups.push(group);
    return group;
  }

  /**
   * Register one typed tree and return only an opaque direct-materialization
   * authority. The mutable internal group is deliberately not exposed.
   */
  registerLazyTreeWithMaterializationHandle(
    contentValue: LazyTreeContent,
    entriesValue: readonly LazyTreeRegistrationEntry[],
    mountPrefix = "/",
    activationValue?: LazyTreeActivation,
  ): DeferredTreeMaterializationHandle {
    const group = this.registerLazyTreeInternal(
      contentValue,
      entriesValue,
      mountPrefix,
      activationValue,
      true,
    );
    const handle = Object.freeze({
      [DEFERRED_TREE_MATERIALIZATION_HANDLE]: true as const,
    });
    this.deferredTreeMaterializationHandles.set(handle, group);
    return handle;
  }

  /**
   * Register a lazy archive group: creates stubs in SharedFS for every file
   * entry and records metadata so that accessing any one of them triggers a
   * single archive fetch that materializes all files in the group.
   *
   * Parse the zip's central directory (via host/src/vfs/zip.ts) and pass the
   * resulting ZipEntry[] in `zipEntries`. `mountPrefix` maps the zip's
   * internal paths into the VFS (e.g. prefix "/usr/" turns "bin/vim" into
   * "/usr/bin/vim").
   */
  registerLazyArchiveFromEntries(
    url: string,
    zipEntries: ZipEntry[],
    mountPrefix: string,
    symlinkTargets?: Map<string, string>,
    integrity?: LazyArchiveIntegrity,
  ): LazyArchiveGroup {
    // Validate and plan the entire archive before creating even one directory,
    // stub, symlink, inode mapping, or group. SharedFS resolves `..`, so
    // validating only while registering would allow an archive member to
    // escape its mount prefix or leave partial state after a later failure.
    const plannedEntries = planLazyArchiveEntries(
      url,
      zipEntries,
      mountPrefix,
      symlinkTargets,
    );
    if (plannedEntries.some(({ entry }) => !entry.isDirectory && !entry.isSymlink)) {
      this.assertCanRegisterPendingLazyArchiveGroup();
    }
    const group: LazyArchiveGroup = {
      ...(integrity
        ? {
          content: validateLazyTreeContent({
            decoder: "zip-v1",
            mediaType: "application/zip",
            sha256: integrity.sha256,
            bytes: integrity.bytes,
            expandedBytes: plannedEntries.reduce(
              (total, planned) => total + planned.entry.uncompressedSize,
              0,
            ),
            sourceEntryCount: plannedEntries.length,
            transports: [url],
          }),
        }
        : {}),
      url,
      mountPrefix,
      integrity: validateLazyArchiveIntegrity(integrity),
      materialized: false,
      entries: new Map(),
    };

    for (const { entry: ze, vfsPath } of plannedEntries) {
      if (ze.isDirectory) continue;

      const parts = vfsPath.split("/").filter(Boolean);
      let current = "";
      for (let i = 0; i < parts.length - 1; i++) {
        current += "/" + parts[i];
        try {
          this.fs.mkdir(current, 0o755);
        } catch {
          /* exists */
        }
      }

      if (ze.isSymlink) {
        const target = symlinkTargets!.get(ze.fileName)!;
        this.fs.symlink(target, vfsPath);
        const st = this.fs.lstat(vfsPath);
        const entry: LazyArchiveFileEntry = {
          ino: st.ino,
          generation: st.generation,
          dataSequence: st.dataSequence,
          size: ze.uncompressedSize,
          isSymlink: true,
          deleted: false,
          materialized: true,
          archivePath: ze.fileName,
          sourcePath: ze.fileName,
          type: "symlink",
        };
        group.entries.set(vfsPath, entry);
      } else {
        const st = this.fs.createLazyStub(vfsPath, ze.mode);
        this.invalidateLazyData(st);
        const entry: LazyArchiveFileEntry = {
          ino: st.ino,
          generation: st.generation,
          dataSequence: st.dataSequence,
          size: ze.uncompressedSize,
          isSymlink: false,
          deleted: false,
          materialized: false,
          archivePath: ze.fileName,
          sourcePath: ze.fileName,
          type: "file",
          inodeGroup: ze.fileName,
        };
        group.entries.set(vfsPath, entry);
        this.lazyArchiveInodes.set(
          MemoryFileSystem.inodeKey(st.ino, st.generation),
          group,
        );
      }
    }

    group.materialized = Array.from(group.entries.values()).every(
      (entry) => entry.deleted || entry.materialized,
    );
    this.lazyArchiveGroups.push(group);
    return group;
  }

  /** Import lazy archive groups from another instance. Assumes stubs already exist. */
  importLazyArchiveEntries(serialized: SerializedLazyArchiveEntry[]): void {
    this.importLazyArchiveEntriesInternal(serialized, false, true);
  }

  private importLazyArchiveEntriesInternal(
    serializedValue: unknown,
    trustedLegacySnapshot: boolean,
    requireDiscriminator: boolean,
  ): void {
    const serialized = requireLazyTreeArray(
      serializedValue,
      "Serialized lazy archive groups",
      0,
      MAX_LAZY_TREE_GROUPS,
    ).map((value, index) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Serialized lazy archive group ${index} must be an object`);
      }
      const kind = (value as Record<string, unknown>).kind;
      if (
        kind === SERIALIZED_DEFERRED_TREE_V1_KIND ||
        kind === SERIALIZED_DEFERRED_TREE_V2_KIND
      ) {
        return validateSerializedGenericTree(value, kind);
      }
      if (kind === SERIALIZED_LEGACY_ARCHIVE_KIND) {
        return validateSerializedLegacyArchive(value, false);
      }
      if (kind !== undefined) {
        throw new Error(`Serialized lazy archive group ${index} has an unsupported kind`);
      }
      if (requireDiscriminator) {
        throw new Error(
          `Serialized lazy archive group ${index} is missing its kind discriminator`,
        );
      }
      return validateSerializedLegacyArchive(value, true);
    });
    validateSerializedDeferredTreeCollection([
      ...this.serializeLazyArchiveEntries(),
      ...serialized,
    ]);
    const plannedGroups: LazyArchiveGroup[] = [];
    const plannedInodes = new Map<string, LazyArchiveGroup>();
    for (const s of serialized) {
      const entries = new Map<string, LazyArchiveFileEntry>();
      const normalizedPrefix = s.mountPrefix.replace(/\/+$/, "");
      const genericTree = s.content !== undefined && s.inventory !== undefined &&
        s.activation !== undefined;
      const inventoryByPath = genericTree
        ? new Map(s.inventory!.map((entry) => [entry.vfsPath, entry]))
        : null;
      const inventoryByIdentity = genericTree
        ? new Map(s.inventory!.map((entry) => [
          lazyTreeInventoryIdentityKey(entry),
          entry,
        ]))
        : null;
      const identityByGroup = new Map<string, string>();
      const groupByIdentity = new Map<string, string>();
      for (const e of s.entries) {
        let st: SfsStatResult | null = null;
        const materialized =
          s.materialized || e.materialized === true || e.isSymlink;
        if (!e.deleted && !materialized) {
          const isLegacy =
            e.generation === undefined || e.dataSequence === undefined;
          if (isLegacy && !trustedLegacySnapshot) {
            throw new Error(
              "Live lazy-archive metadata requires inode generation and data sequence",
            );
          }
          try {
            st = this.fs.lstat(e.vfsPath);
          } catch {
            if (genericTree) {
              throw new Error(
                `Serialized lazy tree stub ${e.vfsPath} is missing from the filesystem`,
              );
            }
            continue;
          }
          if (st.ino !== e.ino) {
            if (genericTree) {
              throw new Error(
                `Serialized lazy tree stub ${e.vfsPath} has a different inode`,
              );
            }
            continue;
          }
          if (e.generation !== undefined && st.generation !== e.generation) {
            if (genericTree) {
              throw new Error(
                `Serialized lazy tree stub ${e.vfsPath} has a different generation`,
              );
            }
            continue;
          }
          if (e.dataSequence === undefined) {
            if (!MemoryFileSystem.canAdoptLegacyLazyStub(st)) {
              if (genericTree) {
                throw new Error(
                  `Serialized lazy tree stub ${e.vfsPath} is not pristine`,
                );
              }
              continue;
            }
          } else if (st.dataSequence !== e.dataSequence) {
            if (genericTree) {
              throw new Error(
                `Serialized lazy tree stub ${e.vfsPath} has a different data sequence`,
              );
            }
            continue;
          }
          if (genericTree) {
            const inventoryAtPath = inventoryByPath!.get(e.vfsPath);
            const inventoryEntry =
              inventoryByIdentity!.get(lazyTreeInventoryIdentityKey(e)) ??
              inventoryAtPath;
            if (
              !inventoryEntry || (st.mode & S_IFMT) !== S_IFREG || st.size !== 0 ||
              (st.mode & 0o7777) !== inventoryEntry.mode ||
              (inventoryAtPath?.inodeGroup !== undefined &&
                inventoryAtPath.inodeGroup !== inventoryEntry.inodeGroup)
            ) {
              throw new Error(
                `Serialized lazy tree stub ${e.vfsPath} disagrees with its inventory`,
              );
            }
            const identity = MemoryFileSystem.inodeKey(st.ino, st.generation);
            const group = e.inodeGroup!;
            const priorIdentity = identityByGroup.get(group);
            const priorGroup = groupByIdentity.get(identity);
            if (
              (priorIdentity !== undefined && priorIdentity !== identity) ||
              (priorGroup !== undefined && priorGroup !== group)
            ) {
              throw new Error(
                `Serialized lazy tree inode group ${group} disagrees with the filesystem`,
              );
            }
            identityByGroup.set(group, identity);
            groupByIdentity.set(identity, group);
          }
        }
        entries.set(e.vfsPath, {
          ino: e.ino,
          generation: st?.generation ?? e.generation,
          dataSequence: st?.dataSequence ?? e.dataSequence,
          size: e.size,
          isSymlink: e.isSymlink,
          deleted: e.deleted,
          materialized,
          archivePath:
            e.archivePath ?? e.vfsPath.slice(normalizedPrefix.length + 1),
          sourcePath:
            e.sourcePath ?? e.archivePath ??
              e.vfsPath.slice(normalizedPrefix.length + 1),
          type: e.type ?? (e.isSymlink ? "symlink" : "file"),
          inodeGroup: e.inodeGroup,
          target: e.target,
        });
      }
      const content = s.content === undefined
        ? undefined
        : validateLazyTreeContent(s.content);
      const group: LazyArchiveGroup = {
        content,
        url: content?.transports[0] ?? s.url,
        mountPrefix: s.mountPrefix,
        integrity: content
          ? { sha256: content.sha256, bytes: content.bytes }
          : validateLazyArchiveIntegrity(s.integrity),
        materialized: s.materialized || (
          !(content && s.inventory) &&
          Array.from(entries.values()).every(
            (entry) => entry.deleted || entry.materialized,
          )
        ),
        inventory: s.inventory?.map((entry) => ({ ...entry })),
        activation: s.activation
          ? {
            mode: s.activation.mode,
            capabilities: [...s.activation.capabilities],
            roots: [...s.activation.roots],
          }
          : undefined,
        entries,
      };
      plannedGroups.push(group);
      if (!group.materialized) {
        for (const [, entry] of entries) {
          if (
            !entry.deleted &&
            !entry.materialized &&
            entry.generation !== undefined
          ) {
            const key = MemoryFileSystem.inodeKey(entry.ino, entry.generation);
            const planned = plannedInodes.get(key);
            if (planned !== undefined && planned !== group) {
              throw new Error(
                `Serialized lazy archive groups share pending inode ${key}`,
              );
            }
            if (this.lazyArchiveInodes.has(key)) {
              throw new Error(
                `Serialized lazy archive group collides with pending inode ${key}`,
              );
            }
            plannedInodes.set(key, group);
          }
        }
      }
    }
    this.lazyArchiveGroups.push(...plannedGroups);
    for (const [key, group] of plannedInodes) {
      this.lazyArchiveInodes.set(key, group);
    }
  }

  /**
   * Rewrite the URL of every registered lazy archive group. Useful when the
   * VFS image was built with relative URLs (e.g. "vim.zip") and the runtime
   * needs to resolve them against a deployment base URL.
   */
  rewriteLazyArchiveUrls(transform: (url: string) => string): void {
    for (const group of this.lazyArchiveGroups) {
      if (group.content) {
        group.content = {
          ...group.content,
          transports: group.content.transports.map(transform),
        };
        group.url = group.content.transports[0];
      } else {
        group.url = transform(group.url);
      }
    }
  }

  private serializeLazyArchiveEntries(): SerializedLazyArchiveEntry[] {
    const serialized: SerializedLazyArchiveEntry[] = [];
    for (const group of this.lazyArchiveGroups) {
      const entries = Array.from(group.entries, ([vfsPath, entry]) => ({
        vfsPath,
        ino: entry.ino,
        generation: entry.generation,
        dataSequence: entry.dataSequence,
        size: entry.size,
        isSymlink: entry.isSymlink,
        deleted: entry.deleted,
        materialized: entry.materialized,
        archivePath: entry.archivePath,
        sourcePath: entry.sourcePath,
        type: entry.type,
        inodeGroup: entry.inodeGroup,
        target: entry.target,
      })).filter((entry) => !entry.deleted && !entry.materialized);
      if (
        entries.length === 0 &&
        !(group.content && group.inventory && !group.materialized)
      ) continue;
      const genericTree = group.content !== undefined &&
        group.inventory !== undefined && group.activation !== undefined;
      if (genericTree && group.content!.transports.length === 0) {
        throw new Error(
          "Direct-materialization tree must be materialized before serialization",
        );
      }
      serialized.push(genericTree
        ? {
          kind: group.content!.source === undefined
            ? SERIALIZED_DEFERRED_TREE_V1_KIND
            : SERIALIZED_DEFERRED_TREE_V2_KIND,
          content: group.content,
          inventory: group.inventory,
          activation: group.activation,
          url: group.url,
          mountPrefix: group.mountPrefix,
          integrity: group.integrity,
          materialized: false,
          entries,
        }
        : {
          kind: SERIALIZED_LEGACY_ARCHIVE_KIND,
          url: group.url,
          mountPrefix: group.mountPrefix,
          integrity: group.integrity,
          materialized: false,
          entries,
        });
    }
    return serialized;
  }

  /** Export all pending lazy archive groups for transfer to another instance. */
  exportLazyArchiveEntries(): SerializedLazyArchiveEntry[] {
    this.reconcileLazyIdentityState(this.fs.identityState());
    return this.serializeLazyArchiveEntries();
  }

  /** Return aggregate resources that a saved image would retain lazily. */
  pendingDeferredTreeUsage(): VfsDeferredTreeUsage {
    this.reconcileLazyIdentityState(this.fs.identityState());
    return summarizeSerializedDeferredTreeCollection(
      this.serializeLazyArchiveEntries(),
    );
  }

  /**
   * Prove that additional deferred-tree metadata can still be serialized and
   * restored together with the groups already pending in this filesystem.
   */
  assertCanAppendDeferredTreeUsage(additional: VfsDeferredTreeUsage): void {
    validateDeferredTreeUsage(additional);
    const pending = this.pendingDeferredTreeUsage();
    validateDeferredTreeUsage({
      groups: pending.groups + additional.groups,
      archiveBytes: pending.archiveBytes + additional.archiveBytes,
      expandedBytes: pending.expandedBytes + additional.expandedBytes,
      payloadBytes: pending.payloadBytes + additional.payloadBytes,
      entries: pending.entries + additional.entries,
    });
  }

  private assertCanRegisterPendingLazyArchiveGroup(): void {
    this.reconcileLazyIdentityState(this.fs.identityState());
    const pendingGroups = this.lazyArchiveGroups.filter((group) =>
      !group.materialized && (
        group.content !== undefined && group.inventory !== undefined ||
        Array.from(group.entries.values()).some((entry) =>
          !entry.deleted && !entry.materialized
        )
      )
    ).length;
    if (pendingGroups >= VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxGroups) {
      throw new Error(
        `Cannot register another lazy archive group: ` +
          `${VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxGroups} pending groups already exist`,
      );
    }
  }

  /**
   * Async-materialize a lazy file or archive-backed file if the given path
   * resolves to one. Call this before any synchronous read (e.g. in
   * handleExec) to avoid sync XHR which deadlocks with COOP/COEP.
   * Returns true if something was materialized, false if already concrete.
   */
  async preparePath(path: string): Promise<boolean> {
    let materialized = false;
    const maximumAttempts = Math.max(3, this.lazyArchiveGroups.length + 1);
    for (let attempt = 0; attempt < maximumAttempts; attempt++) {
      const backing = this.lazyBackingForPath(path);
      if (!backing) return materialized;
      const preparation = this.lazyPreparations.get(backing.token) ??
        this.startLazyPreparation(backing);
      try {
        materialized = (await preparation.promise) || materialized;
      } finally {
        if (this.lazyPreparations.get(backing.token) === preparation) {
          this.lazyPreparations.delete(backing.token);
        }
      }
    }
    if (this.lazyBackingForPath(path)) {
      throw new Error(`Lazy backing kept changing identity while preparing: ${path}`);
    }
    return materialized;
  }

  /**
   * Resolve every tree whose capability policy requires bytes before boot.
   * Registration/stat remain inert; callers choose the boot boundary and any
   * failure aborts that boundary instead of exposing zero-byte stubs.
   */
  async prepareBootDeferredTrees(): Promise<number> {
    const groups = this.lazyArchiveGroups.filter(
      (group) => !group.materialized && group.activation?.mode === "boot-prefetch",
    );
    let next = 0;
    let failure: unknown;
    const workers = Array.from(
      { length: Math.min(groups.length, MAX_BOOT_DEFERRED_TREE_CONCURRENCY) },
      async () => {
        while (failure === undefined) {
          const index = next;
          next += 1;
          if (index >= groups.length) return;
          try {
            await this.prepareLazyTreeGroup(groups[index]);
          } catch (error) {
            failure ??= error;
          }
        }
      },
    );
    await Promise.all(workers);
    if (failure !== undefined) throw failure;
    return groups.length;
  }

  /**
   * Materialize one exact typed tree authorized by this filesystem's opaque
   * registration wrapper. Build-time composers use this to embed a reviewed
   * package subset without re-pouring a smaller closure and thereby changing
   * global path/conflict ownership.
   */
  async materializeRegisteredDeferredTree(
    handle: DeferredTreeMaterializationHandle,
    exactBytes: Uint8Array,
  ): Promise<boolean> {
    const group = this.deferredTreeMaterializationHandles.get(handle);
    if (group === undefined) {
      throw new Error(
        "Deferred-tree handle was not issued by this filesystem",
      );
    }
    if (group.materialized) return false;
    const existing = this.lazyPreparations.get(group);
    if (existing !== undefined) return existing.promise;
    const bytes = new Uint8Array(exactBytes.byteLength);
    bytes.set(exactBytes);
    const preparation = {
      status: "pending",
      promise: Promise.resolve(false),
    } as LazyPreparation;
    // Defer the first await until after the shared preparation slot is owned,
    // so a concurrent guest preparePath() joins this exact-byte operation
    // instead of starting a transport fetch for the same group.
    preparation.promise = Promise.resolve().then(async () => {
      await assertLazyIntegrity(bytes, "tree", group.integrity);
      await this.materializeArchiveBytes(group, bytes);
      return true;
    }).then(
      (materialized) => {
        preparation.status = "fulfilled";
        return materialized;
      },
      (error) => {
        preparation.status = "rejected";
        preparation.error = error;
        throw error;
      },
    );
    void preparation.promise.catch(() => {});
    this.lazyPreparations.set(group, preparation);
    try {
      return await preparation.promise;
    } finally {
      if (this.lazyPreparations.get(group) === preparation) {
        this.lazyPreparations.delete(group);
      }
    }
  }

  private async prepareLazyTreeGroup(group: LazyTreeGroup): Promise<boolean> {
    if (group.materialized) return false;
    const backing: LazyBacking = {
      token: group,
      path: group.activation?.roots[0] ?? group.mountPrefix,
      directGroup: group,
    };
    const preparation = this.lazyPreparations.get(group) ??
      this.startLazyPreparation(backing);
    try {
      return await preparation.promise;
    } finally {
      if (this.lazyPreparations.get(group) === preparation) {
        this.lazyPreparations.delete(group);
      }
    }
  }

  /** Backward-compatible explicit preparation entrypoint. */
  async ensureMaterialized(path: string): Promise<boolean> {
    return this.preparePath(path);
  }

  private async materializePath(path: string): Promise<boolean> {
    if (this.lazyFiles.size === 0 && this.lazyArchiveInodes.size === 0)
      return false;
    let st: SfsStatResult;
    try {
      st = this.fs.stat(path); // follows symlinks
    } catch {
      return false;
    }
    const key = MemoryFileSystem.inodeKey(st.ino, st.generation);
    const entry = this.lazyFiles.get(key);
    if (entry) {
      const data = await this.fetchLazyBytes({
        id: `file:${st.ino}`,
        kind: "file",
        url: entry.url,
        path: entry.path,
        fallbackTotalBytes: entry.size,
      });
      for (let attempt = 0; attempt < 3; attempt++) {
        if (this.lazyFiles.get(key) !== entry) return false;
        for (const candidate of new Set([path, ...entry.paths])) {
          const materialized = this.fs.replaceIfIdentity(
            candidate,
            entry.ino,
            entry.generation,
            entry.dataSequence,
            data,
          );
          if (materialized) {
            entry.path = candidate;
            this.lazyFiles.delete(key);
            return true;
          }
        }
        // A peer may have renamed the inode while the fetch was in flight.
        // Refresh aliases and retry immediately with the bytes already read.
        this.reconcileLazyIdentityState(this.fs.identityState());
      }
      throw new Error(
        `Lazy file kept changing names while materializing: ${path}`,
      );
    }
    const group = this.lazyArchiveInodes.get(key);
    if (group) {
      await this.ensureArchiveMaterialized(group, {
        path,
        ino: st.ino,
        generation: st.generation,
      });
      return !this.lazyArchiveInodes.has(key);
    }
    return false;
  }

  private async decodeAndValidateLazyTree(
    group: LazyTreeGroup,
    data: Uint8Array,
  ): Promise<Map<string, Uint8Array>> {
    const content = group.content;
    const inventory = group.inventory;
    if (!content || !inventory) {
      throw new Error("Lazy tree is missing its decoder or complete inventory");
    }
    const expectedBySource = new Map<string, LazyTreeSourceEntry>();
    const inventoryByPath = new Map(inventory.map((entry) => [entry.vfsPath, entry]));
    if (content.source !== undefined) {
      for (const entry of content.source.entries) {
        expectedBySource.set(entry.sourcePath, entry);
      }
    } else {
      for (const entry of inventory) {
        if (entry.type === "hardlink") {
          const target = inventoryByPath.get(entry.target!);
          if (!target) throw new Error(`Lazy tree hardlink target disappeared: ${entry.target}`);
          // The derived ZIP scaffold stores one source member per inode and
          // reconstructs aliases from inventory. Native TAR hardlinks retain a
          // distinct source member and are validated below.
          if (entry.sourcePath === target.sourcePath) continue;
        }
        const prior = expectedBySource.get(entry.sourcePath);
        if (prior) {
          throw new Error(`Lazy tree inventory duplicates source member ${entry.sourcePath}`);
        }
        expectedBySource.set(entry.sourcePath, {
          sourcePath: entry.sourcePath,
          type: entry.type,
          mode: entry.mode,
          size: entry.size,
          ...(entry.type === "symlink" ? { target: entry.target } : {}),
          ...(entry.type === "hardlink"
            ? { target: inventoryByPath.get(entry.target!)?.sourcePath }
            : {}),
        });
      }
    }

    const decoded = new Map<string, {
      type: "directory" | "file" | "symlink" | "hardlink";
      mode: number;
      data?: Uint8Array;
      target?: string;
    }>();
    let expandedBytes = 0;
    if (content.decoder === "zip-v1") {
      const { parseZipCentralDirectory, extractZipEntryBounded } =
        await import("./zip");
      const zipEntries = parseZipCentralDirectory(data);
      if (
        zipEntries.length !== content.sourceEntryCount ||
        zipEntries.length !== expectedBySource.size
      ) {
        throw new Error("Lazy ZIP tree decoded inventory counts differ from its descriptor");
      }
      for (const entry of zipEntries) {
        const sourcePath = entry.isDirectory
          ? entry.fileName.replace(/\/$/, "")
          : entry.fileName;
        if (decoded.has(sourcePath)) {
          throw new Error(`Lazy ZIP tree duplicates source member ${sourcePath}`);
        }
        const expected = expectedBySource.get(sourcePath);
        if (!expected) {
          throw new Error(`Lazy ZIP tree has undeclared source member ${sourcePath}`);
        }
        expandedBytes += entry.uncompressedSize;
        if (expandedBytes > content.expandedBytes || entry.uncompressedSize !== expected.size) {
          throw new Error(`Lazy ZIP tree member ${sourcePath} exceeds its inventory`);
        }
        const actualType = entry.isDirectory
          ? "directory"
          : entry.isSymlink
            ? "symlink"
            : "file";
        if (
          actualType !== expected.type ||
          (entry.mode & 0o7777) !== expected.mode
        ) {
          throw new Error(`Lazy ZIP tree member ${sourcePath} differs from inventory`);
        }
        if (entry.isDirectory) {
          decoded.set(sourcePath, { type: "directory", mode: entry.mode });
        } else {
          const member = extractZipEntryBounded(data, entry, expected.size);
          if (entry.isSymlink) {
            let target: string;
            try {
              target = new TextDecoder("utf-8", { fatal: true }).decode(member);
            } catch {
              throw new Error(`Lazy ZIP tree symlink ${sourcePath} is not UTF-8`);
            }
            decoded.set(sourcePath, {
              type: "symlink",
              mode: entry.mode,
              target,
            });
          } else {
            decoded.set(sourcePath, {
              type: "file",
              mode: entry.mode,
              data: member,
            });
          }
        }
      }
    } else {
      const { parseTarGzip } = await import("./tar");
      const parsed = parseTarGzip(data, {
        label: `Lazy tree ${content.sha256}`,
        limits: {
          maxCompressedBytes: content.bytes,
          maxUncompressedBytes: content.expandedBytes,
          maxEntries: content.sourceEntryCount,
        },
      });
      expandedBytes = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      ).getUint32(data.byteLength - 4, true);
      for (const entry of parsed) {
        if (decoded.has(entry.path)) {
          throw new Error(`Lazy TAR tree duplicates source member ${entry.path}`);
        }
        if (entry.type === "file") {
          decoded.set(entry.path, {
            type: "file",
            mode: entry.mode,
            data: entry.data,
          });
        } else if (entry.type === "directory") {
          decoded.set(entry.path, { type: "directory", mode: entry.mode });
        } else {
          decoded.set(entry.path, {
            type: entry.type,
            mode: entry.mode,
            target: entry.linkName,
          });
        }
      }
    }
    if (
      decoded.size !== content.sourceEntryCount ||
      decoded.size !== expectedBySource.size ||
      expandedBytes !== content.expandedBytes
    ) {
      throw new Error("Lazy tree decoded inventory counts differ from its descriptor");
    }

    for (const [sourcePath, expected] of expectedBySource) {
      const actual = decoded.get(sourcePath);
      if (!actual) throw new Error(`Lazy tree is missing source member ${sourcePath}`);
      const expectedType = expected.type;
      if (actual.type !== expectedType) {
        throw new Error(
          `Lazy tree member ${sourcePath} is ${actual.type}, expected ${expectedType}`,
        );
      }
      if ((actual.mode & 0o7777) !== expected.mode) {
        throw new Error(`Lazy tree member ${sourcePath} mode differs from inventory`);
      }
      if (expectedType === "file" && actual.data?.byteLength !== expected.size) {
        throw new Error(`Lazy tree member ${sourcePath} size differs from inventory`);
      }
      if (expectedType === "symlink" && actual.target !== expected.target) {
        throw new Error(`Lazy tree symlink ${sourcePath} target differs from inventory`);
      }
      if (expectedType === "hardlink") {
        if (actual.target !== expected.target) {
          throw new Error(`Lazy tree hardlink ${sourcePath} target differs from inventory`);
        }
      }
    }

    const relocationSources = new Set(
      inventory.flatMap((entry) =>
        entry.materialization === "archive-homebrew-relocate"
          ? [entry.sourcePath]
          : []
      ),
    );
    if (content.source !== undefined) {
      const sourceByPath = new Map(
        content.source.entries.map((entry) => [entry.sourcePath, entry]),
      );
      const canonicalByPath = resolveLazyTreeSourceHardlinks(content.source.entries);
      const receiptSources = content.source.entries.filter((entry) =>
        entry.sourcePath === "INSTALL_RECEIPT.json" ||
        entry.sourcePath.endsWith("/INSTALL_RECEIPT.json")
      );
      if (receiptSources.length > 1) {
        throw new Error(
          `Lazy Homebrew bottle has ${receiptSources.length} INSTALL_RECEIPT.json ` +
            "source members, expected at most one",
        );
      }
      if (receiptSources.length === 0) {
        if (relocationSources.size > 0) {
          throw new Error(
            "Lazy Homebrew bottle marks receipt relocation without INSTALL_RECEIPT.json",
          );
        }
      } else {
        const receiptSource = receiptSources[0]!;
        const receiptCanonical = receiptSource.type === "file"
          ? receiptSource
          : canonicalByPath.get(receiptSource.sourcePath);
        const receiptDecoded = receiptCanonical === undefined
          ? undefined
          : decoded.get(receiptCanonical.sourcePath);
        if (receiptCanonical?.type !== "file" || receiptDecoded?.type !== "file" ||
          receiptDecoded.data === undefined) {
          throw new Error("Lazy Homebrew bottle INSTALL_RECEIPT.json is not regular");
        }
        const receipt = parseHomebrewInstallReceiptRelocation(receiptDecoded.data);
        const separator = receiptSource.sourcePath.lastIndexOf("/");
        const sourceRoot = separator < 0
          ? ""
          : receiptSource.sourcePath.slice(0, separator);
        const receiptChangedSources = new Set(receipt.changedFiles.map((path) =>
          sourceRoot.length === 0 ? path : `${sourceRoot}/${path}`
        ));
        if (
          relocationSources.size !== receiptChangedSources.size ||
          [...relocationSources].some((path) => !receiptChangedSources.has(path))
        ) {
          throw new Error(
            "Lazy Homebrew bottle relocation markers differ from INSTALL_RECEIPT.json",
          );
        }
        const relocatedCanonicalSources = new Set<string>();
        for (const sourcePath of receiptChangedSources) {
          const source = sourceByPath.get(sourcePath);
          const canonical = source?.type === "file"
            ? source
            : source === undefined
              ? undefined
              : canonicalByPath.get(source.sourcePath);
          const actual = canonical === undefined
            ? undefined
            : decoded.get(canonical.sourcePath);
          if (canonical?.type !== "file" || actual?.type !== "file" ||
            actual.data === undefined) {
            throw new Error(
              `Lazy Homebrew bottle changed source ${sourcePath} is not regular`,
            );
          }
          if (relocatedCanonicalSources.has(canonical.sourcePath)) continue;
          actual.data = relocateHomebrewBottleFile(actual.data, receipt, sourcePath);
          relocatedCanonicalSources.add(canonical.sourcePath);
        }
      }
    } else if (relocationSources.size > 0) {
      throw new Error("Lazy tree receipt relocation requires original-bottle source truth");
    }

    const files = new Map<string, Uint8Array>();
    for (const entry of inventory) {
      if (entry.type !== "file") continue;
      if (entry.materialization === "descriptor") continue;
      const decodedEntry = decoded.get(entry.sourcePath);
      if (decodedEntry?.type !== "file" || !decodedEntry.data) {
        throw new Error(`Lazy tree has no file content for ${entry.sourcePath}`);
      }
      files.set(entry.sourcePath, decodedEntry.data);
    }
    return files;
  }

  /**
   * Materialize a full lazy archive group: fetch the zip once, parse its
   * central directory, and write every non-deleted entry into its stub.
   * Subsequent calls are no-ops.
   */
  async ensureArchiveMaterialized(
    group: LazyArchiveGroup,
    requested?: { path: string; ino: number; generation: number },
  ): Promise<void> {
    if (group.materialized) return;
    const genericTree = group.content !== undefined && group.inventory !== undefined;

    const transports = genericTree ? group.content!.transports : [group.url];
    const failures: string[] = [];
    let archiveData: Uint8Array | null = null;
    for (const [index, url] of transports.entries()) {
      try {
        archiveData = await this.fetchLazyBytes({
          id: `archive:${group.mountPrefix}:${group.content?.sha256 ?? url}:${index}`,
          kind: genericTree ? "tree" : "archive",
          url,
          mountPrefix: group.mountPrefix,
          integrity: group.integrity,
        });
        break;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (archiveData === null) {
      throw new Error(
        `All ${transports.length} lazy ${genericTree ? "tree" : "archive"} ` +
          `transports failed: ${failures.join("; ")}`,
      );
    }

    await this.materializeArchiveBytes(group, archiveData, requested);
  }

  private async materializeArchiveBytes(
    group: LazyArchiveGroup,
    archiveData: Uint8Array,
    requested?: { path: string; ino: number; generation: number },
  ): Promise<void> {
    if (group.materialized) return;
    const genericTree = group.content !== undefined && group.inventory !== undefined;
    const decodedTreeFiles = genericTree
      ? await this.decodeAndValidateLazyTree(group, archiveData)
      : null;
    const { parseZipCentralDirectory, extractZipEntry } = await import("./zip");
    const zipEntries = decodedTreeFiles ? [] : parseZipCentralDirectory(archiveData);
    const zipLookup = new Map<string, ZipEntry>();
    for (const ze of zipEntries) {
      if (zipLookup.has(ze.fileName)) {
        throw new Error(`Lazy archive contains duplicate member: ${ze.fileName}`);
      }
      zipLookup.set(ze.fileName, ze);
    }

    const normalizedPrefix = group.mountPrefix.replace(/\/+$/, "");
    const extractedByIdentity = new Map<string, {
      archivePath: string;
      content: Uint8Array;
    }>();
    for (const [vfsPath, archiveEntry] of group.entries) {
      if (archiveEntry.deleted || archiveEntry.materialized) continue;
      const zipFileName =
        archiveEntry.archivePath ??
        vfsPath.slice(normalizedPrefix.length + 1);
      const ze = decodedTreeFiles ? undefined : zipLookup.get(zipFileName);
      const treeContent = decodedTreeFiles?.get(zipFileName);
      if (decodedTreeFiles) {
        if (treeContent === undefined || treeContent.byteLength !== archiveEntry.size) {
          throw new Error(
            `Lazy tree member ${zipFileName} does not match its registered metadata`,
          );
        }
      } else if (
        ze === undefined || ze.isDirectory || ze.isSymlink ||
        ze.uncompressedSize !== archiveEntry.size
      ) {
        throw new Error(
          `Lazy archive member ${zipFileName} does not match its registered metadata`,
        );
      }
      if (archiveEntry.generation === undefined) continue;
      const key = MemoryFileSystem.inodeKey(
        archiveEntry.ino,
        archiveEntry.generation,
      );
      const prior = extractedByIdentity.get(key);
      if (prior && prior.archivePath !== zipFileName) {
        throw new Error(
          `Lazy archive aliases for inode ${key} name different members`,
        );
      }
      if (!prior) {
        // Extraction (including compression/CRC/size validation) is part of
        // preflight. Do not mutate the first stub until every pending member
        // has been successfully decoded into ordinary memory.
        const content = treeContent ?? extractZipEntry(archiveData, ze!);
        if (content.byteLength !== archiveEntry.size) {
          throw new Error(
            `Lazy archive member ${zipFileName} extracted ${content.byteLength} ` +
              `bytes, expected ${archiveEntry.size}`,
          );
        }
        extractedByIdentity.set(key, { archivePath: zipFileName, content });
      }
    }
    const requestedKey = requested
      ? MemoryFileSystem.inodeKey(requested.ino, requested.generation)
      : null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const pending = new Map<string, {
        ino: number;
        generation: number;
        dataSequence: number;
        paths: Set<string>;
        content: Uint8Array;
      }>();
      for (const [vfsPath, archiveEntry] of group.entries) {
        if (
          archiveEntry.deleted ||
          archiveEntry.materialized ||
          archiveEntry.generation === undefined
        ) continue;
        const key = MemoryFileSystem.inodeKey(
          archiveEntry.ino,
          archiveEntry.generation,
        );
        if (this.lazyArchiveInodes.get(key) !== group) continue;
        const extracted = extractedByIdentity.get(key);
        if (!extracted) {
          throw new Error(`Lazy archive has no extracted content for inode ${key}`);
        }
        let replacement = pending.get(key);
        if (!replacement) {
          replacement = {
            ino: archiveEntry.ino,
            generation: archiveEntry.generation,
            dataSequence: archiveEntry.dataSequence ?? 0,
            paths: new Set(),
            content: extracted.content,
          };
          pending.set(key, replacement);
        }
        replacement.paths.add(vfsPath);
        if (
          requested &&
          requested.ino === archiveEntry.ino &&
          requested.generation === archiveEntry.generation
        ) {
          replacement.paths.add(requested.path);
        }
      }

      if (pending.size > 0) {
        const committed = this.fs.replaceManyIfIdentities(
          Array.from(pending.values(), (replacement) => ({
            paths: Array.from(replacement.paths),
            expectedIno: replacement.ino,
            expectedGeneration: replacement.generation,
            expectedDataSequence: replacement.dataSequence,
            data: replacement.content,
          })),
        );
        if (!committed) {
          this.reconcileLazyIdentityState(this.fs.identityState());
          if (requestedKey && !this.lazyArchiveInodes.has(requestedKey)) return;
          continue;
        }
      }

      for (const [key, replacement] of pending) {
        this.lazyArchiveInodes.delete(key);
        for (const alias of group.entries.values()) {
          if (
            alias.ino === replacement.ino &&
            alias.generation === replacement.generation
          ) alias.materialized = true;
        }
      }

      group.materialized = Array.from(group.entries.values()).every(
        (entry) => entry.deleted || entry.materialized,
      );
      if (group.materialized) return;
      this.reconcileLazyIdentityState(this.fs.identityState());
      if (requestedKey && !this.lazyArchiveInodes.has(requestedKey)) return;
    }

    if (requestedKey && this.lazyArchiveInodes.has(requestedKey)) {
      throw new Error(
        `Lazy archive member kept changing names while materializing: ${requested?.path}`,
      );
    }
  }

  private async materializeAllLazyEntries(): Promise<void> {
    // A peer can rename an inode while an asynchronous fetch is in flight.
    // Refresh and retry a bounded number of times; a continuously mutating
    // filesystem is not a stable source for a self-contained image.
    for (let attempt = 0; attempt < 3; attempt++) {
      this.reconcileLazyIdentityState(this.fs.identityState());
      const genericGroups = this.lazyArchiveGroups.filter((group) =>
        !group.materialized && group.content !== undefined && group.inventory !== undefined
      );
      if (
        this.lazyFiles.size === 0 &&
        this.lazyArchiveInodes.size === 0 &&
        genericGroups.length === 0
      )
        return;

      const filePaths = Array.from(
        this.lazyFiles.values(),
        (entry) => entry.path,
      );
      for (const path of filePaths) await this.ensureMaterialized(path);

      const archiveGroups = new Set(this.lazyArchiveInodes.values());
      for (const group of genericGroups) archiveGroups.add(group);
      for (const group of archiveGroups) {
        await this.prepareLazyTreeGroup(group);
      }
    }

    this.reconcileLazyIdentityState(this.fs.identityState());
    const pendingGenericTree = this.lazyArchiveGroups.some((group) =>
      !group.materialized && group.content !== undefined && group.inventory !== undefined
    );
    if (
      this.lazyFiles.size !== 0 ||
      this.lazyArchiveInodes.size !== 0 ||
      pendingGenericTree
    ) {
      throw new Error(
        "Cannot create a self-contained VFS image while lazy entries remain pending",
      );
    }
  }

  /**
   * Save the current filesystem state as a portable binary image.
   *
   * With `materializeAll: true`, all lazy files are fetched and written
   * into the filesystem before saving, producing a self-contained image.
   * Otherwise, lazy file metadata (path/URL/size) is preserved in the
   * image and restored on load.
   */
  async saveImage(options?: VfsImageOptions): Promise<Uint8Array> {
    if (options?.materializeAll) {
      await this.materializeAllLazyEntries();
    }

    const { bytes: sabBytes, identities } = this.fs.snapshotState({
      normalizeTimestampsMs: options?.normalizeTimestampsMs,
    });
    this.reconcileLazyIdentityState(identities);
    const lazyEntries = this.serializeLazyEntries();
    const hasLazy = lazyEntries.length > 0;
    const lazyJson = hasLazy
      ? new TextEncoder().encode(JSON.stringify(lazyEntries))
      : new Uint8Array(0);
    if (lazyJson.byteLength > VFS_IMAGE_MAX_LAZY_METADATA_BYTES) {
      throw new Error(
        `VFS image lazy metadata exceeds ${VFS_IMAGE_MAX_LAZY_METADATA_BYTES} bytes`,
      );
    }

    const archiveEntries = this.serializeLazyArchiveEntries();
    validateSerializedDeferredTreeCollection(archiveEntries);
    const hasArchives = archiveEntries.length > 0;
    const archiveJson = hasArchives
      ? new TextEncoder().encode(JSON.stringify(archiveEntries))
      : new Uint8Array(0);
    if (archiveJson.byteLength > VFS_IMAGE_MAX_LAZY_ARCHIVE_METADATA_BYTES) {
      throw new Error(
        `VFS image lazy archive metadata exceeds ` +
          `${VFS_IMAGE_MAX_LAZY_ARCHIVE_METADATA_BYTES} bytes`,
      );
    }

    const metadata =
      options?.metadata === undefined ? this.imageMetadata : options.metadata;
    const metadataJson = encodeMetadata(metadata);
    const hasMetadata = metadataJson.byteLength > 0;

    // Layout: header | sab | u32 lazyLen | lazyJson | u32 archiveLen | archiveJson | u32 metadataLen | metadataJson
    // Archive and metadata sections are only appended when their flags are set.
    const archiveSectionSize = hasArchives ? 4 + archiveJson.byteLength : 0;
    const metadataSectionSize = hasMetadata ? 4 + metadataJson.byteLength : 0;
    const totalSize =
      VFS_IMAGE_HEADER_SIZE +
      sabBytes.byteLength +
      4 +
      lazyJson.byteLength +
      archiveSectionSize +
      metadataSectionSize;
    const image = new Uint8Array(totalSize);
    const view = new DataView(image.buffer);

    // Header
    view.setUint32(0, VFS_IMAGE_MAGIC, true);
    view.setUint32(4, VFS_IMAGE_VERSION, true);
    view.setUint32(
      8,
      (hasLazy ? VFS_IMAGE_FLAG_HAS_LAZY : 0) |
        (hasArchives ? VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES : 0) |
        (hasArchives ? VFS_IMAGE_FLAG_HAS_TYPED_LAZY_ARCHIVES : 0) |
        (hasMetadata ? VFS_IMAGE_FLAG_HAS_METADATA : 0),
      true,
    );
    view.setUint32(12, sabBytes.byteLength, true);

    // SAB data is already a detached, runtime-state-free snapshot.
    image.set(sabBytes, VFS_IMAGE_HEADER_SIZE);

    // Lazy entries
    const lazyOffset = VFS_IMAGE_HEADER_SIZE + sabBytes.byteLength;
    view.setUint32(lazyOffset, lazyJson.byteLength, true);
    if (lazyJson.byteLength > 0) {
      image.set(lazyJson, lazyOffset + 4);
    }

    // Archive entries
    if (hasArchives) {
      const archiveOffset = lazyOffset + 4 + lazyJson.byteLength;
      view.setUint32(archiveOffset, archiveJson.byteLength, true);
      image.set(archiveJson, archiveOffset + 4);
    }

    // Metadata
    if (hasMetadata) {
      const metadataOffset =
        lazyOffset + 4 + lazyJson.byteLength + archiveSectionSize;
      view.setUint32(metadataOffset, metadataJson.byteLength, true);
      image.set(metadataJson, metadataOffset + 4);
    }

    return image;
  }

  /** Read image-level metadata without materializing the filesystem SAB. */
  static readImageMetadata(image: Uint8Array): VfsImageMetadata | null {
    const parsed = parseImageHeader(image);
    if (!(parsed.flags & VFS_IMAGE_FLAG_HAS_METADATA)) return null;
    const { metadataOffset } = sectionOffsetAfterArchives(
      parsed.image,
      parsed.view,
      parsed.flags,
      parsed.sabLen,
    );
    if (parsed.image.byteLength < metadataOffset + 4) {
      throw new Error("VFS image truncated (metadata section)");
    }
    const metadataLen = parsed.view.getUint32(metadataOffset, true);
    if (metadataLen > VFS_IMAGE_MAX_METADATA_BYTES) {
      throw new Error(
        `VFS image metadata exceeds ${VFS_IMAGE_MAX_METADATA_BYTES} bytes`,
      );
    }
    if (parsed.image.byteLength < metadataOffset + 4 + metadataLen) {
      throw new Error("VFS image truncated (metadata payload)");
    }
    if (metadataLen === 0) return null;
    return decodeMetadata(
      parsed.image.subarray(
        metadataOffset + 4,
        metadataOffset + 4 + metadataLen,
      ),
    );
  }

  /**
   * Validate an image's optional kernel ABI declaration. Images without a
   * `kernelAbi` declaration are accepted so legacy/data-only images keep
   * loading; callers that require an explicit declaration should check
   * `readImageMetadata(image)?.kernelAbi` first.
   */
  static assertImageKernelAbi(
    image: Uint8Array,
    kernelAbi: number,
    label = "VFS image",
  ): void {
    const metadata = MemoryFileSystem.readImageMetadata(image);
    const declared = metadata?.kernelAbi;
    if (declared === undefined) return;
    if (declared !== kernelAbi) {
      throw new Error(
        `${label} requires kernel ABI ${declared}, but the running kernel is ABI ${kernelAbi}`,
      );
    }
  }

  /** Read the current and maximum filesystem sizes encoded in an image. */
  static readImageCapacity(image: Uint8Array): VfsImageCapacity {
    const parsed = parseImageHeader(image);
    return SharedFS.inspectImageCapacity(
      parsed.image.subarray(
        VFS_IMAGE_HEADER_SIZE,
        VFS_IMAGE_HEADER_SIZE + parsed.sabLen,
      ),
    );
  }

  /**
   * Restore an image with the growth ceiling recorded in its SharedFS
   * superblock. Use fromImage() when a caller intentionally supplies a
   * different runtime ceiling.
   */
  static fromImagePreservingCapacity(image: Uint8Array): MemoryFileSystem {
    const parsed = parseImageHeader(image);
    const capacity = SharedFS.inspectImageCapacity(
      parsed.image.subarray(
        VFS_IMAGE_HEADER_SIZE,
        VFS_IMAGE_HEADER_SIZE + parsed.sabLen,
      ),
    );
    return MemoryFileSystem.restoreParsedImage(parsed, {
      maxByteLength: capacity.maxByteLength,
    });
  }

  /**
   * Restore a MemoryFileSystem from a previously saved VFS image.
   * Allocates a new SharedArrayBuffer and populates it from the image.
   *
   * When `maxByteLength` is specified, creates a growable SharedArrayBuffer
   * so the filesystem can expand beyond the image's original size, up to the
   * maximum already recorded in the image superblock.
   */
  static fromImage(
    image: Uint8Array,
    options?: { maxByteLength?: number },
  ): MemoryFileSystem {
    const parsed = parseImageHeader(image);
    return MemoryFileSystem.restoreParsedImage(parsed, options);
  }

  private static restoreParsedImage(
    parsed: ParsedImageHeader,
    options?: { maxByteLength?: number },
  ): MemoryFileSystem {
    const image = parsed.image;
    const view = parsed.view;
    const flags = parsed.flags;
    const sabLen = parsed.sabLen;
    const sections = sectionOffsetAfterArchives(image, view, flags, sabLen);
    if (!(flags & VFS_IMAGE_FLAG_HAS_LAZY) && sections.lazyLen !== 0) {
      throw new Error("VFS image has lazy metadata without its format flag");
    }
    if (
      (flags & VFS_IMAGE_FLAG_HAS_TYPED_LAZY_ARCHIVES) &&
      !(flags & VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES)
    ) {
      throw new Error(
        "VFS image has typed lazy-archive metadata without its archive flag",
      );
    }

    // Restore SharedArrayBuffer (optionally growable). Some TypeScript lib
    // versions still expose only the 1-arg constructor even on runtimes that
    // support the options object.
    const sabOptions = options?.maxByteLength
      ? { maxByteLength: options.maxByteLength }
      : undefined;
    const SharedArrayBufferCtor = SharedArrayBuffer as new (
      byteLength: number,
      options?: { maxByteLength?: number },
    ) => SharedArrayBuffer;
    const sab = new SharedArrayBufferCtor(sabLen, sabOptions);
    const sabView = new Uint8Array(sab);
    sabView.set(
      image.subarray(VFS_IMAGE_HEADER_SIZE, VFS_IMAGE_HEADER_SIZE + sabLen),
    );

    let metadata: VfsImageMetadata | null = null;
    if (flags & VFS_IMAGE_FLAG_HAS_METADATA) {
      metadata = MemoryFileSystem.readImageMetadata(image);
    }

    const mfs = new MemoryFileSystem(
      SharedFS.mount(sab, { restoreImage: true }),
      metadata,
    );

    // Restore lazy entries
    const lazyOffset = VFS_IMAGE_HEADER_SIZE + sabLen;
    const lazyLen = sections.lazyLen;
    if (flags & VFS_IMAGE_FLAG_HAS_LAZY) {
      if (lazyLen > 0) {
        const lazyBytes = image.subarray(
          lazyOffset + 4,
          lazyOffset + 4 + lazyLen,
        );
        const entries = requireLazyTreeArray(
          decodeJsonSection(lazyBytes, "VFS image lazy metadata"),
          "VFS image lazy entries",
          0,
          MAX_LAZY_TREE_ENTRIES,
        ) as LazyFileEntry[];
        mfs.importLazyEntriesInternal(entries, true);
      }
    }

    // Restore lazy archive groups
    if (flags & VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES) {
      const archiveOffset = sections.archiveOffset;
      const archiveLen = view.getUint32(archiveOffset, true);
      if (archiveLen > 0) {
        const archiveBytes = image.subarray(
          archiveOffset + 4,
          archiveOffset + 4 + archiveLen,
        );
        const entries = decodeJsonSection(
          archiveBytes,
          "VFS image lazy archive metadata",
        );
        mfs.importLazyArchiveEntriesInternal(
          entries,
          true,
          Boolean(flags & VFS_IMAGE_FLAG_HAS_TYPED_LAZY_ARCHIVES),
        );
      }
    }

    return mfs;
  }

  private adaptStat(s: SfsStatResult): StatResult {
    return {
      dev: 0,
      ino: s.ino,
      mode: s.mode,
      nlink: s.linkCount,
      uid: s.uid,
      gid: s.gid,
      size: s.size,
      atimeMs: s.atime,
      mtimeMs: s.mtime,
      ctimeMs: s.ctime,
    };
  }

  private adaptStatWithLazySize(s: SfsStatResult): StatResult {
    const result = this.adaptStat(s);
    const entry = this.lazyFileForStat(s);
    if (entry) {
      result.size = entry.size;
      return result;
    }

    const group = this.lazyArchiveForStat(s);
    if (group) {
      for (const archiveEntry of group.entries.values()) {
        if (
          archiveEntry.ino === s.ino &&
          archiveEntry.generation === s.generation &&
          !archiveEntry.deleted
        ) {
          result.size = archiveEntry.size;
          break;
        }
      }
    }
    return result;
  }

  open(path: string, flags: number, mode: number): number {
    if (
      (flags & O_TRUNC) === 0 &&
      !((flags & O_CREAT) !== 0 && (flags & O_EXCL) !== 0)
    ) {
      this.guardSynchronousLazyAccess(path);
    }
    const handle = this.fs.open(path, flags, mode);
    if ((flags & O_TRUNC) !== 0) {
      // O_TRUNC
      this.invalidateLazyData(this.fs.fstat(handle));
    }
    return handle;
  }

  close(handle: number): number {
    this.fs.close(handle);
    return 0;
  }

  read(
    handle: number,
    buffer: Uint8Array,
    offset: number | null,
    length: number,
  ): number {
    if (length > 0) {
      let backing = this.lazyBackingForStat(this.fs.fstat(handle));
      if (backing) {
        // Another SharedFS peer can rename a still-open lazy inode. Refresh
        // its surviving name before starting the asynchronous preparation.
        this.reconcileLazyIdentityState(this.fs.identityState());
        backing = this.lazyBackingForStat(this.fs.fstat(handle));
        if (backing) this.guardSynchronousLazyAccess(backing.path);
      }
    }
    if (offset !== null) {
      return this.fs.readAt(handle, buffer.subarray(0, length), offset);
    }
    return this.fs.read(handle, buffer.subarray(0, length));
  }

  write(
    handle: number,
    buffer: Uint8Array,
    offset: number | null,
    length: number,
  ): number {
    if (offset !== null) {
      const n = this.fs.writeAt(handle, buffer.subarray(0, length), offset);
      if (n > 0) this.invalidateLazyData(this.fs.fstat(handle));
      return n;
    }
    const n = this.fs.write(handle, buffer.subarray(0, length));
    if (n > 0) this.invalidateLazyData(this.fs.fstat(handle));
    return n;
  }

  seek(handle: number, offset: number, whence: number): number {
    return this.fs.lseek(handle, offset, whence);
  }

  fstat(handle: number): StatResult {
    return this.adaptStatWithLazySize(this.fs.fstat(handle));
  }

  fpathconf(handle: number, name: number): PathconfValue {
    const stat = this.fstat(handle);
    return filesystemPathconf(stat, name, {
      supportsSymlinks: true,
      timestampResolutionNs: 1_000_000,
    });
  }

  ftruncate(handle: number, length: number): void {
    this.fs.ftruncate(handle, length);
    this.invalidateLazyData(this.fs.fstat(handle));
  }

  // SharedFS is memory-backed, fsync is a no-op
  fsync(_handle: number): void {}

  fchmod(handle: number, mode: number): void {
    this.fs.fchmod(handle, mode);
  }
  fchown(handle: number, uid: number, gid: number): void {
    this.fs.fchown(handle, uid, gid);
  }

  stat(path: string): StatResult {
    return this.adaptStatWithLazySize(this.fs.stat(path));
  }

  lstat(path: string): StatResult {
    return this.adaptStatWithLazySize(this.fs.lstat(path));
  }

  statfs(path: string): StatfsResult {
    this.fs.stat(path);
    const stats = this.fs.statfs();
    return {
      type: SFFS_SUPER_MAGIC,
      bsize: stats.blockSize,
      blocks: stats.totalBlocks,
      bfree: stats.freeBlocks,
      bavail: stats.freeBlocks,
      files: stats.totalInodes,
      ffree: stats.freeInodes,
      fsid: 0,
      namelen: stats.maxName,
      frsize: stats.blockSize,
      flags: 0,
    };
  }

  pathconf(path: string, name: number): PathconfValue {
    const stat = this.stat(path);
    return filesystemPathconf(stat, name, {
      supportsSymlinks: true,
      timestampResolutionNs: 1_000_000,
    });
  }

  mkdir(path: string, mode: number): void {
    this.fs.mkdir(path, mode);
  }

  rmdir(path: string): void {
    this.fs.rmdir(path);
  }

  unlink(path: string): void {
    const removed = this.fs.unlink(path);
    const key = MemoryFileSystem.inodeKey(removed.ino, removed.generation);
    if (
      removed.linkCount > 1 &&
      (this.lazyFiles.has(key) || this.lazyArchiveInodes.has(key))
    ) {
      // A peer may have added hard-link names this instance never observed.
      // Rebuild aliases from SharedFS instead of treating an empty local path
      // set as proof that the inode disappeared.
      this.reconcileLazyIdentityState(this.fs.identityState());
      return;
    }

    const lazy = this.lazyFiles.get(key);
    if (lazy) {
      lazy.paths.delete(path);
      if (removed.linkCount <= 1) {
        this.lazyFiles.delete(key);
      } else if (lazy.path === path) {
        lazy.path = lazy.paths.values().next().value!;
      }
    }

    const group = this.lazyArchiveInodes.get(key);
    if (group) {
      const entry = group.entries.get(path);
      if (removed.linkCount <= 1) {
        for (const candidate of group.entries.values()) {
          if (
            candidate.ino === removed.ino &&
            candidate.generation === removed.generation
          )
            candidate.deleted = true;
        }
        this.lazyArchiveInodes.delete(key);
      } else if (entry) {
        group.entries.delete(path);
      }
    }
  }

  rename(oldPath: string, newPath: string): void {
    const { source, replaced } = this.fs.rename(oldPath, newPath);

    if (
      replaced &&
      replaced.ino === source.ino &&
      replaced.generation === source.generation
    )
      return;

    let reconciledNamespace = false;
    if (replaced) {
      const replacedKey = MemoryFileSystem.inodeKey(
        replaced.ino,
        replaced.generation,
      );
      if (
        replaced.linkCount > 1 &&
        (this.lazyFiles.has(replacedKey) ||
          this.lazyArchiveInodes.has(replacedKey))
      ) {
        // The replaced inode survived through a hard link that may have been
        // created by a peer. One authoritative reconciliation updates both
        // that alias and the source paths changed by rename().
        this.reconcileLazyIdentityState(this.fs.identityState());
        reconciledNamespace = true;
      }

      const replacedLazy = this.lazyFiles.get(replacedKey);
      if (!reconciledNamespace && replacedLazy) {
        replacedLazy.paths.delete(newPath);
        if (replaced.linkCount <= 1) {
          this.lazyFiles.delete(replacedKey);
        } else if (replacedLazy.path === newPath) {
          replacedLazy.path = replacedLazy.paths.values().next().value!;
        }
      }
      const replacedGroup = this.lazyArchiveInodes.get(replacedKey);
      if (!reconciledNamespace && replacedGroup) {
        const entry = replacedGroup.entries.get(newPath);
        if (replaced.linkCount <= 1) {
          if (entry) entry.deleted = true;
          this.lazyArchiveInodes.delete(replacedKey);
        } else if (entry) {
          replacedGroup.entries.delete(newPath);
        }
      }
    }

    if (!reconciledNamespace) {
      this.rewriteLazyNamespacePaths(source, oldPath, newPath);
    }
  }

  link(existingPath: string, newPath: string): void {
    const sourceIdentity = this.fs.link(existingPath, newPath);
    const key = MemoryFileSystem.inodeKey(
      sourceIdentity.ino,
      sourceIdentity.generation,
    );
    const lazy = this.lazyFiles.get(key);
    if (lazy) lazy.paths.add(newPath);

    const group = this.lazyArchiveInodes.get(key);
    if (group) {
      const source = Array.from(group.entries.values()).find(
        (entry) =>
          entry.ino === sourceIdentity.ino &&
          entry.generation === sourceIdentity.generation,
      );
      if (source) group.entries.set(newPath, { ...source });
    }
  }

  symlink(target: string, path: string): void {
    this.fs.symlink(target, path);
  }

  readlink(path: string): string {
    return this.fs.readlink(path);
  }

  chmod(path: string, mode: number): void {
    this.fs.chmod(path, mode);
  }
  chown(path: string, uid: number, gid: number): void {
    this.fs.chown(path, uid, gid);
  }
  lchown(path: string, uid: number, gid: number): void {
    this.fs.lchown(path, uid, gid);
  }

  createFileWithOwner(
    path: string,
    mode: number,
    uid: number,
    gid: number,
    content: Uint8Array,
  ): void {
    const fd = this.open(path, 0o1101, mode); // O_WRONLY | O_CREAT | O_TRUNC
    if (content.length > 0) this.write(fd, content, null, content.length);
    this.close(fd);
    this.chown(path, uid, gid);
    this.chmod(path, mode);
  }

  mkdirWithOwner(path: string, mode: number, uid: number, gid: number): void {
    this.mkdir(path, mode);
    this.chown(path, uid, gid);
    this.chmod(path, mode);
  }

  symlinkWithOwner(
    target: string,
    path: string,
    uid: number,
    gid: number,
  ): void {
    this.symlink(target, path);
    this.lchown(path, uid, gid);
  }

  private copyPathToFreshFileSystem(
    path: string,
    target: MemoryFileSystem,
    lazyFilePaths: Set<string>,
    lazyArchiveStubPaths: Set<string>,
    hardLinks: Map<string, string>,
  ): void {
    const st = this.lstat(path);
    const kind = st.mode & S_IFMT;
    const mode = st.mode & 0o7777;

    if (kind === S_IFDIR) {
      if (path === "/") {
        target.chown(path, st.uid, st.gid);
        target.chmod(path, mode);
      } else {
        target.mkdirWithOwner(path, mode, st.uid, st.gid);
      }

      const dh = this.opendir(path);
      try {
        for (;;) {
          const entry = this.readdir(dh);
          if (!entry) break;
          if (entry.name === "." || entry.name === "..") continue;
          this.copyPathToFreshFileSystem(
            path === "/" ? `/${entry.name}` : `${path}/${entry.name}`,
            target,
            lazyFilePaths,
            lazyArchiveStubPaths,
            hardLinks,
          );
        }
      } finally {
        this.closedir(dh);
      }
      MemoryFileSystem.applyTimes(target, path, st);
      return;
    }

    const identity = st.nlink > 1 ? `${st.dev}:${st.ino}` : null;
    const existingHardLink = identity ? hardLinks.get(identity) : undefined;
    if (existingHardLink) {
      target.link(existingHardLink, path);
      return;
    }

    if (kind === S_IFLNK) {
      target.symlinkWithOwner(this.readlink(path), path, st.uid, st.gid);
      if (identity) hardLinks.set(identity, path);
      return;
    }

    if (kind !== S_IFREG) {
      throw new Error(`Unsupported file type while rebasing VFS: ${path}`);
    }

    const isLazyStub =
      lazyFilePaths.has(path) || lazyArchiveStubPaths.has(path);
    if (isLazyStub) {
      target.createFileWithOwner(path, mode, st.uid, st.gid, new Uint8Array(0));
      MemoryFileSystem.applyTimes(target, path, st);
      if (identity) hardLinks.set(identity, path);
      return;
    }

    this.copyRegularFileToFreshFileSystem(path, target, st, mode);
    if (identity) hardLinks.set(identity, path);
  }

  private copyRegularFileToFreshFileSystem(
    path: string,
    target: MemoryFileSystem,
    st: StatResult,
    mode: number,
  ): void {
    const inFd = this.open(path, O_RDONLY, 0);
    let outFd: number | null = null;
    try {
      outFd = target.open(path, O_WRONLY_CREAT_TRUNC, mode);
      const chunk = new Uint8Array(
        Math.min(COPY_CHUNK_BYTES, Math.max(1, st.size)),
      );
      let remaining = st.size;
      while (remaining > 0) {
        const wanted = Math.min(chunk.byteLength, remaining);
        const nread = this.read(inFd, chunk, null, wanted);
        if (nread <= 0) {
          throw new Error(`Unexpected EOF while rebasing VFS file: ${path}`);
        }
        let written = 0;
        while (written < nread) {
          const nwritten = target.write(
            outFd,
            chunk.subarray(written, nread),
            null,
            nread - written,
          );
          if (nwritten <= 0) {
            throw new Error(`Short write while rebasing VFS file: ${path}`);
          }
          written += nwritten;
        }
        remaining -= nread;
      }
    } finally {
      if (outFd !== null) target.close(outFd);
      this.close(inFd);
    }
    target.chown(path, st.uid, st.gid);
    target.chmod(path, mode);
    MemoryFileSystem.applyTimes(target, path, st);
  }

  private static applyTimes(
    fs: MemoryFileSystem,
    path: string,
    st: StatResult,
  ): void {
    const atimeSec = Math.floor(st.atimeMs / 1000);
    const atimeNsec = Math.floor((st.atimeMs - atimeSec * 1000) * 1_000_000);
    const mtimeSec = Math.floor(st.mtimeMs / 1000);
    const mtimeNsec = Math.floor((st.mtimeMs - mtimeSec * 1000) * 1_000_000);
    fs.utimensat(path, atimeSec, atimeNsec, mtimeSec, mtimeNsec);
  }

  // access: check if path exists by stat'ing it (stat throws on error)
  access(path: string, _mode: number): void {
    this.fs.stat(path);
  }

  utimensat(
    path: string,
    atimeSec: number,
    atimeNsec: number,
    mtimeSec: number,
    mtimeNsec: number,
  ): void {
    this.fs.utimens(path, atimeSec, atimeNsec, mtimeSec, mtimeNsec);
  }

  opendir(path: string): number {
    return this.fs.opendir(path);
  }

  readdir(handle: number): DirEntry | null {
    const entry = this.fs.readdirEntry(handle);
    if (!entry) return null;
    // Determine d_type from mode
    const mode = entry.stat.mode;
    let dtype = 0; // DT_UNKNOWN
    if ((mode & 0xf000) === 0x8000)
      dtype = 8; // DT_REG
    else if ((mode & 0xf000) === 0x4000)
      dtype = 4; // DT_DIR
    else if ((mode & 0xf000) === 0xa000) dtype = 10; // DT_LNK
    return { name: entry.name, type: dtype, ino: entry.stat.ino };
  }

  closedir(handle: number): void {
    this.fs.closedir(handle);
  }
}

// fzstd is a regular sync static import (see top of file). Earlier we
// tried lazy-loading it via top-level `await import("fzstd")`, but a
// top-level await turns this module — and every consumer, including
// the kernel worker entry — into an async module. `BrowserKernel.boot
// Worker()` posts its `init` message immediately after `new Worker(url)`,
// before the worker's async load completes; the message was being
// dropped before the worker's onmessage handler became reachable. A
// static import is bundled by Vite for browser pages and resolved by
// Node for tests + build scripts (host/package.json + apps/browser-demos/
// package.json both declare fzstd, so it's always installed).
function decompressZstd(image: Uint8Array): Uint8Array {
  return zstdDecompress(image);
}
