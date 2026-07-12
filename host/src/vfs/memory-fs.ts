import { decompress as zstdDecompress } from "fzstd";
import type { StatResult, StatfsResult } from "../types";
import { SFFS_SUPER_MAGIC } from "../statfs";
import type { FileSystemBackend, DirEntry } from "./types";
import {
  assertExpectedByteLength,
  assertValidLazyContentSize,
  MAX_LAZY_CONTENT_BYTES,
  readFetchBody,
} from "./lazy-fetch";
import {
  SharedFS,
  type StatResult as SfsStatResult,
} from "./sharedfs-vendor";
import type { ZipEntry } from "./zip";

/** Serializable lazy file entry for transfer between instances. */
export interface LazyFileEntry {
  ino: number;
  path: string;
  url: string;
  /** Exact logical file bytes, after HTTP Content-Encoding decoding. */
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
  size: number;
  isSymlink: boolean;
  deleted: boolean;
}

/**
 * A group of files whose content comes from a single zip archive.
 * Accessing any member materializes the entire archive in one fetch.
 */
export interface LazyArchiveGroup {
  url: string;
  mountPrefix: string;
  materialized: boolean;
  entries: Map<string, LazyArchiveFileEntry>; // keyed by VFS absolute path
}

/** JSON-serializable form of LazyArchiveGroup for cross-worker transfer. */
export interface SerializedLazyArchiveEntry {
  url: string;
  mountPrefix: string;
  materialized: boolean;
  entries: Array<{
    vfsPath: string;
    ino: number;
    size: number;
    isSymlink: boolean;
    deleted: boolean;
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
const O_WRONLY_CREAT_TRUNC = 0o1101;
const COPY_CHUNK_BYTES = 1024 * 1024;
const MIN_REBASE_INITIAL_BYTES = 16 * 1024 * 1024;
const VFS_IMAGE_MAX_METADATA_BYTES = 64 * 1024;
const VFS_IMAGE_MAX_LAZY_SECTION_BYTES = 16 * 1024 * 1024;
const MAX_LAZY_ENTRIES = 100_000;
const MAX_LAZY_ARCHIVE_GROUPS = 4096;
const MAX_LAZY_PATH_BYTES = 4096;
const MAX_LAZY_URL_BYTES = 64 * 1024;

function cloneMetadata(metadata: VfsImageMetadata | null): VfsImageMetadata | null {
  return metadata === null ? null : { ...metadata };
}

function validateMetadata(metadata: VfsImageMetadata): VfsImageMetadata {
  if (!metadata || typeof metadata !== "object") {
    throw new Error("VFS image metadata must be an object");
  }
  if (metadata.version !== 1) {
    throw new Error(`Unsupported VFS image metadata version: ${String(metadata.version)}`);
  }
  if (
    metadata.kernelAbi !== undefined &&
    (!Number.isInteger(metadata.kernelAbi) || metadata.kernelAbi < 0)
  ) {
    throw new Error(`VFS image metadata kernelAbi must be a non-negative integer`);
  }
  if (metadata.createdBy !== undefined && typeof metadata.createdBy !== "string") {
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

  const view = new DataView(
    image.buffer,
    image.byteOffset,
    image.byteLength,
  );
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
    throw new Error(`VFS image has unknown flags: 0x${(flags & ~knownFlags).toString(16)}`);
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
    throw new Error("VFS image lazy file flag does not match its metadata section");
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
      throw new Error("VFS image lazy archive flag has an empty metadata section");
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

function validateLazySize(size: number, context: string): void {
  assertValidLazyContentSize(context, size);
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

function validateLazyEntryShape(entry: unknown, context: string): asserts entry is LazyFileEntry {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`${context} must be an object`);
  }
  const candidate = entry as Partial<LazyFileEntry>;
  if (!Number.isSafeInteger(candidate.ino) || (candidate.ino ?? 0) <= 0) {
    throw new Error(`${context} has an invalid inode`);
  }
  validateCanonicalAbsolutePath(candidate.path, context);
  validateLazyUrl(candidate.url, context);
  validateLazySize(candidate.size as number, context);
}

export class MemoryFileSystem implements FileSystemBackend {
  private fs: SharedFS;
  private imageMetadata: VfsImageMetadata | null;
  /** Lazy files: inode → { path, url, size }. Cleared per-inode after materialization. */
  private lazyFiles = new Map<number, { path: string; url: string; size: number }>();
  /** Lazy archive groups (bundle of files backed by one zip URL). */
  private lazyArchiveGroups: LazyArchiveGroup[] = [];
  /** Fast lookup: inode → group it belongs to. Cleared per-group after materialization. */
  private lazyArchiveInodes = new Map<number, LazyArchiveGroup>();
  private lazyFileMaterializations = new Map<number, Promise<void>>();
  private lazyArchiveMaterializations = new Map<LazyArchiveGroup, Promise<void>>();
  private lazyDownloadListeners = new Set<LazyDownloadListener>();

  private constructor(fs: SharedFS, metadata: VfsImageMetadata | null = null) {
    this.fs = fs;
    this.imageMetadata = metadata;
  }

  /** Return the underlying SharedArrayBuffer (for sharing with workers). */
  get sharedBuffer(): SharedArrayBuffer {
    return this.fs.buffer as SharedArrayBuffer;
  }

  static create(sab: SharedArrayBuffer, maxSizeBytes?: number): MemoryFileSystem {
    return new MemoryFileSystem(SharedFS.mkfs(sab, maxSizeBytes));
  }

  static fromExisting(sab: SharedArrayBuffer): MemoryFileSystem {
    return new MemoryFileSystem(SharedFS.mount(sab));
  }

  private lazyEntryCount(): number {
    return this.lazyArchiveGroups.reduce(
      (total, group) => total + group.entries.size,
      this.lazyFiles.size,
    );
  }

  /**
   * Copy this filesystem into a freshly formatted SharedFS whose superblock
   * records `maxByteLength` as its growth ceiling. Lazy file/archive metadata
   * is rebuilt from paths so the destination carries the new inode numbers.
   */
  rebaseToNewFileSystem(maxByteLength: number): MemoryFileSystem {
    if (!Number.isSafeInteger(maxByteLength) || maxByteLength <= 0) {
      throw new Error(`Invalid MemoryFileSystem maxByteLength: ${maxByteLength}`);
    }

    const initialByteLength = Math.min(
      maxByteLength,
      Math.max(this.sharedBuffer.byteLength, MIN_REBASE_INITIAL_BYTES),
    );
    const SharedArrayBufferCtor = SharedArrayBuffer as new (
      byteLength: number,
      options?: { maxByteLength?: number },
    ) => SharedArrayBuffer;
    const sab = new SharedArrayBufferCtor(initialByteLength, { maxByteLength });
    const target = MemoryFileSystem.create(sab, maxByteLength);
    target.setImageMetadata(this.imageMetadata);

    const lazyEntries = this.exportLazyEntries();
    const lazyFilePaths = new Set(lazyEntries.map((entry) => entry.path));
    const lazyArchiveEntries = this.exportLazyArchiveEntries();
    const lazyArchiveStubPaths = new Set<string>();
    for (const group of lazyArchiveEntries) {
      if (group.materialized) continue;
      for (const entry of group.entries) {
        if (!entry.deleted && !entry.isSymlink) {
          lazyArchiveStubPaths.add(entry.vfsPath);
        }
      }
    }

    this.copyPathToFreshFileSystem("/", target, lazyFilePaths, lazyArchiveStubPaths);

    target.importLazyEntries(lazyEntries.map((entry) => ({
      ...entry,
      ino: target.lstat(entry.path).ino,
    })));
    target.importLazyArchiveEntries(lazyArchiveEntries.map((group) => ({
      ...group,
      entries: group.entries.map((entry) => ({
        ...entry,
        ino: entry.deleted ? 0 : target.lstat(entry.vfsPath).ino,
      })),
    })));

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
      try { listener(stamped); } catch { /* listener errors must not break VFS I/O */ }
    }
  }

  private async fetchLazyBytes(
    details: {
      id: string;
      kind: LazyDownloadKind;
      url: string;
      path?: string;
      mountPrefix?: string;
      /** Expected decoded Fetch body size for a lazy file. */
      expectedBytes?: number;
    },
  ): Promise<Uint8Array> {
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

      // The VFS declaration is authoritative for lazy files. A successful
      // response can still be an HTML fallback or another wrong-sized
      // artifact, so keep reporting the declared size and verify the bytes.
      totalBytes = details.expectedBytes ?? parseContentLength(resp.headers);
      const data = await readFetchBody(resp, {
        label: details.path ?? details.url,
        expectedBytes: details.expectedBytes,
        onProgress: (receivedBytes) => {
          loadedBytes = receivedBytes;
          this.emitLazyDownload({
            ...base,
            status: "progress",
            loadedBytes,
            totalBytes: totalBytes ?? loadedBytes,
          });
        },
      });
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
   * metadata so that read() will fetch content on demand via sync XHR.
   * Returns the inode number (useful for forwarding to other instances).
   */
  registerLazyFile(path: string, url: string, size: number, mode = 0o755): number {
    validateCanonicalAbsolutePath(path, "lazy file path");
    validateLazyUrl(url, `lazy file ${path}`);
    if (this.lazyEntryCount() >= MAX_LAZY_ENTRIES) {
      throw new Error(`lazy entry count exceeds ${MAX_LAZY_ENTRIES}`);
    }
    validateLazySize(size, `lazy file ${path}`);
    // Ensure parent directories exist
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current += "/" + parts[i];
      try { this.fs.mkdir(current, 0o755); } catch { /* exists */ }
    }
    // Create empty stub file
    const fd = this.fs.open(path, 0o1101, mode); // O_WRONLY | O_CREAT | O_TRUNC
    this.fs.close(fd);
    // Get inode
    const st = this.fs.stat(path);
    this.lazyFiles.set(st.ino, { path, url, size });
    return st.ino;
  }

  /**
   * Import lazy file entries from another instance (e.g., main thread → worker).
   * Does not create files — assumes the files already exist in the SharedArrayBuffer.
   */
  importLazyEntries(entries: LazyFileEntry[]): void {
    if (!Array.isArray(entries)) {
      throw new Error("lazy file entries must be an array");
    }
    if (entries.length > MAX_LAZY_ENTRIES - this.lazyEntryCount()) {
      throw new Error(`lazy entry count exceeds ${MAX_LAZY_ENTRIES}`);
    }
    const seenInodes = new Set<number>(this.lazyFiles.keys());
    const seenPaths = new Set<string>(
      Array.from(this.lazyFiles.values(), (entry) => entry.path),
    );
    for (const group of this.lazyArchiveGroups) {
      for (const [path, entry] of group.entries) {
        seenPaths.add(path);
        if (!entry.deleted) seenInodes.add(entry.ino);
      }
    }
    for (const [index, e] of entries.entries()) {
      validateLazyEntryShape(e, `lazy file entry ${index}`);
      if (seenInodes.has(e.ino) || seenPaths.has(e.path)) {
        throw new Error(`lazy file entry ${index} duplicates an inode or path`);
      }
      seenInodes.add(e.ino);
      seenPaths.add(e.path);
      let actual: SfsStatResult;
      try {
        actual = this.fs.lstat(e.path);
      } catch {
        throw new Error(`lazy file entry ${index} path does not exist: ${e.path}`);
      }
      if (actual.ino !== e.ino) {
        throw new Error(
          `lazy file entry ${index} inode mismatch for ${e.path}: ` +
          `expected ${actual.ino}, received ${e.ino}`,
        );
      }
      if ((actual.mode & S_IFMT) !== S_IFREG) {
        throw new Error(`lazy file entry ${index} is not a regular file: ${e.path}`);
      }
      if (actual.size !== 0) {
        throw new Error(`lazy file entry ${index} is not an empty stub: ${e.path}`);
      }
    }
    for (const e of entries) {
      this.lazyFiles.set(e.ino, { path: e.path, url: e.url, size: e.size });
    }
  }

  /** Export all pending lazy entries for transfer to another instance. */
  exportLazyEntries(): LazyFileEntry[] {
    const entries: LazyFileEntry[] = [];
    for (const [ino, { path, url, size }] of this.lazyFiles) {
      entries.push({ ino, path, url, size });
    }
    return entries;
  }

  /** Return lazy metadata for `path`, following symlinks through stat(). */
  getLazyEntry(path: string): LazyFileEntry | null {
    try {
      const st = this.fs.stat(path);
      const entry = this.lazyFiles.get(st.ino);
      return entry ? { ino: st.ino, path: entry.path, url: entry.url, size: entry.size } : null;
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
    for (const [ino, entry] of this.lazyFiles) {
      const url = transform(entry.url, entry.path);
      validateLazyUrl(url, `lazy file ${entry.path}`);
      this.lazyFiles.set(ino, {
        ...entry,
        url,
      });
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
  ): LazyArchiveGroup {
    validateLazyUrl(url, "lazy archive");
    validateLazyMountPrefix(mountPrefix, "lazy archive mount prefix");
    if (!Array.isArray(zipEntries)) {
      throw new Error("lazy archive entries must be an array");
    }
    if (this.lazyArchiveGroups.length >= MAX_LAZY_ARCHIVE_GROUPS) {
      throw new Error(`lazy archive group count exceeds ${MAX_LAZY_ARCHIVE_GROUPS}`);
    }
    const existingEntryCount = this.lazyEntryCount();
    const fileEntryCount = zipEntries.filter((entry) => !entry.isDirectory).length;
    if (fileEntryCount > MAX_LAZY_ENTRIES - existingEntryCount) {
      throw new Error(`lazy entry count exceeds ${MAX_LAZY_ENTRIES}`);
    }
    const group: LazyArchiveGroup = {
      url,
      mountPrefix,
      materialized: false,
      entries: new Map(),
    };

    const normalized = mountPrefix.replace(/\/+$/, "");
    const seenPaths = new Set<string>();
    const pendingEntries: Array<{ zipEntry: ZipEntry; vfsPath: string }> = [];
    let expandedBytes = 0;
    for (const ze of zipEntries) {
      if (ze.isDirectory) continue;

      const vfsPath = normalized + "/" + ze.fileName;
      validateCanonicalAbsolutePath(vfsPath, "lazy archive entry");
      validateLazySize(ze.uncompressedSize, `lazy archive entry ${vfsPath}`);
      expandedBytes += ze.uncompressedSize;
      if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_LAZY_CONTENT_BYTES) {
        throw new Error(
          `lazy archive expanded content exceeds ${MAX_LAZY_CONTENT_BYTES} bytes`,
        );
      }
      if (seenPaths.has(vfsPath)) {
        throw new Error(`lazy archive duplicates path: ${vfsPath}`);
      }
      seenPaths.add(vfsPath);
      pendingEntries.push({ zipEntry: ze, vfsPath });
    }

    for (const { zipEntry: ze, vfsPath } of pendingEntries) {
      const parts = vfsPath.split("/").filter(Boolean);
      let current = "";
      for (let i = 0; i < parts.length - 1; i++) {
        current += "/" + parts[i];
        try { this.fs.mkdir(current, 0o755); } catch { /* exists */ }
      }

      if (ze.isSymlink && symlinkTargets?.has(ze.fileName)) {
        const target = symlinkTargets.get(ze.fileName)!;
        this.fs.symlink(target, vfsPath);
      } else {
        const fd = this.fs.open(vfsPath, 0o1101, ze.mode); // O_WRONLY | O_CREAT | O_TRUNC
        this.fs.close(fd);
      }

      const st = this.fs.lstat(vfsPath);
      const entry: LazyArchiveFileEntry = {
        ino: st.ino,
        size: ze.uncompressedSize,
        isSymlink: ze.isSymlink,
        deleted: false,
      };
      group.entries.set(vfsPath, entry);
      this.lazyArchiveInodes.set(st.ino, group);
    }

    this.lazyArchiveGroups.push(group);
    return group;
  }

  /** Import lazy archive groups from another instance. Assumes stubs already exist. */
  importLazyArchiveEntries(serialized: SerializedLazyArchiveEntry[]): void {
    if (!Array.isArray(serialized)) {
      throw new Error("lazy archive groups must be an array");
    }
    if (serialized.length > MAX_LAZY_ARCHIVE_GROUPS - this.lazyArchiveGroups.length) {
      throw new Error(`lazy archive group count exceeds ${MAX_LAZY_ARCHIVE_GROUPS}`);
    }

    const seenPaths = new Set<string>(
      Array.from(this.lazyFiles.values(), (entry) => entry.path),
    );
    const seenInodes = new Set<number>(this.lazyFiles.keys());
    let totalEntries = this.lazyEntryCount();
    for (const existing of this.lazyArchiveGroups) {
      for (const [path, entry] of existing.entries) {
        seenPaths.add(path);
        if (!entry.deleted) seenInodes.add(entry.ino);
      }
    }

    const groups: LazyArchiveGroup[] = [];
    for (const [groupIndex, value] of serialized.entries()) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`lazy archive group ${groupIndex} must be an object`);
      }
      const s = value as Partial<SerializedLazyArchiveEntry>;
      validateLazyUrl(s.url, `lazy archive group ${groupIndex}`);
      validateLazyMountPrefix(
        s.mountPrefix,
        `lazy archive group ${groupIndex} mount prefix`,
      );
      if (typeof s.materialized !== "boolean") {
        throw new Error(`lazy archive group ${groupIndex} has invalid materialized state`);
      }
      if (!Array.isArray(s.entries)) {
        throw new Error(`lazy archive group ${groupIndex} entries must be an array`);
      }
      totalEntries += s.entries.length;
      if (totalEntries > MAX_LAZY_ENTRIES) {
        throw new Error(`lazy entry count exceeds ${MAX_LAZY_ENTRIES}`);
      }

      const entries = new Map<string, LazyArchiveFileEntry>();
      let expandedBytes = 0;
      const normalizedPrefix = s.mountPrefix.replace(/\/+$/, "");
      for (const [entryIndex, rawEntry] of s.entries.entries()) {
        const context = `lazy archive group ${groupIndex} entry ${entryIndex}`;
        if (
          typeof rawEntry !== "object" ||
          rawEntry === null ||
          Array.isArray(rawEntry)
        ) {
          throw new Error(`${context} must be an object`);
        }
        const e = rawEntry as SerializedLazyArchiveEntry["entries"][number];
        validateCanonicalAbsolutePath(e.vfsPath, context);
        if (
          normalizedPrefix !== "" &&
          !e.vfsPath.startsWith(`${normalizedPrefix}/`)
        ) {
          throw new Error(`${context} is outside mount prefix ${s.mountPrefix}`);
        }
        if (typeof e.isSymlink !== "boolean" || typeof e.deleted !== "boolean") {
          throw new Error(`${context} has invalid state flags`);
        }
        validateLazySize(e.size, context);
        expandedBytes += e.size;
        if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_LAZY_CONTENT_BYTES) {
          throw new Error(
            `lazy archive group ${groupIndex} expanded content exceeds ` +
            `${MAX_LAZY_CONTENT_BYTES} bytes`,
          );
        }
        if (!Number.isSafeInteger(e.ino) || e.ino < (e.deleted ? 0 : 1)) {
          throw new Error(`${context} has an invalid inode`);
        }
        if (seenPaths.has(e.vfsPath) || (!e.deleted && seenInodes.has(e.ino))) {
          throw new Error(`${context} duplicates an inode or path`);
        }
        seenPaths.add(e.vfsPath);
        if (!e.deleted) seenInodes.add(e.ino);

        let actual: SfsStatResult | null = null;
        try {
          actual = this.fs.lstat(e.vfsPath);
        } catch {
          // Deleted archive members are the only entries allowed to be absent.
        }
        if (e.deleted) {
          if (actual !== null) {
            throw new Error(`${context} is marked deleted but its path still exists`);
          }
        } else {
          if (actual === null) {
            throw new Error(`${context} path does not exist: ${e.vfsPath}`);
          }
          if (actual.ino !== e.ino) {
            throw new Error(
              `${context} inode mismatch for ${e.vfsPath}: ` +
              `expected ${actual.ino}, received ${e.ino}`,
            );
          }
          const expectedKind = e.isSymlink ? S_IFLNK : S_IFREG;
          if ((actual.mode & S_IFMT) !== expectedKind) {
            throw new Error(`${context} has the wrong file type: ${e.vfsPath}`);
          }
          if (!s.materialized && !e.isSymlink && actual.size !== 0) {
            throw new Error(`${context} is not an empty stub: ${e.vfsPath}`);
          }
        }

        entries.set(e.vfsPath, {
          ino: e.ino,
          size: e.size,
          isSymlink: e.isSymlink,
          deleted: e.deleted,
        });
      }
      const group: LazyArchiveGroup = {
        url: s.url,
        mountPrefix: s.mountPrefix,
        materialized: s.materialized,
        entries,
      };
      groups.push(group);
    }

    for (const group of groups) {
      this.lazyArchiveGroups.push(group);
      if (!group.materialized) {
        for (const [, entry] of group.entries) {
          if (!entry.deleted) {
            this.lazyArchiveInodes.set(entry.ino, group);
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

  /** Export all lazy archive groups for transfer to another instance. */
  exportLazyArchiveEntries(): SerializedLazyArchiveEntry[] {
    return this.lazyArchiveGroups.map((group) => ({
      url: group.url,
      mountPrefix: group.mountPrefix,
      materialized: group.materialized,
      entries: Array.from(group.entries, ([vfsPath, entry]) => ({
        vfsPath,
        ino: entry.ino,
        size: entry.size,
        isSymlink: entry.isSymlink,
        deleted: entry.deleted,
      })),
    }));
  }

  private replaceStubContents(path: string, data: Uint8Array, label: string): void {
    let fd: number | null = null;
    try {
      fd = this.fs.open(path, O_WRONLY_CREAT_TRUNC, 0o755);
      let offset = 0;
      while (offset < data.byteLength) {
        const written = this.fs.write(fd, data.subarray(offset));
        if (written <= 0) {
          throw new Error(
            `${label} could not be stored completely: wrote ${offset} of ` +
            `${data.byteLength} bytes`,
          );
        }
        offset += written;
      }
    } catch (error) {
      if (fd !== null) {
        try {
          this.fs.ftruncate(fd, 0);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `${label} failed and its empty stub could not be restored`,
          );
        }
      }
      throw error;
    } finally {
      if (fd !== null) this.fs.close(fd);
    }
  }

  /**
   * Replace a lazy file stub with already-fetched bytes. The metadata is
   * removed only after every byte has been stored; failures restore an empty
   * stub so the same entry can be retried.
   */
  materializeLazyFile(path: string, data: Uint8Array): boolean {
    let st: SfsStatResult;
    try {
      st = this.fs.stat(path);
    } catch {
      return false;
    }
    const entry = this.lazyFiles.get(st.ino);
    if (!entry) return false;

    assertExpectedByteLength(entry.path, entry.size, data.byteLength);
    this.replaceStubContents(entry.path, data, `lazy file ${entry.path}`);
    this.lazyFiles.delete(st.ino);
    return true;
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
    const entry = this.lazyFiles.get(st.ino);
    if (!entry) return false;

    let pending = this.lazyFileMaterializations.get(st.ino);
    if (!pending) {
      const lazyEntry: LazyFileEntry = { ino: st.ino, ...entry };
      pending = (async () => {
        const data = await load(lazyEntry);
        if (!this.materializeLazyFile(lazyEntry.path, data)) {
          let current: SfsStatResult | null = null;
          try { current = this.fs.stat(lazyEntry.path); } catch { /* checked below */ }
          if (current?.ino === lazyEntry.ino && !this.lazyFiles.has(lazyEntry.ino)) {
            return;
          }
          throw new Error(
            `lazy file entry disappeared during materialization: ${lazyEntry.path}`,
          );
        }
      })();
      this.lazyFileMaterializations.set(st.ino, pending);
    }

    try {
      await pending;
    } finally {
      if (this.lazyFileMaterializations.get(st.ino) === pending) {
        this.lazyFileMaterializations.delete(st.ino);
      }
    }
    return true;
  }

  /**
   * Async-materialize a lazy file or archive-backed file if the given path
   * resolves to one. Call this before any synchronous read (e.g. in
   * handleExec) to avoid sync XHR which deadlocks with COOP/COEP.
   * Returns true if something was materialized, false if already concrete.
   */
  async ensureMaterialized(path: string): Promise<boolean> {
    if (this.lazyFiles.size === 0 && this.lazyArchiveInodes.size === 0) return false;
    let st: SfsStatResult;
    try {
      st = this.fs.stat(path); // follows symlinks
    } catch {
      return false;
    }

    const entry = this.lazyFiles.get(st.ino);
    if (entry) {
      return this.materializeLazyFileFrom(entry.path, (current) =>
        this.fetchLazyBytes({
          id: `file:${current.ino}`,
          kind: "file",
          url: current.url,
          path: current.path,
          expectedBytes: current.size,
        })
      );
    }
    const group = this.lazyArchiveInodes.get(st.ino);
    if (group) {
      await this.ensureArchiveMaterialized(group);
      return true;
    }
    return false;
  }

  /**
   * Materialize a full lazy archive group: fetch the zip once, parse its
   * central directory, and write every non-deleted entry into its stub.
   * Subsequent calls are no-ops.
   */
  async ensureArchiveMaterialized(group: LazyArchiveGroup): Promise<void> {
    if (group.materialized) return;

    let pending = this.lazyArchiveMaterializations.get(group);
    if (!pending) {
      pending = this.materializeLazyArchive(group);
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

  private async materializeLazyArchive(group: LazyArchiveGroup): Promise<void> {
    if (group.materialized) return;

    const zipData = await this.fetchLazyBytes({
      id: `archive:${group.mountPrefix}:${group.url}`,
      kind: "archive",
      url: group.url,
      mountPrefix: group.mountPrefix,
    });

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
    const filesToWrite: Array<{ vfsPath: string; zipEntry: ZipEntry }> = [];
    for (const [vfsPath, archiveEntry] of group.entries) {
      if (archiveEntry.deleted) continue;
      if (archiveEntry.isSymlink) continue; // symlinks already created at registration
      const zipFileName = vfsPath.slice(normalizedPrefix.length + 1);
      const ze = zipLookup.get(zipFileName);
      if (!ze) {
        throw new Error(`lazy archive member is missing: ${zipFileName}`);
      }
      assertExpectedByteLength(vfsPath, archiveEntry.size, ze.uncompressedSize);
      const content = extractZipEntry(zipData, ze);
      assertExpectedByteLength(vfsPath, archiveEntry.size, content.byteLength);
      filesToWrite.push({ vfsPath, zipEntry: ze });
    }

    try {
      for (const { vfsPath, zipEntry } of filesToWrite) {
        const content = extractZipEntry(zipData, zipEntry);
        this.replaceStubContents(vfsPath, content, `lazy archive member ${vfsPath}`);
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const { vfsPath } of filesToWrite) {
        let fd: number | null = null;
        try {
          fd = this.fs.open(vfsPath, O_WRONLY_CREAT_TRUNC, 0o755);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        } finally {
          if (fd !== null) {
            try { this.fs.close(fd); } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
            }
          }
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "lazy archive materialization failed and its stubs could not be restored",
        );
      }
      throw error;
    }

    group.materialized = true;
    for (const [, archiveEntry] of group.entries) {
      this.lazyArchiveInodes.delete(archiveEntry.ino);
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
      const paths = Array.from(this.lazyFiles.values()).map((e) => e.path);
      for (const p of paths) {
        await this.ensureMaterialized(p);
      }
    }

    const sabBytes = new Uint8Array(this.fs.buffer);
    const lazyEntries = this.exportLazyEntries();
    const hasLazy = lazyEntries.length > 0;
    const lazyJson = hasLazy
      ? new TextEncoder().encode(JSON.stringify(lazyEntries))
      : new Uint8Array(0);
    if (lazyJson.byteLength > VFS_IMAGE_MAX_LAZY_SECTION_BYTES) {
      throw new Error(
        `VFS image lazy file metadata exceeds ` +
        `${VFS_IMAGE_MAX_LAZY_SECTION_BYTES} bytes`,
      );
    }

    const archiveEntries = this.exportLazyArchiveEntries();
    const hasArchives = archiveEntries.length > 0;
    const archiveJson = hasArchives
      ? new TextEncoder().encode(JSON.stringify(archiveEntries))
      : new Uint8Array(0);
    if (archiveJson.byteLength > VFS_IMAGE_MAX_LAZY_SECTION_BYTES) {
      throw new Error(
        `VFS image lazy archive metadata exceeds ` +
        `${VFS_IMAGE_MAX_LAZY_SECTION_BYTES} bytes`,
      );
    }

    const metadata = options?.metadata === undefined
      ? this.imageMetadata
      : options.metadata;
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

    // SAB data — copy from SharedArrayBuffer (can't use set() directly on SAB-backed views in all environments)
    const sabCopy = new Uint8Array(sabBytes.byteLength);
    sabCopy.set(sabBytes);
    image.set(sabCopy, VFS_IMAGE_HEADER_SIZE);

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
      const metadataOffset = lazyOffset + 4 + lazyJson.byteLength + archiveSectionSize;
      view.setUint32(metadataOffset, metadataJson.byteLength, true);
      image.set(metadataJson, metadataOffset + 4);
    }

    return image;
  }

  /** Read image-level metadata without materializing the filesystem SAB. */
  static readImageMetadata(image: Uint8Array): VfsImageMetadata | null {
    const parsed = parseImageHeader(image);
    const sections = parseImageSections(parsed);
    if (sections.metadataLen === 0) return null;
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

  /**
   * Restore a MemoryFileSystem from a previously saved VFS image.
   * Allocates a new SharedArrayBuffer and populates it from the image.
   *
   * When `maxByteLength` is specified, creates a growable SharedArrayBuffer
   * so the filesystem can expand beyond the image's original size, up to the
   * maximum already recorded in the image superblock.
   */
  static fromImage(image: Uint8Array, options?: { maxByteLength?: number }): MemoryFileSystem {
    const parsed = parseImageHeader(image);
    const sections = parseImageSections(parsed);
    image = parsed.image;
    const sabLen = parsed.sabLen;

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
    sabView.set(image.subarray(VFS_IMAGE_HEADER_SIZE, VFS_IMAGE_HEADER_SIZE + sabLen));

    let metadata: VfsImageMetadata | null = null;
    if (sections.metadataLen > 0) {
      metadata = decodeMetadata(
        image.subarray(
          sections.metadataOffset + 4,
          sections.metadataOffset + 4 + sections.metadataLen,
        ),
      );
    }

    const mfs = new MemoryFileSystem(SharedFS.mount(sab), metadata);

    // Restore lazy entries
    if (sections.lazyLen > 0) {
      const lazyBytes = image.subarray(
        sections.lazyOffset + 4,
        sections.lazyOffset + 4 + sections.lazyLen,
      );
      const entries: LazyFileEntry[] = JSON.parse(
        new TextDecoder().decode(lazyBytes),
      );
      mfs.importLazyEntries(entries);
    }

    // Restore lazy archive groups
    if (sections.archiveLen > 0) {
      const archiveBytes = image.subarray(
        sections.archiveOffset + 4,
        sections.archiveOffset + 4 + sections.archiveLen,
      );
      const entries: SerializedLazyArchiveEntry[] = JSON.parse(
        new TextDecoder().decode(archiveBytes),
      );
      mfs.importLazyArchiveEntries(entries);
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

  open(path: string, flags: number, mode: number): number {
    return this.fs.open(path, flags, mode);
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
      // pread semantics: read at offset without changing file position
      const savedPos = this.fs.lseek(handle, 0, 1); // SEEK_CUR
      this.fs.lseek(handle, offset, 0); // SEEK_SET
      const n = this.fs.read(handle, buffer.subarray(0, length));
      this.fs.lseek(handle, savedPos, 0); // restore position
      return n;
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
      // pwrite semantics: write at offset without changing file position
      const savedPos = this.fs.lseek(handle, 0, 1); // SEEK_CUR
      this.fs.lseek(handle, offset, 0); // SEEK_SET
      const n = this.fs.write(handle, buffer.subarray(0, length));
      this.fs.lseek(handle, savedPos, 0); // restore position
      return n;
    }
    return this.fs.write(handle, buffer.subarray(0, length));
  }

  seek(handle: number, offset: number, whence: number): number {
    return this.fs.lseek(handle, offset, whence);
  }

  fstat(handle: number): StatResult {
    const result = this.adaptStat(this.fs.fstat(handle));
    // Override size for unmaterialized lazy files / archive entries
    const entry = this.lazyFiles.get(result.ino);
    if (entry) {
      result.size = entry.size;
    } else {
      const group = this.lazyArchiveInodes.get(result.ino);
      if (group) {
        for (const archiveEntry of group.entries.values()) {
          if (archiveEntry.ino === result.ino) {
            result.size = archiveEntry.size;
            break;
          }
        }
      }
    }
    return result;
  }

  ftruncate(handle: number, length: number): void {
    this.fs.ftruncate(handle, length);
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
    const result = this.adaptStat(this.fs.stat(path));
    // Override size for unmaterialized lazy files / archive entries
    const entry = this.lazyFiles.get(result.ino);
    if (entry) {
      result.size = entry.size;
    } else {
      const group = this.lazyArchiveInodes.get(result.ino);
      if (group) {
        for (const archiveEntry of group.entries.values()) {
          if (archiveEntry.ino === result.ino) {
            result.size = archiveEntry.size;
            break;
          }
        }
      }
    }
    return result;
  }

  lstat(path: string): StatResult {
    const result = this.adaptStat(this.fs.lstat(path));
    // Override size for unmaterialized lazy files / archive entries
    const entry = this.lazyFiles.get(result.ino);
    if (entry) {
      result.size = entry.size;
    } else {
      const group = this.lazyArchiveInodes.get(result.ino);
      if (group) {
        for (const archiveEntry of group.entries.values()) {
          if (archiveEntry.ino === result.ino) {
            result.size = archiveEntry.size;
            break;
          }
        }
      }
    }
    return result;
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

  mkdir(path: string, mode: number): void {
    this.fs.mkdir(path, mode);
  }

  rmdir(path: string): void {
    this.fs.rmdir(path);
  }

  unlink(path: string): void {
    // If the path belongs to an unmaterialized archive group, mark the entry
    // as deleted so materialization skips it.
    if (this.lazyArchiveInodes.size > 0) {
      try {
        const st = this.fs.lstat(path);
        const group = this.lazyArchiveInodes.get(st.ino);
        if (group) {
          const entry = group.entries.get(path);
          if (entry) entry.deleted = true;
          this.lazyArchiveInodes.delete(st.ino);
        }
      } catch { /* not present — unlink will raise the real error */ }
    }
    this.fs.unlink(path);
  }

  rename(oldPath: string, newPath: string): void {
    this.fs.rename(oldPath, newPath);
  }

  link(existingPath: string, newPath: string): void {
    this.fs.link(existingPath, newPath);
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

  symlinkWithOwner(target: string, path: string, uid: number, gid: number): void {
    this.symlink(target, path);
    this.lchown(path, uid, gid);
  }

  private copyPathToFreshFileSystem(
    path: string,
    target: MemoryFileSystem,
    lazyFilePaths: Set<string>,
    lazyArchiveStubPaths: Set<string>,
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
          );
        }
      } finally {
        this.closedir(dh);
      }
      MemoryFileSystem.applyTimes(target, path, st);
      return;
    }

    if (kind === S_IFLNK) {
      target.symlinkWithOwner(this.readlink(path), path, st.uid, st.gid);
      return;
    }

    if (kind !== S_IFREG) {
      throw new Error(`Unsupported file type while rebasing VFS: ${path}`);
    }

    const isLazyStub = lazyFilePaths.has(path) || lazyArchiveStubPaths.has(path);
    if (isLazyStub) {
      target.createFileWithOwner(path, mode, st.uid, st.gid, new Uint8Array(0));
      MemoryFileSystem.applyTimes(target, path, st);
      return;
    }

    this.copyRegularFileToFreshFileSystem(path, target, st, mode);
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
      const chunk = new Uint8Array(Math.min(COPY_CHUNK_BYTES, Math.max(1, st.size)));
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

  private static applyTimes(fs: MemoryFileSystem, path: string, st: StatResult): void {
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

  utimensat(path: string, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void {
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
    if ((mode & 0xf000) === 0x8000) dtype = 8; // DT_REG
    else if ((mode & 0xf000) === 0x4000) dtype = 4; // DT_DIR
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
