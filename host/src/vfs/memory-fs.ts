import { decompress as zstdDecompress } from "fzstd";
import type { PathconfValue, StatResult, StatfsResult } from "../types";
import { filesystemPathconf } from "../pathconf";
import { SFFS_SUPER_MAGIC } from "../statfs";
import type { FileSystemBackend, DirEntry } from "./types";
import {
  assertExpectedByteLength,
  assertExpectedSha256,
  assertValidLazyContentSize,
  assertValidLazySha256,
  MAX_LAZY_CONTENT_BYTES,
  readFetchBody,
} from "./lazy-fetch";
import {
  SharedFS,
  type NamespaceEntryIdentity,
  type SharedFsIdentityState,
  type StatResult as SfsStatResult,
} from "./sharedfs-vendor";
import type { ZipEntry } from "./zip";

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

interface PendingLazyFile {
  ino: number;
  generation: number;
  dataSequence: number;
  path: string;
  paths: Set<string>;
  url: string;
  size: number;
}

export type LazyDownloadKind = "file" | "archive";
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
}

/**
 * A group of files whose content comes from a single zip archive.
 * Accessing any member materializes the entire archive in one fetch.
 */
export interface LazyArchiveGroup {
  url: string;
  mountPrefix: string;
  /** Exact ZIP bytes after HTTP Content-Encoding decoding, when integrity-bound. */
  compressedBytes?: number;
  /** SHA-256 of those exact ZIP bytes, written as lowercase hexadecimal. */
  sha256?: string;
  materialized: boolean;
  entries: Map<string, LazyArchiveFileEntry>; // keyed by VFS absolute path
}

export interface LazyArchiveIntegrity {
  compressedBytes: number;
  sha256: string;
}

export interface LazyArchiveLoadRequest {
  url: string;
  mountPrefix: string;
  compressedBytes?: number;
  sha256?: string;
}

/** JSON-serializable form of LazyArchiveGroup for cross-worker transfer. */
export interface SerializedLazyArchiveEntry {
  url: string;
  mountPrefix: string;
  compressedBytes?: number;
  sha256?: string;
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
  }>;
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
const VFS_IMAGE_HEADER_SIZE = 16; // magic(4) + version(4) + flags(4) + sabLen(4)
const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;
const S_IFLNK = 0xa000;
const O_RDONLY = 0x0000;
const O_TRUNC = 0x0200;
const O_WRONLY_CREAT_TRUNC = 0o1101;
const COPY_CHUNK_BYTES = 1024 * 1024;
const MIN_REBASE_INITIAL_BYTES = 16 * 1024 * 1024;
const VFS_IMAGE_MAX_METADATA_BYTES = 64 * 1024;
const VFS_IMAGE_MAX_LAZY_SECTION_BYTES = 16 * 1024 * 1024;
const MAX_LAZY_ENTRIES = 100_000;
const MAX_LAZY_ARCHIVE_GROUPS = 4096;
const MAX_LAZY_PATH_BYTES = 4096;
const MAX_LAZY_URL_BYTES = 64 * 1024;

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

interface ParsedImageSections {
  lazyOffset: number;
  lazyLen: number;
  archiveOffset: number;
  archiveLen: number;
  metadataOffset: number;
  metadataLen: number;
}

function parseImageSections(parsed: ParsedImageHeader): ParsedImageSections {
  const { image, view, flags, sabLen } = parsed;
  const knownFlags =
    VFS_IMAGE_FLAG_HAS_LAZY |
    VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES |
    VFS_IMAGE_FLAG_HAS_METADATA;
  if ((flags & ~knownFlags) !== 0) {
    throw new Error(
      `VFS image has unknown flags: 0x${(flags & ~knownFlags).toString(16)}`,
    );
  }

  const readSection = (
    offset: number,
    label: string,
    maxBytes: number,
  ): { length: number; end: number } => {
    if (offset > image.byteLength - 4) {
      throw new Error(`VFS image truncated (${label} section)`);
    }
    const length = view.getUint32(offset, true);
    if (length > maxBytes) {
      throw new Error(`VFS image ${label} exceeds ${maxBytes} bytes`);
    }
    const payloadOffset = offset + 4;
    if (length > image.byteLength - payloadOffset) {
      throw new Error(`VFS image truncated (${label} payload)`);
    }
    return { length, end: payloadOffset + length };
  };

  const lazyOffset = VFS_IMAGE_HEADER_SIZE + sabLen;
  const lazy = readSection(
    lazyOffset,
    "lazy file metadata",
    VFS_IMAGE_MAX_LAZY_SECTION_BYTES,
  );
  if ((lazy.length > 0) !== Boolean(flags & VFS_IMAGE_FLAG_HAS_LAZY)) {
    throw new Error(
      "VFS image lazy file flag does not match its metadata section",
    );
  }

  const archiveOffset = lazy.end;
  let archiveLen = 0;
  let nextOffset = archiveOffset;
  if (flags & VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES) {
    const archive = readSection(
      archiveOffset,
      "lazy archive metadata",
      VFS_IMAGE_MAX_LAZY_SECTION_BYTES,
    );
    if (archive.length === 0) {
      throw new Error(
        "VFS image lazy archive flag has an empty metadata section",
      );
    }
    archiveLen = archive.length;
    nextOffset = archive.end;
  }

  const metadataOffset = nextOffset;
  let metadataLen = 0;
  let imageEnd = metadataOffset;
  if (flags & VFS_IMAGE_FLAG_HAS_METADATA) {
    const metadata = readSection(
      metadataOffset,
      "metadata",
      VFS_IMAGE_MAX_METADATA_BYTES,
    );
    if (metadata.length === 0) {
      throw new Error("VFS image metadata flag has an empty metadata section");
    }
    metadataLen = metadata.length;
    imageEnd = metadata.end;
  }
  if (imageEnd !== image.byteLength) {
    throw new Error("VFS image has trailing bytes after its declared sections");
  }

  return {
    lazyOffset,
    lazyLen: lazy.length,
    archiveOffset,
    archiveLen,
    metadataOffset,
    metadataLen,
  };
}

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function parseContentLength(headers: Headers | undefined): number | undefined {
  const raw = headers?.get("content-length");
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function validateLazySize(size: unknown, context: string): asserts size is number {
  assertValidLazyContentSize(context, size as number);
}

function validateCanonicalAbsolutePath(
  path: unknown,
  context: string,
  allowRoot = false,
): asserts path is string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    throw new Error(`${context} has an invalid absolute path`);
  }
  if (new TextEncoder().encode(path).byteLength > MAX_LAZY_PATH_BYTES) {
    throw new Error(`${context} path exceeds ${MAX_LAZY_PATH_BYTES} bytes`);
  }
  if (!path.startsWith("/") || (!allowRoot && path === "/")) {
    throw new Error(`${context} has an invalid absolute path`);
  }
  if (path !== "/") {
    const segments = path.slice(1).split("/");
    if (
      path.endsWith("/") ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error(`${context} path must be canonical`);
    }
  }
}

function validateLazyUrl(url: unknown, context: string): asserts url is string {
  if (typeof url !== "string" || url.length === 0 || url.includes("\0")) {
    throw new Error(`${context} has an invalid URL`);
  }
  if (new TextEncoder().encode(url).byteLength > MAX_LAZY_URL_BYTES) {
    throw new Error(`${context} URL exceeds ${MAX_LAZY_URL_BYTES} bytes`);
  }
}

function validateLazyMountPrefix(
  path: unknown,
  context: string,
): asserts path is string {
  if (typeof path !== "string") {
    throw new Error(`${context} has an invalid absolute path`);
  }
  const canonical = path !== "/" && path.endsWith("/")
    ? path.slice(0, -1)
    : path;
  validateCanonicalAbsolutePath(canonical, context, true);
}

function validateLazyArchiveIntegrity(
  compressedBytes: unknown,
  sha256: unknown,
  context: string,
): void {
  if ((compressedBytes === undefined) !== (sha256 === undefined)) {
    throw new Error(
      `${context} must declare compressedBytes and sha256 together`,
    );
  }
  if (compressedBytes === undefined) return;
  validateLazySize(compressedBytes, `${context} compressed bytes`);
  if (typeof sha256 !== "string") {
    throw new Error(`${context} has an invalid SHA-256`);
  }
  assertValidLazySha256(context, sha256);
}

function validateLazyEntryShape(
  entry: unknown,
  context: string,
): asserts entry is LazyFileEntry {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`${context} must be an object`);
  }
  const candidate = entry as Partial<LazyFileEntry>;
  if (!Number.isSafeInteger(candidate.ino) || (candidate.ino ?? 0) <= 0) {
    throw new Error(`${context} has an invalid inode`);
  }
  if (
    candidate.generation !== undefined &&
    (!Number.isSafeInteger(candidate.generation) || candidate.generation < 0)
  ) {
    throw new Error(`${context} has an invalid inode generation`);
  }
  if (
    candidate.dataSequence !== undefined &&
    (!Number.isSafeInteger(candidate.dataSequence) || candidate.dataSequence < 0)
  ) {
    throw new Error(`${context} has an invalid data sequence`);
  }
  validateCanonicalAbsolutePath(candidate.path, context);
  if (candidate.paths !== undefined) {
    if (!Array.isArray(candidate.paths) || candidate.paths.length === 0) {
      throw new Error(`${context} has invalid inode paths`);
    }
    for (const path of candidate.paths) {
      validateCanonicalAbsolutePath(path, context);
    }
  }
  validateLazyUrl(candidate.url, context);
  validateLazySize(candidate.size, context);
}

export class MemoryFileSystem implements FileSystemBackend {
  private fs: SharedFS;
  private imageMetadata: VfsImageMetadata | null;
  /** Lazy files keyed by inode slot + generation (raw inode numbers are reused). */
  private lazyFiles = new Map<string, PendingLazyFile>();
  /** Lazy archive groups (bundle of files backed by one zip URL). */
  private lazyArchiveGroups: LazyArchiveGroup[] = [];
  /** Fast lookup keyed by inode slot + generation. */
  private lazyArchiveInodes = new Map<string, LazyArchiveGroup>();
  private lazyFileMaterializations = new Map<string, Promise<boolean>>();
  private lazyArchiveMaterializations = new Map<LazyArchiveGroup, Promise<void>>();
  private lazyDownloadListeners = new Set<LazyDownloadListener>();

  private constructor(fs: SharedFS, metadata: VfsImageMetadata | null = null) {
    this.fs = fs;
    this.imageMetadata = metadata;
  }

  private static inodeKey(ino: number, generation: number): string {
    return `${ino}:${generation}`;
  }

  private lazyEntryCount(): number {
    return this.lazyArchiveGroups.reduce(
      (total, group) => total + group.entries.size,
      this.lazyFiles.size,
    );
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
      group.materialized = reconciled.size === 0;
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
    /** Expected decoded Fetch body size. */
    expectedBytes?: number;
    /** Expected decoded Fetch body SHA-256. */
    expectedSha256?: string;
  }): Promise<Uint8Array> {
    let loadedBytes = 0;
    let totalBytes = details.expectedBytes;
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
      const resp = await fetch(details.url);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }

      totalBytes = details.expectedBytes ?? parseContentLength(resp.headers);
      const data = await readFetchBody(resp, {
        label: details.path ?? details.mountPrefix ?? details.url,
        expectedBytes: details.expectedBytes,
        expectedSha256: details.expectedSha256,
        onProgress: (nextLoadedBytes) => {
          loadedBytes = nextLoadedBytes;
          this.emitLazyDownload({
            ...base,
            status: "progress",
            loadedBytes,
            totalBytes,
          });
        },
      });
      if (loadedBytes === 0 && data.byteLength === 0) {
        this.emitLazyDownload({
          ...base,
          status: "progress",
          loadedBytes: 0,
          totalBytes: totalBytes ?? 0,
        });
      }
      loadedBytes = data.byteLength;
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
    validateCanonicalAbsolutePath(path, "lazy file");
    validateLazyUrl(url, `lazy file ${path}`);
    validateLazySize(size, `lazy file ${path}`);
    if (this.lazyEntryCount() >= MAX_LAZY_ENTRIES) {
      throw new Error(`lazy entry count exceeds ${MAX_LAZY_ENTRIES}`);
    }
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
    if (!Array.isArray(entries)) {
      throw new Error("lazy file metadata must be an array");
    }
    if (entries.length > MAX_LAZY_ENTRIES - this.lazyEntryCount()) {
      throw new Error(`lazy entry count exceeds ${MAX_LAZY_ENTRIES}`);
    }

    const seenPaths = new Set<string>();
    const seenIdentities = new Set<string>();
    for (const existing of this.lazyFiles.values()) {
      for (const path of existing.paths) seenPaths.add(path);
      seenIdentities.add(
        MemoryFileSystem.inodeKey(existing.ino, existing.generation),
      );
    }
    for (const group of this.lazyArchiveGroups) {
      for (const [path, entry] of group.entries) {
        if (entry.deleted) continue;
        seenPaths.add(path);
        if (entry.generation !== undefined) {
          seenIdentities.add(
            MemoryFileSystem.inodeKey(entry.ino, entry.generation),
          );
        }
      }
    }

    const pending: Array<{
      identity: SfsStatResult;
      primaryPath: string;
      paths: Set<string>;
      url: string;
      size: number;
    }> = [];
    for (const [index, e] of entries.entries()) {
      const context = `lazy file entry ${index}`;
      validateLazyEntryShape(e, context);
      const isLegacy =
        e.generation === undefined || e.dataSequence === undefined;
      if (isLegacy && !trustedLegacySnapshot) {
        throw new Error(
          "Live lazy-file metadata requires inode generation and data sequence",
        );
      }
      const validPaths = new Set<string>();
      let identity: SfsStatResult | null = null;
      const declaredPaths = new Set([e.path, ...(e.paths ?? [])]);
      for (const path of declaredPaths) {
        if (seenPaths.has(path)) {
          throw new Error(`${context} duplicates path ${path}`);
        }
        let st: SfsStatResult;
        try {
          st = this.fs.stat(path);
        } catch {
          if (trustedLegacySnapshot) {
            throw new Error(`${context} path does not exist: ${path}`);
          }
          // Cross-worker metadata can race a guest unlink. A missing live
          // identity is stale rather than malformed, so do not resurrect it.
          continue;
        }
        if (st.ino !== e.ino) {
          if (trustedLegacySnapshot) {
            throw new Error(`${context} inode mismatch for ${path}`);
          }
          continue;
        }
        if (e.generation !== undefined && st.generation !== e.generation) {
          if (trustedLegacySnapshot) {
            throw new Error(`${context} generation mismatch for ${path}`);
          }
          continue;
        }
        if (e.dataSequence === undefined) {
          if (!MemoryFileSystem.canAdoptLegacyLazyStub(st)) {
            if (trustedLegacySnapshot) {
              throw new Error(`${context} is not a legacy empty stub: ${path}`);
            }
            continue;
          }
        } else if (st.dataSequence !== e.dataSequence) {
          if (trustedLegacySnapshot) {
            throw new Error(`${context} data sequence mismatch for ${path}`);
          }
          continue;
        }
        if ((st.mode & S_IFMT) !== S_IFREG || st.size !== 0) {
          if (trustedLegacySnapshot) {
            throw new Error(
              `${context} is not an empty regular-file stub: ${path}`,
            );
          }
          continue;
        }
        if (
          identity &&
          (identity.ino !== st.ino || identity.generation !== st.generation)
        ) {
          throw new Error(`${context} aliases do not name one inode`);
        }
        identity ??= st;
        validPaths.add(path);
      }
      if (!identity || validPaths.size === 0) {
        if (trustedLegacySnapshot) {
          throw new Error(`${context} does not name a live lazy stub`);
        }
        continue;
      }
      const identityKey = MemoryFileSystem.inodeKey(
        identity.ino,
        identity.generation,
      );
      if (seenIdentities.has(identityKey)) {
        throw new Error(`${context} duplicates inode identity ${identityKey}`);
      }
      seenIdentities.add(identityKey);
      for (const path of validPaths) seenPaths.add(path);
      const primaryPath = validPaths.has(e.path)
        ? e.path
        : validPaths.values().next().value!;
      pending.push({
        identity,
        primaryPath,
        paths: validPaths,
        url: e.url,
        size: e.size,
      });
    }

    for (const entry of pending) {
      this.lazyFiles.set(
        MemoryFileSystem.inodeKey(
          entry.identity.ino,
          entry.identity.generation,
        ),
        {
          ino: entry.identity.ino,
          generation: entry.identity.generation,
          dataSequence: entry.identity.dataSequence,
          path: entry.primaryPath,
          paths: entry.paths,
          url: entry.url,
          size: entry.size,
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
   * Rewrite the URL of every registered lazy file. Useful when a VFS image
   * was built with placeholder URLs and the browser runtime needs to replace
   * them with bundler-produced asset URLs.
   */
  rewriteLazyFileUrls(transform: (url: string, path: string) => string): void {
    for (const entry of this.lazyFiles.values()) {
      const url = transform(entry.url, entry.path);
      validateLazyUrl(url, `lazy file ${entry.path}`);
      entry.url = url;
    }
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
    validateLazyUrl(url, "lazy archive");
    validateLazyMountPrefix(mountPrefix, "lazy archive mount prefix");
    if (!Array.isArray(zipEntries)) {
      throw new Error("lazy archive entries must be an array");
    }
    if (this.lazyArchiveGroups.length >= MAX_LAZY_ARCHIVE_GROUPS) {
      throw new Error(
        `lazy archive group count exceeds ${MAX_LAZY_ARCHIVE_GROUPS}`,
      );
    }
    validateLazyArchiveIntegrity(
      integrity?.compressedBytes,
      integrity?.sha256,
      "lazy archive",
    );

    const existingEntryCount = this.lazyEntryCount();
    const fileEntryCount = zipEntries.filter((entry) => !entry.isDirectory).length;
    if (fileEntryCount > MAX_LAZY_ENTRIES - existingEntryCount) {
      throw new Error(`lazy entry count exceeds ${MAX_LAZY_ENTRIES}`);
    }

    const group: LazyArchiveGroup = {
      url,
      mountPrefix,
      compressedBytes: integrity?.compressedBytes,
      sha256: integrity?.sha256,
      materialized: false,
      entries: new Map(),
    };

    const normalized = mountPrefix.replace(/\/+$/, "");
    const pendingEntries: Array<{ zipEntry: ZipEntry; vfsPath: string }> = [];
    const seenPaths = new Set<string>();
    let expandedBytes = 0;
    for (const ze of zipEntries) {
      if (ze.isDirectory) continue;

      const vfsPath = normalized + "/" + ze.fileName;
      validateCanonicalAbsolutePath(vfsPath, "lazy archive entry");
      validateLazySize(ze.compressedSize, `lazy archive member ${ze.fileName}`);
      validateLazySize(ze.uncompressedSize, `lazy archive entry ${vfsPath}`);
      expandedBytes += ze.uncompressedSize;
      if (
        !Number.isSafeInteger(expandedBytes) ||
        expandedBytes > MAX_LAZY_CONTENT_BYTES
      ) {
        throw new Error(
          `lazy archive expanded content exceeds ${MAX_LAZY_CONTENT_BYTES} bytes`,
        );
      }
      if (seenPaths.has(vfsPath)) {
        throw new Error(`lazy archive duplicates path: ${vfsPath}`);
      }
      seenPaths.add(vfsPath);
      if (ze.isSymlink) {
        const target = symlinkTargets?.get(ze.fileName);
        if (typeof target !== "string" || target.length === 0 || target.includes("\0")) {
          throw new Error(
            `Lazy archive symlink target was not provided: ${ze.fileName}`,
          );
        }
      }
      pendingEntries.push({ zipEntry: ze, vfsPath });
    }

    try {
      for (const { zipEntry: ze, vfsPath } of pendingEntries) {
        const parts = vfsPath.split("/").filter(Boolean);
        let current = "";
        for (let i = 0; i < parts.length - 1; i++) {
          current += "/" + parts[i];
          try {
            this.fs.mkdir(current, 0o755);
          } catch {
            const parent = this.fs.lstat(current);
            if ((parent.mode & S_IFMT) !== S_IFDIR) {
              throw new Error(
                `lazy archive parent is not a directory: ${current}`,
              );
            }
          }
        }

        if (ze.isSymlink) {
          const target = symlinkTargets!.get(ze.fileName)!;
          this.fs.symlink(target, vfsPath);
          const st = this.fs.lstat(vfsPath);
          group.entries.set(vfsPath, {
            ino: st.ino,
            generation: st.generation,
            dataSequence: st.dataSequence,
            size: ze.uncompressedSize,
            isSymlink: true,
            deleted: false,
            materialized: true,
            archivePath: ze.fileName,
          });
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
          };
          group.entries.set(vfsPath, entry);
          this.lazyArchiveInodes.set(
            MemoryFileSystem.inodeKey(st.ino, st.generation),
            group,
          );
        }
      }
    } catch (error) {
      for (const entry of group.entries.values()) {
        if (entry.generation !== undefined) {
          this.lazyArchiveInodes.delete(
            MemoryFileSystem.inodeKey(entry.ino, entry.generation),
          );
        }
      }
      throw error;
    }

    group.materialized = Array.from(group.entries.values()).every(
      (entry) => entry.deleted || entry.materialized,
    );
    this.lazyArchiveGroups.push(group);
    return group;
  }

  /** Import lazy archive groups from another instance. Assumes stubs already exist. */
  importLazyArchiveEntries(serialized: SerializedLazyArchiveEntry[]): void {
    this.importLazyArchiveEntriesInternal(serialized, false);
  }

  private importLazyArchiveEntriesInternal(
    serialized: SerializedLazyArchiveEntry[],
    trustedLegacySnapshot: boolean,
  ): void {
    if (!Array.isArray(serialized)) {
      throw new Error("lazy archive groups must be an array");
    }
    if (
      serialized.length >
      MAX_LAZY_ARCHIVE_GROUPS - this.lazyArchiveGroups.length
    ) {
      throw new Error(
        `lazy archive group count exceeds ${MAX_LAZY_ARCHIVE_GROUPS}`,
      );
    }

    const seenPaths = new Set<string>();
    const seenIdentities = new Set<string>();
    for (const existing of this.lazyFiles.values()) {
      for (const path of existing.paths) seenPaths.add(path);
      seenIdentities.add(
        MemoryFileSystem.inodeKey(existing.ino, existing.generation),
      );
    }
    for (const existing of this.lazyArchiveGroups) {
      for (const [path, entry] of existing.entries) {
        if (entry.deleted) continue;
        seenPaths.add(path);
        if (entry.generation !== undefined) {
          seenIdentities.add(
            MemoryFileSystem.inodeKey(entry.ino, entry.generation),
          );
        }
      }
    }

    let totalEntries = this.lazyEntryCount();
    const pendingGroups: LazyArchiveGroup[] = [];
    for (const [groupIndex, value] of serialized.entries()) {
      const context = `lazy archive group ${groupIndex}`;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${context} must be an object`);
      }
      const s = value as SerializedLazyArchiveEntry;
      validateLazyUrl(s.url, context);
      validateLazyMountPrefix(s.mountPrefix, `${context} mount prefix`);
      validateLazyArchiveIntegrity(s.compressedBytes, s.sha256, context);
      if (typeof s.materialized !== "boolean") {
        throw new Error(`${context} has invalid materialized state`);
      }
      if (!Array.isArray(s.entries)) {
        throw new Error(`${context} entries must be an array`);
      }
      totalEntries += s.entries.length;
      if (totalEntries > MAX_LAZY_ENTRIES) {
        throw new Error(`lazy entry count exceeds ${MAX_LAZY_ENTRIES}`);
      }

      const entries = new Map<string, LazyArchiveFileEntry>();
      const normalizedPrefix = s.mountPrefix.replace(/\/+$/, "");
      const groupIdentities = new Map<string, {
        archivePath: string;
        size: number;
        isSymlink: boolean;
      }>();
      let expandedBytes = 0;
      for (const [entryIndex, rawEntry] of s.entries.entries()) {
        const entryContext = `${context} entry ${entryIndex}`;
        if (
          typeof rawEntry !== "object" ||
          rawEntry === null ||
          Array.isArray(rawEntry)
        ) {
          throw new Error(`${entryContext} must be an object`);
        }
        const e = rawEntry as SerializedLazyArchiveEntry["entries"][number];
        validateCanonicalAbsolutePath(e.vfsPath, entryContext);
        if (
          normalizedPrefix !== "" &&
          !e.vfsPath.startsWith(`${normalizedPrefix}/`)
        ) {
          throw new Error(
            `${entryContext} is outside mount prefix ${s.mountPrefix}`,
          );
        }
        if (
          typeof e.isSymlink !== "boolean" ||
          typeof e.deleted !== "boolean" ||
          (e.materialized !== undefined && typeof e.materialized !== "boolean")
        ) {
          throw new Error(`${entryContext} has invalid state flags`);
        }
        validateLazySize(e.size, entryContext);
        expandedBytes += e.size;
        if (
          !Number.isSafeInteger(expandedBytes) ||
          expandedBytes > MAX_LAZY_CONTENT_BYTES
        ) {
          throw new Error(
            `${context} expanded content exceeds ${MAX_LAZY_CONTENT_BYTES} bytes`,
          );
        }
        if (!Number.isSafeInteger(e.ino) || e.ino < (e.deleted ? 0 : 1)) {
          throw new Error(`${entryContext} has an invalid inode`);
        }
        if (
          e.generation !== undefined &&
          (!Number.isSafeInteger(e.generation) || e.generation < 0)
        ) {
          throw new Error(`${entryContext} has an invalid inode generation`);
        }
        if (
          e.dataSequence !== undefined &&
          (!Number.isSafeInteger(e.dataSequence) || e.dataSequence < 0)
        ) {
          throw new Error(`${entryContext} has an invalid data sequence`);
        }
        if (seenPaths.has(e.vfsPath) || entries.has(e.vfsPath)) {
          throw new Error(`${entryContext} duplicates path ${e.vfsPath}`);
        }

        const archivePath =
          e.archivePath ?? e.vfsPath.slice(normalizedPrefix.length + 1);
        if (
          typeof archivePath !== "string" ||
          archivePath.length === 0 ||
          archivePath.startsWith("/")
        ) {
          throw new Error(`${entryContext} has an invalid archive path`);
        }
        validateCanonicalAbsolutePath(
          `/${archivePath}`,
          `${entryContext} archive path`,
        );

        let st: SfsStatResult | null = null;
        const materialized =
          s.materialized || e.materialized === true || e.isSymlink;
        if (e.deleted) {
          try {
            this.fs.lstat(e.vfsPath);
            throw new Error(
              `${entryContext} is marked deleted but its path still exists`,
            );
          } catch (error) {
            if (
              error instanceof Error &&
              error.message ===
                `${entryContext} is marked deleted but its path still exists`
            ) {
              throw error;
            }
          }
        } else {
          const isLegacy =
            e.generation === undefined || e.dataSequence === undefined;
          if (isLegacy && !trustedLegacySnapshot && !materialized) {
            throw new Error(
              "Live lazy-archive metadata requires inode generation and data sequence",
            );
          }
          try {
            st = this.fs.lstat(e.vfsPath);
          } catch {
            if (trustedLegacySnapshot) {
              throw new Error(
                `${entryContext} path does not exist: ${e.vfsPath}`,
              );
            }
            // Live metadata may race an unlink. Ignore that stale member while
            // retaining any still-current members of the archive closure.
            continue;
          }
          if (st.ino !== e.ino) {
            if (trustedLegacySnapshot) {
              throw new Error(
                `${entryContext} inode mismatch for ${e.vfsPath}`,
              );
            }
            continue;
          }
          if (e.generation !== undefined && st.generation !== e.generation) {
            if (trustedLegacySnapshot) {
              throw new Error(
                `${entryContext} generation mismatch for ${e.vfsPath}`,
              );
            }
            continue;
          }
          if (!materialized) {
            if (e.dataSequence === undefined) {
              if (!MemoryFileSystem.canAdoptLegacyLazyStub(st)) {
                throw new Error(
                  `${entryContext} is not a legacy empty stub: ${e.vfsPath}`,
                );
              }
            } else if (st.dataSequence !== e.dataSequence) {
              if (trustedLegacySnapshot) {
                throw new Error(
                  `${entryContext} data sequence mismatch for ${e.vfsPath}`,
                );
              }
              continue;
            }
            if ((st.mode & S_IFMT) !== S_IFREG || st.size !== 0) {
              if (trustedLegacySnapshot) {
                throw new Error(
                  `${entryContext} is not an empty regular-file stub: ${e.vfsPath}`,
                );
              }
              continue;
            }
          } else {
            const expectedKind = e.isSymlink ? S_IFLNK : S_IFREG;
            if ((st.mode & S_IFMT) !== expectedKind) {
              throw new Error(
                `${entryContext} has the wrong file type: ${e.vfsPath}`,
              );
            }
          }
        }

        if (st && e.generation !== undefined) {
          const identityKey = MemoryFileSystem.inodeKey(
            st.ino,
            st.generation,
          );
          const prior = groupIdentities.get(identityKey);
          if (seenIdentities.has(identityKey)) {
            throw new Error(`${entryContext} duplicates inode ${identityKey}`);
          }
          if (
            prior &&
            (prior.archivePath !== archivePath ||
              prior.size !== e.size ||
              prior.isSymlink !== e.isSymlink)
          ) {
            throw new Error(
              `${entryContext} gives one inode conflicting archive metadata`,
            );
          }
          groupIdentities.set(identityKey, {
            archivePath,
            size: e.size,
            isSymlink: e.isSymlink,
          });
        }
        seenPaths.add(e.vfsPath);
        entries.set(e.vfsPath, {
          ino: e.ino,
          generation: st?.generation ?? e.generation,
          dataSequence: st?.dataSequence ?? e.dataSequence,
          size: e.size,
          isSymlink: e.isSymlink,
          deleted: e.deleted,
          materialized,
          archivePath,
        });
      }
      for (const identityKey of groupIdentities.keys()) {
        seenIdentities.add(identityKey);
      }
      const group: LazyArchiveGroup = {
        url: s.url,
        mountPrefix: s.mountPrefix,
        compressedBytes: s.compressedBytes,
        sha256: s.sha256,
        materialized:
          s.materialized ||
          Array.from(entries.values()).every(
            (entry) => entry.deleted || entry.materialized,
          ),
        entries,
      };
      pendingGroups.push(group);
    }

    for (const group of pendingGroups) {
      this.lazyArchiveGroups.push(group);
      if (!group.materialized) {
        for (const [, entry] of group.entries) {
          if (
            !entry.deleted &&
            !entry.materialized &&
            entry.generation !== undefined
          ) {
            this.lazyArchiveInodes.set(
              MemoryFileSystem.inodeKey(entry.ino, entry.generation),
              group,
            );
          }
        }
      }
    }
  }

  /**
   * Rewrite the URL of every registered lazy archive group. Useful when the
   * VFS image was built with relative URLs (e.g. "vim.zip") and the runtime
   * needs to resolve them against a deployment base URL.
   */
  rewriteLazyArchiveUrls(transform: (url: string) => string): void {
    for (const group of this.lazyArchiveGroups) {
      const url = transform(group.url);
      validateLazyUrl(url, `lazy archive ${group.mountPrefix}`);
      group.url = url;
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
      })).filter((entry) => !entry.deleted && !entry.materialized);
      if (entries.length === 0) continue;
      serialized.push({
        url: group.url,
        mountPrefix: group.mountPrefix,
        compressedBytes: group.compressedBytes,
        sha256: group.sha256,
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

  /** Replace one lazy-file stub only after its declared bytes are verified. */
  materializeLazyFile(path: string, data: Uint8Array): boolean {
    let st: SfsStatResult;
    try {
      st = this.fs.stat(path);
    } catch {
      return false;
    }
    const key = MemoryFileSystem.inodeKey(st.ino, st.generation);
    const entry = this.lazyFiles.get(key);
    if (!entry || entry.dataSequence !== st.dataSequence) return false;
    return this.materializeLazyFileEntry(path, key, entry, data);
  }

  private materializeLazyFileEntry(
    path: string,
    key: string,
    entry: PendingLazyFile,
    data: Uint8Array,
  ): boolean {
    assertExpectedByteLength(entry.path, entry.size, data.byteLength);

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
      this.reconcileLazyIdentityState(this.fs.identityState());
    }
    throw new Error(`Lazy file kept changing names while materializing: ${path}`);
  }

  /** Deduplicate concurrent fetch/materialize operations for one lazy inode. */
  async materializeLazyFileFrom(
    path: string,
    load: (entry: LazyFileEntry) => Promise<Uint8Array>,
  ): Promise<boolean> {
    let st: SfsStatResult;
    try {
      st = this.fs.stat(path);
    } catch {
      return false;
    }
    const key = MemoryFileSystem.inodeKey(st.ino, st.generation);
    const entry = this.lazyFiles.get(key);
    if (!entry || entry.dataSequence !== st.dataSequence) return false;

    let pending = this.lazyFileMaterializations.get(key);
    if (!pending) {
      const lazyEntry: LazyFileEntry = {
        ino: entry.ino,
        generation: entry.generation,
        dataSequence: entry.dataSequence,
        path: entry.path,
        paths: Array.from(entry.paths),
        url: entry.url,
        size: entry.size,
      };
      pending = (async () => {
        const data = await load(lazyEntry);
        return this.materializeLazyFileEntry(path, key, entry, data);
      })();
      this.lazyFileMaterializations.set(key, pending);
    }

    try {
      return await pending;
    } finally {
      if (this.lazyFileMaterializations.get(key) === pending) {
        this.lazyFileMaterializations.delete(key);
      }
    }
  }

  /** Materialize the lazy ZIP group containing `path` with a host loader. */
  async materializeLazyArchiveFrom(
    path: string,
    load: (request: LazyArchiveLoadRequest) => Promise<Uint8Array>,
  ): Promise<boolean> {
    let st: SfsStatResult;
    try {
      st = this.fs.stat(path);
    } catch {
      return false;
    }
    const key = MemoryFileSystem.inodeKey(st.ino, st.generation);
    const group = this.lazyArchiveInodes.get(key);
    if (!group) return false;
    await this.ensureArchiveMaterialized(
      group,
      { path, ino: st.ino, generation: st.generation },
      load,
    );
    return !this.lazyArchiveInodes.has(key);
  }

  /**
   * Async-materialize a lazy file or archive-backed file if the given path
   * resolves to one. Call this before any synchronous read (e.g. in
   * handleExec) to avoid sync XHR which deadlocks with COOP/COEP.
   * Returns true if something was materialized, false if already concrete.
   */
  async ensureMaterialized(path: string): Promise<boolean> {
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
      return this.materializeLazyFileFrom(path, (current) =>
        this.fetchLazyBytes({
          id: `file:${current.ino}`,
          kind: "file",
          url: current.url,
          path: current.path,
          expectedBytes: current.size,
        })
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

  /**
   * Materialize a full lazy archive group: fetch the zip once, parse its
   * central directory, and write every non-deleted entry into its stub.
   * Subsequent calls are no-ops.
   */
  async ensureArchiveMaterialized(
    group: LazyArchiveGroup,
    requested?: { path: string; ino: number; generation: number },
    load?: (request: LazyArchiveLoadRequest) => Promise<Uint8Array>,
  ): Promise<void> {
    if (group.materialized) return;

    let pending = this.lazyArchiveMaterializations.get(group);
    if (!pending) {
      pending = this.materializeLazyArchive(group, requested, load);
      this.lazyArchiveMaterializations.set(group, pending);
    }
    try {
      await pending;
    } finally {
      if (this.lazyArchiveMaterializations.get(group) === pending) {
        this.lazyArchiveMaterializations.delete(group);
      }
    }
  }

  private async materializeLazyArchive(
    group: LazyArchiveGroup,
    requested?: { path: string; ino: number; generation: number },
    load?: (request: LazyArchiveLoadRequest) => Promise<Uint8Array>,
  ): Promise<void> {
    if (group.materialized) return;

    const request: LazyArchiveLoadRequest = {
      url: group.url,
      mountPrefix: group.mountPrefix,
      compressedBytes: group.compressedBytes,
      sha256: group.sha256,
    };
    const zipData = load
      ? await load(request)
      : await this.fetchLazyBytes({
          id: `archive:${group.mountPrefix}:${group.url}`,
          kind: "archive",
          url: group.url,
          mountPrefix: group.mountPrefix,
          expectedBytes: group.compressedBytes,
          expectedSha256: group.sha256,
        });
    if (load) {
      if (group.compressedBytes !== undefined) {
        assertExpectedByteLength(
          group.mountPrefix,
          group.compressedBytes,
          zipData.byteLength,
        );
      }
      if (group.sha256 !== undefined) {
        await assertExpectedSha256(group.mountPrefix, group.sha256, zipData);
      }
      if (zipData.byteLength > MAX_LAZY_CONTENT_BYTES) {
        throw new Error(
          `lazy content for ${group.mountPrefix} exceeds the ` +
          `${MAX_LAZY_CONTENT_BYTES}-byte limit`,
        );
      }
    }

    const { parseZipCentralDirectory, extractZipEntry } = await import("./zip");
    const zipEntries = parseZipCentralDirectory(zipData);
    const zipLookup = new Map<string, ZipEntry>();
    for (const ze of zipEntries) {
      if (zipLookup.has(ze.fileName)) {
        throw new Error(`lazy archive duplicates member: ${ze.fileName}`);
      }
      zipLookup.set(ze.fileName, ze);
    }

    const normalizedPrefix = group.mountPrefix.replace(/\/+$/, "");
    const extracted = new Map<string, Uint8Array>();
    for (const [vfsPath, archiveEntry] of group.entries) {
      if (archiveEntry.deleted || archiveEntry.materialized) continue;
      const zipFileName =
        archiveEntry.archivePath ??
        vfsPath.slice(normalizedPrefix.length + 1);
      const ze = zipLookup.get(zipFileName);
      if (!ze) {
        throw new Error(`lazy archive member is missing: ${zipFileName}`);
      }
      if (ze.isSymlink !== archiveEntry.isSymlink) {
        throw new Error(`lazy archive member type changed: ${zipFileName}`);
      }
      assertExpectedByteLength(
        vfsPath,
        archiveEntry.size,
        ze.uncompressedSize,
      );
      if (archiveEntry.isSymlink) continue;
      const content = extractZipEntry(zipData, ze);
      assertExpectedByteLength(vfsPath, archiveEntry.size, content.byteLength);
      extracted.set(zipFileName, content);
    }

    const requestedKey = requested
      ? MemoryFileSystem.inodeKey(requested.ino, requested.generation)
      : null;
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const [vfsPath, archiveEntry] of group.entries) {
        if (archiveEntry.deleted || archiveEntry.materialized) continue;
        if (archiveEntry.isSymlink) {
          archiveEntry.materialized = true;
          continue;
        }
        const zipFileName =
          archiveEntry.archivePath ??
          vfsPath.slice(normalizedPrefix.length + 1);
        const content = extracted.get(zipFileName);
        if (!content) {
          throw new Error(`lazy archive member was not extracted: ${zipFileName}`);
        }
        if (archiveEntry.generation === undefined) continue;
        const key = MemoryFileSystem.inodeKey(
          archiveEntry.ino,
          archiveEntry.generation,
        );
        if (this.lazyArchiveInodes.get(key) !== group) continue;
        const candidates = new Set([vfsPath]);
        if (
          requested &&
          requested.ino === archiveEntry.ino &&
          requested.generation === archiveEntry.generation
        )
          candidates.add(requested.path);
        let materialized = false;
        for (const candidate of candidates) {
          materialized = this.fs.replaceIfIdentity(
            candidate,
            archiveEntry.ino,
            archiveEntry.generation,
            archiveEntry.dataSequence ?? 0,
            content,
          );
          if (materialized) break;
        }
        if (!materialized) continue;
        this.lazyArchiveInodes.delete(key);
        for (const alias of group.entries.values()) {
          if (
            alias.ino === archiveEntry.ino &&
            alias.generation === archiveEntry.generation
          )
            alias.materialized = true;
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
      if (this.lazyFiles.size === 0 && this.lazyArchiveInodes.size === 0)
        return;

      const filePaths = Array.from(
        this.lazyFiles.values(),
        (entry) => entry.path,
      );
      for (const path of filePaths) await this.ensureMaterialized(path);

      const archiveGroups = new Set(this.lazyArchiveInodes.values());
      for (const group of archiveGroups) {
        await this.ensureArchiveMaterialized(group);
      }
    }

    this.reconcileLazyIdentityState(this.fs.identityState());
    if (this.lazyFiles.size !== 0 || this.lazyArchiveInodes.size !== 0) {
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
    if (lazyJson.byteLength > VFS_IMAGE_MAX_LAZY_SECTION_BYTES) {
      throw new Error(
        `VFS image lazy file metadata exceeds ${VFS_IMAGE_MAX_LAZY_SECTION_BYTES} bytes`,
      );
    }

    const archiveEntries = this.serializeLazyArchiveEntries();
    const hasArchives = archiveEntries.length > 0;
    const archiveJson = hasArchives
      ? new TextEncoder().encode(JSON.stringify(archiveEntries))
      : new Uint8Array(0);
    if (archiveJson.byteLength > VFS_IMAGE_MAX_LAZY_SECTION_BYTES) {
      throw new Error(
        `VFS image lazy archive metadata exceeds ${VFS_IMAGE_MAX_LAZY_SECTION_BYTES} bytes`,
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
    const sections = parseImageSections(parsed);
    if (!(parsed.flags & VFS_IMAGE_FLAG_HAS_METADATA)) return null;
    return decodeMetadata(
      parsed.image.subarray(
        sections.metadataOffset + 4,
        sections.metadataOffset + 4 + sections.metadataLen,
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
    parseImageSections(parsed);
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
    const flags = parsed.flags;
    const sabLen = parsed.sabLen;
    const sections = parseImageSections(parsed);

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
      metadata = decodeMetadata(
        image.subarray(
          sections.metadataOffset + 4,
          sections.metadataOffset + 4 + sections.metadataLen,
        ),
      );
    }

    const mfs = new MemoryFileSystem(
      SharedFS.mount(sab, { restoreImage: true }),
      metadata,
    );

    // Restore lazy entries
    if (flags & VFS_IMAGE_FLAG_HAS_LAZY) {
      const lazyBytes = image.subarray(
        sections.lazyOffset + 4,
        sections.lazyOffset + 4 + sections.lazyLen,
      );
      let entries: unknown;
      try {
        entries = JSON.parse(new TextDecoder().decode(lazyBytes));
      } catch (error) {
        throw new Error(
          `Invalid VFS lazy file metadata JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      mfs.importLazyEntriesInternal(entries as LazyFileEntry[], true);
    }

    // Restore lazy archive groups
    if (flags & VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES) {
      const archiveBytes = image.subarray(
        sections.archiveOffset + 4,
        sections.archiveOffset + 4 + sections.archiveLen,
      );
      let entries: unknown;
      try {
        entries = JSON.parse(new TextDecoder().decode(archiveBytes));
      } catch (error) {
        throw new Error(
          `Invalid VFS lazy archive metadata JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      mfs.importLazyArchiveEntriesInternal(
        entries as SerializedLazyArchiveEntry[],
        true,
      );
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
