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
import { resolveLazyUrl } from "./lazy-url";
import type { RootfsOverlayBaseImage } from "./rootfs-lazy-archives";

/** What `SffsImageFs.lazyEntries()` answers, named so this file need not import it. */
export interface ModuleLazyEntries {
  files: readonly {
    path: string;
    ino: bigint;
    size: number;
    archiveId: number;
    sourcePath: string;
    /** Where a standalone file's bytes are; empty for an archive member. */
    uri: string;
    digest: Uint8Array;
  }[];
  archives: readonly {
    archiveId: number;
    bytes: number;
    descriptor: Uint8Array;
    /** Where the archive is; the kernel relays it. */
    uri: string;
    /** What its bytes must hash to; 32 zero bytes when none was declared. */
    digest: Uint8Array;
  }[];
}

/** A 32-byte SHA-256 as hex: the image stores a value, the host speaks hex. */
function bytesToSha256Hex(digest: Uint8Array): string {
  let out = "";
  for (const byte of digest) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Take the descriptor half out of an archive's seal payload.
 *
 * The module wraps every archive payload as
 * `u32 version | u32 descriptor_len | descriptor | u8 has_seal | [seal]` —
 * `seal::encode` in `crates/sffs-module/src/seal.rs`. Reading it here is the
 * design rather than a duplication of it: the seal was deliberately split so
 * that *"the descriptor half stays whatever the producer writes ... and the
 * kernel still never parses it. The seal half is parsed by the VERIFIER, which
 * is consumer-side."* The host is that consumer. What this must never do is
 * re-derive the canonical cohort IDENTITY, which is the part a second
 * implementation could get subtly wrong; a length-prefixed slice has no such
 * freedom.
 */
function unwrapSealPayload(payload: Uint8Array, archiveId: number): Uint8Array {
  if (payload.byteLength < 8) {
    throw new Error(
      `VFS image lazy archive ${archiveId} has a payload too short to carry a descriptor.`,
    );
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const version = view.getUint32(0, true);
  if (version !== 1) {
    throw new Error(
      `VFS image lazy archive ${archiveId} declares payload version ${version}, `
        + "which this reader does not know.",
    );
  }
  const length = view.getUint32(4, true);
  // UNREACHABLE through the module's own writer, and kept deliberately. The
  // module wraps every payload in a well-formed envelope, so no producer
  // reachable from here can declare a length past the end — a perturbation
  // removing this check survives, and provably would, because `subarray`
  // CLAMPS rather than overruns. It stays because the clamp is the dangerous
  // behaviour: it would hand the seal bytes on as if they were descriptor.
  if (8 + length > payload.byteLength) {
    throw new Error(
      `VFS image lazy archive ${archiveId} declares a ${length}-byte descriptor `
        + `that does not fit in its ${payload.byteLength}-byte payload.`,
    );
  }
  return payload.subarray(8, 8 + length);
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
 * Build the overlay's base image from the container and a reader for its bytes.
 *
 * There is no filesystem here, and no module interface either. Metadata is
 * decoded from `container`'s own host-side JSON sections, and `imageRead`
 * answers container-offset reads however its owner likes: from the container
 * array itself via `imageReadFromContainer`, or through the wasm bridge's
 * `sm_image_read`, which is a one-line adapter because the coordinates already
 * agree.
 */
export function createBaseImageFromContainer(
  container: Uint8Array,
  imageRead: (at: number, dest: Uint8Array) => number,
  /**
   * The deployment's base path for relative lazy URLs, applied on the way OUT.
   *
   * Applying it here rather than mutating a stored record is what lets the
   * image stay one artifact: `lazyUrlBase` defaults to the site's `BASE_URL`,
   * so the same bytes are served from `/` in dev and from `/kandelo/` in an
   * assembled-site preview. Rewriting on read-out costs nothing and
   * invalidates nothing — V3 deliberately excludes transport locations from
   * descriptor identity, in its own words *"because image composition rewrites
   * mirrors after sealing"*, so no digest covers the string being changed.
   */
  lazyUrlBase?: string,
  /**
   * Where the lazy metadata lives when the container's JSON sections do not
   * carry it.
   *
   * **The two producers do not agree, and this is not a style difference.**
   * Measured: a `MemoryFileSystem`-built image records a deferred URL in the
   * host-side JSON sections and leaves the KLZY descriptor empty; an image
   * built through the module records it in the KLZY descriptor and writes no
   * JSON sections at all. Neither writes both.
   *
   * Today's production images are the first kind, so the sections are present
   * and this is unused. It exists because deleting `memory-fs.ts` makes every
   * image the second kind, and then reading only the sections would return an
   * empty list for an image full of deferred files — a load failure reported
   * as a successful load of nothing.
   */
  moduleLazyEntries?: () => ModuleLazyEntries,
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

  // Sections absent and a module to ask: the image was built through the
  // module, which kept the URLs the sections would have carried.
  const fromModule = lazy === null && archives === null && moduleLazyEntries !== undefined
    ? moduleLazyEntries()
    : undefined;

  // No open/read/close. The overlay used to pull deferred bytes THROUGH this
  // object; it now fetches them itself, so what remains is the metadata the
  // image declared — which is the only part the module was ever authoritative
  // about anyway.
  const rebaseUrl = (url: string): string =>
    lazyUrlBase === undefined ? url : resolveLazyUrl(lazyUrlBase, url);

  // An archive names its transports in declared order and its `url` is the
  // first of them; an entry with no `content` carries only the `url`. That is
  // the whole of what the incumbent's three-branch rewrite does to observable
  // state — the branches choose which in-memory record to touch, and a decoded
  // entry is one record.
  const rebaseArchive = (
    entry: SerializedLazyArchiveEntry,
  ): SerializedLazyArchiveEntry => {
    if (lazyUrlBase === undefined) return entry;
    if (entry.content === undefined) return { ...entry, url: rebaseUrl(entry.url) };
    const transports = entry.content.transports.map(rebaseUrl);
    return {
      ...entry,
      content: { ...entry.content, transports },
      url: transports[0] ?? entry.url,
    };
  };

  const baseImage: RootfsOverlayBaseImage = {
    exportLazyEntries: () => {
      if (fromModule !== undefined) {
        // `archiveId === 0` is the STANDALONE registration: no archive behind
        // it, so `uri` is the whole of what says where the bytes are.
        return fromModule.files
          .filter((file) => file.archiveId === 0)
          .map((file) => ({
            ino: Number(file.ino),
            generation: 1,
            dataSequence: 1,
            path: file.path,
            paths: [file.path],
            url: rebaseUrl(file.uri),
            size: file.size,
          })) as LazyFileEntry[];
      }
      return (Array.isArray(lazy) ? (lazy as LazyFileEntry[]) : []).map((entry) =>
        lazyUrlBase === undefined ? entry : { ...entry, url: rebaseUrl(entry.url) },
      );
    },
    exportLazyArchiveEntries: () => {
      if (fromModule !== undefined) {
        // Members are grouped by the archive they came from. `archiveId === 0`
        // is the standalone registration handled above, not a member.
        const membersByArchive = new Map<number, SerializedLazyArchiveEntry["entries"]>();
        for (const file of fromModule.files) {
          if (file.archiveId === 0) continue;
          const list = membersByArchive.get(file.archiveId) ?? [];
          list.push({
            vfsPath: file.path,
            ino: Number(file.ino),
            size: file.size,
            isSymlink: false,
            deleted: false,
            type: "file",
            sourcePath: file.sourcePath,
          });
          membersByArchive.set(file.archiveId, list);
        }
        return fromModule.archives.map((archive) => {
          // Read as FIELDS, not parsed back out of the descriptor: they were
          // in there only because the format had nowhere typed to put them, so
          // this reader had to open a blob the format says nobody opens — on
          // untrusted input, since an image can arrive from a shared link.
          if (archive.uri === "") {
            throw new Error(
              `VFS image lazy archive ${archive.archiveId} declares no address, `
                + "so there is nothing that says where its bytes come from.",
            );
          }
          // `mountPrefix` stays parsed: the kernel genuinely never reads it,
          // so it is the one field here that is the consumer's alone.
          const text = new TextDecoder().decode(unwrapSealPayload(archive.descriptor, archive.archiveId));
          let described: { mountPrefix?: unknown };
          try {
            described = JSON.parse(text) as typeof described;
          } catch {
            // Refused, not guessed. A descriptor this reader cannot parse is a
            // producer it does not know, and an archive built from a guess
            // activates wrongly rather than not at all.
            throw new Error(
              `VFS image lazy archive ${archive.archiveId} has a descriptor this `
                + "reader cannot parse, so its mount prefix is unknown.",
            );
          }
          if (typeof described.mountPrefix !== "string") {
            throw new Error(
              `VFS image lazy archive ${archive.archiveId} declares no mount `
                + "prefix, and the mount prefix is written into the kernel's "
                + "lazy manifest — it cannot be inferred from member paths.",
            );
          }
          return rebaseArchive({
            kind: "kandelo-legacy-zip-v1",
            url: archive.uri,
            mountPrefix: described.mountPrefix,
            materialized: false,
            integrity: archive.digest.length === 32 && archive.digest.some((b) => b !== 0)
              ? { sha256: bytesToSha256Hex(archive.digest), bytes: archive.bytes }
              : undefined,
            entries: membersByArchive.get(archive.archiveId) ?? [],
          } as SerializedLazyArchiveEntry);
        });
      }
      return (Array.isArray(archives) ? (archives as SerializedLazyArchiveEntry[]) : [])
        .map(rebaseArchive);
    },
  };

  return { baseImage, imageRead };
}
