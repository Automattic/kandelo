/**
 * Zip central directory parser and entry extractor.
 *
 * Parses zip file metadata from the central directory without
 * decompressing the entire archive. Used by lazy archive registration
 * to index file entries from range-request-fetched bytes.
 */

import { inflateSync } from "fflate";

// --- Zip format signatures ---

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

// Maximum size to search backwards for EOCD (64KiB comment + 22 bytes header)
const EOCD_MAX_SEARCH = 65557;

// Fixed header sizes
const EOCD_MIN_SIZE = 22;
const CENTRAL_DIR_FIXED_SIZE = 46;
const LOCAL_HEADER_FIXED_SIZE = 30;

// Compression methods
const COMPRESSION_STORE = 0;
const COMPRESSION_DEFLATE = 8;

// Unix creator OS code
const CREATOR_UNIX = 3;

// Unix file type mask for symlinks
const S_IFLNK = 0xa000;
const S_IFMT = 0xf000;

export interface ZipEntry {
  fileName: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
  mode: number;
  isDirectory: boolean;
  isSymlink: boolean;
  externalAttrs: number;
  creatorOS: number;
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
export function parseZipCentralDirectory(data: Uint8Array): ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Find and parse EOCD
  const eocdOffset = findEOCD(data);
  const cdEntryCount = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const entries: ZipEntry[] = [];
  let offset = cdOffset;

  for (let i = 0; i < cdEntryCount; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error(
        `Invalid central directory entry signature at offset ${offset}`,
      );
    }

    const versionMadeBy = view.getUint16(offset + 4, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraFieldLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttrs = view.getUint32(offset + 38, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    const fileNameBytes = data.subarray(
      offset + CENTRAL_DIR_FIXED_SIZE,
      offset + CENTRAL_DIR_FIXED_SIZE + fileNameLength,
    );
    const fileName = new TextDecoder().decode(fileNameBytes);

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
      compressedSize,
      uncompressedSize,
      compressionMethod,
      localHeaderOffset,
      mode,
      isDirectory,
      isSymlink,
      externalAttrs,
      creatorOS,
    });

    // Advance to next central directory entry
    offset +=
      CENTRAL_DIR_FIXED_SIZE + fileNameLength + extraFieldLength + commentLength;
  }

  return entries;
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
 * Fetch the zip central directory from a URL using HTTP range requests.
 *
 * Strategy:
 * 1. HEAD request to get Content-Length and check range support
 * 2. Fetch the last ~64KiB to find the EOCD and determine CD location
 * 3. If the CD is fully within the tail, parse it directly
 * 4. Otherwise, fetch just the CD range
 * 5. Falls back to a full fetch if range requests are not supported
 */
export async function fetchZipCentralDirectory(
  url: string,
): Promise<{ entries: ZipEntry[]; totalSize: number }> {
  // Step 1: HEAD to determine size and range support
  const headResp = await fetch(url, { method: "HEAD" });
  if (!headResp.ok) {
    throw new Error(`HEAD request failed: ${headResp.status} ${headResp.statusText}`);
  }

  const contentLength = parseInt(headResp.headers.get("content-length") || "0", 10);
  const acceptRanges = headResp.headers.get("accept-ranges");

  if (!contentLength || acceptRanges !== "bytes") {
    // Fallback: full download
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);
    }
    const data = new Uint8Array(await resp.arrayBuffer());
    return { entries: parseZipCentralDirectory(data), totalSize: data.length };
  }

  // Step 2: Fetch tail to find EOCD
  const tailSize = Math.min(contentLength, EOCD_MAX_SEARCH);
  const tailStart = contentLength - tailSize;
  const tailResp = await fetch(url, {
    headers: { Range: `bytes=${tailStart}-${contentLength - 1}` },
  });
  if (tailResp.status !== 206) {
    // Range not actually supported, fall back to full fetch
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);
    }
    const data = new Uint8Array(await resp.arrayBuffer());
    return { entries: parseZipCentralDirectory(data), totalSize: data.length };
  }

  const tailData = new Uint8Array(await tailResp.arrayBuffer());
  const tailView = new DataView(
    tailData.buffer,
    tailData.byteOffset,
    tailData.byteLength,
  );

  // Find EOCD within the tail
  const eocdOffsetInTail = findEOCD(tailData);
  const cdSize = tailView.getUint32(eocdOffsetInTail + 12, true);
  const cdOffset = tailView.getUint32(eocdOffsetInTail + 16, true);

  // Step 3: Check if the CD is fully within the fetched tail
  if (cdOffset >= tailStart) {
    // The central directory is within our tail bytes
    // We need to reconstruct a buffer where the offsets align
    const fullSize = contentLength;
    const buf = new Uint8Array(fullSize);
    buf.set(tailData, tailStart);
    return { entries: parseZipCentralDirectory(buf), totalSize: fullSize };
  }

  // Step 4: Fetch just the central directory range
  const cdEnd = cdOffset + cdSize - 1;
  const cdResp = await fetch(url, {
    headers: { Range: `bytes=${cdOffset}-${cdEnd}` },
  });
  if (cdResp.status !== 206) {
    throw new Error(`Range request for CD failed: ${cdResp.status}`);
  }

  const cdData = new Uint8Array(await cdResp.arrayBuffer());

  // Build a buffer with CD data at the correct offset and EOCD at the end
  const fullSize = contentLength;
  const buf = new Uint8Array(fullSize);
  buf.set(cdData, cdOffset);
  buf.set(tailData, tailStart);
  return { entries: parseZipCentralDirectory(buf), totalSize: fullSize };
}
