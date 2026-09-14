/**
 * Getting a VFS image's bytes off the wire, before anything reads them.
 *
 * Shipped images are zstd-compressed (`.vfs.zst`), so every reader has to
 * answer the same two questions before it can parse anything: are these bytes
 * compressed, and can this frame be trusted to stop. Those answers belong to
 * the image's TRANSPORT rather than to any one reader, and they were reachable
 * from exactly one -- `memory-fs.ts`, the implementation this campaign is
 * deleting. A reader built on the Rust module met a compressed image as
 * `EINVAL`, because the module reads images and not archives.
 *
 * Nothing here knows what a VFS image contains. It decides whether bytes are
 * compressed, bounds what they may decompress to, and hands back bytes.
 *
 * # The bound is the point
 *
 * A zstd frame declares how much it expands to, and a hostile one can declare
 * very little and deliver gigabytes. `assertBoundedZstdFrames` walks every
 * frame and block header BEFORE decompressing and refuses anything whose
 * declared window, declared content size, or summed per-block maximum crosses
 * the caller's ceiling. A decompression bomb therefore fails as a bound
 * violation on a few kilobytes of header rather than as an allocation failure
 * somewhere with less context.
 */
import { decompress as zstdDecompress } from "fzstd";

import { VFS_IMAGE_MAX_KERNEL_LAZY_BYTES } from "./kernel-lazy-section";

// zstd frame magic (little-endian on the wire: 28 B5 2F FD).
// `maybeDecompressImage` auto-detects this and decompresses transparently so
// callers don't have to know whether the bytes came from a `.vfs` or a
// `.vfs.zst`.
const ZSTD_MAGIC_BYTES = [0x28, 0xb5, 0x2f, 0xfd];
const ZSTD_FRAME_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE_MAGIC_MIN = 0x184d2a50;
const ZSTD_SKIPPABLE_MAGIC_MAX = 0x184d2a5f;
const ZSTD_MAX_BLOCK_BYTES = 128 * 1024;

/** magic(4) + version(4) + flags(4) + sabLen(4). The floor a bound may name. */
export const VFS_IMAGE_HEADER_SIZE = 16;
export const VFS_IMAGE_MAX_METADATA_BYTES = 64 * 1024;
export const VFS_IMAGE_MAX_LAZY_METADATA_BYTES = 16 * 1024 * 1024;
export const VFS_IMAGE_MAX_LAZY_ARCHIVE_METADATA_BYTES = 16 * 1024 * 1024;
export const VFS_IMAGE_MAX_DECOMPRESSED_BYTES =
  1024 * 1024 * 1024
  + VFS_IMAGE_MAX_LAZY_METADATA_BYTES
  + VFS_IMAGE_MAX_LAZY_ARCHIVE_METADATA_BYTES
  + VFS_IMAGE_MAX_METADATA_BYTES
  + VFS_IMAGE_MAX_KERNEL_LAZY_BYTES
  + VFS_IMAGE_HEADER_SIZE
  + 16;

function decompressZstd(image: Uint8Array): Uint8Array {
  return zstdDecompress(image);
}

export function maybeDecompressImage(
  image: Uint8Array,
  maximum: number = VFS_IMAGE_MAX_DECOMPRESSED_BYTES,
): Uint8Array {
  if (maximum === undefined) maximum = VFS_IMAGE_MAX_DECOMPRESSED_BYTES;
  if (
    !Number.isSafeInteger(maximum) || maximum < VFS_IMAGE_HEADER_SIZE ||
    maximum > VFS_IMAGE_MAX_DECOMPRESSED_BYTES
  ) {
    throw new Error("VFS image decompressed byte bound is invalid");
  }
  if (
    image.byteLength >= ZSTD_MAGIC_BYTES.length &&
    image[0] === ZSTD_MAGIC_BYTES[0] &&
    image[1] === ZSTD_MAGIC_BYTES[1] &&
    image[2] === ZSTD_MAGIC_BYTES[2] &&
    image[3] === ZSTD_MAGIC_BYTES[3]
  ) {
    assertBoundedZstdFrames(image, maximum);
    const decompressed = decompressZstd(image);
    if (decompressed.byteLength > maximum) {
      throw new Error("zstd VFS image exceeds its decompressed byte bound");
    }
    return decompressed;
  }
  if (image.byteLength > maximum) {
    throw new Error("VFS image exceeds its decompressed byte bound");
  }
  return image;
}

function assertBoundedZstdFrames(image: Uint8Array, maximum: number): void {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  let offset = 0;
  let totalBound = 0;
  let frames = 0;
  const requireBytes = (count: number, label: string) => {
    if (count < 0 || offset + count > image.byteLength) {
      throw new Error(`zstd VFS image has a truncated ${label}`);
    }
  };
  const addBound = (count: number) => {
    totalBound += count;
    if (!Number.isSafeInteger(totalBound) || totalBound > maximum) {
      throw new Error("zstd VFS image exceeds its decompressed byte bound");
    }
  };
  const readLittleEndian = (count: number): bigint => {
    requireBytes(count, "frame header");
    let result = 0n;
    for (let index = 0; index < count; index++) {
      result |= BigInt(image[offset + index]!) << BigInt(index * 8);
    }
    offset += count;
    return result;
  };

  while (offset < image.byteLength) {
    requireBytes(4, "frame magic");
    const magic = view.getUint32(offset, true);
    offset += 4;
    if (magic >= ZSTD_SKIPPABLE_MAGIC_MIN && magic <= ZSTD_SKIPPABLE_MAGIC_MAX) {
      requireBytes(4, "skippable frame size");
      const bytes = view.getUint32(offset, true);
      offset += 4;
      requireBytes(bytes, "skippable frame");
      offset += bytes;
      continue;
    }
    if (magic !== ZSTD_FRAME_MAGIC) {
      throw new Error("zstd VFS image contains an invalid frame magic");
    }
    frames++;
    requireBytes(1, "frame descriptor");
    const descriptor = image[offset++]!;
    if ((descriptor & 0x08) !== 0) {
      throw new Error("zstd VFS image uses a reserved frame descriptor bit");
    }
    const singleSegment = (descriptor & 0x20) !== 0;
    const hasChecksum = (descriptor & 0x04) !== 0;
    const dictionaryBytes = [0, 1, 2, 4][descriptor & 0x03]!;
    const contentSizeFlag = descriptor >>> 6;
    let windowBytes: bigint | undefined;
    if (!singleSegment) {
      requireBytes(1, "window descriptor");
      const windowDescriptor = image[offset++]!;
      const exponent = 10 + (windowDescriptor >>> 3);
      const base = 1n << BigInt(exponent);
      windowBytes = base + (base >> 3n) * BigInt(windowDescriptor & 0x07);
    }
    requireBytes(dictionaryBytes, "dictionary identity");
    offset += dictionaryBytes;
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : contentSizeFlag === 1
      ? 2
      : contentSizeFlag === 2
      ? 4
      : 8;
    let contentBytes: bigint | undefined;
    if (contentSizeBytes > 0) {
      contentBytes = readLittleEndian(contentSizeBytes);
      if (contentSizeFlag === 1) contentBytes += 256n;
      if (singleSegment) windowBytes = contentBytes;
    }
    if (windowBytes !== undefined && windowBytes > BigInt(maximum)) {
      throw new Error("zstd VFS image exceeds its decompressed window bound");
    }
    if (contentBytes !== undefined && contentBytes > BigInt(maximum)) {
      throw new Error("zstd VFS image exceeds its decompressed byte bound");
    }

    let frameBound = 0;
    for (;;) {
      requireBytes(3, "block header");
      const header = image[offset]!
        | (image[offset + 1]! << 8)
        | (image[offset + 2]! << 16);
      offset += 3;
      const last = (header & 1) !== 0;
      const type = (header >>> 1) & 0x03;
      const blockBytes = header >>> 3;
      if (type === 3 || blockBytes > ZSTD_MAX_BLOCK_BYTES) {
        throw new Error("zstd VFS image contains an invalid block header");
      }
      frameBound += type === 2 ? ZSTD_MAX_BLOCK_BYTES : blockBytes;
      if (
        !Number.isSafeInteger(frameBound) ||
        (contentBytes === undefined && frameBound > maximum)
      ) {
        throw new Error("zstd VFS image exceeds its decompressed byte bound");
      }
      const encodedBytes = type === 1 ? 1 : blockBytes;
      requireBytes(encodedBytes, "block payload");
      offset += encodedBytes;
      if (last) break;
    }
    if (hasChecksum) {
      requireBytes(4, "content checksum");
      offset += 4;
    }
    if (contentBytes !== undefined && contentBytes > BigInt(frameBound)) {
      throw new Error("zstd VFS image frame content exceeds its block bound");
    }
    // A compressed block may expand to at most 128 KiB, so frameBound is the
    // only safe pre-decompression bound when the frame omits its content
    // size. When zstd carries the exact size, use that stronger declaration:
    // summing the per-block maximum can otherwise reject a valid frame whose
    // declared output remains below the caller-owned lifecycle ceiling.
    addBound(
      contentBytes === undefined ? frameBound : Number(contentBytes),
    );
  }
  if (frames === 0) {
    throw new Error("zstd VFS image contains no data frame");
  }
}

export const VFS_IMAGE_MAGIC = 0x56465349; // "VFSI"
export const VFS_IMAGE_VERSION = 1;
export const VFS_IMAGE_FLAG_HAS_LAZY = 1 << 0;
export const VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES = 1 << 1;
export const VFS_IMAGE_FLAG_HAS_METADATA = 1 << 2;
export const VFS_IMAGE_FLAG_HAS_TYPED_LAZY_ARCHIVES = 1 << 3;

export interface ParsedImageHeader {
  image: Uint8Array;
  view: DataView;
  flags: number;
  sabLen: number;
}

export function parseImageHeader(
  input: Uint8Array,
  maxDecompressedBytes?: number,
): ParsedImageHeader {
  const image = maybeDecompressImage(input, maxDecompressedBytes);

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

export function sectionOffsetAfterArchives(
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
