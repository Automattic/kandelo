/**
 * A `RootfsOverlayBaseImage` backed by the Rust module instead of
 * `MemoryFileSystem`.
 *
 * # Where each half comes from, and why
 *
 * The deferred BYTES come from the module: it holds the image and serves any
 * offset, which is what `open`/`read`/`close` and the image window need.
 *
 * The lazy METADATA does not, and cannot. `KLZY` carries no fetch description
 * — whoever fetches decides whether a URL may be fetched — so a lazy file
 * loaded from an image has no URL on the module side at all. A parity test
 * established that the hard way by returning empty URLs for every entry. The
 * URLs and archive records live in the container's host-side JSON sections,
 * written there by the producer and parsed only by the host, which is the
 * courier contract working rather than a gap in the module.
 *
 * So this reads the container for metadata and the module for bytes, which is
 * exactly the split `MemoryFileSystem` performs today — with the 8,000-line
 * filesystem in between removed.
 */
import {
  archiveSectionBytes,
  lazySectionBytes,
  parseImageHeader,
  sectionOffsetAfterArchives,
} from "./vfs-image-transport";
import type {
  LazyFileEntry,
  SerializedLazyArchiveEntry,
} from "./memory-fs";
import type { RootfsOverlayBaseImage } from "./rootfs-lazy-archives";

/** The bytes half: whatever can serve POSIX-shaped reads and an image window. */
export interface ModuleImageSource {
  imageRead(offset: bigint, dest: Uint8Array): number;
}

function decodeSection(bytes: Uint8Array | null, label: string): unknown {
  if (bytes === null) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid UTF-8 JSON: ${detail}`);
  }
}

/**
 * Build the overlay's base image from a module and the container it loaded.
 *
 * `container` must be the same bytes the module was given. It is read for its
 * host-side JSON sections only; the filesystem itself is the module's.
 */
export function createModuleBaseImage(
  module: ModuleImageSource,
  container: Uint8Array,
): { baseImage: RootfsOverlayBaseImage; imageRead: (at: number, dest: Uint8Array) => number } {
  const parsed = parseImageHeader(container);
  const sections = sectionOffsetAfterArchives(
    parsed.image,
    parsed.view,
    parsed.flags,
    parsed.sabLen,
  );
  const lazy = decodeSection(
    lazySectionBytes(parsed, sections),
    "VFS image lazy metadata",
  );
  const archives = decodeSection(
    archiveSectionBytes(parsed, sections),
    "VFS image lazy archive metadata",
  );

  // No open/read/close. The overlay used to pull deferred bytes THROUGH this
  // object; it now fetches them itself, so what remains is the metadata the
  // image declared — which is the only part the module was ever authoritative
  // about anyway.
  const baseImage: RootfsOverlayBaseImage = {
    exportLazyEntries: () => (Array.isArray(lazy) ? lazy : []) as LazyFileEntry[],
    exportLazyArchiveEntries: () =>
      (Array.isArray(archives) ? archives : []) as SerializedLazyArchiveEntry[],
  };

  return {
    baseImage,
    // CONTAINER coordinates straight through: the module holds the container,
    // so unlike a body-holding backend it subtracts nothing.
    imageRead: (at, dest) => module.imageRead(BigInt(at), dest),
  };
}
