#!/usr/bin/env node

// Exit 0 only when a well-formed VFS image explicitly declares an ABI that
// differs from the expected ABI. Exit 1 for a matching or absent declaration,
// and 2 when the image cannot be inspected. Both an explicit mismatch and an
// uninspectable image are policy failures in the shell and TypeScript
// resolvers; only status 1 is accepted.

import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

const VFS_IMAGE_MAGIC = 0x56465349;
const VFS_IMAGE_VERSION = 1;
const VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES = 1 << 1;
const VFS_IMAGE_FLAG_HAS_METADATA = 1 << 2;
const VFS_IMAGE_HEADER_SIZE = 16;
const VFS_IMAGE_MAX_METADATA_BYTES = 64 * 1024;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function readU32(image, offset) {
  if (offset < 0 || image.byteLength < offset + 4) {
    throw new Error("VFS image is truncated");
  }
  return image.readUInt32LE(offset);
}

function validateMetadata(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("VFS image metadata must be an object");
  }
  if (value.version !== 1) {
    throw new Error("Unsupported VFS image metadata version");
  }
  if (
    value.kernelAbi !== undefined &&
    (!Number.isInteger(value.kernelAbi) || value.kernelAbi < 0)
  ) {
    throw new Error("Invalid VFS image metadata kernelAbi");
  }
  if (value.createdBy !== undefined && typeof value.createdBy !== "string") {
    throw new Error("Invalid VFS image metadata createdBy");
  }
  return value;
}

function readKernelAbi(path) {
  let image = readFileSync(path);
  if (image.subarray(0, ZSTD_MAGIC.byteLength).equals(ZSTD_MAGIC)) {
    image = zstdDecompressSync(image);
  }

  if (image.byteLength < VFS_IMAGE_HEADER_SIZE) {
    throw new Error("VFS image is too small");
  }
  if (readU32(image, 0) !== VFS_IMAGE_MAGIC) {
    throw new Error("Bad VFS image magic");
  }
  if (readU32(image, 4) !== VFS_IMAGE_VERSION) {
    throw new Error("Unsupported VFS image version");
  }

  const flags = readU32(image, 8);
  const sabLen = readU32(image, 12);
  const lazyOffset = VFS_IMAGE_HEADER_SIZE + sabLen;
  if (image.byteLength < lazyOffset + 4) {
    throw new Error("VFS image is truncated");
  }
  if (!(flags & VFS_IMAGE_FLAG_HAS_METADATA)) return undefined;

  const lazyLen = readU32(image, lazyOffset);
  const archiveOffset = lazyOffset + 4 + lazyLen;
  let metadataOffset = archiveOffset;
  if (flags & VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES) {
    const archiveLen = readU32(image, archiveOffset);
    metadataOffset = archiveOffset + 4 + archiveLen;
  }

  const metadataLen = readU32(image, metadataOffset);
  if (metadataLen > VFS_IMAGE_MAX_METADATA_BYTES) {
    throw new Error("VFS image metadata is too large");
  }
  if (metadataLen === 0) return undefined;
  if (image.byteLength < metadataOffset + 4 + metadataLen) {
    throw new Error("VFS image metadata is truncated");
  }

  const metadata = validateMetadata(
    JSON.parse(
      image.subarray(metadataOffset + 4, metadataOffset + 4 + metadataLen).toString("utf8"),
    ),
  );
  return metadata.kernelAbi;
}

let status = 2;
try {
  const [path, expectedRaw] = process.argv.slice(2);
  const expected = Number(expectedRaw);
  if (!path || !Number.isInteger(expected) || expected < 0) {
    throw new Error("usage: vfs-has-stale-abi.mjs <image> <expected-abi>");
  }
  const declared = readKernelAbi(path);
  status = declared === undefined || declared === expected ? 1 : 0;
} catch {
  status = 2;
}
process.exitCode = status;
