import { Gunzip } from "fflate";

const TAR_BLOCK_BYTES = 512;
const MODE_BITS = 0o7777;
const MEBIBYTE = 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});
const UTF8_ENCODER = new TextEncoder();
const CRC32_TABLE = createCrc32Table();

/** Default bounds for parsing an untrusted gzip-compressed TAR archive. */
export const DEFAULT_TAR_GZIP_LIMITS = Object.freeze({
  maxCompressedBytes: 256 * MEBIBYTE,
  maxUncompressedBytes: 512 * MEBIBYTE,
  maxEntries: 100_000,
  maxPathBytes: 4096,
  maxLinkBytes: 65_536,
});

export interface TarGzipLimits {
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxEntries: number;
  maxPathBytes: number;
  maxLinkBytes: number;
}

export interface ParseTarGzipOptions {
  /** Human-readable archive identity included in parse failures. */
  label?: string;
  /** Override individual defaults without disabling the remaining bounds. */
  limits?: Partial<TarGzipLimits>;
}

interface TarEntryBase {
  path: string;
  mode: number;
}

export interface TarFileEntry extends TarEntryBase {
  type: "file";
  data: Uint8Array;
}

export interface TarDirectoryEntry extends TarEntryBase {
  type: "directory";
}

export interface TarSymlinkEntry extends TarEntryBase {
  type: "symlink";
  linkName: string;
}

export interface TarHardlinkEntry extends TarEntryBase {
  type: "hardlink";
  /** Canonical, safe relative TAR member named by this hardlink. */
  linkName: string;
}

/** Closed set of filesystem entry kinds accepted from a TAR archive. */
export type TarEntry =
  | TarFileEntry
  | TarDirectoryEntry
  | TarSymlinkEntry
  | TarHardlinkEntry;

export class TarParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarParseError";
  }
}

/**
 * Parse a bounded gzip-compressed POSIX/PAX TAR archive.
 *
 * Expansion is streamed into bounded chunks, then checked against the gzip
 * trailer before a single TAR buffer is allocated. The returned regular-file
 * data are views into that bounded buffer, so callers should finish consuming
 * the entries before discarding the parse result.
 */
export function parseTarGzip(
  bytes: Uint8Array,
  options: ParseTarGzipOptions = {},
): TarEntry[] {
  const label = options.label ?? "TAR gzip archive";
  const limits = resolveLimits(options.limits, label);
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > limits.maxCompressedBytes
  ) {
    throw new TarParseError(
      `${label}: compressed byte count ${bytes.byteLength} is outside 1..` +
        `${limits.maxCompressedBytes}`,
    );
  }

  const declaredSize = gzipDeclaredSize(bytes, label);
  if (
    declaredSize === 0 ||
    declaredSize > limits.maxUncompressedBytes
  ) {
    throw new TarParseError(
      `${label}: declared uncompressed byte count ${declaredSize} is outside ` +
        `1..${limits.maxUncompressedBytes}`,
    );
  }

  const tarBytes = gunzipBounded(bytes, label, declaredSize);
  if (tarBytes.byteLength !== declaredSize) {
    throw new TarParseError(
      `${label}: gzip expanded to ${tarBytes.byteLength} bytes, expected ${declaredSize}`,
    );
  }
  const expectedCrc = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(bytes.byteLength - 8, true);
  const actualCrc = crc32(tarBytes);
  if (actualCrc !== expectedCrc) {
    throw new TarParseError(`${label}: gzip CRC32 mismatch`);
  }
  return parseTar(tarBytes, label, limits);
}

function parseTar(
  bytes: Uint8Array,
  label: string,
  limits: TarGzipLimits,
): TarEntry[] {
  if (bytes.byteLength % TAR_BLOCK_BYTES !== 0) {
    throw new TarParseError(`${label}: TAR byte count is not block-aligned`);
  }

  const entries: TarEntry[] = [];
  let offset = 0;
  let entryCount = 0;
  let extensionHeaderCount = 0;
  let localPax: Record<string, string> | null = null;
  let globalPax: Record<string, string> = {};
  let terminated = false;

  while (offset + TAR_BLOCK_BYTES <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK_BYTES);
    offset += TAR_BLOCK_BYTES;

    if (isZeroBlock(header)) {
      if (offset + TAR_BLOCK_BYTES > bytes.byteLength) {
        throw new TarParseError(`${label}: TAR end marker is truncated`);
      }
      const second = bytes.subarray(offset, offset + TAR_BLOCK_BYTES);
      if (!isZeroBlock(second)) {
        throw new TarParseError(`${label}: TAR has only one zero end block`);
      }
      offset += TAR_BLOCK_BYTES;
      if (!isZeroBlock(bytes.subarray(offset))) {
        throw new TarParseError(`${label}: TAR has nonzero data after its end marker`);
      }
      terminated = true;
      break;
    }

    validateTarChecksum(header, label);
    const typeflag = readStringField(header, 156, 1, label) || "0";
    const headerSize = readTarNumber(
      header,
      124,
      12,
      `${label}: TAR entry size`,
    );
    const mode =
      readTarNumber(header, 100, 8, `${label}: TAR entry mode`) & MODE_BITS;
    const rawName = tarPathFromHeader(header, label, limits.maxPathBytes);
    const rawLinkName = readStringField(header, 157, 100, label);

    if (typeflag === "x" || typeflag === "g") {
      extensionHeaderCount += 1;
      // A canonical PAX stream needs at most one local header per filesystem
      // entry plus one global header. Keep extension-only abuse bounded
      // without charging legitimate PAX metadata against maxEntries.
      if (extensionHeaderCount > limits.maxEntries + 1) {
        throw new TarParseError(
          `${label}: TAR extension header count exceeds ${limits.maxEntries + 1}`,
        );
      }
      const data = readTarPayload(bytes, offset, headerSize, label);
      offset = advancePastPayload(offset, headerSize, bytes.byteLength, label);
      const parsedPax = parsePaxRecords(data, label, limits);
      if (typeflag === "x") {
        localPax = parsedPax;
      } else {
        globalPax = { ...globalPax, ...parsedPax };
      }
      continue;
    }

    entryCount += 1;
    if (entryCount > limits.maxEntries) {
      throw new TarParseError(
        `${label}: TAR entry count exceeds ${limits.maxEntries}`,
      );
    }

    const pax = { ...globalPax, ...(localPax ?? {}) };
    localPax = null;
    const size = pax.size === undefined
      ? headerSize
      : readPaxSize(pax.size, `${label}: PAX entry size`);
    const data = readTarPayload(bytes, offset, size, label);
    offset = advancePastPayload(offset, size, bytes.byteLength, label);
    const path = normalizeTarEntryPath(
      pax.path ?? rawName,
      label,
      limits.maxPathBytes,
    );
    const linkName = pax.linkpath ?? rawLinkName;

    switch (typeflag) {
      case "0":
      case "\0":
        entries.push({ path, type: "file", mode, data });
        break;
      case "5":
        requireEmptyPayload(size, label, "directory", path);
        entries.push({ path, type: "directory", mode });
        break;
      case "2":
        requireEmptyPayload(size, label, "symlink", path);
        validateLinkName(linkName, label, path, limits.maxLinkBytes, false);
        entries.push({
          path,
          type: "symlink",
          mode,
          linkName,
        });
        break;
      case "1":
        requireEmptyPayload(size, label, "hardlink", path);
        validateLinkName(linkName, label, path, limits.maxLinkBytes, true);
        entries.push({
          path,
          type: "hardlink",
          mode,
          linkName: normalizeTarEntryPath(
            linkName,
            `${label}: hardlink target`,
            limits.maxPathBytes,
          ),
        });
        break;
      case "3":
      case "4":
      case "6":
        throw new TarParseError(
          `${label}: unsupported TAR device/FIFO entry ${path}`,
        );
      default:
        throw new TarParseError(
          `${label}: unsupported TAR entry type ${JSON.stringify(typeflag)} for ${path}`,
        );
    }
  }

  if (!terminated) {
    throw new TarParseError(`${label}: TAR is missing its two-block end marker`);
  }
  if (localPax !== null) {
    throw new TarParseError(`${label}: local PAX header has no following entry`);
  }
  return entries;
}

function resolveLimits(
  overrides: Partial<TarGzipLimits> | undefined,
  label: string,
): TarGzipLimits {
  const limits: TarGzipLimits = {
    ...DEFAULT_TAR_GZIP_LIMITS,
    ...overrides,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TarParseError(`${label}: ${name} must be a positive safe integer`);
    }
  }
  return limits;
}

function gzipDeclaredSize(bytes: Uint8Array, label: string): number {
  if (
    bytes.byteLength < 18 ||
    bytes[0] !== 0x1f ||
    bytes[1] !== 0x8b ||
    bytes[2] !== 8
  ) {
    throw new TarParseError(`${label}: invalid gzip header`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(bytes.byteLength - 4, true);
}

function gunzipBounded(
  bytes: Uint8Array,
  label: string,
  expectedSize: number,
): Uint8Array {
  const output = new Uint8Array(expectedSize);
  let total = 0;
  let sawAdditionalMember = false;
  const decoder = new Gunzip((chunk) => {
    if (chunk.byteLength > expectedSize - total) {
      throw new TarParseError(
        `${label}: gzip expansion exceeds its declared ${expectedSize} bytes`,
      );
    }
    output.set(chunk, total);
    total += chunk.byteLength;
  });
  decoder.onmember = () => {
    sawAdditionalMember = true;
    throw new TarParseError(`${label}: concatenated gzip members are unsupported`);
  };
  try {
    decoder.push(bytes, true);
  } catch (error) {
    if (error instanceof TarParseError) throw error;
    throw new TarParseError(
      `${label}: cannot gunzip archive: ${errorMessage(error)}`,
    );
  }
  if (sawAdditionalMember) {
    throw new TarParseError(`${label}: concatenated gzip members are unsupported`);
  }
  return output.subarray(0, total);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function createCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let value = 0; value < table.length; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb8_8320);
    }
    table[value] = crc >>> 0;
  }
  return table;
}

function readTarPayload(
  bytes: Uint8Array,
  offset: number,
  size: number,
  label: string,
): Uint8Array {
  if (size > bytes.byteLength - offset) {
    throw new TarParseError(`${label}: TAR entry is truncated`);
  }
  return bytes.subarray(offset, offset + size);
}

function advancePastPayload(
  offset: number,
  size: number,
  total: number,
  label: string,
): number {
  const blocks = Math.ceil(size / TAR_BLOCK_BYTES);
  const paddedBytes = blocks * TAR_BLOCK_BYTES;
  if (!Number.isSafeInteger(paddedBytes) || paddedBytes > total - offset) {
    throw new TarParseError(`${label}: TAR entry padding is truncated`);
  }
  return offset + paddedBytes;
}

function parsePaxRecords(
  data: Uint8Array,
  label: string,
  limits: TarGzipLimits,
): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < data.byteLength) {
    let space = offset;
    while (space < data.byteLength && data[space] !== 0x20) space += 1;
    if (space === offset || space === data.byteLength) {
      throw new TarParseError(`${label}: invalid PAX record length`);
    }
    let recordLength = 0;
    for (let index = offset; index < space; index += 1) {
      const digit = data[index] - 0x30;
      if (digit < 0 || digit > 9) {
        throw new TarParseError(`${label}: invalid PAX record length`);
      }
      recordLength = recordLength * 10 + digit;
      if (!Number.isSafeInteger(recordLength)) {
        throw new TarParseError(`${label}: invalid PAX record length`);
      }
    }
    const recordEnd = offset + recordLength;
    if (
      recordLength <= space - offset + 2 ||
      recordEnd > data.byteLength ||
      data[recordEnd - 1] !== 0x0a
    ) {
      throw new TarParseError(`${label}: truncated PAX record`);
    }
    let equals = space + 1;
    while (equals < recordEnd - 1 && data[equals] !== 0x3d) equals += 1;
    if (equals === space + 1 || equals >= recordEnd - 1) {
      throw new TarParseError(`${label}: invalid PAX record`);
    }
    const keyBytes = data.subarray(space + 1, equals);
    if (keyBytes.byteLength > 256) {
      throw new TarParseError(`${label}: PAX record key is too long`);
    }
    const key = decodeUtf8(
      keyBytes,
      `${label}: PAX record key`,
    );
    const valueBytes = data.subarray(equals + 1, recordEnd - 1);
    const maximum = key === "path"
      ? limits.maxPathBytes
      : key === "linkpath"
        ? limits.maxLinkBytes
        : key === "size"
          ? 32
          : 0;
    if (maximum === 0) {
      offset = recordEnd;
      continue;
    }
    if (valueBytes.byteLength > maximum) {
      throw new TarParseError(`${label}: PAX ${key} value is too long`);
    }
    const value = decodeUtf8(
      valueBytes,
      `${label}: PAX record value`,
    );
    out[key] = value;
    offset = recordEnd;
  }
  return out;
}

function readPaxSize(value: string, label: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TarParseError(`${label} is invalid`);
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TarParseError(`${label} is invalid`);
  }
  return size;
}

function validateTarChecksum(header: Uint8Array, label: string): void {
  const recorded = readTarNumber(
    header,
    148,
    8,
    `${label}: TAR checksum`,
  );
  let sum = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (recorded !== sum) {
    throw new TarParseError(`${label}: TAR checksum mismatch`);
  }
}

function tarPathFromHeader(
  header: Uint8Array,
  label: string,
  maxPathBytes: number,
): string {
  const name = readStringField(header, 0, 100, label);
  const prefix = readStringField(header, 345, 155, label);
  return normalizeTarEntryPath(
    prefix ? `${prefix}/${name}` : name,
    label,
    maxPathBytes,
  );
}

function normalizeTarEntryPath(
  path: string,
  label: string,
  maxPathBytes: number,
): string {
  let normalized = path;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+$/g, "");
  validateSafeRelativePath(normalized, `${label}: TAR path`, maxPathBytes);
  return normalized;
}

function readStringField(
  bytes: Uint8Array,
  offset: number,
  length: number,
  label: string,
): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && bytes[end] !== 0) end += 1;
  if (end === offset) return "";
  return decodeUtf8(
    bytes.subarray(offset, end),
    `${label}: TAR string field`,
  );
}

function readTarNumber(
  bytes: Uint8Array,
  offset: number,
  length: number,
  label: string,
): number {
  const first = bytes[offset];
  if ((first & 0x80) !== 0) {
    throw new TarParseError(`${label}: base-256 TAR numbers are not supported`);
  }
  const raw = readStringField(bytes, offset, length, label).trim();
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/.test(raw)) {
    throw new TarParseError(`${label}: invalid octal number`);
  }
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TarParseError(`${label}: invalid TAR number`);
  }
  return value;
}

function requireEmptyPayload(
  size: number,
  label: string,
  type: string,
  path: string,
): void {
  if (size !== 0) {
    throw new TarParseError(
      `${label}: ${type} ${path} has nonzero payload size ${size}`,
    );
  }
}

function validateLinkName(
  linkName: string,
  label: string,
  path: string,
  maxLinkBytes: number,
  requireSafePath: boolean,
): void {
  const bytes = UTF8_ENCODER.encode(linkName).byteLength;
  if (bytes === 0 || bytes > maxLinkBytes || linkName.includes("\0")) {
    throw new TarParseError(`${label}: link target for ${path} is invalid`);
  }
  if (requireSafePath && linkName.includes("\\")) {
    throw new TarParseError(`${label}: hardlink target for ${path} is invalid`);
  }
}

function validateSafeRelativePath(
  path: string,
  label: string,
  maxPathBytes: number,
): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.includes("\\") ||
    UTF8_ENCODER.encode(path).byteLength > maxPathBytes
  ) {
    throw new TarParseError(
      `${label} ${JSON.stringify(path)} must be a bounded relative POSIX path`,
    );
  }
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new TarParseError(
        `${label} ${JSON.stringify(path)} contains an unsafe path segment`,
      );
    }
  }
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new TarParseError(`${label} contains non-UTF-8 text`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
