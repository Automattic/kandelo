/**
 * Zip central directory parser and entry extractor.
 *
 * Parses zip file metadata from the central directory without
 * decompressing the entire archive. Used by lazy archive registration,
 * and to browse and extract members of remote archives through HTTP
 * range requests without downloading them.
 *
 * Remote archives are untrusted input. Every offset and size read from one
 * is checked against the archive's length before it is used, ZIP64 fields
 * are accepted only when they fit a safe integer, and callers bound how many
 * entries and directory bytes they will accept.
 */

import { Inflate, inflateSync } from "fflate";
import { FILE_MODES } from "../generated/abi";
import {
  fetchByteRange,
  isStrongEntityTag,
  type ByteRangeFetch,
} from "../networking/byte-range-fetch";

// --- Zip format signatures ---

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_SIGNATURE = 0x06064b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

// Maximum size to search backwards for EOCD (64KiB comment + 22 bytes header)
const EOCD_MAX_SEARCH = 65557;

// Fixed header sizes
const EOCD_MIN_SIZE = 22;
const CENTRAL_DIR_FIXED_SIZE = 46;
const LOCAL_HEADER_FIXED_SIZE = 30;
const EOCD64_LOCATOR_SIZE = 20;
const EOCD64_MIN_SIZE = 56;

// A 16- or 32-bit field holding its maximum defers to the ZIP64 record.
const U16_SATURATED = 0xffff;
const U32_SATURATED = 0xffffffff;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const GENERAL_PURPOSE_ENCRYPTED = 0x0001;
const MAX_LOCAL_EXTRA_BYTES = 0xffff;

// Compression methods
const COMPRESSION_STORE = 0;
const COMPRESSION_DEFLATE = 8;

// Unix creator OS code
const CREATOR_UNIX = 3;

const { S_IFLNK, S_IFMT } = FILE_MODES;
const fileNameDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});
const textEncoder = new TextEncoder();

export interface ZipEntry {
  fileName: string;
  /** Exact filename bytes from the central directory. */
  fileNameBytes: Uint8Array;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
  mode: number;
  isDirectory: boolean;
  isSymlink: boolean;
  externalAttrs: number;
  creatorOS: number;
  /** The member is encrypted; its bytes cannot be extracted without a key. */
  encrypted: boolean;
}

export interface ZipParseOptions {
  /**
   * `exact` (the default) rejects a member name that is not byte-exact
   * UTF-8, because a VFS installs names byte-for-byte. `display` decodes such
   * a name with replacement characters instead, for listing third-party
   * archives whose tools wrote legacy code-page names; `fileNameBytes` stays
   * exact either way.
   */
  names?: "exact" | "display";
  /** Reject a directory that declares more entries than this. */
  maxEntries?: number;
}

interface DirectoryLocation {
  entryCount: number;
  cdOffset: number;
  cdSize: number;
}

/**
 * Find the End of Central Directory record by searching backwards
 * from the end of the data.
 */
function findEOCD(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const searchStart = Math.max(0, data.length - EOCD_MAX_SEARCH);

  for (let i = data.length - EOCD_MIN_SIZE; i >= searchStart; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      return i;
    }
  }
  throw new Error("Zip EOCD record not found");
}

/**
 * Parse the central directory from zip file bytes and return all entries.
 */
export function parseZipCentralDirectory(
  data: Uint8Array,
  options: ZipParseOptions = {},
): ZipEntry[] {
  return parseDirectoryWindow(data, 0, data.byteLength, options);
}

function readSafeU64(view: DataView, offset: number, what: string): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`ZIP64 ${what} is too large to address`);
  }
  return Number(value);
}

/**
 * Where the central directory is, from the end record at `eocdOffset`
 * (absolute), following the ZIP64 locator when one precedes it.
 *
 * `window` holds archive bytes [windowStart, windowStart + window.length).
 */
function locateCentralDirectory(
  window: Uint8Array,
  windowStart: number,
  totalLength: number,
  eocdOffset: number,
): DirectoryLocation & { eocd64Offset?: number } {
  const view = new DataView(window.buffer, window.byteOffset, window.byteLength);
  const at = (absolute: number) => absolute - windowStart;
  let entryCount = view.getUint16(at(eocdOffset) + 10, true);
  let cdSize = view.getUint32(at(eocdOffset) + 12, true);
  let cdOffset = view.getUint32(at(eocdOffset) + 16, true);
  const saturated = entryCount === U16_SATURATED
    || cdSize === U32_SATURATED
    || cdOffset === U32_SATURATED;

  const locatorOffset = eocdOffset - EOCD64_LOCATOR_SIZE;
  let eocd64Offset: number | undefined;
  if (
    locatorOffset >= windowStart
    && view.getUint32(at(locatorOffset), true) === EOCD64_LOCATOR_SIGNATURE
  ) {
    eocd64Offset = readSafeU64(view, at(locatorOffset) + 8, "end record offset");
    if (eocd64Offset + EOCD64_MIN_SIZE > locatorOffset) {
      throw new Error("ZIP64 end record overlaps the records that follow it");
    }
    if (eocd64Offset < windowStart) {
      // The caller must fetch these bytes and ask again.
      return { entryCount, cdOffset, cdSize, eocd64Offset };
    }
    if (view.getUint32(at(eocd64Offset), true) !== EOCD64_SIGNATURE) {
      throw new Error("ZIP64 end record signature not found where its locator points");
    }
    entryCount = readSafeU64(view, at(eocd64Offset) + 32, "entry count");
    cdSize = readSafeU64(view, at(eocd64Offset) + 40, "directory size");
    cdOffset = readSafeU64(view, at(eocd64Offset) + 48, "directory offset");
  } else if (saturated) {
    throw new Error("ZIP archive needs ZIP64 fields but has no ZIP64 end record");
  }

  const directoryEnd = eocd64Offset ?? eocdOffset;
  if (cdOffset + cdSize > directoryEnd || directoryEnd > totalLength) {
    throw new Error("ZIP central directory lies outside the archive");
  }
  // Every entry is at least the fixed header, so this also bounds the loop.
  if (entryCount * CENTRAL_DIR_FIXED_SIZE > cdSize) {
    throw new Error(
      `ZIP directory declares ${entryCount} entries in ${cdSize} bytes`,
    );
  }
  return { entryCount, cdOffset, cdSize, eocd64Offset };
}

/**
 * Parse the directory held in `window`, which is archive bytes
 * [windowStart, windowStart + window.length) of an archive `totalLength`
 * bytes long. The window must contain the whole directory and the end
 * records; nothing before the directory is needed.
 */
function parseDirectoryWindow(
  window: Uint8Array,
  windowStart: number,
  totalLength: number,
  options: ZipParseOptions,
): ZipEntry[] {
  const view = new DataView(window.buffer, window.byteOffset, window.byteLength);
  const eocdOffset = windowStart + findEOCD(window);
  const location = locateCentralDirectory(window, windowStart, totalLength, eocdOffset);
  if (location.cdOffset < windowStart) {
    throw new Error("ZIP central directory is not within the bytes provided");
  }
  if (options.maxEntries !== undefined && location.entryCount > options.maxEntries) {
    throw new Error(
      `ZIP directory declares ${location.entryCount} entries; at most ` +
        `${options.maxEntries} are accepted`,
    );
  }
  const decoder = options.names === "display"
    ? new TextDecoder("utf-8", { ignoreBOM: true })
    : fileNameDecoder;

  const entries: ZipEntry[] = [];
  const cdEnd = location.cdOffset + location.cdSize - windowStart;
  let offset = location.cdOffset - windowStart;

  for (let i = 0; i < location.entryCount; i++) {
    if (
      offset + CENTRAL_DIR_FIXED_SIZE > cdEnd
      || view.getUint32(offset, true) !== CENTRAL_DIR_SIGNATURE
    ) {
      throw new Error(
        `Invalid central directory entry signature at offset ${offset + windowStart}`,
      );
    }

    const versionMadeBy = view.getUint16(offset + 4, true);
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    let compressedSize = view.getUint32(offset + 20, true);
    let uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraFieldLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttrs = view.getUint32(offset + 38, true);
    let localHeaderOffset = view.getUint32(offset + 42, true);

    const nameStart = offset + CENTRAL_DIR_FIXED_SIZE;
    const extraStart = nameStart + fileNameLength;
    const next = extraStart + extraFieldLength + commentLength;
    if (next > cdEnd) {
      throw new Error(
        `ZIP central directory entry at offset ${offset + windowStart} overruns the directory`,
      );
    }

    // ZIP64: each saturated field is replaced, in this order, by a 64-bit
    // value from the extended-information extra field.
    if (
      uncompressedSize === U32_SATURATED
      || compressedSize === U32_SATURATED
      || localHeaderOffset === U32_SATURATED
    ) {
      let field = extraStart;
      const extraEnd = extraStart + extraFieldLength;
      let found = false;
      while (field + 4 <= extraEnd) {
        const id = view.getUint16(field, true);
        const size = view.getUint16(field + 2, true);
        const body = field + 4;
        if (body + size > extraEnd) break;
        if (id === ZIP64_EXTRA_FIELD_ID) {
          let cursor = body;
          const take = (what: string): number => {
            if (cursor + 8 > body + size) {
              throw new Error(`ZIP64 extra field is missing the ${what}`);
            }
            const value = readSafeU64(view, cursor, what);
            cursor += 8;
            return value;
          };
          if (uncompressedSize === U32_SATURATED) uncompressedSize = take("uncompressed size");
          if (compressedSize === U32_SATURATED) compressedSize = take("compressed size");
          if (localHeaderOffset === U32_SATURATED) localHeaderOffset = take("local header offset");
          found = true;
          break;
        }
        field = body + size;
      }
      if (!found) {
        throw new Error(
          `ZIP entry at offset ${offset + windowStart} needs a ZIP64 extra field`,
        );
      }
    }
    if (
      localHeaderOffset + LOCAL_HEADER_FIXED_SIZE > location.cdOffset
      || compressedSize > location.cdOffset - localHeaderOffset
    ) {
      throw new Error(
        `ZIP entry at offset ${offset + windowStart} points outside the archive's data`,
      );
    }

    // Copy the member name so a parsed entry does not retain the entire ZIP
    // backing buffer merely to expose its original bytes.
    const fileNameBytes = new Uint8Array(window.subarray(nameStart, extraStart));
    let fileName: string;
    try {
      fileName = decoder.decode(fileNameBytes);
    } catch {
      throw new Error(
        `Invalid UTF-8 in ZIP member name at central directory offset ${offset + windowStart}`,
      );
    }
    if (
      options.names !== "display"
      && !bytesEqual(fileNameBytes, textEncoder.encode(fileName))
    ) {
      throw new Error(
        `ZIP member name at central directory offset ${offset + windowStart} cannot be preserved byte-for-byte`,
      );
    }

    const creatorOS = versionMadeBy >> 8;

    // Extract Unix permissions from external attributes
    let mode: number;
    if (creatorOS === CREATOR_UNIX) {
      const unixMode = (externalAttrs >> 16) & 0xffff;
      mode = unixMode;
    } else {
      // Default permissions when Unix mode is absent
      if (
        fileName.startsWith("bin/") ||
        fileName.startsWith("sbin/") ||
        fileName.includes("/bin/") ||
        fileName.includes("/sbin/")
      ) {
        mode = 0o755;
      } else {
        mode = 0o644;
      }
    }

    const isDirectory = fileName.endsWith("/");
    const isSymlink = creatorOS === CREATOR_UNIX && (mode & S_IFMT) === S_IFLNK;

    entries.push({
      fileName,
      fileNameBytes,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      localHeaderOffset,
      mode,
      isDirectory,
      isSymlink,
      externalAttrs,
      creatorOS,
      encrypted: (flags & GENERAL_PURPOSE_ENCRYPTED) !== 0,
    });

    offset = next;
  }

  return entries;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Extract and decompress a single file from zip bytes given its central
 * directory entry. Supports store (method 0) and deflate (method 8).
 */
export function extractZipEntry(data: Uint8Array, entry: ZipEntry): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Read local file header to get actual variable-length field sizes
  const localOffset = entry.localHeaderOffset;
  if (view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(
      `Invalid local file header signature at offset ${localOffset}`,
    );
  }

  const localFileNameLength = view.getUint16(localOffset + 26, true);
  const localExtraLength = view.getUint16(localOffset + 28, true);

  const dataStart =
    localOffset + LOCAL_HEADER_FIXED_SIZE + localFileNameLength + localExtraLength;
  const compressedData = data.subarray(
    dataStart,
    dataStart + entry.compressedSize,
  );

  if (entry.compressionMethod === COMPRESSION_STORE) {
    // Stored — no compression, return raw bytes
    return new Uint8Array(compressedData);
  } else if (entry.compressionMethod === COMPRESSION_DEFLATE) {
    // Deflate — decompress using fflate
    return inflateSync(compressedData);
  } else {
    throw new Error(
      `Unsupported compression method: ${entry.compressionMethod}`,
    );
  }
}

/**
 * Extract one ZIP member into an exact caller-declared bound.
 *
 * Deferred-tree descriptors are untrusted and must not let a forged central
 * directory turn a small inventory size into an unbounded DEFLATE allocation.
 * The streaming inflater rejects output beyond `expectedSize` and also rejects
 * a short stream. Existing legacy callers retain extractZipEntry().
 */
export function extractZipEntryBounded(
  data: Uint8Array,
  entry: ZipEntry,
  expectedSize: number,
): Uint8Array {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new Error("Invalid bounded ZIP member size");
  }
  if (entry.uncompressedSize !== expectedSize) {
    throw new Error(
      `ZIP member ${entry.fileName} declares ${entry.uncompressedSize} bytes, ` +
        `expected ${expectedSize}`,
    );
  }
  const compressedData = zipCompressedData(data, entry);
  if (entry.compressionMethod === COMPRESSION_STORE) {
    if (compressedData.byteLength !== expectedSize) {
      throw new Error(`Stored ZIP member ${entry.fileName} has an invalid size`);
    }
    return new Uint8Array(compressedData);
  }
  if (entry.compressionMethod !== COMPRESSION_DEFLATE) {
    throw new Error(`Unsupported compression method: ${entry.compressionMethod}`);
  }

  const output = new Uint8Array(expectedSize);
  let total = 0;
  const inflater = new Inflate((chunk) => {
    if (chunk.byteLength > expectedSize - total) {
      throw new Error(
        `ZIP member ${entry.fileName} expands beyond ${expectedSize} bytes`,
      );
    }
    output.set(chunk, total);
    total += chunk.byteLength;
  });
  inflater.push(compressedData, true);
  if (total !== expectedSize) {
    throw new Error(
      `ZIP member ${entry.fileName} expanded ${total} bytes, expected ${expectedSize}`,
    );
  }
  return output;
}

function zipCompressedData(data: Uint8Array, entry: ZipEntry): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const localOffset = entry.localHeaderOffset;
  if (
    localOffset < 0 ||
    localOffset > data.byteLength - LOCAL_HEADER_FIXED_SIZE ||
    view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER_SIGNATURE
  ) {
    throw new Error(
      `Invalid local file header signature at offset ${localOffset}`,
    );
  }
  const localMethod = view.getUint16(localOffset + 8, true);
  const localFileNameLength = view.getUint16(localOffset + 26, true);
  const localExtraLength = view.getUint16(localOffset + 28, true);
  const nameStart = localOffset + LOCAL_HEADER_FIXED_SIZE;
  const dataStart = nameStart + localFileNameLength + localExtraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (
    localMethod !== entry.compressionMethod ||
    dataStart < nameStart ||
    dataEnd < dataStart ||
    dataEnd > data.byteLength ||
    !bytesEqual(
      data.subarray(nameStart, nameStart + localFileNameLength),
      entry.fileNameBytes,
    )
  ) {
    throw new Error(`ZIP member ${entry.fileName} has inconsistent local metadata`);
  }
  return data.subarray(dataStart, dataEnd);
}

export interface RemoteZipOptions {
  /** Defaults to the global `fetch`. Pass a proxy-aware fetch to relay. */
  fetch?: ByteRangeFetch;
  parse?: ZipParseOptions;
  /**
   * The largest directory (central directory plus end records) to read.
   * Defaults to 64 MiB.
   */
  maxDirectoryBytes?: number;
  /**
   * The largest archive to download whole when a server or relay ignores
   * Range and answers with the complete entity. Defaults to no limit; a
   * caller browsing third-party archives should set one.
   */
  maxWholeArchiveBytes?: number;
  signal?: AbortSignal;
}

export interface RemoteZipDirectory {
  entries: ZipEntry[];
  totalSize: number;
  /** Strong ETag of the archive the directory was read from, if it had one. */
  entityTag?: string;
  /**
   * The whole archive, when a server answered with it instead of a range.
   * Members are then extracted from these bytes rather than fetched again.
   */
  wholeArchive?: Uint8Array;
}

const DEFAULT_MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
// Enough to hold a maximal comment, the end record, the ZIP64 locator and a
// minimal ZIP64 end record in one read.
const TAIL_READ_BYTES = EOCD_MAX_SEARCH + EOCD64_LOCATOR_SIZE + EOCD64_MIN_SIZE;

/**
 * Read a remote archive's directory with HTTP range requests.
 *
 * 1. A suffix range reads the tail, which holds the end record (and the
 *    ZIP64 records when present) and reveals the archive's length. No HEAD
 *    request is needed, which matters for relays that do not answer HEAD.
 * 2. If the directory starts before the tail, one more range reads it.
 * 3. If a server or relay answers a range with the complete entity (200),
 *    that body is the archive from offset 0: it is parsed as the whole
 *    archive, never as the requested tail, and it is refused beyond
 *    `maxWholeArchiveBytes`.
 *
 * The reads are separate requests, so the archive could change between
 * them. With a strong ETag each later answer must carry the same one, or the
 * read fails instead of mixing two versions; without one, only a change of
 * length is caught. (If-Range would do this in one request, but the browser
 * CORS proxy cannot carry it.)
 */
export async function fetchZipCentralDirectory(
  url: string,
  options: RemoteZipOptions = {},
): Promise<RemoteZipDirectory> {
  const maxDirectoryBytes = options.maxDirectoryBytes ?? DEFAULT_MAX_DIRECTORY_BYTES;
  const tail = await fetchByteRange(
    url,
    { suffixLength: TAIL_READ_BYTES },
    { fetch: options.fetch, signal: options.signal },
  );
  if (tail.kind === "whole-entity") {
    return parseWholeArchive(tail.response, options);
  }
  if (tail.kind === "failed") {
    throw new Error(`ZIP tail read failed: ${tail.reason}`);
  }
  const totalSize = tail.completeLength;
  if (totalSize === undefined) {
    throw new Error("ZIP tail read did not report the archive's length");
  }
  const etag = tail.response.headers.get("etag");
  const entityTag = etag !== null && isStrongEntityTag(etag) ? etag : undefined;
  const tailData = await tail.bytes();
  const tailStart = totalSize - tailData.byteLength;

  const readRange = async (start: number, endExclusive: number, what: string) => {
    const read = await fetchByteRange(
      url,
      { start, end: endExclusive - 1 },
      { fetch: options.fetch, signal: options.signal, entityTag },
    );
    if (read.kind !== "partial") {
      throw new Error(
        `ZIP ${what} read failed: ${
          read.kind === "failed" ? read.reason : "the server ignored the range"
        }`,
      );
    }
    assertSameArchiveLength(read.completeLength, totalSize);
    return read.bytes();
  };

  let window = tailData;
  let windowStart = tailStart;
  const eocdOffset = tailStart + findEOCD(tailData);
  let location = locateCentralDirectory(window, windowStart, totalSize, eocdOffset);
  if (location.eocd64Offset !== undefined && location.eocd64Offset < windowStart) {
    // A long archive comment pushed the ZIP64 end record out of the tail.
    if (tailStart - location.eocd64Offset > maxDirectoryBytes) {
      throw new Error("ZIP64 end record lies too far before the end of the archive");
    }
    const record = await readRange(location.eocd64Offset, tailStart, "ZIP64 end record");
    window = concatBytes(record, window);
    windowStart = location.eocd64Offset;
    location = locateCentralDirectory(window, windowStart, totalSize, eocdOffset);
  }
  if (totalSize - location.cdOffset > maxDirectoryBytes) {
    throw new Error(
      `ZIP directory is ${totalSize - location.cdOffset} bytes; at most ` +
        `${maxDirectoryBytes} are read`,
    );
  }
  if (location.cdOffset < windowStart) {
    const directory = await readRange(location.cdOffset, windowStart, "central directory");
    window = concatBytes(directory, window);
    windowStart = location.cdOffset;
  }
  return {
    entries: parseDirectoryWindow(window, windowStart, totalSize, options.parse ?? {}),
    totalSize,
    ...(entityTag === undefined ? {} : { entityTag }),
  };
}

/**
 * Fetch and extract one member of a remote archive with one range request:
 * the local header, a local extra field of up to 64 KiB, and the data. The
 * member is inflated into exactly its declared size, which must not exceed
 * `maxBytes`.
 */
export async function fetchZipMember(
  url: string,
  directory: RemoteZipDirectory,
  entry: ZipEntry,
  options: RemoteZipOptions & { maxBytes: number },
): Promise<Uint8Array> {
  assertExtractable(entry, options.maxBytes);
  if (directory.wholeArchive) {
    return extractZipEntryBounded(directory.wholeArchive, entry, entry.uncompressedSize);
  }
  const start = entry.localHeaderOffset;
  const endExclusive = Math.min(
    directory.totalSize,
    start + LOCAL_HEADER_FIXED_SIZE + entry.fileNameBytes.byteLength
      + MAX_LOCAL_EXTRA_BYTES + entry.compressedSize,
  );
  const read = await fetchByteRange(
    url,
    { start, end: endExclusive - 1 },
    {
      fetch: options.fetch,
      signal: options.signal,
      ...(directory.entityTag === undefined ? {} : { entityTag: directory.entityTag }),
    },
  );
  if (read.kind !== "partial") {
    throw new Error(
      `ZIP member ${entry.fileName} read failed: ${
        read.kind === "failed" ? read.reason : "the server ignored the range"
      }`,
    );
  }
  assertSameArchiveLength(read.completeLength, directory.totalSize);
  const chunk = await read.bytes();
  // The chunk starts at the member's local header.
  return extractZipEntryBounded(
    chunk,
    { ...entry, localHeaderOffset: 0 },
    entry.uncompressedSize,
  );
}

function assertExtractable(entry: ZipEntry, maxBytes: number): void {
  if (entry.isDirectory) throw new Error(`${entry.fileName} is a directory`);
  if (entry.encrypted) {
    throw new Error(`${entry.fileName} is encrypted and cannot be extracted`);
  }
  if (
    entry.compressionMethod !== COMPRESSION_STORE
    && entry.compressionMethod !== COMPRESSION_DEFLATE
  ) {
    throw new Error(
      `${entry.fileName} uses compression method ${entry.compressionMethod}, which is not supported`,
    );
  }
  if (entry.uncompressedSize > maxBytes) {
    throw new Error(
      `${entry.fileName} is ${entry.uncompressedSize} bytes; at most ${maxBytes} are accepted`,
    );
  }
}

async function parseWholeArchive(
  response: Response,
  options: RemoteZipOptions,
): Promise<RemoteZipDirectory> {
  const data = await readBoundedBody(response, options.maxWholeArchiveBytes);
  return {
    entries: parseZipCentralDirectory(data, options.parse),
    totalSize: data.byteLength,
    wholeArchive: data,
  };
}

async function readBoundedBody(
  response: Response,
  maxBytes: number | undefined,
): Promise<Uint8Array> {
  if (maxBytes === undefined) return new Uint8Array(await response.arrayBuffer());
  const declared = Number(response.headers.get("content-length") ?? NaN);
  const refuse = () => {
    throw new Error(
      `the server sent the whole archive instead of a range, and it is larger ` +
        `than the ${maxBytes} bytes that are downloaded whole`,
    );
  };
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    refuse();
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      refuse();
    }
    chunks.push(value);
  }
  return concatBytes(...chunks);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function assertSameArchiveLength(
  completeLength: number | undefined,
  contentLength: number,
): void {
  if (completeLength !== undefined && completeLength !== contentLength) {
    throw new Error(
      `ZIP archive length changed from ${contentLength} to ${completeLength} between requests`,
    );
  }
}
