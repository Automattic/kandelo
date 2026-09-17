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
import { resolveLazyUrl } from "./lazy-url";
import type { DeferredBody, RootfsOverlayBaseImage } from "./rootfs-lazy-archives";

/** What `KandeloImageFs.lazyEntries()` answers, named so this file need not import it. */
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

// THE SEAL-PAYLOAD UNWRAPPER IS GONE, and so is the reason it existed.
//
// The module wraps every archive payload as
// `u32 version | u32 descriptor_len | descriptor | u8 has_seal | [seal]`
// (`seal::encode`). This file opened that envelope to JSON-parse the
// descriptor for one field, `mountPrefix` — the only field it could not read
// as a typed value — and nothing downstream ever read the result. With the
// record reduced to what a host acts on, a boot no longer opens an opaque
// blob at all: the address, the length and the digest are typed fields the
// module hands over, and the seal half is authenticated in the loader by
// `rootfs::load_image` rather than inspected here.

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

  // WHAT A HOST-SIDE SECTION RECORDS, read structurally rather than cast.
  //
  // These sections are JSON written by the legacy producer, and the legacy
  // shape was a TYPE this file imported from the filesystem that declared it.
  // Reading the three fields a host acts on needs no such import, and the cast
  // it replaces was never sound anyway: the bytes are parsed from an image
  // that can arrive from a shared link, so a declared type here asserted
  // something about untrusted input that nothing had checked.
  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  const declaredTransports = (entry: Record<string, unknown>): string[] => {
    const content = asRecord(entry.content);
    const listed = Array.isArray(content?.transports)
      ? (content.transports as unknown[]).filter(
        (url): url is string => typeof url === "string" && url.length > 0,
      )
      : [];
    if (listed.length > 0) return listed.map(rebaseUrl);
    return typeof entry.url === "string" && entry.url.length > 0
      ? [rebaseUrl(entry.url)]
      : [];
  };
  const declaredIdentity = (
    entry: Record<string, unknown>,
  ): { bytes: number | undefined; sha256: string | undefined } => {
    // `content` first, `integrity` second: a v3 tree describes its bytes in
    // `content` and older entries in `integrity`, and an entry carrying both
    // is describing one archive twice.
    const identity = asRecord(entry.content) ?? asRecord(entry.integrity);
    return {
      bytes: typeof identity?.bytes === "number" ? identity.bytes : undefined,
      sha256: typeof identity?.sha256 === "string" ? identity.sha256 : undefined,
    };
  };

  const baseImage: RootfsOverlayBaseImage = {
    deferredFiles: () => {
      if (fromModule !== undefined) {
        // `archiveId === 0` is the STANDALONE registration: no archive behind
        // it, so `uri` is the whole of what says where the bytes are.
        return fromModule.files
          .filter((file) => file.archiveId === 0)
          .map((file) => ({
            address: rebaseUrl(file.uri),
            transports: [rebaseUrl(file.uri)],
            bytes: file.size,
            sha256: undefined,
          }));
      }
      const listed = Array.isArray(lazy) ? lazy : [];
      return listed.flatMap((value): DeferredBody[] => {
        const entry = asRecord(value);
        if (entry === undefined) return [];
        const url = typeof entry.url === "string" ? rebaseUrl(entry.url) : "";
        return [{
          address: url,
          transports: url === "" ? [] : [url],
          bytes: typeof entry.size === "number" ? entry.size : undefined,
          sha256: undefined,
        }];
      });
    },
    deferredArchives: () => {
      if (fromModule !== undefined) {
        return fromModule.archives.map((archive) => {
          // Read as FIELDS, not parsed back out of the descriptor: they were
          // in there only because the format had nowhere typed to put them, so
          // this reader had to open a blob the format says nobody opens — on
          // untrusted input, since an image can arrive from a shared link.
          //
          // NO DESCRIPTOR PARSE AT ALL NOW. It survived here to recover a
          // `mountPrefix` for the legacy record's shape; nothing downstream
          // ever read that field, so a boot no longer JSON-parses an opaque
          // blob to fill a slot nobody looks in.
          if (archive.uri === "") {
            throw new Error(
              `VFS image lazy archive ${archive.archiveId} declares no address, `
                + "so there is nothing that says where its bytes come from.",
            );
          }
          const address = rebaseUrl(archive.uri);
          const declared = archive.digest.length === 32
            && archive.digest.some((byte) => byte !== 0);
          return {
            address,
            transports: [address],
            bytes: declared ? archive.bytes : undefined,
            sha256: declared ? bytesToSha256Hex(archive.digest) : undefined,
          };
        });
      }
      const listed = Array.isArray(archives) ? archives : [];
      return listed.flatMap((value): DeferredBody[] => {
        const entry = asRecord(value);
        if (entry === undefined) return [];
        const transports = declaredTransports(entry);
        const { bytes, sha256 } = declaredIdentity(entry);
        return [{
          address: transports[0] ?? "",
          transports,
          bytes,
          sha256,
        }];
      });
    },
  };

  return { baseImage, imageRead };
}
