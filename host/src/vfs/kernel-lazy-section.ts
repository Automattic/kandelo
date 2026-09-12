/**
 * The VFS image's kernel-facing lazy-linkage section ("KLZY").
 *
 * A VFS image's trailing sections are JSON because JSON is the right shape for
 * what they mostly carry: fetch URLs and transport mirrors, integrity digests,
 * activation modes, atomic-group seals, and per-builder image metadata. All of
 * that is HOST authority — it decides which bytes the host may hand over — and
 * the kernel is downstream of that decision.
 *
 * Exactly two facts in those sections are kernel-relevant: a lazy file's real
 * size, and an archive member's `(archive_id, source_path, size)`. The kernel
 * used to get both from the RTFS manifest the host built by walking the
 * restored filesystem. `KLZY` puts the same kernel-needed subset in the image
 * itself, so an image's lazy linkage is readable without a JSON parser and
 * without a host-side tree walk first — which is what let the boot cutover
 * remove the walk entirely.
 *
 * The layout is documented once, authoritatively, next to its structural
 * constants in `crates/shared/src/lib.rs` (`VFS_IMAGE_KERNEL_LAZY_*`); the
 * in-kernel decoder is `crates/runtime-core/src/klzy.rs` and the committed
 * cross-language fixture `crates/runtime-core/src/testdata/klzy-v1.bin` is
 * emitted by THIS encoder (see `host/scripts/gen-klzy-fixture.mts`).
 *
 * `archive_id` is assigned here, by the image writer, rather than minted at
 * boot by `buildRootfsLazyWiring`. That makes "the kernel's archive table and
 * the host's fetch table cannot drift" a structural property of the image
 * instead of a procedural property of one boot path — which is why the id
 * assignment lives in `reduceLazyArchiveGroups` below and both readers use it.
 */

import type {
  LazyFileEntry,
  SerializedLazyArchiveEntry,
} from "./memory-fs";

/** "KLZY" — mirrors `abi::VFS_IMAGE_KERNEL_LAZY_MAGIC`. */
export const KERNEL_LAZY_MAGIC = new Uint8Array([0x4b, 0x4c, 0x5a, 0x59]);
export const KERNEL_LAZY_VERSION = 1;
export const KERNEL_LAZY_HEADER_SIZE = 20;
export const KERNEL_LAZY_GROUP_HEADER_SIZE = 24;
export const KERNEL_LAZY_FILE_HEADER_SIZE = 24;
/** Announces the section in the image header's flags word (bits 0-3 are the
 * pre-existing lazy/archive/metadata/typed-archive flags). */
export const VFS_IMAGE_FLAG_HAS_KERNEL_LAZY = 1 << 4;
/** Framing ceiling, matching the JSON sections' own 16 MiB caps. The largest
 * shipped image encodes 510 KiB here. */
export const VFS_IMAGE_MAX_KERNEL_LAZY_BYTES = 16 * 1024 * 1024;

/** One lazy archive the image declares. */
export interface KernelLazyArchive {
  /** Image-assigned, nonzero, strictly increasing across the section. */
  readonly archiveId: number;
  /** The archive's total raw byte length. */
  readonly archiveBytes: number;
  /** VFS prefix the members were mounted under. */
  readonly mountPrefix: string;
}

/** One deferred file: which inode it backs, its real size, and — for an
 * archive member — which archive and which member within it. */
export interface KernelLazyFile {
  readonly ino: number;
  readonly size: number;
  /** `0` for a URL-backed single lazy file. */
  readonly archiveId: number;
  /** Empty exactly when `archiveId === 0`. */
  readonly sourcePath: string;
}

export interface KernelLazyLinkage {
  readonly archives: KernelLazyArchive[];
  readonly files: KernelLazyFile[];
}

/** An archive group reduced to what a consumer of the image needs, keyed the
 * two different ways its two consumers key it. */
export interface ReducedLazyArchiveGroup {
  readonly archiveId: number;
  readonly archiveBytes: number;
  readonly mountPrefix: string;
  /** Fetch mirrors, in preference order. Host authority: never encoded. */
  readonly transports: string[];
  readonly members: ReducedLazyArchiveMember[];
}

export interface ReducedLazyArchiveMember {
  readonly vfsPath: string;
  readonly ino: number;
  readonly size: number;
  readonly sourcePath: string;
}

/**
 * Reduce serialized lazy-archive groups to the facts a reader of the image
 * needs, assigning each fetchable group its image-local `archiveId`.
 *
 * A group with no declared raw archive size, or with no transport at all, is
 * skipped entirely — no id, no members, no archive entry. That is a truthful
 * gap rather than a guess: without a size the fetched bytes cannot be
 * validated, and without a transport they cannot be fetched. Members that are
 * deleted, symlinks, non-file types, or missing a source path are likewise
 * skipped; none of them is a byte range in the archive.
 *
 * This is the single definition of both rules. `buildRootfsLazyWiring` and the
 * `KLZY` encoder each consume it, so the ids in an image and the ids in the
 * host's fetch table are the same ids by construction.
 */
export function reduceLazyArchiveGroups(
  entries: readonly SerializedLazyArchiveEntry[],
): ReducedLazyArchiveGroup[] {
  const reduced: ReducedLazyArchiveGroup[] = [];
  let nextArchiveId = 1;
  for (const group of entries) {
    const archiveBytes = group.content?.bytes ?? group.integrity?.bytes;
    if (archiveBytes === undefined) continue;

    const transports =
      group.content?.transports && group.content.transports.length > 0
        ? [...group.content.transports]
        : typeof group.url === "string" && group.url.length > 0
          ? [group.url]
          : undefined;
    if (transports === undefined) continue;

    const members: ReducedLazyArchiveMember[] = [];
    for (const member of group.entries) {
      if (member.deleted) continue;
      if (member.isSymlink) continue;
      if (member.type !== undefined && member.type !== "file") continue;
      if (!member.sourcePath) continue;
      members.push({
        vfsPath: member.vfsPath,
        ino: member.ino,
        size: member.size,
        sourcePath: member.sourcePath,
      });
    }

    reduced.push({
      archiveId: nextArchiveId++,
      archiveBytes,
      mountPrefix: group.mountPrefix,
      transports,
      members,
    });
  }
  return reduced;
}

class ByteWriter {
  #buf: Uint8Array;
  #len = 0;

  constructor(initialCapacity: number) {
    this.#buf = new Uint8Array(Math.max(initialCapacity, 64));
  }

  #ensure(extra: number): void {
    const need = this.#len + extra;
    if (need <= this.#buf.length) return;
    let capacity = this.#buf.length * 2;
    while (capacity < need) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.#buf.subarray(0, this.#len));
    this.#buf = grown;
  }

  u16(value: number): void {
    this.#ensure(2);
    new DataView(this.#buf.buffer, this.#buf.byteOffset).setUint16(
      this.#len,
      value,
      true,
    );
    this.#len += 2;
  }

  u32(value: number): void {
    this.#ensure(4);
    new DataView(this.#buf.buffer, this.#buf.byteOffset).setUint32(
      this.#len,
      value >>> 0,
      true,
    );
    this.#len += 4;
  }

  u64(value: bigint): void {
    this.#ensure(8);
    new DataView(this.#buf.buffer, this.#buf.byteOffset).setBigUint64(
      this.#len,
      value,
      true,
    );
    this.#len += 8;
  }

  bytes(value: Uint8Array): void {
    this.#ensure(value.length);
    this.#buf.set(value, this.#len);
    this.#len += value.length;
  }

  take(): Uint8Array {
    return this.#buf.subarray(0, this.#len);
  }
}

const encoder = new TextEncoder();

function checkUnsigned32(label: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`KLZY section: ${label} is not a u32: ${value}`);
  }
  return value;
}

function checkSize(label: string, value: number): bigint {
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new Error(`KLZY section: ${label} is not a byte length: ${value}`);
  }
  return BigInt(value);
}

function encodeName(label: string, value: string): Uint8Array {
  const bytes = encoder.encode(value);
  if (bytes.includes(0)) {
    throw new Error(`KLZY section: ${label} contains a NUL byte`);
  }
  if (bytes.length > 0xffff_ffff) {
    throw new Error(`KLZY section: ${label} is too long`);
  }
  return bytes;
}

/**
 * Encode the kernel-facing lazy linkage of one image.
 *
 * `lazyFiles` are the URL-backed single lazy files (`archiveId 0`); `archives`
 * are the serialized archive groups, reduced through
 * `reduceLazyArchiveGroups`. Both are the exact arrays the image's JSON
 * sections carry, so the section describes the same image state the host would
 * reconstruct by reloading it.
 *
 * A duplicated inode is a hard error, not a last-writer-wins merge: the kernel
 * keys deferred backing by inode, and two records for one inode would mean the
 * image cannot say which size a `stat` should report.
 */
export function encodeKernelLazySection(
  lazyFiles: readonly LazyFileEntry[],
  archives: readonly SerializedLazyArchiveEntry[],
): Uint8Array {
  const groups = reduceLazyArchiveGroups(archives);
  const fileCount =
    lazyFiles.length + groups.reduce((n, g) => n + g.members.length, 0);

  const w = new ByteWriter(
    KERNEL_LAZY_HEADER_SIZE + fileCount * (KERNEL_LAZY_FILE_HEADER_SIZE + 48),
  );
  w.bytes(KERNEL_LAZY_MAGIC);
  w.u16(KERNEL_LAZY_VERSION);
  w.u16(KERNEL_LAZY_HEADER_SIZE);
  w.u32(groups.length);
  w.u32(fileCount);
  w.u32(0); // reserved

  for (const group of groups) {
    const mountPrefix = encodeName("mount prefix", group.mountPrefix);
    w.u32(KERNEL_LAZY_GROUP_HEADER_SIZE + mountPrefix.length);
    w.u32(checkUnsigned32("archive id", group.archiveId));
    w.u64(checkSize("archive byte length", group.archiveBytes));
    w.u16(0); // flags
    w.u16(0); // reserved
    w.u32(mountPrefix.length);
    w.bytes(mountPrefix);
  }

  const seen = new Set<number>();
  const emitFile = (
    ino: number,
    size: number,
    archiveId: number,
    sourcePath: string,
    what: string,
  ): void => {
    checkUnsigned32("inode number", ino);
    if (ino === 0) {
      throw new Error(`KLZY section: ${what} has inode 0`);
    }
    if (seen.has(ino)) {
      throw new Error(
        `KLZY section: inode ${ino} has more than one deferred backing (${what})`,
      );
    }
    seen.add(ino);
    const path = encodeName("source path", sourcePath);
    w.u32(KERNEL_LAZY_FILE_HEADER_SIZE + path.length);
    w.u32(ino);
    w.u64(checkSize("file size", size));
    w.u32(checkUnsigned32("archive id", archiveId));
    w.u32(path.length);
    w.bytes(path);
  };

  for (const entry of lazyFiles) {
    emitFile(entry.ino, entry.size, 0, "", `lazy file ${entry.path}`);
  }
  for (const group of groups) {
    for (const member of group.members) {
      emitFile(
        member.ino,
        member.size,
        group.archiveId,
        member.sourcePath,
        `archive member ${member.vfsPath}`,
      );
    }
  }

  const section = w.take();
  if (section.byteLength > VFS_IMAGE_MAX_KERNEL_LAZY_BYTES) {
    throw new Error(
      `VFS image kernel lazy linkage exceeds ${VFS_IMAGE_MAX_KERNEL_LAZY_BYTES} bytes`,
    );
  }
  return section;
}

/**
 * Decode a `KLZY` section. Mirrors `decode_kernel_lazy_linkage` in
 * `crates/runtime-core/src/klzy.rs`, including which violations are rejected;
 * every framing or consistency failure throws.
 */
export function decodeKernelLazySection(bytes: Uint8Array): KernelLazyLinkage {
  const fail = (why: string): never => {
    throw new Error(`KLZY section: ${why}`);
  };
  if (bytes.byteLength < KERNEL_LAZY_HEADER_SIZE) fail("truncated header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== KERNEL_LAZY_MAGIC[i]) fail("invalid magic");
  }
  if (view.getUint16(4, true) !== KERNEL_LAZY_VERSION) fail("unsupported version");
  if (view.getUint16(6, true) !== KERNEL_LAZY_HEADER_SIZE) fail("unsupported header size");
  const groupCount = view.getUint32(8, true);
  const fileCount = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0) fail("reserved header field is nonzero");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const readName = (offset: number, length: number, label: string): string => {
    if (offset + length > bytes.byteLength) fail(`${label} truncated`);
    const slice = bytes.subarray(offset, offset + length);
    if (slice.includes(0)) fail(`${label} contains a NUL byte`);
    try {
      return decoder.decode(slice);
    } catch {
      return fail(`${label} is not valid UTF-8`);
    }
  };

  let offset = KERNEL_LAZY_HEADER_SIZE;
  const archives: KernelLazyArchive[] = [];
  const archiveIds = new Set<number>();
  let previousArchiveId = 0;
  for (let i = 0; i < groupCount; i++) {
    if (offset + KERNEL_LAZY_GROUP_HEADER_SIZE > bytes.byteLength) {
      fail("group record header truncated");
    }
    const recordSize = view.getUint32(offset, true);
    const archiveId = view.getUint32(offset + 4, true);
    const archiveBytes = view.getBigUint64(offset + 8, true);
    const flags = view.getUint16(offset + 16, true);
    const reserved = view.getUint16(offset + 18, true);
    const mountPrefixLen = view.getUint32(offset + 20, true);
    if (recordSize !== KERNEL_LAZY_GROUP_HEADER_SIZE + mountPrefixLen) {
      fail("inconsistent group record size");
    }
    if (offset + recordSize > bytes.byteLength) fail("group record truncated");
    if (flags !== 0) fail("unknown group flag");
    if (reserved !== 0) fail("reserved group field is nonzero");
    if (archiveId === 0 || archiveId <= previousArchiveId) {
      fail("zero, duplicated, or unordered archive id");
    }
    previousArchiveId = archiveId;
    archiveIds.add(archiveId);
    archives.push({
      archiveId,
      archiveBytes: Number(archiveBytes),
      mountPrefix: readName(
        offset + KERNEL_LAZY_GROUP_HEADER_SIZE,
        mountPrefixLen,
        "mount prefix",
      ),
    });
    offset += recordSize;
  }

  const files: KernelLazyFile[] = [];
  const inodes = new Set<number>();
  for (let i = 0; i < fileCount; i++) {
    if (offset + KERNEL_LAZY_FILE_HEADER_SIZE > bytes.byteLength) {
      fail("file record header truncated");
    }
    const recordSize = view.getUint32(offset, true);
    const ino = view.getUint32(offset + 4, true);
    const size = view.getBigUint64(offset + 8, true);
    const archiveId = view.getUint32(offset + 16, true);
    const sourcePathLen = view.getUint32(offset + 20, true);
    if (recordSize !== KERNEL_LAZY_FILE_HEADER_SIZE + sourcePathLen) {
      fail("inconsistent file record size");
    }
    if (offset + recordSize > bytes.byteLength) fail("file record truncated");
    if (ino === 0) fail("file record has inode 0");
    if (inodes.has(ino)) fail(`inode ${ino} appears twice`);
    inodes.add(ino);
    if (archiveId === 0) {
      if (sourcePathLen !== 0) fail("source path without an archive");
    } else {
      if (!archiveIds.has(archiveId)) fail(`undeclared archive id ${archiveId}`);
      if (sourcePathLen === 0) fail("archive member without a source path");
    }
    files.push({
      ino,
      size: Number(size),
      archiveId,
      sourcePath: readName(
        offset + KERNEL_LAZY_FILE_HEADER_SIZE,
        sourcePathLen,
        "source path",
      ),
    });
    offset += recordSize;
  }

  if (offset !== bytes.byteLength) fail("trailing bytes");
  return { archives, files };
}
