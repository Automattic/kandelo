/**
 * Getting a VFS image's bytes off the wire, before anything reads them.
 *
 * Shipped images are zstd-compressed (`.vfs.zst`), so every reader has to
 * answer the same two questions before it can parse anything: are these bytes
 * compressed, and can this frame be trusted to stop. Those answers belong to
 * the image's TRANSPORT rather than to any one reader, and they were reachable
 * from exactly one -- `memory-fs.ts`, the implementation this campaign
 * deleted. A reader built on the Rust module met a compressed image as
 * `EINVAL`, because the module reads images and not archives.
 *
 * Nothing here knows what a VFS image contains. It decides whether bytes are
 * compressed, bounds what they may decompress to, and hands back bytes.
 *
 * # It used to know more, and that half is gone
 *
 * This module also carried a header parser, the container's magic, version and
 * section flags, and slicers for the two host-side JSON sections. Every one of
 * those had `memory-fs.ts` or `module-base-image.ts`'s section-reading branch
 * behind it, and both are deleted -- the census after them found ZERO callers,
 * in any language, for `parseImageHeader`, `sectionOffsetAfterArchives`,
 * `lazySectionBytes`, `archiveSectionBytes` and `assertSectionFlagsConsistent`.
 * The format's authority for those flags is
 * `crates/runtime-core/src/vfsi_container.rs`, which is where the reader that
 * still parses containers lives; the TypeScript constants were a second
 * spelling of them with nothing reading it.
 *
 * `VFS_IMAGE_FLAG_HAS_KERNEL_LAZY` survives alone because a test still needs to
 * NAME that bit: `rootfs-image-load.test.ts` clears it to build the stale image
 * whose loud refusal it asserts.
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
const VFS_IMAGE_MAX_METADATA_BYTES = 64 * 1024;
const VFS_IMAGE_MAX_LAZY_METADATA_BYTES = 16 * 1024 * 1024;
const VFS_IMAGE_MAX_LAZY_ARCHIVE_METADATA_BYTES = 16 * 1024 * 1024;
/** The bound on a `KLZY` section, kept because the decompression ceiling below
 *  is the sum of every section a container may declare. */
const VFS_IMAGE_MAX_KERNEL_LAZY_BYTES = 16 * 1024 * 1024;
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

/**
 * The container declares a kernel-facing lazy-linkage (`KLZY`) section.
 *
 * MOVED HERE 2026-09-17 from `kernel-lazy-section.ts`, which went with the
 * encoder and decoder that were its only reason to exist — the one writer that
 * emitted a `KLZY` section is deleted. The flag stays because containers that
 * declare one still exist on disk, and a reader must be able to say so: an
 * image the kernel refuses because it describes its deferred files NOWHERE is
 * a different artifact from one that describes them in a section this reader
 * no longer decodes.
 */
export const VFS_IMAGE_FLAG_HAS_KERNEL_LAZY = 1 << 4;
